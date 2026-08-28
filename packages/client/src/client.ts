import {
	type Command,
	type CommandResult,
	type EventEnvelope,
	encodeClientMessage,
	ProtocolValidationError,
	type ResponseEnvelope,
	type ResultForCommand,
	type ServerEvent,
	type ServerSnapshot,
	type SessionMetadata,
} from "@earendil-works/pi-protocol";
import { Connection } from "./connection.ts";
import {
	PiClientDisposedError,
	PiDisconnectedError,
	PiServerError,
	PiSessionDetachedError,
	PiSessionOwnershipError,
	toError,
} from "./errors.ts";
import { createPromiseResolvers } from "./promise.ts";
import {
	type AcquireSessionOptions,
	type PiSessionHandle,
	SessionHandle,
	type SessionHandleCallbacks,
	type SessionLeaseMode,
} from "./session-handle.ts";
import { ClientState } from "./state.ts";
import type {
	ConnectionState,
	ConnectionStateChange,
	CreateSessionOptions,
	PiClientOptions,
	Unsubscribe,
} from "./types.ts";

/** 会话租约的生命周期状态：活跃、释放中、已释放或已失效。 */
type SessionLeaseState = "active" | "releasing" | "released" | "invalidated";

/** 会话租约令牌：标识一次具体的租约，携带租约模式。 */
interface SessionLeaseToken {
	/** 该租约的模式（共享或独占）。 */
	readonly mode: SessionLeaseMode;
}

/** 一条等待服务器响应的挂起请求。 */
interface PendingRequest {
	/** 已发送的命令，用于校验响应匹配。 */
	command: Command;
	/** 收到成功响应时结算。 */
	resolve(result: CommandResult): void;
	/** 收到错误或连接失败时拒绝。 */
	reject(error: Error): void;
}

/** Pi 客户端主类：连接远程会话服务器，管理会话租约并暴露操作 API。 */
export class PiClient {
	/** 客户端配置选项。 */
	readonly #options: PiClientOptions;
	/** 底层连接管理器。 */
	readonly #connection: Connection;
	/** 客户端状态（快照与订阅者）。 */
	readonly #state: ClientState;
	/** 等待服务器响应的请求表（按请求 ID 索引）。 */
	readonly #pendingRequests = new Map<string, PendingRequest>();
	/** 每个会话当前的租约计数。 */
	readonly #sessionLeaseCounts = new Map<string, number>();
	/** 每个会话的独占租约令牌。 */
	readonly #exclusiveSessionLeases = new Map<string, SessionLeaseToken>();
	/** 每个会话的租约代数，用于在会话被移除时使旧租约失效。 */
	readonly #sessionLeaseGenerations = new Map<string, number>();
	/** 进行中的会话附加（attach）操作。 */
	readonly #sessionAttachments = new Map<string, Promise<void>>();
	/** 进行中的会话脱离（detach）操作。 */
	readonly #sessionDetachments = new Map<string, Promise<void>>();
	/** 需要清理（重新 detach）的会话集合。 */
	readonly #sessionCleanupRequired = new Set<string>();
	/** 进行中的清理对账操作。 */
	readonly #sessionReconciliations = new Map<string, Promise<void>>();
	/** 连接状态变更监听器。 */
	readonly #connectionStateListeners = new Set<(change: ConnectionStateChange) => void>();
	/** 请求序号计数器，用于生成唯一的请求 ID。 */
	#requestSequence = 0;
	/** 是否已释放。 */
	#disposed = false;
	/** 释放完成 promise，保证 dispose 幂等。 */
	#disposePromise: Promise<void> | undefined;

	/** @param options 客户端配置，包含 token 与传输工厂等。 */
	constructor(options: PiClientOptions) {
		this.#options = options;
		this.#state = new ClientState(options.onListenerError);
		this.#connection = new Connection({
			transportFactory: options.transportFactory,
			maxFrameLength: options.maxFrameLength,
			onHandshake: (snapshot) => this.#state.applyServerSnapshot(snapshot),
			onMessage: (message) => this.#handleMessage(message),
			onStateChange: (change) => this.#handleConnectionStateChange(change),
		});
	}

	/** 是否已释放。 */
	get disposed(): boolean {
		return this.#disposed;
	}

	/** 当前连接状态。 */
	get connectionState(): ConnectionState {
		return this.#connection.state;
	}

	/** 是否已连接。 */
	get connected(): boolean {
		return this.#connection.state === "connected";
	}

	/** 最近一次的服务端全局快照。 */
	get snapshot(): ServerSnapshot | undefined {
		return this.#state.snapshot;
	}

	/** 创建客户端并建立连接；失败时自动释放已创建的资源。 */
	static async connect(options: PiClientOptions): Promise<PiClient> {
		const client = new PiClient(options);
		try {
			await client.connect();
			return client;
		} catch (error) {
			await client.dispose();
			throw error;
		}
	}

	/** 建立连接，返回握手完成后的服务端快照。 */
	connect(): Promise<ServerSnapshot> {
		if (this.#disposed) return Promise.reject(new PiClientDisposedError());
		if (this.#connection.state === "disconnected") this.#state.reset();
		return this.#connection.connect();
	}

	/** 重新建立连接（等价于 connect）。 */
	reconnect(): Promise<ServerSnapshot> {
		return this.connect();
	}

	/** 主动断开连接（可携带原因）。 */
	disconnect(reason = "Client disconnected"): void {
		this.#connection.disconnect(reason);
	}

	/** 订阅全局快照更新，返回取消订阅函数。 */
	subscribe(listener: (snapshot: ServerSnapshot) => void): Unsubscribe {
		this.#assertNotDisposed();
		return this.#state.subscribe(listener);
	}

	/** 订阅全局事件，返回取消订阅函数。 */
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		this.#assertNotDisposed();
		return this.#state.onEvent(listener);
	}

	/** 订阅连接状态变更，返回取消订阅函数。 */
	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
		this.#assertNotDisposed();
		this.#connectionStateListeners.add(listener);
		return () => this.#connectionStateListeners.delete(listener);
	}

	async listSessions(): Promise<readonly SessionMetadata[]> {
		return (await this.#request({ command: "list" })).sessions;
	}

	/** 创建一个新会话，并以独占租约方式返回会话句柄。 */
	async createSession(options: CreateSessionOptions = {}): Promise<PiSessionHandle> {
		const result = await this.#request({ command: "create", ...options });
		const token = this.#reserveSessionLease(result.session.id, "exclusive");
		return this.#createSessionLease(result.session.id, token);
	}

	/** 以共享模式附加到已有会话，返回会话句柄。 */
	async attachSession(sessionId: string): Promise<PiSessionHandle> {
		return this.acquireSession(sessionId, { mode: "shared" });
	}

	/** 按指定模式申请会话租约；必要时先完成附加或清理，再返回会话句柄。 */
	async acquireSession(sessionId: string, options: AcquireSessionOptions): Promise<PiSessionHandle> {
		this.#assertNotDisposed();
		const token = this.#reserveSessionLease(sessionId, options.mode);
		try {
			const detachment = this.#sessionDetachments.get(sessionId);
			if (detachment) await detachment.catch(() => {});
			const reconciled = this.#sessionCleanupRequired.has(sessionId)
				? await this.#reconcileSessionCleanup(sessionId)
				: false;
			if (reconciled || !this.#state.isSessionAttached(sessionId)) {
				let attachment = this.#sessionAttachments.get(sessionId);
				if (!attachment) {
					attachment = this.#attachSession(sessionId);
					this.#sessionAttachments.set(sessionId, attachment);
				}
				try {
					await attachment;
				} finally {
					if (this.#sessionAttachments.get(sessionId) === attachment) this.#sessionAttachments.delete(sessionId);
				}
			}
			return this.#createSessionLease(sessionId, token);
		} catch (error) {
			this.#releaseSessionLease(sessionId, token);
			throw error;
		}
	}

	/** 内部：附加会话（发送 attach 命令）；失败时回滚快照。 */
	async #attachSession(sessionId: string): Promise<void> {
		const previous = this.#state.forgetSessionSnapshot(sessionId);
		try {
			await this.#request({ command: "attach", sessionId });
		} catch (error) {
			if (previous) this.#state.restoreSessionSnapshot(previous);
			throw error;
		}
	}

	/** 内部：发送一条命令请求并等待响应；已释放或未连接时拒绝。 */
	#request<const TCommand extends Command>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		if (this.#disposed) return Promise.reject(new PiClientDisposedError());
		if (!this.connected) return Promise.reject(new PiDisconnectedError());
		const id = `request-${++this.#requestSequence}`;
		const { promise, resolve, reject } = createPromiseResolvers<CommandResult>();
		this.#pendingRequests.set(id, { command, resolve, reject });
		let frame: Uint8Array;
		try {
			frame = encodeClientMessage(
				{ type: "request", id, request: command },
				{ maxFrameLength: this.#connection.maxFrameLength },
			);
		} catch (error) {
			this.#takePendingRequest(id)?.reject(toError(error));
			return promise as Promise<ResultForCommand<TCommand>>;
		}
		this.#connection.send(frame);
		return promise as Promise<ResultForCommand<TCommand>>;
	}

	/** 内部：为会话创建租约并包装成 {@link SessionHandle}。 */
	#createSessionLease(sessionId: string, token: SessionLeaseToken): PiSessionHandle {
		const generation = this.#sessionLeaseGenerations.get(sessionId) ?? 0;
		this.#sessionLeaseGenerations.set(sessionId, generation);
		let state: SessionLeaseState = "active";
		let releasePromise: Promise<void> | undefined;
		// 若会话的租约代数已递增，说明租约被外部失效，标记为 invalidated。
		const refreshState = () => {
			if (
				(state === "active" || state === "releasing") &&
				this.#sessionLeaseGenerations.get(sessionId) !== generation
			) {
				state = "invalidated";
			}
		};
		const isActive = () => {
			refreshState();
			return state === "active" && this.#state.isSessionAttached(sessionId);
		};
		const assertActive = () => {
			this.#assertNotDisposed();
			if (!this.connected) throw new PiDisconnectedError();
			if (!isActive()) throw new PiSessionDetachedError(sessionId);
		};
		// 释放租约：最后一个租约结束时向服务器发送 detach；失败时可选是否放弃该租约。
		const release = (relinquishOnFailure: boolean): Promise<void> => {
			refreshState();
			if (state === "released" || state === "invalidated") return Promise.resolve();
			if (releasePromise) return releasePromise;
			assertActive();
			state = "releasing";
			releasePromise = (async () => {
				const count = this.#sessionLeaseCounts.get(sessionId) ?? 0;
				if (count <= 1) {
					const detachment = this.#request({ command: "detach", sessionId }).then(() => undefined);
					this.#sessionDetachments.set(sessionId, detachment);
					try {
						await detachment;
						this.#releaseSessionLease(sessionId, token);
					} finally {
						if (this.#sessionDetachments.get(sessionId) === detachment) {
							this.#sessionDetachments.delete(sessionId);
						}
					}
				} else {
					this.#releaseSessionLease(sessionId, token);
				}
				state = "released";
			})().catch((error: unknown) => {
				refreshState();
				if (state === "invalidated") return;
				if (relinquishOnFailure) {
					this.#releaseSessionLease(sessionId, token);
					this.#sessionCleanupRequired.add(sessionId);
					state = "released";
				} else {
					state = "active";
					releasePromise = undefined;
				}
				throw error;
			});
			return releasePromise;
		};
		const callbacks: SessionHandleCallbacks = {
			isAttached: isActive,
			getSnapshot: () => (isActive() ? this.#state.getSessionSnapshot(sessionId) : undefined),
			subscribe: (listener) => {
				assertActive();
				return this.#state.subscribeSession(sessionId, (snapshot) => {
					if (isActive()) listener(snapshot);
				});
			},
			onEvent: (listener) => {
				assertActive();
				return this.#state.onSessionEvent(sessionId, (event) => {
					if (isActive() || event.type === "session_removed") listener(event);
				});
			},
			detach: () => release(false),
			dispose: () => release(true),
			request: (command) => {
				assertActive();
				return this.#request(command);
			},
		};
		return new SessionHandle(sessionId, callbacks);
	}

	/** 内部：处理服务端响应/事件消息，匹配挂起请求或派发事件。 */
	#handleMessage(message: ResponseEnvelope | EventEnvelope): void {
		if (message.type === "event") {
			if (message.event.type === "session_removed") this.#invalidateSessionLeases(message.event.sessionId);
			this.#state.applyEvent(message.event);
			return;
		}
		const pending = this.#takePendingRequest(message.id);
		if (!pending) {
			this.#connection.fail(new ProtocolValidationError("Response has no matching request"));
			return;
		}
		if (!message.ok) {
			pending.reject(new PiServerError(message.error));
			return;
		}
		if (message.result.command !== pending.command.command) {
			const error = new ProtocolValidationError(
				`Response command ${message.result.command} does not match ${pending.command.command}`,
			);
			pending.reject(error);
			this.#connection.fail(error);
			return;
		}
		this.#state.applyResult(message.result);
		pending.resolve(message.result);
	}

	/** 内部：处理连接状态变更；断开时清理租约并拒绝全部挂起请求。 */
	#handleConnectionStateChange(change: ConnectionStateChange): void {
		if (change.state === "disconnected") {
			this.#state.clearAttachments();
			this.#invalidateAllSessionLeases();
			this.#rejectPendingRequests(change.error ?? new PiDisconnectedError());
		}
		this.#notifyConnectionStateListeners(change);
	}

	/** 取出并删除指定 ID 的挂起请求（不存在则返回 undefined）。 */
	#takePendingRequest(id: string): PendingRequest | undefined {
		const request = this.#pendingRequests.get(id);
		if (request) this.#pendingRequests.delete(id);
		return request;
	}

	/** 以同一错误拒绝全部挂起请求（用于断开/释放时）。 */
	#rejectPendingRequests(error: Error): void {
		const requests = [...this.#pendingRequests.values()];
		this.#pendingRequests.clear();
		for (const request of requests) request.reject(error);
	}

	/** 释放客户端：拒绝挂起请求、断开连接并清理全部状态。幂等。 */
	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = Promise.resolve();
		const error = new PiClientDisposedError();
		this.#rejectPendingRequests(error);
		this.#connection.disconnect(error);
		this.#state.dispose();
		this.#invalidateAllSessionLeases();
		this.#connectionStateListeners.clear();
		return this.#disposePromise;
	}

	/** 支持 `await using` 语法，在作用域结束时自动释放。 */
	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	/** 断言客户端尚未释放，否则抛错。 */
	#assertNotDisposed(): void {
		if (this.#disposed) throw new PiClientDisposedError();
	}

	/** 内部：清理需要重新 detach 的会话，返回是否有清理发生。 */
	async #reconcileSessionCleanup(sessionId: string): Promise<boolean> {
		if (!this.#sessionCleanupRequired.has(sessionId)) return false;
		let reconciliation = this.#sessionReconciliations.get(sessionId);
		if (!reconciliation) {
			reconciliation = this.#request({ command: "detach", sessionId })
				.then(() => undefined)
				.then(() => {
					this.#sessionCleanupRequired.delete(sessionId);
				})
				.finally(() => {
					this.#sessionReconciliations.delete(sessionId);
				});
			this.#sessionReconciliations.set(sessionId, reconciliation);
		}
		await reconciliation;
		return true;
	}

	/** 内部：预占一个会话租约；独占模式在已有租约时、共享模式遇独占租约时抛所有权错误。 */
	#reserveSessionLease(sessionId: string, mode: SessionLeaseMode): SessionLeaseToken {
		const count = this.#sessionLeaseCounts.get(sessionId) ?? 0;
		if (mode === "exclusive" && count > 0) {
			throw new PiSessionOwnershipError(sessionId, `Session ${sessionId} already has an active lease`);
		}
		if (mode === "shared" && this.#exclusiveSessionLeases.has(sessionId)) {
			throw new PiSessionOwnershipError(sessionId, `Session ${sessionId} has an exclusive lease`);
		}
		const token: SessionLeaseToken = { mode };
		this.#sessionLeaseCounts.set(sessionId, count + 1);
		if (mode === "exclusive") this.#exclusiveSessionLeases.set(sessionId, token);
		return token;
	}

	/** 内部：释放一次租约计数，并清除对应的独占标记。 */
	#releaseSessionLease(sessionId: string, token: SessionLeaseToken): void {
		const count = this.#sessionLeaseCounts.get(sessionId) ?? 0;
		if (count <= 1) this.#sessionLeaseCounts.delete(sessionId);
		else this.#sessionLeaseCounts.set(sessionId, count - 1);
		if (this.#exclusiveSessionLeases.get(sessionId) === token) this.#exclusiveSessionLeases.delete(sessionId);
	}

	/** 内部：使某个会话的全部租约失效，并递增租约代数。 */
	#invalidateSessionLeases(sessionId: string): void {
		this.#sessionLeaseCounts.delete(sessionId);
		this.#exclusiveSessionLeases.delete(sessionId);
		this.#sessionCleanupRequired.delete(sessionId);
		this.#sessionLeaseGenerations.set(sessionId, (this.#sessionLeaseGenerations.get(sessionId) ?? 0) + 1);
	}

	/** 内部：使所有会话的租约失效（用于断开/释放）。 */
	#invalidateAllSessionLeases(): void {
		for (const sessionId of this.#sessionLeaseCounts.keys()) this.#invalidateSessionLeases(sessionId);
		this.#sessionCleanupRequired.clear();
	}

	/** 内部：通知所有连接状态监听器，单个监听器抛错不影响其余。 */
	#notifyConnectionStateListeners(change: ConnectionStateChange): void {
		for (const listener of this.#connectionStateListeners) {
			try {
				listener(change);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	/** 内部：上报监听器异常；诊断逻辑不能影响协议或传输层状态。 */
	#reportListenerError(error: unknown): void {
		if (!this.#options.onListenerError) return;
		try {
			this.#options.onListenerError(toError(error));
		} catch {
			// 诊断逻辑不能影响协议或传输层状态。
		}
	}
}

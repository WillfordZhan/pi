import type {
	ConnectionState,
	ConnectionStateChange,
	PiClient,
	SessionLease,
	Unsubscribe,
} from "@earendil-works/pi-client";
import type {
	ModelMetadata,
	ModelRef,
	ServerEvent,
	SessionMetadata,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import {
	applyTranscriptProgress,
	applyTranscriptSnapshot,
	createTranscriptState,
	selectTranscript,
	type TranscriptState,
} from "./transcript.ts";

/** 远程会话上可以执行的操作名称。 */
export type RemoteSessionOperation = "open" | "create" | "submit" | "abort" | "setModel" | "setThinking" | "reconnect";

/** 远程会话的生命周期状态：未绑定、就绪、正忙（携带操作名）或已销毁。 */
export type RemoteSessionLifecycle =
	| { readonly status: "unbound" }
	| { readonly status: "ready" }
	| { readonly status: "busy"; readonly operation: RemoteSessionOperation }
	| { readonly status: "disposed" };

/** 对外暴露的远程会话状态：生命周期、最近快照以及转录条目。 */
export interface RemoteSessionState {
	readonly lifecycle: RemoteSessionLifecycle;
	readonly snapshot?: SessionSnapshot;
	readonly transcript: readonly TranscriptItem[];
}

/** 创建新远程会话所需的选项。 */
export interface CreateRemoteSessionOptions {
	cwd: string;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
}

/** 远程会话的通用选项。 */
export interface RemoteSessionOptions {
	/** 监听器抛错时的回调；未提供则静默忽略。 */
	onListenerError?: (error: Error) => void;
}

/** 会话已销毁时抛出的内部错误，用于清理路径中静默忽略。 */
class RemoteSessionDisposedError extends Error {
	constructor() {
		super("Remote session is disposed");
		this.name = "RemoteSessionDisposedError";
	}
}

/** 汇总清理操作的成败：忽略“已销毁”错误，聚合其余错误后抛出。 */
async function settleRemoteSessionDisposal(cleanup: readonly Promise<void>[]): Promise<void> {
	const results = await Promise.allSettled(cleanup);
	const errors = results.flatMap((result) =>
		result.status === "rejected" && !(result.reason instanceof RemoteSessionDisposedError) ? [result.reason] : [],
	);
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose remote session");
}

/**
 * 远程会话的客户端封装：绑定一个会话租约，订阅快照与事件，
 * 对外提供打开/创建/提交/中断/切换模型等操作，并广播状态变化。
 */
export class RemoteSession {
	/** 底层 Pi 客户端连接。 */
	readonly #client: PiClient;
	/** 监听器出错时的回调。 */
	readonly #onListenerError: ((error: Error) => void) | undefined;
	/** 当前生命周期状态。 */
	#lifecycle: RemoteSessionLifecycle = { status: "unbound" };
	/** 当前绑定的会话租约。 */
	#handle: SessionLease | undefined;
	/** 转录状态（快照 + 增量进度）。 */
	#transcript: TranscriptState | undefined;
	/** 快照订阅的取消函数。 */
	#unsubscribeSnapshot: Unsubscribe | undefined;
	/** 事件订阅的取消函数。 */
	#unsubscribeEvents: Unsubscribe | undefined;
	/** 状态监听器集合。 */
	readonly #listeners = new Set<(state: RemoteSessionState) => void>();
	/** 进行中的附着类操作（用于销毁时一并等待）。 */
	readonly #pendingAttachmentOperations = new Set<Promise<void>>();
	/** 当前活跃的“忙碌”状态对象（用于嵌套操作恢复）。 */
	readonly #activeOperationStates = new Set<RemoteSessionLifecycle>();
	/** 销毁流程的 Promise 缓存，保证只执行一次。 */
	#disposePromise: Promise<void> | undefined;
	/** 销毁信号的解析函数。 */
	#resolveDisposeSignal: () => void = () => {};
	/** 销毁信号：销毁时 resolve，用于中断进行中的操作。 */
	readonly #disposeSignal = new Promise<void>((resolve) => {
		this.#resolveDisposeSignal = resolve;
	});

	/** 私有构造函数：请使用静态工厂方法 `open` / `create` 创建实例。 */
	private constructor(client: PiClient, options: RemoteSessionOptions = {}) {
		this.#client = client;
		this.#onListenerError = options.onListenerError;
	}

	/** 当前会话 ID；未绑定时为 undefined。 */
	get id(): string | undefined {
		return this.#handle?.id;
	}

	/** 当前的完整会话状态（生命周期 + 快照 + 转录）。 */
	get state(): RemoteSessionState {
		return {
			lifecycle: this.#lifecycle,
			snapshot: this.#transcript?.snapshot,
			transcript: this.#transcript ? selectTranscript(this.#transcript) : [],
		};
	}

	/** 最近一次会话快照。 */
	get snapshot(): SessionSnapshot | undefined {
		return this.#transcript?.snapshot;
	}

	/** 当前会话阶段（如 idle / turn）。 */
	get phase(): SessionPhase | undefined {
		return this.snapshot?.phase;
	}

	/** 当前正在执行的远程操作（仅当生命周期为 busy 时存在）。 */
	get operation(): RemoteSessionOperation | undefined {
		return this.#lifecycle.status === "busy" ? this.#lifecycle.operation : undefined;
	}

	/** 服务端已知的模型元数据列表。 */
	get models(): readonly ModelMetadata[] {
		return this.#client.snapshot?.models ?? [];
	}

	get sessions(): readonly SessionMetadata[] {
		return this.#client.snapshot?.sessions ?? [];
	}

	/** 底层连接状态。 */
	get connectionState(): ConnectionState {
		return this.#client.connectionState;
	}

	/** 是否已销毁。 */
	get disposed(): boolean {
		return this.#lifecycle.status === "disposed";
	}

	/** 订阅会话状态变化，立即回调一次当前状态，返回取消订阅函数。 */
	subscribe(listener: (state: RemoteSessionState) => void): Unsubscribe {
		this.#assertNotDisposed();
		this.#listeners.add(listener);
		this.#callListener(listener, this.state);
		return () => this.#listeners.delete(listener);
	}

	/** 订阅底层连接状态变化，返回取消订阅函数。 */
	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
		this.#assertNotDisposed();
		return this.#client.onConnectionStateChange(listener);
	}

	/** 打开一个已有会话；失败时自动销毁并重新抛出异常。 */
	static async open(client: PiClient, sessionId: string, options: RemoteSessionOptions = {}): Promise<RemoteSession> {
		const session = new RemoteSession(client, options);
		try {
			await session.open(sessionId);
			return session;
		} catch (error) {
			await session.dispose();
			throw error;
		}
	}

	/** 打开指定会话；若已绑定到该会话且处于就绪状态则直接返回。 */
	async open(sessionId: string): Promise<void> {
		if (this.#handle?.id === sessionId && this.#lifecycle.status === "ready") return;
		await this.#replace("open", () => this.#client.acquireSession(sessionId, { mode: "exclusive" }));
	}

	/** 创建并绑定一个新会话；失败时自动销毁并重新抛出异常。 */
	static async create(
		client: PiClient,
		createOptions: CreateRemoteSessionOptions,
		options: RemoteSessionOptions = {},
	): Promise<RemoteSession> {
		const session = new RemoteSession(client, options);
		try {
			await session.create(createOptions);
			return session;
		} catch (error) {
			await session.dispose();
			throw error;
		}
	}

	/** 使用给定选项创建并绑定一个新会话。 */
	async create(options: CreateRemoteSessionOptions): Promise<void> {
		await this.#replace("create", () => this.#client.createSession(options));
	}

	/** 提交一段文本：空闲阶段发送 prompt，回合中则以 steer 方式注入。 */
	async submit(text: string): Promise<void> {
		const normalized = text.trim();
		if (!normalized) return;
		this.#assertAvailable();
		const handle = this.#requireHandle();
		if (this.phase !== "idle" && this.phase !== "turn") {
			throw new Error(`Session cannot accept input during ${this.phase ?? "unknown"} phase`);
		}
		await this.#runOperation("submit", () =>
			(this.phase === "idle" ? handle.prompt(normalized) : handle.steer(normalized)).then(() => undefined),
		);
	}

	/** 中断当前正在进行的操作；可抢占正在执行的 submit。 */
	async abort(): Promise<void> {
		const preemptingSubmit = this.#lifecycle.status === "busy" && this.#lifecycle.operation === "submit";
		if (preemptingSubmit) this.#assertNotDisposed();
		else this.#assertAvailable();
		const handle = this.#requireHandle();
		if (this.phase === "idle" && !preemptingSubmit) return;
		await this.#runOperation("abort", () => handle.abort().then(() => undefined), preemptingSubmit);
	}

	/** 在空闲阶段切换会话模型。 */
	async setModel(model: ModelRef): Promise<void> {
		await this.#runIdleOperation("setModel", "change model", () =>
			this.#requireHandle()
				.setModel(model)
				.then(() => undefined),
		);
	}

	/** 在空闲阶段切换会话的思考深度。 */
	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		await this.#runIdleOperation("setThinking", "change thinking level", () =>
			this.#requireHandle()
				.setThinking(thinkingLevel)
				.then(() => undefined),
		);
	}

	/** 重新建立连接并重新绑定原会话（适用于连接中断后的恢复）。 */
	async reconnect(): Promise<void> {
		this.#assertAvailable();
		const sessionId = this.#requireHandle().id;
		await this.#runOperation("reconnect", () =>
			this.#trackAttachmentOperation(async () => {
				await this.#client.reconnect();
				const handle = await this.#client.acquireSession(sessionId, { mode: "exclusive" });
				await this.#assertNotDisposedAfterAwait(handle);
				this.#bind(handle);
			}),
		);
	}

	/** 销毁远程会话：释放租约、等待进行中的附着操作结束，并广播一次最终状态。 */
	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		const handle = this.#handle;
		this.#lifecycle = { status: "disposed" };
		this.#resolveDisposeSignal();
		this.#clearSubscriptions();
		this.#handle = undefined;
		this.#transcript = undefined;
		const cleanup = [...this.#pendingAttachmentOperations];
		if (handle) cleanup.push(handle.dispose());
		this.#disposePromise = settleRemoteSessionDisposal(cleanup);
		this.#notify();
		this.#listeners.clear();
		return this.#disposePromise;
	}

	/** 支持 `await using` 语法，在作用域退出时自动销毁。 */
	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	/** 用新的会话租约替换当前绑定（open/create 共用），要求当前空闲。 */
	async #replace(operation: "open" | "create", prepare: () => Promise<SessionLease>): Promise<void> {
		this.#assertAvailable();
		if (this.#handle && this.phase !== "idle") {
			throw new Error(`Cannot ${operation} a session while session is ${this.phase ?? "unavailable"}`);
		}
		await this.#runOperation(operation, () =>
			this.#trackAttachmentOperation(() => this.#prepareReplacement(operation, prepare)),
		);
	}

	/** 登记一个附着操作，确保销毁时能够一并等待其完成。 */
	async #trackAttachmentOperation(run: () => Promise<void>): Promise<void> {
		const pending = run();
		this.#pendingAttachmentOperations.add(pending);
		try {
			await pending;
		} finally {
			this.#pendingAttachmentOperations.delete(pending);
		}
	}

	/** 准备并完成会话租约替换：校验快照、必要时分离旧会话，然后绑定新会话。 */
	async #prepareReplacement(operation: "open" | "create", prepare: () => Promise<SessionLease>): Promise<void> {
		const previous = this.#handle;
		const next = await prepare();
		await this.#assertNotDisposedAfterAwait(next);
		const snapshot = next.snapshot;
		if (!snapshot) {
			await this.#detach(next);
			throw new Error(`Session ${next.id} did not provide a snapshot`);
		}
		if (previous && previous.id !== next.id && previous.attached && this.phase !== "idle") {
			await this.#detach(next);
			throw new Error(`Cannot ${operation} a session while session is ${this.phase ?? "unavailable"}`);
		}
		if (previous && previous.id !== next.id && previous.attached) {
			try {
				await previous.detach();
			} catch (error) {
				try {
					await this.#detach(next);
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Failed to replace remote session attachment");
				}
				throw error;
			}
		}
		await this.#assertNotDisposedAfterAwait(next);
		this.#bind(next, snapshot);
	}

	/** 运行一个仅允许在空闲阶段执行的闲置操作（如切换模型/思考深度）。 */
	async #runIdleOperation(
		operation: "setModel" | "setThinking",
		description: string,
		run: () => Promise<void>,
	): Promise<void> {
		this.#assertAvailable();
		this.#requireHandle();
		if (this.phase !== "idle") {
			throw new Error(`Cannot ${description} while session is ${this.phase ?? "unavailable"}`);
		}
		await this.#runOperation(operation, run);
	}

	/** 运行一个远程操作：置为 busy、广播状态、等待完成并与销毁信号竞争。 */
	async #runOperation(operation: RemoteSessionOperation, run: () => Promise<void>, preempt = false): Promise<void> {
		if (preempt) this.#assertNotDisposed();
		else this.#assertAvailable();
		const previous = this.#lifecycle;
		const busy: RemoteSessionLifecycle = { status: "busy", operation };
		this.#lifecycle = busy;
		this.#activeOperationStates.add(busy);
		this.#notify();
		const running = run();
		try {
			await Promise.race([
				running,
				this.#disposeSignal.then(() => {
					throw new Error("Remote session is disposed");
				}),
			]);
		} finally {
			this.#activeOperationStates.delete(busy);
			if (!this.disposed && this.#lifecycle === busy) {
				this.#lifecycle =
					preempt && this.#activeOperationStates.has(previous)
						? previous
						: this.#handle
							? { status: "ready" }
							: { status: "unbound" };
				this.#notify();
			}
		}
	}

	/** 绑定会话租约：重建转录状态并订阅快照更新与事件。 */
	#bind(handle: SessionLease, knownSnapshot?: SessionSnapshot): void {
		const snapshot = knownSnapshot ?? handle.snapshot;
		if (!snapshot) throw new Error(`Session ${handle.id} did not provide a snapshot`);
		this.#clearSubscriptions();
		this.#handle = handle;
		this.#transcript = createTranscriptState(snapshot);
		this.#unsubscribeSnapshot = handle.subscribe((next) => {
			if (!this.#transcript) return;
			this.#transcript = applyTranscriptSnapshot(this.#transcript, next);
			this.#notify();
		});
		this.#unsubscribeEvents = handle.onEvent((event) => this.#handleEvent(event));
	}

	/** 处理服务端事件：会话被移除时解绑，进度事件则应用到转录状态。 */
	#handleEvent(event: ServerEvent): void {
		if (event.type === "session_removed") {
			this.#clearSubscriptions();
			this.#handle = undefined;
			this.#transcript = undefined;
			if (this.#lifecycle.status !== "busy") this.#lifecycle = { status: "unbound" };
			this.#notify();
			return;
		}
		if (event.type !== "session_progress" || !this.#transcript) return;
		this.#transcript = applyTranscriptProgress(this.#transcript, event.progress);
		this.#notify();
	}

	/** 向所有监听器广播当前状态。 */
	#notify(): void {
		const state = this.state;
		for (const listener of this.#listeners) this.#callListener(listener, state);
	}

	/** 调用单个监听器；捕获并上报监听器抛出的异常。 */
	#callListener(listener: (state: RemoteSessionState) => void, state: RemoteSessionState): void {
		try {
			listener(state);
		} catch (error) {
			this.#reportListenerError(error);
		}
	}

	/** 把监听器异常交给回调处理；回调自身出错则静默忽略。 */
	#reportListenerError(error: unknown): void {
		if (!this.#onListenerError) return;
		try {
			this.#onListenerError(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// 诊断信息不应影响会话或传输状态。
		}
	}

	/** 取消快照与事件的订阅并清空引用。 */
	#clearSubscriptions(): void {
		this.#unsubscribeSnapshot?.();
		this.#unsubscribeEvents?.();
		this.#unsubscribeSnapshot = undefined;
		this.#unsubscribeEvents = undefined;
	}

	/** 获取当前绑定的会话租约；未绑定时抛出错误。 */
	#requireHandle(): SessionLease {
		if (!this.#handle) throw new Error("No remote session is attached");
		return this.#handle;
	}

	/** 断言会话可用（未销毁且当前不忙）。 */
	#assertAvailable(): void {
		this.#assertNotDisposed();
		if (this.#lifecycle.status === "busy") {
			throw new Error(`Remote session is busy with ${this.#lifecycle.operation}`);
		}
	}

	/** 断言会话未被销毁。 */
	#assertNotDisposed(): void {
		if (this.disposed) throw new Error("Remote session is disposed");
	}

	/** 在异步等待后再次确认未销毁；若已销毁则分离新租约并抛出错误。 */
	async #assertNotDisposedAfterAwait(handle: SessionLease): Promise<void> {
		if (!this.disposed) return;
		await this.#detach(handle);
		throw new RemoteSessionDisposedError();
	}

	/** 释放（销毁）一个会话租约。 */
	async #detach(handle: SessionLease): Promise<void> {
		await handle.dispose();
	}
}

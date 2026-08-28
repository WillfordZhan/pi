import { randomUUID } from "node:crypto";
import {
	type ClientHello,
	type ClientMessage,
	ClientMessageDecoder,
	DEFAULT_MAX_FRAME_LENGTH,
	encodeServerMessage,
	isSupportedProtocolVersion,
	PROTOCOL_VERSION,
	type ProtocolError,
	ProtocolValidationError,
	type RequestEnvelope,
	type ResponseEnvelope,
	type ServerHello,
	type ServerHelloError,
	type ServerMessage,
} from "@earendil-works/pi-protocol";
import {
	type ByteConnection,
	type ByteConnectionHandler,
	type ConnectionState,
	isTerminalConnection,
} from "./connection.ts";
import {
	INTERNAL_SERVER_ERROR_MESSAGE,
	InternalServerError,
	NOT_IMPLEMENTED_MESSAGE,
	PiServerError,
} from "./errors.ts";
import type { PiServerListener } from "./listener.ts";
import { LiveSessionManager } from "./sessions.ts";
import { ServerSnapshotPublisher } from "./snapshots.ts";
import type { PiServerOptions, PiServerService } from "./types.ts";

/** 默认的握手超时时长（毫秒）。 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
/** uint32 最大值，用于校验帧长度上限。 */
const MAX_UINT32 = 0xffff_ffff;
/** Node.js 定时器允许的最大延迟（毫秒）。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class PiServer {
	/** 服务器实例唯一 ID。 */
	readonly id: string;

	/** 已注册的传输监听器列表。 */
	private readonly listeners: readonly PiServerListener[];
	private readonly maxFrameLength: number;
	/** 握手超时时长（毫秒）。 */
	private readonly handshakeTimeoutMs: number;
	/** 可选的全局错误回调，用于上报非致命异常。 */
	private readonly onError: ((error: Error) => void) | undefined;
	/** 当前所有活跃连接的集合。 */
	private readonly connections = new Set<ConnectionState>();
	/** 会话管理器：负责创建/附加/执行会话命令。 */
	private readonly sessions: LiveSessionManager;
	/** 快照发布器：向所有就绪连接广播服务器快照。 */
	private readonly snapshots: ServerSnapshotPublisher;
	/** 是否正在关闭。 */
	private closing = false;
	/** 已开始的关闭流程（幂等去重）。 */
	private closePromise?: Promise<void>;
	/** 已开始的启动流程（幂等去重）。 */
	private startPromise?: Promise<this>;
	/** 是否已成功启动。 */
	private started = false;

	constructor(service: PiServerService, options: PiServerOptions) {
		const resolved = resolveOptions(options);
		this.listeners = options.listeners;
		this.id = options.serverId ?? randomUUID();
		this.maxFrameLength = resolved.maxFrameLength;
		this.handshakeTimeoutMs = resolved.handshakeTimeoutMs;
		this.onError = options.onError;
		this.sessions = new LiveSessionManager({
			service,
			isClosing: () => this.closing,
			sendMessage: (connection, message) => this.sendMessage(connection, message),
			closeConnection: (connection) => this.closeConnection(connection),
			disconnect: (connection) => this.disconnect(connection),
			broadcastServerSnapshot: () => void this.snapshots.broadcast(),
			reportError: (error) => this.reportError(error),
		});
		this.snapshots = new ServerSnapshotPublisher({
			serverId: this.id,
			service,
			connections: this.connections,
			isClosing: () => this.closing,
			listSessions: () => this.sessions.listMetadata(),
			sendMessage: (connection, message) => this.sendMessage(connection, message),
			reportError: (error) => this.reportError(error),
		});
	}

	/** 所有监听器绑定的地址列表（仅包含有地址概念的传输层）。 */
	get addresses(): readonly string[] {
		return this.listeners.flatMap((listener) => (listener.address === undefined ? [] : [listener.address]));
	}

	/** 启动服务器（启动所有监听器）；重复调用会拒绝。 */
	start(): Promise<this> {
		if (this.started) return Promise.reject(new Error("PiServer is already started"));
		if (this.startPromise) return Promise.reject(new Error("PiServer is already starting"));
		if (this.closing) return Promise.reject(new Error("PiServer is closing or closed"));
		this.startPromise = this.startInternal();
		return this.startPromise;
	}

	/** 依次启动所有监听器；若中途失败，则回滚已启动的监听器并关闭服务器状态。 */
	private async startInternal(): Promise<this> {
		const started: PiServerListener[] = [];
		try {
			for (const listener of this.listeners) {
				await listener.start((connection) => this.accept(connection));
				started.push(listener);
			}
			this.started = true;
			return this;
		} catch (error) {
			this.closing = true;
			await Promise.allSettled(started.map((listener) => listener.close()));
			await this.closeServerState();
			throw error;
		} finally {
			this.startPromise = undefined;
		}
	}

	/** 接收一条新连接：建立连接状态、启动握手超时，并返回数据/关闭/错误事件处理器。 */
	accept(connection: ByteConnection): ByteConnectionHandler {
		if (this.closing) {
			void this.closeConnection(connection);
			return {
				onData: () => {},
				onClose: () => {},
				onError: (error) => this.reportError(error),
			};
		}

		let state: ConnectionState;
		const handshakeTimeout = setTimeout(() => {
			void this.failProtocol(state, {
				code: "invalid_request",
				message: "Handshake timeout",
			});
		}, this.handshakeTimeoutMs);
		handshakeTimeout.unref();
		state = {
			id: randomUUID(),
			connection,
			decoder: new ClientMessageDecoder({ maxFrameLength: this.maxFrameLength }),
			sessionIds: new Set(),
			stage: "awaitingHello",
			disconnected: false,
			handshakeComplete: false,
			handshakeTimeout,
		};
		this.connections.add(state);

		return {
			onData: (chunk) => this.receive(state, chunk),
			onClose: () => this.transportClosed(state),
			onError: (error) => {
				this.reportError(error);
				void this.closeConnection(connection).then(() => this.disconnect(state));
			},
		};
	}

	/** 关闭服务器：停止所有监听器并释放全部连接与会话资源（幂等）。 */
	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	/** 关闭内部实现：先等待启动流程结束，再关闭监听器与服务器状态。 */
	private async closeInternal(): Promise<void> {
		const starting = this.startPromise;
		if (starting) await starting.catch(() => {});
		try {
			await Promise.all(this.listeners.map((listener) => listener.close()));
		} finally {
			await this.closeServerState();
			this.started = false;
		}
	}

	/** 接收原始字节块：交给解码器解出消息后逐一分发；解码失败则按协议失败处理。 */
	private receive(state: ConnectionState, chunk: Uint8Array): void {
		if (isTerminalConnection(state)) return;
		let messages: ClientMessage[];
		try {
			messages = state.decoder.push(chunk);
		} catch (error) {
			void this.failProtocol(state, this.toProtocolError(error));
			return;
		}
		for (const message of messages) {
			if (isTerminalConnection(state)) return;
			this.dispatchMessage(state, message);
		}
	}

	/** 按协议阶段分发客户端消息：首条必须是 hello，之后在就绪阶段处理请求，握手期间的请求排队等待。 */
	private dispatchMessage(state: ConnectionState, message: ClientMessage): void {
		if (state.stage === "awaitingHello") {
			if (message.type !== "hello") {
				void this.failProtocol(state, {
					code: "invalid_request",
					message: "The first client message must be hello",
				});
				return;
			}
			state.stage = "handshaking";
			state.handshake = this.finishHandshake(state, message).catch((error: unknown) =>
				this.failProtocol(state, this.toProtocolError(error)),
			);
			return;
		}

		if (message.type === "hello") {
			void this.failProtocol(state, {
				code: "invalid_request",
				message: "hello may only be sent as the first message",
			});
			return;
		}

		if (state.stage === "ready") {
			void this.handleRequest(state, message);
			return;
		}
		if (state.stage !== "handshaking") return;
		const handshake = state.handshake;
		if (!handshake) return;
		void handshake.then(() => {
			if (state.stage === "ready" && !state.disconnected) void this.handleRequest(state, message);
		});
	}

	/** 完成握手：校验令牌与协议版本，回复 hello 快照并把连接推进到就绪阶段。 */
	private async finishHandshake(state: ConnectionState, hello: ClientHello): Promise<void> {
		if (!isSupportedProtocolVersion(hello.version)) {
			await this.failProtocol(state, {
				code: "version",
				message: `Unsupported protocol version ${hello.version}; expected ${PROTOCOL_VERSION}`,
			});
			return;
		}

		const snapshot = await this.snapshots.get();
		if (this.closing || state.disconnected || state.stage !== "handshaking" || state.connection.closed) return;
		const sent = await this.sendMessage(state, {
			type: "hello",
			version: PROTOCOL_VERSION,
			connectionId: state.id,
			snapshot,
		} satisfies ServerHello);
		if (sent && !state.disconnected && state.stage === "handshaking") {
			state.handshakeComplete = true;
			state.stage = "ready";
			clearTimeout(state.handshakeTimeout);
			if (snapshot.revision !== this.snapshots.currentRevision) {
				const current = await this.snapshots.get();
				await this.sendMessage(state, {
					type: "event",
					event: { type: "server_snapshot", snapshot: current },
				});
			}
		}
	}

	private async handleRequest(state: ConnectionState, envelope: RequestEnvelope): Promise<void> {
		try {
			const result = await this.sessions.executeCommand(state, envelope.request);
			await this.sendMessage(state, {
				type: "response",
				id: envelope.id,
				ok: true,
				result,
			} satisfies ResponseEnvelope);
		} catch (error) {
			await this.sendMessage(state, {
				type: "response",
				id: envelope.id,
				ok: false,
				error: this.toProtocolError(error),
			} satisfies ResponseEnvelope);
		}
	}

	/** 底层传输关闭时调用：结束解码器并断开连接状态。 */
	private transportClosed(connection: ConnectionState): void {
		if (!connection.disconnected && connection.stage !== "closing") {
			try {
				connection.decoder.end();
			} catch (error) {
				this.reportError(error);
			}
		}
		void this.disconnect(connection);
	}

	/** 断开一个连接：标记关闭、从连接集合移除、解绑会话，并在握手完成后广播快照。 */
	private async disconnect(connection: ConnectionState): Promise<void> {
		if (connection.disconnected) return;
		const handshakeComplete = connection.handshakeComplete;
		connection.disconnected = true;
		connection.stage = "closed";
		clearTimeout(connection.handshakeTimeout);
		this.connections.delete(connection);
		await this.sessions.disconnect(connection);
		if (!this.closing && handshakeComplete) void this.snapshots.broadcast();
	}

	/** 编码并发送一条服务器消息；编码或发送失败时上报错误并关闭连接，返回是否发送成功。 */
	private async sendMessage(connection: ConnectionState, message: ServerMessage): Promise<boolean> {
		if (connection.disconnected || connection.connection.closed) return false;
		let frame: Uint8Array;
		try {
			frame = encodeServerMessage(message, { maxFrameLength: this.maxFrameLength });
		} catch (error) {
			this.reportError(error);
			await this.closeConnection(connection.connection);
			await this.disconnect(connection);
			return false;
		}
		try {
			await connection.connection.send(frame);
			return true;
		} catch (error) {
			this.reportError(error);
			await this.closeConnection(connection.connection);
			await this.disconnect(connection);
			return false;
		}
	}

	/** 协议级失败：向客户端发送 hello_error（带最终帧）后关闭连接。 */
	private async failProtocol(connection: ConnectionState, error: ProtocolError): Promise<void> {
		if (connection.disconnected || connection.stage === "closing" || connection.stage === "closed") return;
		connection.stage = "closing";
		clearTimeout(connection.handshakeTimeout);
		const message: ServerHelloError = { type: "hello_error", error };
		let finalFrame: Uint8Array | undefined;
		try {
			finalFrame = encodeServerMessage(message, { maxFrameLength: this.maxFrameLength });
		} catch (encodeError) {
			this.reportError(encodeError);
		}
		await this.closeConnection(connection.connection, finalFrame);
		await this.disconnect(connection);
	}

	/** 关闭服务器级状态：先关闭所有连接，再关闭会话管理器并清空连接集合。 */
	private async closeServerState(): Promise<void> {
		const connections = [...this.connections];
		for (const connection of connections) {
			connection.stage = "closing";
			clearTimeout(connection.handshakeTimeout);
		}
		await Promise.all(connections.map((connection) => this.closeConnection(connection.connection)));
		await Promise.all(connections.map((connection) => this.disconnect(connection)));

		await this.sessions.close();
		this.connections.clear();
	}

	/** 关闭单条底层连接，可选附带最终字节块；关闭异常仅上报错误。 */
	private async closeConnection(connection: ByteConnection, finalChunk?: Uint8Array): Promise<void> {
		try {
			await connection.close(finalChunk);
		} catch (error) {
			this.reportError(error);
		}
	}

	/** 将任意异常映射为协议错误：PiServerError 直接透传，其余归为内部错误。 */
	private toProtocolError(error: unknown): ProtocolError {
		if (error instanceof InternalServerError) {
			this.reportError(error.cause);
			return { code: "internal_error", message: INTERNAL_SERVER_ERROR_MESSAGE };
		}
		if (error instanceof PiServerError) {
			if (error.code === "not_implemented") {
				return { code: "not_implemented", message: NOT_IMPLEMENTED_MESSAGE };
			}
			return error.details === undefined
				? { code: error.code, message: error.message }
				: { code: error.code, message: error.message, details: error.details };
		}
		if (error instanceof ProtocolValidationError) {
			return { code: "invalid_request", message: error.message };
		}
		this.reportError(error);
		return { code: "internal_error", message: INTERNAL_SERVER_ERROR_MESSAGE };
	}

	/** 上报错误给 onError 回调；错误观察者的异常不能影响服务器状态。 */
	private reportError(error: unknown): void {
		try {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// 错误观察者不得影响服务器状态。
		}
	}
}

/** 校验并规范化服务器选项（监听器、令牌、帧长、握手超时）。 */
function resolveOptions(options: PiServerOptions): { maxFrameLength: number; handshakeTimeoutMs: number } {
	if (!Array.isArray(options.listeners)) throw new TypeError("PiServer listeners must be an array");
	if (options.serverId === "") throw new TypeError("PiServer serverId must not be empty");
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
		throw new TypeError(`PiServer maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
	}
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(handshakeTimeoutMs) ||
		handshakeTimeoutMs <= 0 ||
		handshakeTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new TypeError(`PiServer handshakeTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}
	return { maxFrameLength, handshakeTimeoutMs };
}

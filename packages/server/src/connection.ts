import type { ClientMessageDecoder } from "@earendil-works/pi-protocol";

import type { MaybePromise } from "./types.ts";

/** An established, authorized ordered byte connection. */
export interface ByteConnection {
	/** 连接是否已关闭（用于判断是否还能继续发送数据）。 */
	readonly closed: boolean;
	/** 发送一个字节块；在关闭状态下调用会失败。 */
	send(chunk: Uint8Array): Promise<void>;
	/** 关闭连接，可附带一个最终字节块（例如协议层的最后一条消息）。 */
	close(finalChunk?: Uint8Array): MaybePromise<void>;
}

/** 传输层向 PiServer 领域核心报告连接事件的处理器接口。 */
export interface ByteConnectionHandler {
	/** 收到新的数据字节块时调用。 */
	onData(chunk: Uint8Array): void;
	/** 传输层连接关闭时调用。 */
	onClose(): void;
	/** 传输层发生错误时调用。 */
	onError(error: Error): void;
}

/** 接受一条 {@link ByteConnection} 并返回其事件处理器的回调类型，由监听器在每次新连接时调用。 */
export type ByteConnectionAcceptor = (connection: ByteConnection) => ByteConnectionHandler;

/** 连接所处的协议生命周期阶段。 */
export type ConnectionStage = "awaitingHello" | "handshaking" | "ready" | "closing" | "closed";

/** 服务器端维护的单个连接的完整运行时状态。 */
export interface ConnectionState {
	/** 连接唯一 ID。 */
	id: string;
	/** 底层传输连接。 */
	connection: ByteConnection;
	/** 解码客户端消息的流式解码器。 */
	decoder: ClientMessageDecoder;
	/** 该连接当前附加（attach）的会话 ID 集合。 */
	sessionIds: Set<string>;
	/** 当前协议阶段。 */
	stage: ConnectionStage;
	/** 是否已断开。 */
	disconnected: boolean;
	/** 握手是否成功完成。 */
	handshakeComplete: boolean;
	/** 正在进行的握手流程，供握手完成前排队处理后续请求。 */
	handshake?: Promise<void>;
	/** 握手超时定时器，超时即按协议失败关闭连接。 */
	handshakeTimeout: NodeJS.Timeout;
}

/** 判断连接是否处于终态（已断开或正在/已经关闭），终态下不应再处理消息。 */
export function isTerminalConnection(state: ConnectionState): boolean {
	return state.disconnected || state.stage === "closing" || state.stage === "closed";
}

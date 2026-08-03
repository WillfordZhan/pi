import type { ModelRef, ThinkingLevel } from "@earendil-works/pi-protocol";
import type { ByteTransportFactory } from "./transport.ts";

/** 连接生命周期状态：未连接、连接中、已连接。 */
export type ConnectionState = "disconnected" | "connecting" | "connected";

/** 连接状态变更通知：包含新状态以及断开时的错误信息。 */
export interface ConnectionStateChange {
	/** 变更后的连接状态。 */
	state: ConnectionState;
	/** 断开时的错误信息；非断开状态或正常断开时可为 undefined。 */
	error?: Error;
}

/** 取消订阅函数签名：调用后即取消对应的订阅。 */
export type Unsubscribe = () => void;
/** 监听器错误处理函数：上报订阅者抛出的异常而不污染客户端状态。 */
export type ListenerErrorHandler = (error: Error) => void;

/** 创建 {@link PiClient} 时的配置选项。 */
export interface PiClientOptions {
	/** 用于身份认证的访问令牌。 */
	token: string;
	/** 传输层工厂：为每次连接尝试创建底层字节传输。 */
	transportFactory: ByteTransportFactory;
	/** 单帧最大长度（字节），用于编解码校验。 */
	maxFrameLength?: number;
	/** 上报订阅者抛出的异常，同时避免其破坏客户端状态。 */
	onListenerError?: ListenerErrorHandler;
}

/** 创建新会话时的可选参数。 */
export interface CreateSessionOptions {
	/** 会话的工作目录。 */
	cwd?: string;
	/** 会话名称。 */
	name?: string;
	/** 会话使用的模型。 */
	model?: ModelRef;
	/** 会话的思考级别。 */
	thinkingLevel?: ThinkingLevel;
}

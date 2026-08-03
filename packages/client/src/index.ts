/**
 * `@earendil-works/pi-client`：传输无关的远程会话客户端。
 * 通过 WebSocket / Unix socket 等字节传输连接远程会话服务器，并管理会话租约与操作 API。
 * 主客户端类 `PiClient` 是包对外的核心入口。
 */
export { PiClient } from "./client.ts";
/** 客户端相关的异常类型。 */
export {
	PiClientDisposedError,
	PiDisconnectedError,
	PiServerError,
	PiSessionDetachedError,
	PiSessionOwnershipError,
} from "./errors.ts";
/** 会话句柄及其租约相关类型。 */
export type { AcquireSessionOptions, PiSessionHandle, SessionLease, SessionLeaseMode } from "./session-handle.ts";
/** 字节传输层抽象类型，供自定义传输实现。 */
export type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";
/** 客户端配置、连接状态与订阅等共享类型。 */
export type {
	ConnectionState,
	ConnectionStateChange,
	CreateSessionOptions,
	ListenerErrorHandler,
	PiClientOptions,
	Unsubscribe,
} from "./types.ts";

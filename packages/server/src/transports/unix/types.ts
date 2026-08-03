import type { PiServerOptions } from "../../types.ts";

/** Unix domain socket 监听器的配置选项。 */
export interface UnixListenerOptions {
	/** Unix socket 的绑定路径。 */
	path: string;
	/** socket 文件系统权限，默认仅属主可读写（0o600）。 */
	mode?: number;
	/** 每个连接允许排队等待的最大字节数，超过后视为慢对端并断开。 */
	maxPendingBytes?: number;
	/** 优雅关闭的超时时长（毫秒）。 */
	gracefulCloseTimeoutMs?: number;
	/** 用于推导并校验 maxPendingBytes；自定义时必须与服务器保持一致。 */
	maxFrameLength?: number;
	/** 监听器错误回调。 */
	onError?: (error: Error) => void;
}

/** Unix server 的配置选项：继承 PiServerOptions（去除 listeners），并叠加 Unix 监听器选项。 */
export interface UnixServerOptions extends Omit<PiServerOptions, "listeners">, UnixListenerOptions {}

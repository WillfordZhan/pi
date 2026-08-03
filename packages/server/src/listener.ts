import type { ByteConnectionAcceptor } from "./connection.ts";

/** 传输监听器：负责向 PiServer 提供有序的字节连接（传输无关的抽象）。 */
export interface PiServerListener {
	/** 启动后监听器绑定的地址（若传输层有该概念），用于对外展示。 */
	readonly address?: string;
	/** 启动监听器，每当有新连接时调用 accept 回调。 */
	start(accept: ByteConnectionAcceptor): Promise<void>;
	/** 关闭监听器，停止接受新连接并释放资源。 */
	close(): Promise<void>;
}

import type { ByteConnectionAcceptor } from "./connection.ts";

/** Supplies established byte connections after any required transport authentication. */
export interface PiServerListener {
	/** 启动后监听器绑定的地址（若传输层有该概念），用于对外展示。 */
	readonly address?: string;
	/** Starts listening and passes authorized connections to accept. */
	start(accept: ByteConnectionAcceptor): Promise<void>;
	/** 关闭监听器，停止接受新连接并释放资源。 */
	close(): Promise<void>;
}

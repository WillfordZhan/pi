/**
 * 传输层抽象：连接管理器通过 `ByteTransport` 与具体的字节通道解耦，
 * 便于实现 WebSocket、Unix socket 等不同传输方式。
 */

/** 字节传输层抽象：负责按调用顺序发送字节块，并可在不再需要时被关闭。 */
export interface ByteTransport {
	/** 发送一个字节块。调用必须按调用顺序送达。 */
	send(chunk: Uint8Array): Promise<void>;
	/** 关闭传输层。实现必须保证重复调用是安全的（无副作用）。 */
	close(): void;
}

/** 传输层向连接管理器报告事件的一组回调。 */
export interface ByteTransportHandlers {
	/** 投递一个任意的入站字节块。 */
	onData(chunk: Uint8Array): void;
	/** 报告一次有序的终止性关闭（正常断开）。 */
	onClose(): void;
	/** 报告一次终止性的传输失败。 */
	onError(error: Error): void;
}

/** Creates a fresh connected, authenticated transport. Exactly one terminal handler is expected. */
export type ByteTransportFactory = (handlers: ByteTransportHandlers) => ByteTransport | Promise<ByteTransport>;

import { createConnection, type Socket } from "node:net";
import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

/** 不同平台上 Unix socket 路径的最大字节数（Linux 为 107，其余为 103）。 */
const MAX_UNIX_SOCKET_PATH_BYTES = process.platform === "linux" ? 107 : 103;

/** 创建 Unix socket 传输工厂时的配置选项。 */
export interface UnixTransportOptions {
	/** Unix socket 的路径。 */
	path: string;
	/** 未落盘（pending）字节的上限，用于背压保护。 */
	maxPendingBytes?: number;
}

/** 为 PiClient 连接尝试创建全新的 Unix-domain socket 传输层（适用于 Node 兼容运行时）。 */
export function createUnixTransportFactory(options: UnixTransportOptions): ByteTransportFactory {
	if (options.path.length === 0) throw new TypeError("Unix transport path must not be empty");
	if (Buffer.byteLength(options.path) > MAX_UNIX_SOCKET_PATH_BYTES) {
		throw new TypeError(`Unix transport path is too long; maximum is ${MAX_UNIX_SOCKET_PATH_BYTES} UTF-8 bytes`);
	}
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_FRAME_LENGTH * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new TypeError("Unix transport maxPendingBytes must be a positive safe integer");
	}
	if (process.platform === "win32") throw new Error("Unix transport is not supported on Windows");
	return (handlers) => connectUnixSocket(options.path, maxPendingBytes, handlers);
}

/** 建立到 Unix socket 的连接并包装为 `ByteTransport`；连接前失败会 reject。 */
function connectUnixSocket(
	path: string,
	maxPendingBytes: number,
	handlers: ByteTransportHandlers,
): Promise<ByteTransport> {
	return new Promise<ByteTransport>((resolve, reject) => {
		const socket = createConnection(path);
		let connected = false;
		let terminal = false;

		/** 关闭 socket：已连接则触发 onClose，尚未连接则 reject。 */
		const close = (): void => {
			if (terminal) return;
			terminal = true;
			socket.destroy();
			if (connected) handlers.onClose();
			else reject(new Error("Unix transport closed before connecting"));
		};

		socket.once("connect", () => {
			if (terminal) return;
			connected = true;
			resolve(
				new UnixByteTransport(socket, maxPendingBytes, () => {
					terminal = true;
				}),
			);
		});
		socket.on("data", (chunk) => {
			if (!terminal) handlers.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		});
		socket.once("end", close);
		socket.once("close", close);
		socket.once("error", (error) => {
			if (terminal) return;
			terminal = true;
			socket.destroy();
			if (connected) handlers.onError(error);
			else reject(error);
		});
	});
}

/** 基于 `node:net` Socket 的字节传输实现：带 pending 字节背压控制与写入串行化。 */
class UnixByteTransport implements ByteTransport {
	/** 底层 Node socket。 */
	readonly #socket: Socket;
	/** pending 字节上限。 */
	readonly #maxPendingBytes: number;
	/** 本地主动关闭时的回调（用于通知连接侧已置为终止态）。 */
	readonly #markLocalClose: () => void;
	/** 是否已关闭。 */
	#closed = false;
	/** 当前已发送但尚未写入完成的字节数。 */
	#pendingBytes = 0;
	/** 写入链尾部 promise，用于串行化各次写入。 */
	#writeTail: Promise<void> = Promise.resolve();

	/** @param socket 已连接的 Node socket；@param maxPendingBytes 背压上限；@param markLocalClose 本地关闭回调。 */
	constructor(socket: Socket, maxPendingBytes: number, markLocalClose: () => void) {
		this.#socket = socket;
		this.#maxPendingBytes = maxPendingBytes;
		this.#markLocalClose = markLocalClose;
	}

	/** 发送一个字节块；已关闭或超出 pending 上限时拒绝。 */
	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("Unix transport chunks must be Uint8Array"));
		}
		if (this.#closed) return Promise.reject(new Error("Unix transport is closed"));
		if (this.#pendingBytes + chunk.byteLength > this.#maxPendingBytes) {
			return Promise.reject(new Error("Unix transport exceeded its pending byte limit"));
		}
		this.#pendingBytes += chunk.byteLength;
		const bytes = chunk.slice();
		// 将本次写入排到写入链末尾，保证发送顺序与调用顺序一致。
		const write = this.#writeTail.then(() => this.#write(bytes));
		const tracked = write.finally(() => {
			this.#pendingBytes -= bytes.byteLength;
		});
		this.#writeTail = tracked.catch(() => {});
		return tracked;
	}

	/** 关闭传输层；幂等，可重复调用。 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#markLocalClose();
		this.#socket.destroy();
	}

	/** 真正执行一次写入：等待 socket 可写并处理 write 回调、drain 与 close 事件。 */
	#write(chunk: Uint8Array): Promise<void> {
		if (this.#closed || !this.#socket.writable) return Promise.reject(new Error("Unix transport is closed"));
		return new Promise<void>((resolve, reject) => {
			let callbackComplete = false;
			let drainComplete = false;
			let requiresDrain: boolean | undefined;
			let settled = false;

			// 缓冲区已排空，可以结算本次写入。
			const onDrain = (): void => {
				drainComplete = true;
				finish();
			};
			// 移除本次写入注册的事件监听，避免泄漏。
			const cleanup = (): void => {
				this.#socket.off("drain", onDrain);
				this.#socket.off("close", onClose);
			};
			// 写入失败时结算为 reject（仅一次）。
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			// 同时满足 write 回调完成与 drain 条件时才结算为成功。
			const finish = (): void => {
				if (settled || !callbackComplete || requiresDrain === undefined) return;
				if (requiresDrain && !drainComplete) return;
				settled = true;
				cleanup();
				resolve();
			};
			const onClose = (): void => fail(new Error("Unix transport closed during write"));

			try {
				this.#socket.once("close", onClose);
				const accepted = this.#socket.write(chunk, (error) => {
					if (error) {
						fail(error);
						return;
					}
					callbackComplete = true;
					finish();
				});
				requiresDrain = !accepted;
				if (requiresDrain) this.#socket.once("drain", onDrain);
				finish();
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
}

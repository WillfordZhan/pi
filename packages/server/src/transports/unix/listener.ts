import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, link, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";
import type { ByteConnection, ByteConnectionAcceptor } from "../../connection.ts";
import type { PiServerListener } from "../../listener.ts";
import type { UnixListenerOptions } from "./types.ts";

/** 默认的 socket 文件权限：仅属主可读写。 */
const DEFAULT_SOCKET_MODE = 0o600;
/** 默认的优雅关闭超时（毫秒）。 */
const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
/** uint32 最大值，用于校验帧长上限。 */
const MAX_UINT32 = 0xffff_ffff;
/** Node.js 定时器允许的最大延迟（毫秒）。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** 探测 stale socket 是否存活时的超时（毫秒）。 */
const SOCKET_PROBE_TIMEOUT_MS = 1_000;
/** Unix socket 路径的最大 UTF-8 字节数（Linux 为 107，其余平台为 103）。 */
const MAX_UNIX_SOCKET_PATH_BYTES = process.platform === "linux" ? 107 : 103;

/** 校验 Unix socket 路径：不能为空，且长度不超过平台上限。 */
export function validateUnixSocketPath(path: string, description = "Unix socket path"): void {
	if (!path) throw new TypeError(`${description} must not be empty`);
	if (Buffer.byteLength(path) > MAX_UNIX_SOCKET_PATH_BYTES) {
		throw new TypeError(`${description} is too long; maximum is ${MAX_UNIX_SOCKET_PATH_BYTES} UTF-8 bytes`);
	}
}

/** 规范化后的 Unix 监听器选项。 */
interface ResolvedUnixListenerOptions {
	path: string;
	mode: number;
	gracefulCloseTimeoutMs: number;
	maxPendingBytes: number;
	onError?: (error: Error) => void;
}

/** 文件系统身份标识（设备号 + inode），用于确认路径仍是当初绑定的那个 socket。 */
interface FileIdentity {
	dev: number;
	ino: number;
}
/** Unix domain socket 监听器：实现 PiServerListener，负责绑定 socket 并接受连接。 */
class UnixListener implements PiServerListener {
	/** 规范化后的选项。 */
	private readonly options: ResolvedUnixListenerOptions;
	/** 对外暴露的 socket 绑定路径（可能是链接后的最终路径）。 */
	private readonly path: string;
	/** socket 文件权限模式。 */
	private readonly mode: number;
	/** 当前活跃的 Unix 字节连接集合。 */
	private readonly connections = new Set<UnixByteConnection>();
	/** 底层 Node net.Server。 */
	private server?: Server;
	/** 绑定 socket 的身份标识，用于清理时安全确认。 */
	private socketIdentity?: FileIdentity;
	/** 实际创建并绑定的私有 socket 路径。 */
	private ownedBindPath?: string;
	/** 对外可用的绑定路径（设置后才对外暴露 address）。 */
	private boundPath?: string;
	/** 是否正在关闭。 */
	private closing = false;
	/** 已开始的关闭流程（幂等去重）。 */
	private closePromise?: Promise<void>;
	/** PiServer 传入的连接接受回调。 */
	private accept?: ByteConnectionAcceptor;

	/** @param options Unix 监听器配置（路径、模式、超时等）。 */
	constructor(options: UnixListenerOptions) {
		this.options = resolveUnixListenerOptions(options);
		this.path = this.options.path;
		this.mode = this.options.mode;
	}

	/** 对外暴露的绑定地址（启动成功后为 path）。 */
	get address(): string | undefined {
		return this.boundPath;
	}

	/** 启动监听：清理 stale socket、绑定私有路径、建立对外链接并设置权限。 */
	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.server) throw new Error("Unix listener is already started");
		if (this.closing) throw new Error("Unix listener is closing or closed");
		this.accept = accept;

		const ownedBindPath = getOwnedBindPath(this.path);
		validateUnixSocketPath(ownedBindPath, "PiServer private Unix bind path");
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await removeStaleSocket(this.path);
		await removeStaleSocket(ownedBindPath);
		this.ownedBindPath = ownedBindPath;
		const server = createServer((socket) => this.acceptSocket(socket));
		server.on("error", (error) => this.reportError(error));
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = (): void => {
					server.off("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(ownedBindPath);
			});
			const stats = await lstat(ownedBindPath);
			if (!stats.isSocket()) throw new Error(`Unix listener path is not a socket after binding: ${ownedBindPath}`);
			this.socketIdentity = { dev: stats.dev, ino: stats.ino };
			await link(ownedBindPath, this.path);
			await setSocketMode(this.path, this.mode);
			this.boundPath = this.path;
		} catch (error) {
			await this.closeServerAndCleanup(server);
			this.server = undefined;
			throw error;
		}
	}

	/** 关闭监听器（幂等）：关闭服务器与所有连接，并清理 socket 文件。 */
	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	/** 接受一个新 socket：包装为 UnixByteConnection，交给 accept 回调并绑定数据/关闭事件。 */
	private acceptSocket(socket: Socket): void {
		if (this.closing) {
			socket.destroy();
			return;
		}
		const connection = new UnixByteConnection(
			socket,
			this.options.gracefulCloseTimeoutMs,
			this.options.maxPendingBytes,
		);
		this.connections.add(connection);
		const accept = this.accept;
		if (!accept) {
			socket.destroy();
			return;
		}
		const handler = accept(connection);
		socket.on("data", (chunk) => {
			handler.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		});
		socket.on("error", (error) => {
			handler.onError(error);
			socket.destroy();
		});
		socket.once("close", () => {
			connection.markClosed();
			this.connections.delete(connection);
			handler.onClose();
		});
	}

	/** 关闭内部实现：关闭服务器与连接、移除私有路径并清理 socket 文件。 */
	private async closeInternal(): Promise<void> {
		this.boundPath = undefined;
		const serverClosed = this.server ? this.closeServerAndCleanup(this.server) : this.cleanupOwnedSocket();
		await Promise.all([...this.connections].map((connection) => connection.close()));
		await serverClosed;
		if (this.ownedBindPath) await removePath(this.ownedBindPath);
		this.ownedBindPath = undefined;
		this.connections.clear();
		this.server = undefined;
	}

	/** 关闭 net.Server 并清理它留下的 socket 文件（关闭失败仅上报错误）。 */
	private async closeServerAndCleanup(server: Server): Promise<void> {
		try {
			await closeNetServer(server, (error) => this.reportError(error));
		} finally {
			await this.cleanupOwnedSocket();
			if (this.ownedBindPath) await removePath(this.ownedBindPath);
			this.ownedBindPath = undefined;
		}
	}

	/** 清理对外链接路径：仅当该路径仍是本监听器当初绑定的 socket 时才删除。 */
	private async cleanupOwnedSocket(): Promise<void> {
		const identity = this.socketIdentity;
		this.socketIdentity = undefined;
		if (!identity) return;
		let current: Stats;
		try {
			current = await lstat(this.path);
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) return;
			throw error;
		}
		if (!current.isSocket() || current.dev !== identity.dev || current.ino !== identity.ino) return;

		const preserved = join(dirname(this.path), `.c-${randomUUID().slice(0, 6)}`);
		try {
			await rename(this.path, preserved);
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) return;
			throw error;
		}
		const moved = await lstat(preserved);
		if (moved.isSocket() && moved.dev === identity.dev && moved.ino === identity.ino) {
			await removePath(preserved);
			return;
		}
		try {
			await lstat(this.path);
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) await rename(preserved, this.path);
			else throw error;
		}
		throw new Error(`Unix listener path changed during cleanup; preserved replacement at ${preserved}`);
	}

	/** 上报错误给 onError 回调；错误观察者的异常不能影响监听器状态。 */
	private reportError(error: unknown): void {
		try {
			this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// 错误观察者不得影响监听器状态。
		}
	}
}

/** @internal 仅导出用于传输层验证。 */
export class UnixByteConnection implements ByteConnection {
	/** 底层 net.Socket。 */
	private readonly socket: Socket;
	/** 优雅关闭超时（毫秒）。 */
	private readonly gracefulCloseTimeoutMs: number;
	/** 允许排队等待的最大字节数。 */
	private readonly maxPendingBytes: number;
	/** 当前排队（尚未写完）的字节数。 */
	private pendingBytes = 0;
	/** 是否已关闭。 */
	private closedValue = false;
	/** 是否正在关闭。 */
	private closing = false;
	/** 写队列尾部的 Promise 链，保证写入按序串行。 */
	private writeTail: Promise<void> = Promise.resolve();
	/** 已开始的关闭流程（幂等去重）。 */
	private closePromise?: Promise<void>;
	/** 关闭完成时调用的 resolve 回调。 */
	private resolveClose?: () => void;

	/**
	 * @param socket                 底层 net.Socket。
	 * @param gracefulCloseTimeoutMs 优雅关闭超时（毫秒）。
	 * @param maxPendingBytes        排队字节上限。
	 */
	constructor(socket: Socket, gracefulCloseTimeoutMs: number, maxPendingBytes: number) {
		this.socket = socket;
		this.gracefulCloseTimeoutMs = gracefulCloseTimeoutMs;
		this.maxPendingBytes = maxPendingBytes;
	}

	/** 是否已关闭。 */
	get closed(): boolean {
		return this.closedValue;
	}

	/** 发送一个字节块：串行写入并受排队字节上限约束。 */
	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("Unix connection chunks must be Uint8Array"));
		}
		if (this.closedValue || this.closing) return Promise.reject(new Error("Unix connection is closed"));
		if (this.pendingBytes + chunk.byteLength > this.maxPendingBytes) {
			return Promise.reject(new Error("Unix connection exceeded its pending byte limit"));
		}
		this.pendingBytes += chunk.byteLength;
		const bytes = chunk.slice();
		const write = this.writeTail.then(() => this.write(bytes));
		const tracked = write.finally(() => {
			this.pendingBytes -= bytes.byteLength;
		});
		this.writeTail = tracked.catch(() => {});
		return tracked;
	}

	/** 优雅关闭连接：排空写队列后发送最终块并 end，超时则强制销毁。 */
	close(finalChunk?: Uint8Array): Promise<void> {
		if (this.closedValue || this.socket.destroyed) {
			this.markClosed();
			return Promise.resolve();
		}
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		const finalBytes = finalChunk?.slice();
		this.closePromise = new Promise<void>((resolve) => {
			this.resolveClose = resolve;
			const timer = setTimeout(() => {
				if (!this.socket.destroyed) this.socket.destroy();
				this.markClosed();
			}, this.gracefulCloseTimeoutMs);
			timer.unref();
			this.socket.once("close", () => clearTimeout(timer));
			void this.writeTail.then(() => {
				if (this.socket.destroyed) {
					this.markClosed();
					return;
				}
				try {
					if (finalBytes) this.socket.end(finalBytes);
					else this.socket.end();
				} catch {
					this.socket.destroy();
				}
			});
		});
		return this.closePromise;
	}

	/** 标记连接为已关闭，并完成等待中的关闭 Promise。 */
	markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closing = true;
		this.resolveClose?.();
		this.resolveClose = undefined;
	}

	/** 实际写入 socket：写完成或连接中途关闭时结束 Promise。 */
	private write(chunk: Uint8Array): Promise<void> {
		if (this.closedValue || this.closing || !this.socket.writable) {
			return Promise.reject(new Error("Unix connection is closed"));
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const onClose = (): void => finish(new Error("Unix connection closed during write"));
			const finish = (error?: Error | null): void => {
				if (settled) return;
				settled = true;
				this.socket.off("close", onClose);
				if (error) reject(error);
				else resolve();
			};
			this.socket.once("close", onClose);
			try {
				this.socket.write(chunk, finish);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
}

/** 为给定路径生成私有绑定路径（同目录下以 `.p-` 开头的哈希后缀文件）。 */
function getOwnedBindPath(path: string): string {
	const suffix = createHash("sha256").update(path).digest("hex").slice(0, 8);
	return join(dirname(path), `.p-${suffix}`);
}

/** 移除一个 stale 的 socket 文件：先确认它是 socket 且无人监听，再安全地改名删除。 */
async function removeStaleSocket(path: string): Promise<void> {
	let original: Stats;
	try {
		original = await lstat(path);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return;
		throw error;
	}
	if (!original.isSocket()) throw new Error(`Refusing to remove non-socket Unix listener path: ${path}`);
	if (await isSocketLive(path)) throw new Error(`Unix listener is already running: ${path}`);

	const preserved = join(dirname(path), `.s-${randomUUID().slice(0, 6)}`);
	try {
		await rename(path, preserved);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return;
		throw error;
	}
	const current = await lstat(preserved);
	if (!current.isSocket() || current.dev !== original.dev || current.ino !== original.ino) {
		try {
			await lstat(path);
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) await rename(preserved, path);
			else throw error;
		}
		throw new Error(`Unix listener path changed while checking for a stale socket: ${path}`);
	}
	await removePath(preserved);
}

/** 删除文件；文件不存在时静默忽略。 */
async function removePath(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
}

/** 探测路径上的 socket 是否仍被监听（可连接即视为存活），用于判断 stale socket。 */
function isSocketLive(path: string): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const socket = createConnection(path);
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (result: boolean, error?: Error): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			socket.removeAllListeners();
			socket.destroy();
			if (error) reject(error);
			else resolve(result);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (["ECONNREFUSED", "ENOENT", "EPIPE", "ECONNRESET"].includes(error.code ?? "")) {
				finish(false);
				return;
			}
			finish(false, error);
		});
		timer = setTimeout(() => finish(true), SOCKET_PROBE_TIMEOUT_MS);
		timer.unref();
	});
}

/** 设置 socket 文件的权限位（Windows 直接跳过，不支持 chmod 的平台静默忽略）。 */
async function setSocketMode(path: string, mode: number): Promise<void> {
	if (process.platform === "win32") return;
	try {
		await chmod(path, mode);
	} catch (error) {
		if (!isErrorCode(error, "ENOSYS") && !isErrorCode(error, "ENOTSUP")) throw error;
	}
}

/** 关闭一个 net.Server 并等待回调；关闭错误通过 reportError 上报。 */
function closeNetServer(server: Server, reportError: (error: Error) => void): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise<void>((resolve) => {
		server.close((error) => {
			if (error) reportError(error);
			resolve();
		});
	});
}

/** 判断错误是否带有所给错误码。 */
function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

/** 创建并返回一个 Unix domain socket 监听器（实现 {@link PiServerListener}）。 */
export function createUnixListener(options: UnixListenerOptions): PiServerListener {
	return new UnixListener(options);
}

/** 校验并规范化 Unix 监听器选项（路径、模式、帧长、排队上限、优雅关闭超时）。 */
function resolveUnixListenerOptions(options: UnixListenerOptions): ResolvedUnixListenerOptions {
	validateUnixSocketPath(options.path, "PiServer Unix socket path");
	const mode = options.mode ?? DEFAULT_SOCKET_MODE;
	if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
		throw new TypeError("PiServer Unix socket mode must be an integer between 0 and 0o777");
	}
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
		throw new TypeError(`PiServer maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
	}
	const maxPendingBytes = options.maxPendingBytes ?? maxFrameLength * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < maxFrameLength + 4) {
		throw new TypeError("PiServer maxPendingBytes must be a safe integer at least maxFrameLength + 4");
	}
	const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(gracefulCloseTimeoutMs) ||
		gracefulCloseTimeoutMs <= 0 ||
		gracefulCloseTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new TypeError(`PiServer gracefulCloseTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}
	return {
		path: options.path,
		mode,
		maxPendingBytes,
		gracefulCloseTimeoutMs,
		onError: options.onError,
	};
}

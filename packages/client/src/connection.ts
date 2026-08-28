import {
	DEFAULT_MAX_FRAME_LENGTH,
	encodeClientMessage,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type ServerMessage,
	ServerMessageDecoder,
	type ServerSnapshot,
} from "@earendil-works/pi-protocol";
import { PiDisconnectedError, PiServerError, toDisconnectedError, toError } from "./errors.ts";
import { createPromiseResolvers, type PromiseResolvers } from "./promise.ts";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";
import type { ConnectionState, ConnectionStateChange } from "./types.ts";

/** 32 位无符号整数的最大值，用于校验 `maxFrameLength`。 */
const MAX_UINT32 = 0xffff_ffff;

/** 活跃连接的信息：连接序号、消息解码器与可选的传输层。 */
type ActiveConnection = {
	/** 连接序号，用于丢弃过期连接产生的回调。 */
	id: number;
	/** 服务端消息解码器。 */
	decoder: ServerMessageDecoder;
	/** 底层字节传输层，在发送客户端 hello 之前可能尚未就绪。 */
	transport?: ByteTransport;
};

/** 连接生命周期状态机：未连接 / 连接中 / 已连接。 */
type ConnectionLifecycle =
	| { state: "disconnected" }
	| ({ state: "connecting"; handshake: PromiseResolvers<ServerSnapshot> } & ActiveConnection)
	| ({
			state: "connected";
			transport: ByteTransport;
			handshake: PromiseResolvers<ServerSnapshot> | undefined;
	  } & ActiveConnection);

/** Connection 的构造选项。 */
interface ConnectionOptions {
	transportFactory: ByteTransportFactory;
	/** 单帧最大长度（字节），缺省时使用协议默认值。 */
	maxFrameLength?: number;
	/** 握手成功后回调，携带服务端快照。 */
	onHandshake(snapshot: ServerSnapshot): void;
	/** 收到业务消息时回调。 */
	onMessage(message: Exclude<ServerMessage, { type: "hello" | "hello_error" }>): void;
	/** 连接状态变更时回调。 */
	onStateChange(change: ConnectionStateChange): void;
}

/** 管理一条到远程会话服务器的连接：负责握手、消息编解码与生命周期状态切换。 */
export class Connection {
	/** 构造选项。 */
	readonly #options: ConnectionOptions;
	/** 帧长度上限，用于编解码校验。 */
	readonly #maxFrameLength: number;
	/** 当前生命周期状态。 */
	#lifecycle: ConnectionLifecycle = { state: "disconnected" };
	/** 连接序号计数器。 */
	#sequence = 0;

	/** 校验 `maxFrameLength` 合法后保存配置。 */
	constructor(options: ConnectionOptions) {
		this.#options = options;
		this.#maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
		if (
			!Number.isSafeInteger(this.#maxFrameLength) ||
			this.#maxFrameLength <= 0 ||
			this.#maxFrameLength > MAX_UINT32
		) {
			throw new TypeError(`PiClient maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
		}
	}

	/** 当前连接状态。 */
	get state(): ConnectionState {
		return this.#lifecycle.state;
	}

	/** 帧长度上限。 */
	get maxFrameLength(): number {
		return this.#maxFrameLength;
	}

	/** 发起连接：创建解码器与握手 promise、打开传输层并发送 hello，返回握手快照的 promise。 */
	connect(): Promise<ServerSnapshot> {
		if (this.#lifecycle.state !== "disconnected") {
			return Promise.reject(new PiDisconnectedError(`PiClient is already ${this.#lifecycle.state}`));
		}
		const id = ++this.#sequence;
		const handshake = createPromiseResolvers<ServerSnapshot>();
		this.#lifecycle = {
			state: "connecting",
			id,
			decoder: new ServerMessageDecoder({ maxFrameLength: this.#maxFrameLength }),
			handshake,
		};
		this.#options.onStateChange({ state: "connecting" });
		const handlers = {
			onData: (chunk) => this.#handleData(id, chunk),
			onClose: () => {
				if (this.#isCurrent(id)) this.#handleClose();
			},
			onError: (error) => {
				if (this.#isCurrent(id)) this.#failAndClose(toDisconnectedError(error));
			},
		} satisfies ByteTransportHandlers;
		void this.#openTransport(id, handlers);
		return handshake.promise;
	}

	/** 主动断开连接（可携带原因字符串或错误对象）。 */
	disconnect(reason: string | Error = "Client disconnected"): void {
		if (this.#lifecycle.state === "disconnected") return;
		this.#failAndClose(typeof reason === "string" ? new PiDisconnectedError(reason) : reason);
	}

	/** 使连接失败并进入断开状态（由协议校验等场景触发）。 */
	fail(error: Error): void {
		this.#failAndClose(error);
	}

	/** 发送一个已编码的帧；未连接时抛错，异步失败时也会使连接失败。 */
	send(frame: Uint8Array): void {
		const lifecycle = this.#lifecycle;
		if (lifecycle.state !== "connected") throw new PiDisconnectedError();
		let sending: Promise<void>;
		try {
			sending = lifecycle.transport.send(frame);
		} catch (error) {
			this.#failAndClose(toDisconnectedError(error));
			return;
		}
		void sending.catch((error: unknown) => {
			const current = this.#lifecycle;
			if (current.state !== "disconnected" && current.transport === lifecycle.transport) {
				this.#failAndClose(toDisconnectedError(error));
			}
		});
	}

	/** 打开底层传输层并发送客户端 hello；异步完成后校验连接是否仍然有效。 */
	async #openTransport(id: number, handlers: ByteTransportHandlers): Promise<void> {
		let transport: ByteTransport;
		try {
			transport = await this.#options.transportFactory(handlers);
		} catch (error) {
			if (this.#isCurrent(id)) this.#fail(toDisconnectedError(error));
			return;
		}
		const lifecycle = this.#lifecycle;
		if (lifecycle.state !== "connecting" || lifecycle.id !== id) {
			transport.close();
			return;
		}
		this.#lifecycle = { ...lifecycle, transport };
		try {
			await transport.send(
				encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION }, { maxFrameLength: this.#maxFrameLength }),
			);
		} catch (error) {
			if (this.#isCurrent(id)) this.#failAndClose(toDisconnectedError(error));
		}
	}

	/** 处理传输层投递的字节块：解码为消息后逐条派发。 */
	#handleData(id: number, chunk: Uint8Array): void {
		const lifecycle = this.#lifecycle;
		if (lifecycle.state === "disconnected" || lifecycle.id !== id) return;
		if (lifecycle.state === "connecting" && !lifecycle.transport) {
			this.#failAndClose(new ProtocolValidationError("Received server data before the client hello was sent"));
			return;
		}
		let messages: ServerMessage[];
		try {
			messages = lifecycle.decoder.push(chunk);
		} catch (error) {
			this.#failAndClose(toError(error));
			return;
		}
		for (const message of messages) {
			if (this.#lifecycle.state === "disconnected") return;
			this.#handleMessage(message);
		}
	}

	/** 处理单条服务端消息：推进握手流程，或在已连接状态下交给上层。 */
	#handleMessage(message: ServerMessage): void {
		const lifecycle = this.#lifecycle;
		if (lifecycle.state === "connecting") {
			if (message.type === "hello_error") {
				this.#failAndClose(new PiServerError(message.error));
				return;
			}
			if (message.type !== "hello") {
				this.#failAndClose(new ProtocolValidationError("Expected server hello as first message"));
				return;
			}
			if (!lifecycle.transport) {
				this.#failAndClose(new ProtocolValidationError("Received server hello before the client hello was sent"));
				return;
			}
			const connected = {
				state: "connected",
				id: lifecycle.id,
				decoder: lifecycle.decoder,
				transport: lifecycle.transport,
				handshake: lifecycle.handshake,
			} satisfies Extract<ConnectionLifecycle, { state: "connected" }>;
			this.#lifecycle = connected;
			try {
				this.#options.onHandshake(message.snapshot);
			} catch (error) {
				if (this.#lifecycle === connected) this.#failAndClose(toError(error));
				return;
			}
			if (this.#lifecycle !== connected) return;
			this.#options.onStateChange({ state: "connected" });
			if (this.#lifecycle !== connected) return;
			this.#lifecycle = { ...connected, handshake: undefined };
			lifecycle.handshake.resolve(message.snapshot);
			return;
		}
		if (lifecycle.state !== "connected") return;
		if (message.type === "hello" || message.type === "hello_error") {
			this.#failAndClose(new ProtocolValidationError("Unexpected handshake message"));
			return;
		}
		this.#options.onMessage(message);
	}

	/** 传输层正常关闭时触发：尝试结束解码器，并使当前连接失败。 */
	#handleClose(): void {
		const lifecycle = this.#lifecycle;
		if (lifecycle.state === "disconnected") return;
		let error: Error = new PiDisconnectedError("Byte transport closed");
		try {
			lifecycle.decoder.end();
		} catch (decoderError) {
			error = toError(decoderError);
		}
		this.#fail(error);
	}

	/** 使当前连接失败并关闭底层传输层。 */
	#failAndClose(error: Error): void {
		const lifecycle = this.#lifecycle;
		const transport = lifecycle.state === "disconnected" ? undefined : lifecycle.transport;
		this.#fail(error);
		transport?.close();
	}

	/** 将生命周期置为断开：拒绝挂起的握手并广播状态变更。 */
	#fail(error: Error): void {
		const lifecycle = this.#lifecycle;
		if (lifecycle.state === "disconnected") return;
		this.#lifecycle = { state: "disconnected" };
		lifecycle.handshake?.reject(error);
		this.#options.onStateChange({ state: "disconnected", error });
	}

	/** 判断给定序号是否仍是当前连接（用于忽略过期连接的回调）。 */
	#isCurrent(id: number): boolean {
		return this.#lifecycle.state !== "disconnected" && this.#lifecycle.id === id;
	}
}

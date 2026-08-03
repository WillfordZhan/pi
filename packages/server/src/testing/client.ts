import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import {
	type ClientMessage,
	type Command,
	encodeClientMessage,
	PROTOCOL_VERSION,
	type ResponseEnvelope,
	type ServerMessage,
	ServerMessageDecoder,
} from "@earendil-works/pi-protocol";
import { Deferred, TEST_TOKEN } from "./backend.ts";

/** 等待某条匹配消息的等待者记录。 */
interface MessageWaiter {
	/** 匹配谓词：返回 true 即命中。 */
	predicate: (message: ServerMessage) => boolean;
	/** 命中后 resolve 收到的消息。 */
	resolve: (message: ServerMessage) => void;
	/** 连接失败/关闭时 reject。 */
	reject: (error: Error) => void;
}

/** 测试客户端使用的底层字节通道抽象。 */
export interface WireChannel {
	/** 发送一个原始字节块。 */
	send(chunk: Uint8Array): Promise<void>;
	/** 将一个字节块分成两段发送（用于测试粘包/半包处理）。 */
	sendFragmented(chunk: Uint8Array, splitAt: number): Promise<void>;
	/** 关闭通道。 */
	close(): Promise<void>;
}

/** 协议测试客户端：维护解码器与消息等待队列，用于对服务器行为做确定性断言。 */
export class ProtocolTestClient {
	/** 已收到的全部服务器消息（按序累积）。 */
	readonly messages: ServerMessage[] = [];
	/** 底层字节通道。 */
	private readonly channel: WireChannel;
	/** 服务器消息解码器。 */
	private readonly decoder = new ServerMessageDecoder();
	/** 等待中的消息等待者集合。 */
	private readonly waiters = new Set<MessageWaiter>();
	/** 关闭完成时 resolve 的 Deferred。 */
	private readonly closedDeferred = new Deferred<void>();
	/** 请求序号，用于生成唯一请求 ID。 */
	private requestSequence = 0;
	/** 是否已关闭。 */
	private closedValue = false;

	/** @param channel 底层字节通道（通常来自 connectUnixTestClient）。 */
	constructor(channel: WireChannel) {
		this.channel = channel;
	}

	/** 是否已关闭。 */
	get closed(): boolean {
		return this.closedValue;
	}

	/** 发送 hello 并等待服务器的 hello/hello_error 响应。 */
	hello(token = TEST_TOKEN, version: number = PROTOCOL_VERSION): Promise<ServerMessage> {
		const response = this.next((message) => message.type === "hello" || message.type === "hello_error");
		void this.sendMessage({ type: "hello", token, version });
		return response;
	}

	/** 发送一个会话命令请求，并等待同 ID 的响应。 */
	async request(command: Command, id = `request-${++this.requestSequence}`): Promise<ResponseEnvelope> {
		const response = this.next(
			(message): message is ResponseEnvelope => message.type === "response" && message.id === id,
		);
		await this.sendMessage({ type: "request", id, request: command });
		return (await response) as ResponseEnvelope;
	}

	/** 编码并发送一条客户端消息。 */
	sendMessage(message: ClientMessage): Promise<void> {
		return this.channel.send(encodeClientMessage(message));
	}

	/** 发送原始字节（用于测试非法帧等场景）。 */
	sendBytes(chunk: Uint8Array): Promise<void> {
		return this.channel.send(chunk);
	}

	/** 将消息编码后分两段发送（用于测试分帧处理）。 */
	sendFragmentedMessage(message: ClientMessage, splitAt: number): Promise<void> {
		return this.channel.sendFragmented(encodeClientMessage(message), splitAt);
	}

	/** 从全部已收消息中查找下一条匹配消息；未收到则排队等待。 */
	next(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		return this.nextFrom(0, predicate);
	}

	/** 从指定下标起查找匹配消息；未收到则排队等待（连接关闭会 reject）。 */
	nextFrom(index: number, predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		const existing = this.messages.slice(index).find(predicate);
		if (existing) return Promise.resolve(existing);
		if (this.closedValue) return Promise.reject(new Error("Wire client is closed"));
		return new Promise((resolve, reject) => this.waiters.add({ predicate, resolve, reject }));
	}

	/** 等待底层连接关闭。 */
	waitForClose(): Promise<void> {
		return this.closedValue ? Promise.resolve() : this.closedDeferred.promise;
	}

	/** 关闭底层通道。 */
	close(): Promise<void> {
		return this.channel.close();
	}

	/** 接收字节块：解码成消息后按等待者谓词分发。 */
	receive(chunk: Uint8Array): void {
		try {
			for (const message of this.decoder.push(chunk)) {
				this.messages.push(message);
				for (const waiter of this.waiters) {
					if (!waiter.predicate(message)) continue;
					this.waiters.delete(waiter);
					waiter.resolve(message);
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/** 标记底层连接已关闭，并让所有等待者失败。 */
	markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closedDeferred.resolve(undefined);
		this.fail(new Error("Wire connection closed"));
	}

	/** 让所有等待者以指定错误失败并清空队列。 */
	fail(error: Error): void {
		for (const waiter of this.waiters) waiter.reject(error);
		this.waiters.clear();
	}
}

/** 连接一个 Unix domain socket 并返回就绪的协议测试客户端。 */
export async function connectUnixTestClient(path: string): Promise<ProtocolTestClient> {
	const socket = createConnection(path);
	await once(socket, "connect");
	const client = new ProtocolTestClient({
		send: (chunk) => writeSocket(socket, chunk),
		async sendFragmented(chunk, splitAt) {
			await writeSocket(socket, chunk.subarray(0, splitAt));
			await writeSocket(socket, chunk.subarray(splitAt));
		},
		async close() {
			if (socket.destroyed) return;
			const closed = once(socket, "close");
			socket.destroy();
			await closed;
		},
	});
	socket.on("data", (chunk) => {
		client.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
	});
	socket.on("error", (error) => client.fail(error));
	socket.once("close", () => client.markClosed());
	return client;
}

/** 向 socket 写入一个字节块，写完成或出错时结束 Promise。 */
function writeSocket(socket: Socket, chunk: Uint8Array): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		socket.write(chunk, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

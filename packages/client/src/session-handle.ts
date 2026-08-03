import type {
	Command,
	ModelRef,
	ResultForCommand,
	ServerEvent,
	SessionSnapshot,
	ThinkingLevel,
} from "@earendil-works/pi-protocol";
import type { Unsubscribe } from "./types.ts";

/** 需要携带会话 ID 才能执行的命令类型。 */
type SessionCommand = Extract<Command, { sessionId: string }>;

/** 会话租约模式：`shared` 允许多个租约共享同一会话，`exclusive` 独占该会话。 */
export type SessionLeaseMode = "shared" | "exclusive";

/** 申请会话租约时的选项（当前仅包含租约模式）。 */
export interface AcquireSessionOptions {
	mode: SessionLeaseMode;
}

/** 会话租约：代表对一个远端会话的持有，可订阅、发送命令并在结束时释放。 */
export interface SessionLease extends AsyncDisposable {
	/** 会话 ID。 */
	readonly id: string;
	/** 会话当前是否可用（是否仍持有有效租约）。 */
	readonly active: boolean;
	/** 会话当前是否处于附加（attached）状态。 */
	readonly attached: boolean;
	/** 会话最近一次的快照，尚未获取到时为 undefined。 */
	readonly snapshot: SessionSnapshot | undefined;
	/** 订阅该会话的快照更新。 */
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	/** 订阅该会话的事件。 */
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
	/** 释放租约但不销毁会话（之后可重新申请）。 */
	detach(): Promise<void>;
	/** 释放租约并结束对会话的使用。 */
	dispose(): Promise<void>;
	/** 向会话发送 prompt 提示，返回更新后的快照。 */
	prompt(text: string): Promise<SessionSnapshot>;
	/** 向会话发送 steer 指令（引导现有上下文），返回更新后的快照。 */
	steer(text: string): Promise<SessionSnapshot>;
	/** 中止会话当前的活动，返回更新后的快照。 */
	abort(): Promise<SessionSnapshot>;
	/** 切换会话使用的模型，返回更新后的快照。 */
	setModel(model: ModelRef): Promise<SessionSnapshot>;
	/** 设置会话的思考级别，返回更新后的快照。 */
	setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot>;
}

/** `PiSessionHandle` 是 `SessionLease` 的别名，即客户端暴露给用户的会话句柄。 */
export type PiSessionHandle = SessionLease;

/** 会话句柄内部的一组回调，具体实现由 `PiClient` 注入。 */
export interface SessionHandleCallbacks {
	/** 会话是否仍处于附加状态。 */
	isAttached(): boolean;
	/** 获取会话最近一次的快照。 */
	getSnapshot(): SessionSnapshot | undefined;
	/** 订阅会话快照更新。 */
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe;
	/** 订阅会话事件。 */
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe;
	/** 释放租约但不销毁会话。 */
	detach(): Promise<void>;
	/** 释放租约并结束对会话的使用。 */
	dispose(): Promise<void>;
	/** 发送一条需要会话 ID 的命令并等待结果。 */
	request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>>;
}

/** 会话句柄的默认实现：将全部操作委托给 `PiClient` 提供的回调。 */
export class SessionHandle implements SessionLease {
	/** 会话 ID。 */
	readonly id: string;
	/** 指向客户端实现的操作回调。 */
	readonly #callbacks: SessionHandleCallbacks;

	/** @param id 会话 ID；@param callbacks 由 `PiClient` 注入的操作回调。 */
	constructor(id: string, callbacks: SessionHandleCallbacks) {
		this.id = id;
		this.#callbacks = callbacks;
	}

	/** 会话是否仍处于附加状态。 */
	get attached(): boolean {
		return this.#callbacks.isAttached();
	}

	/** 会话是否可用（等价于 attached）。 */
	get active(): boolean {
		return this.attached;
	}

	/** 会话最近一次的快照。 */
	get snapshot(): SessionSnapshot | undefined {
		return this.#callbacks.getSnapshot();
	}

	/** 订阅会话快照更新，返回取消订阅函数。 */
	subscribe(listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		return this.#callbacks.subscribe(listener);
	}

	/** 订阅会话事件，返回取消订阅函数。 */
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		return this.#callbacks.onEvent(listener);
	}

	/** 释放租约但不销毁会话。 */
	async detach(): Promise<void> {
		await this.#callbacks.detach();
	}

	/** 释放租约并结束对会话的使用。 */
	dispose(): Promise<void> {
		return this.#callbacks.dispose();
	}

	/** 支持 `await using` 语法，在作用域结束时自动释放。 */
	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	/** 向会话发送 prompt 提示，返回更新后的快照。 */
	async prompt(text: string): Promise<SessionSnapshot> {
		return (await this.#request({ command: "prompt", sessionId: this.id, text })).session;
	}

	/** 向会话发送 steer 指令，返回更新后的快照。 */
	async steer(text: string): Promise<SessionSnapshot> {
		return (await this.#request({ command: "steer", sessionId: this.id, text })).session;
	}

	/** 中止会话当前的活动，返回更新后的快照。 */
	async abort(): Promise<SessionSnapshot> {
		return (await this.#request({ command: "abort", sessionId: this.id })).session;
	}

	/** 切换会话使用的模型，返回更新后的快照。 */
	async setModel(model: ModelRef): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_model", sessionId: this.id, model })).session;
	}

	/** 设置会话的思考级别，返回更新后的快照。 */
	async setThinking(thinkingLevel: ThinkingLevel): Promise<SessionSnapshot> {
		return (await this.#request({ command: "set_thinking", sessionId: this.id, thinkingLevel })).session;
	}

	/** 发送需要会话 ID 的命令，交由客户端实现处理。 */
	#request<const TCommand extends SessionCommand>(command: TCommand): Promise<ResultForCommand<TCommand>> {
		return this.#callbacks.request(command);
	}
}

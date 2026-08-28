import type {
	Command,
	ModelMetadata,
	ModelRef,
	SessionMetadata,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import type { PiServerError } from "./errors.ts";
import type { PiServerListener } from "./listener.ts";

/** 构造 {@link PiServer} 时的配置选项。 */
export interface PiServerOptions {
	listeners: readonly PiServerListener[];
	/** 单帧消息的最大长度限制，默认由协议库决定。 */
	maxFrameLength?: number;
	/** 握手超时时长（毫秒），默认 5000。 */
	handshakeTimeoutMs?: number;
	/** 服务器实例 ID；未指定时自动生成 UUID。 */
	serverId?: string;
	/** 全局错误回调，用于上报非致命异常。 */
	onError?: (error: Error) => void;
}

/** 值或该值的 Promise，用于同步/异步均可的后端方法返回类型。 */
export type MaybePromise<T> = T | Promise<T>;

/** prompt 命令去掉命令名与 sessionId 后的输入部分。 */
export type PromptInput = Omit<Extract<Command, { command: "prompt" }>, "command" | "sessionId">;
/** steer 命令去掉命令名与 sessionId 后的输入部分。 */
export type SteerInput = Omit<Extract<Command, { command: "steer" }>, "command" | "sessionId">;

/** 创建会话时传给后端选项。 */
export interface CreateSessionOptions {
	/** A collision-resistant ID assigned by PiServer. The service must persist this exact ID. */
	id: string;
	/** 会话工作目录。 */
	cwd?: string;
	/** 会话名称。 */
	name?: string;
	/** 会话使用的模型。 */
	model?: ModelRef;
	/** 会话使用的思考级别。 */
	thinkingLevel?: ThinkingLevel;
}

/** 会话运行时发出的事件类型。 */
export type PiSessionRuntimeEvent =
	| { type: "snapshot" }
	| { type: "progress"; progress: TranscriptProgress }
	| { type: "error"; error: PiServerError };

/** 一个已获取独占权的持久会话。冲突操作必须拒绝（reject）而不是排队等待。 */
export interface PiSessionRuntime {
	/** 返回当前会话快照。 */
	snapshot(): MaybePromise<SessionSnapshot>;
	/** 返回当前会话阶段。 */
	getPhase(): SessionPhase;
	/** 发起一次 prompt（要求会话空闲）。 */
	prompt(input: PromptInput): Promise<void>;
	/** 在运行中的 prompt 中插入引导（要求会话非空闲）。 */
	steer(input: SteerInput): Promise<void>;
	/** 中止当前 prompt。 */
	abort(): Promise<void>;
	/** 切换会话模型（要求会话空闲）。 */
	setModel(model: ModelRef): Promise<void>;
	/** 切换思考级别（要求会话空闲）。 */
	setThinking(thinkingLevel: ThinkingLevel): Promise<void>;
	/** 订阅运行时事件，返回取消订阅函数。 */
	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void;
	/** 释放运行时占用的资源。 */
	dispose(): Promise<void>;
}

/** Service boundary for durable sessions and exclusively acquired runtimes. */
export interface PiServerService {
	listSessions(): Promise<SessionMetadata[]>;
	listModels(): Promise<ModelMetadata[]>;
	/** 创建一个新会话并返回其独占运行时。 */
	createSession(options: CreateSessionOptions): Promise<PiSessionRuntime>;
	/** 打开一个已存在的会话并返回其独占运行时。 */
	openSession(sessionId: string): Promise<PiSessionRuntime>;
}

/** {@link PiSessionRuntime} 的别名。 */
export type SessionRuntime = PiSessionRuntime;
export type SessionRuntimeEvent = PiSessionRuntimeEvent;

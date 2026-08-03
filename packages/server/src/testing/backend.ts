import type {
	ModelMetadata,
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	SessionSummary,
	ThinkingLevel,
	TranscriptProgress,
} from "@earendil-works/pi-protocol";
import { PiServerError } from "../errors.ts";
import type {
	CreateSessionOptions,
	PiSessionBackend,
	PiSessionRuntime,
	PiSessionRuntimeEvent,
	PromptInput,
} from "../types.ts";

/** 测试用固定令牌，服务器与测试客户端共享。 */
export const TEST_TOKEN = "server-conformance-token";
/** 测试用固定模型元数据，用于一致性测试。 */
export const TEST_MODEL: ModelMetadata = {
	provider: "test",
	id: "small",
	name: "Test Small",
	api: "test-api",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 16_000,
	maxTokens: 2_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	supportedThinkingLevels: ["off", "medium", "high"],
	authenticated: true,
};

/** 可手动 resolve 的 Promise，便于在测试中精确控制异步流程的完成时机。 */
export class Deferred<T> {
	/** 待完成的 Promise。 */
	readonly promise: Promise<T>;
	private resolvePromise!: (value: T) => void;

	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	/** 手动完成该 Promise。 */
	resolve(value: T): void {
		this.resolvePromise(value);
	}
}

/** 后端存储的会话：仅保留一份快照作为「持久化」状态。 */
interface StoredSession {
	snapshot: SessionSnapshot;
}

/** 测试会话运行时：模拟 PiSessionRuntime，用内存快照驱动，并暴露测试钩子。 */
export class TestSessionRuntime implements PiSessionRuntime {
	/** 释放完成后会 resolve 的 Deferred。 */
	readonly disposed = new Deferred<void>();
	/** 被调用 dispose 的次数。 */
	disposeCount = 0;
	/** 记录所有 steer 输入。 */
	readonly steers: PromptInput[] = [];
	/** 底层存储的会话快照。 */
	private readonly stored: StoredSession;
	/** 释放时回调（用于让后端解除锁定）。 */
	private readonly onDispose: () => void;
	/** 事件监听器集合。 */
	private readonly listeners = new Set<(event: PiSessionRuntimeEvent) => void>();
	/** 当前正在执行的 prompt（存在即代表会话忙）。 */
	private pendingPrompt?: { input: PromptInput; done: Deferred<"complete" | "aborted"> };

	/**
	 * @param stored    底层存储的会话快照。
	 * @param onDispose 释放时回调。
	 */
	constructor(stored: StoredSession, onDispose: () => void) {
		this.stored = stored;
		this.onDispose = onDispose;
	}

	/** 返回当前快照的深拷贝。 */
	snapshot(): SessionSnapshot {
		return structuredClone(this.stored.snapshot);
	}

	/** 返回当前会话阶段。 */
	getPhase(): SessionPhase {
		return this.stored.snapshot.phase;
	}

	/** 模拟一次 prompt：进入 turn 阶段，等待测试完成或中止后生成对应助手回复。 */
	async prompt(input: PromptInput): Promise<void> {
		if (this.getPhase() !== "idle") throw new PiServerError("busy", "A prompt is already running");
		const done = new Deferred<"complete" | "aborted">();
		this.pendingPrompt = { input, done };
		this.update({
			phase: "turn",
			transcript: [
				...this.stored.snapshot.transcript,
				{
					id: `user-${this.stored.snapshot.revision + 1}`,
					role: "user",
					content: [{ type: "text", text: input.text }],
					timestamp: this.stored.snapshot.revision + 1,
				},
			],
		});
		const outcome = await done.promise;
		const assistant =
			outcome === "complete"
				? {
						id: `assistant-${this.stored.snapshot.revision + 1}`,
						role: "assistant" as const,
						content: [{ type: "text" as const, text: `reply:${input.text}` }],
						status: "complete" as const,
						model: this.stored.snapshot.model,
						stopReason: "stop" as const,
						timestamp: this.stored.snapshot.revision + 1,
					}
				: {
						id: `assistant-${this.stored.snapshot.revision + 1}`,
						role: "assistant" as const,
						content: [{ type: "text" as const, text: "" }],
						status: "aborted" as const,
						model: this.stored.snapshot.model,
						stopReason: "aborted" as const,
						timestamp: this.stored.snapshot.revision + 1,
					};
		this.update({
			phase: "idle",
			transcript: [...this.stored.snapshot.transcript, assistant],
		});
		this.pendingPrompt = undefined;
	}

	/** 模拟一次 steer：记录输入并追加到排队引导列表（要求当前有活跃 prompt）。 */
	async steer(input: PromptInput): Promise<void> {
		if (this.getPhase() === "idle") throw new PiServerError("busy", "There is no active prompt to steer");
		this.steers.push(input);
		this.update({
			queuedSteerCount: this.stored.snapshot.queuedSteerCount + 1,
			queuedSteer: [
				...this.stored.snapshot.queuedSteer,
				{
					id: `steer-${this.stored.snapshot.revision + 1}`,
					role: "user",
					content: [{ type: "text", text: input.text }],
					timestamp: this.stored.snapshot.revision + 1,
				},
			],
		});
	}

	/** 中止当前 prompt（要求存在活跃 prompt）。 */
	async abort(): Promise<void> {
		if (!this.pendingPrompt) throw new PiServerError("busy", "There is no active prompt to abort");
		this.pendingPrompt.done.resolve("aborted");
	}

	/** 设置会话模型（要求会话空闲）。 */
	async setModel(model: ModelRef): Promise<void> {
		if (this.getPhase() !== "idle") throw new PiServerError("busy", "Session is busy");
		this.update({ model });
	}

	/** 设置思考级别（要求会话空闲）。 */
	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		if (this.getPhase() !== "idle") throw new PiServerError("busy", "Session is busy");
		this.update({ thinkingLevel });
	}

	/** 订阅运行时事件，返回取消订阅函数。 */
	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** 释放运行时：计数、触发释放回调并完成 disposed Deferred。 */
	async dispose(): Promise<void> {
		this.disposeCount += 1;
		this.onDispose();
		this.disposed.resolve(undefined);
	}

	/** 测试钩子：直接设置会话阶段。 */
	setPhase(phase: SessionPhase): void {
		this.stored.snapshot = { ...this.stored.snapshot, phase };
	}

	/** 测试钩子：将当前 prompt 标记为完成。 */
	finishPrompt(): void {
		if (!this.pendingPrompt) throw new Error("No prompt is pending");
		this.pendingPrompt.done.resolve("complete");
	}

	/** 测试钩子：向监听器发出进度事件。 */
	emitProgress(progress: TranscriptProgress): void {
		for (const listener of this.listeners) listener({ type: "progress", progress });
	}

	/** 测试钩子：向监听器发出错误事件。 */
	emitError(error: PiServerError): void {
		for (const listener of this.listeners) listener({ type: "error", error });
	}

	/** 测试钩子：向监听器发出快照变更事件。 */
	emitSnapshot(): void {
		for (const listener of this.listeners) listener({ type: "snapshot" });
	}

	/** 应用部分快照更新：递增修订号与 updatedAt，并触发快照事件。 */
	private update(updates: Partial<SessionSnapshot>): void {
		this.stored.snapshot = {
			...this.stored.snapshot,
			...updates,
			revision: this.stored.snapshot.revision + 1,
			updatedAt: this.stored.snapshot.updatedAt + 1,
		};
		this.emitSnapshot();
	}
}

/** 用于在测试中人为延迟 listSessions 返回的控制结构。 */
interface ListDelay {
	/** 当 listSessions 进入并开始等待时 resolve。 */
	entered: Deferred<void>;
	/** 调用 release 后 listSessions 才继续返回。 */
	release: Deferred<void>;
}

/** 测试会话后端：用内存 Map 存储会话，支持种子数据、锁与人为延迟。 */
export class TestSessionBackend implements PiSessionBackend {
	/** 持久化存储：id → 存储的会话。 */
	readonly sessions = new Map<string, StoredSession>();
	/** 每个会话创建过的运行时列表（含已释放的）。 */
	readonly runtimes = new Map<string, TestSessionRuntime[]>();
	/** 当前被锁定的会话 ID 集合。 */
	readonly locked = new Set<string>();
	/** 最近一次创建的会话 ID。 */
	lastCreatedId?: string;
	/** 预置的下一次 listSessions 延迟。 */
	private nextListDelay?: ListDelay;

	/** 列出所有存储会话的摘要（若设置了延迟则先等待释放）。 */
	async listSessions(): Promise<SessionSummary[]> {
		const delay = this.nextListDelay;
		if (delay) {
			this.nextListDelay = undefined;
			delay.entered.resolve(undefined);
			await delay.release.promise;
		}
		return [...this.sessions.values()].map(({ snapshot }) => ({
			id: snapshot.id,
			name: snapshot.name,
			cwd: snapshot.cwd,
			createdAt: snapshot.createdAt,
			updatedAt: snapshot.updatedAt,
			phase: snapshot.phase,
			model: snapshot.model,
			thinkingLevel: snapshot.thinkingLevel,
			attached: false,
			locked: this.locked.has(snapshot.id),
		}));
	}

	/** 返回固定的测试模型列表。 */
	async listModels(): Promise<ModelMetadata[]> {
		return [TEST_MODEL];
	}

	/** 创建一个会话：记录 lastCreatedId、初始化存储并返回独占运行时。 */
	async createSession(options: CreateSessionOptions): Promise<PiSessionRuntime> {
		this.lastCreatedId = options.id;
		if (this.sessions.has(options.id)) throw new PiServerError("session_locked", "Session already exists");
		this.seed(options.id, options.name, options.cwd, options.model, options.thinkingLevel);
		return this.acquire(options.id);
	}

	/** 打开一个已存在且未被锁定的会话，返回其独占运行时。 */
	async openSession(sessionId: string): Promise<PiSessionRuntime> {
		if (!this.sessions.has(sessionId)) throw new PiServerError("not_found", `Unknown session: ${sessionId}`);
		if (this.locked.has(sessionId)) throw new PiServerError("session_locked", `Session is locked: ${sessionId}`);
		return this.acquire(sessionId);
	}

	/** 测试辅助：向存储中写入一个会话的初始快照（可指定各字段）。 */
	seed(
		id = "session-1",
		name = `Session ${id}`,
		cwd = "/tmp/pi-server-conformance",
		model: ModelRef = { provider: TEST_MODEL.provider, id: TEST_MODEL.id },
		thinkingLevel: ThinkingLevel = "off",
	): void {
		this.sessions.set(id, {
			snapshot: {
				id,
				name,
				cwd,
				createdAt: 1,
				updatedAt: 1,
				phase: "idle",
				model,
				thinkingLevel,
				attached: false,
				locked: false,
				revision: 0,
				transcript: [],
				queuedSteer: [],
				queuedSteerCount: 0,
			},
		});
	}

	/** 测试辅助：让下一次 listSessions 阻塞，直到手动 release。 */
	delayNextList(): ListDelay {
		const delay = { entered: new Deferred<void>(), release: new Deferred<void>() };
		this.nextListDelay = delay;
		return delay;
	}

	/** 测试辅助：获取指定会话最近一次创建的运行时。 */
	latestRuntime(id: string): TestSessionRuntime {
		const runtimes = this.runtimes.get(id);
		if (!runtimes?.length) throw new Error(`No runtime for ${id}`);
		return runtimes.at(-1)!;
	}

	/** 内部：为指定会话创建运行时、加入锁定集合并记录到 runtimes 表。 */
	private acquire(id: string): TestSessionRuntime {
		const stored = this.sessions.get(id);
		if (!stored) throw new Error(`Unknown session: ${id}`);
		this.locked.add(id);
		const runtime = new TestSessionRuntime(stored, () => this.locked.delete(id));
		const runtimes = this.runtimes.get(id) ?? [];
		runtimes.push(runtime);
		this.runtimes.set(id, runtimes);
		return runtime;
	}
}

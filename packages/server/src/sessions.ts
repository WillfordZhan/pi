import { randomUUID } from "node:crypto";
import type { Command, EventEnvelope, SessionSnapshot, SessionSummary } from "@earendil-works/pi-protocol";
import type { ByteConnection, ConnectionState } from "./connection.ts";
import { PiServerError } from "./errors.ts";
import type { CreateSessionOptions, PiSessionBackend, PiSessionRuntime, PiSessionRuntimeEvent } from "./types.ts";

/** 服务器内存中一个「活跃会话」的运行时状态（绑定后端运行时与所有附加连接）。 */
interface LiveSession {
	/** 会话唯一 ID。 */
	id: string;
	/** 后端提供的会话运行时。 */
	runtime: PiSessionRuntime;
	/** 当前附加到该会话的连接集合。 */
	connections: Set<ConnectionState>;
	/** 取消订阅运行时事件。 */
	unsubscribe: () => void;
	/** 正在执行中的操作数（用于判断何时可以释放会话）。 */
	operationCount: number;
	/** 会话是否已完成初始化并可用。 */
	ready: boolean;
	/** 会话是否已进入终止流程。 */
	terminal: boolean;
	/** 正在进行的释放流程（用于幂等去重）。 */
	disposing?: Promise<void>;
}

/** 会话管理器依赖的外部协作接口（由 PiServer 注入）。 */
interface LiveSessionManagerOptions {
	/** 会话后端。 */
	backend: PiSessionBackend;
	/** 查询服务器是否正在关闭。 */
	isClosing: () => boolean;
	/** 向某个连接发送事件消息。 */
	sendMessage: (connection: ConnectionState, message: EventEnvelope) => Promise<boolean>;
	/** 关闭某个连接的底层通道。 */
	closeConnection: (connection: ByteConnection) => Promise<void>;
	/** 断开某个连接（解绑其全部会话）。 */
	disconnect: (connection: ConnectionState) => Promise<void>;
	/** 广播一次服务器快照。 */
	broadcastServerSnapshot: () => void;
	/** 上报非致命错误。 */
	reportError: (error: unknown) => void;
}

/** 从会话快照中提取摘要字段，生成列表用的轻量会话摘要。 */
function toSummary(snapshot: SessionSnapshot): SessionSummary {
	return {
		id: snapshot.id,
		name: snapshot.name,
		cwd: snapshot.cwd,
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
		phase: snapshot.phase,
		model: snapshot.model,
		thinkingLevel: snapshot.thinkingLevel,
		attached: snapshot.attached,
		locked: snapshot.locked,
	};
}

/** 会话管理器：创建/附加/分离会话、执行会话命令，并维护会话生命周期与快照广播。 */
export class LiveSessionManager {
	/** 外部协作接口。 */
	private readonly options: LiveSessionManagerOptions;
	/** 当前活跃会话表：id → LiveSession。 */
	private readonly liveSessions = new Map<string, LiveSession>();
	/** 正在打开（尚未就绪）的会话：id → 打开中的 Promise，用于并发去重。 */
	private readonly openingSessions = new Map<string, Promise<LiveSession>>();

	/** @param options 外部协作接口（后端、发送消息、广播快照等）。 */
	constructor(options: LiveSessionManagerOptions) {
		this.options = options;
	}

	/** 执行来自连接的一条会话命令（list/create/attach/detach/prompt/steer/abort/set_model/set_thinking）。 */
	async executeCommand(connection: ConnectionState, command: Command) {
		switch (command.command) {
			case "list":
				return { command: "list" as const, sessions: await this.listSummaries(connection) };
			case "create": {
				const id = randomUUID();
				const options: CreateSessionOptions = {
					id,
					cwd: command.cwd,
					name: command.name,
					model: command.model,
					thinkingLevel: command.thinkingLevel,
				};
				const live = await this.acquire(id, () => this.options.backend.createSession(options));
				await this.attach(connection, live);
				const session = this.forConnection(await this.broadcastSnapshot(live), connection);
				this.options.broadcastServerSnapshot();
				return { command: "create" as const, session };
			}
			case "attach": {
				const live = await this.acquire(command.sessionId, () =>
					this.options.backend.openSession(command.sessionId),
				);
				await this.attach(connection, live);
				const session = this.forConnection(await this.broadcastSnapshot(live), connection);
				this.options.broadcastServerSnapshot();
				return { command: "attach" as const, session };
			}
			case "detach": {
				const live = this.liveSessions.get(command.sessionId);
				if (connection.sessionIds.has(command.sessionId)) {
					connection.sessionIds.delete(command.sessionId);
					if (live) {
						live.connections.delete(connection);
						if (live.connections.size > 0 && !live.terminal && !live.disposing) {
							await this.broadcastSnapshot(live);
						}
						await this.maybeDispose(live);
					}
					this.options.broadcastServerSnapshot();
				}
				return { command: "detach" as const, sessionId: command.sessionId };
			}
			case "prompt": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () =>
					live.runtime.prompt({ text: command.text }),
				);
				return { command: "prompt" as const, session };
			}
			case "steer": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () => live.runtime.steer({ text: command.text }));
				return { command: "steer" as const, session };
			}
			case "abort": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () => live.runtime.abort());
				return { command: "abort" as const, session };
			}
			case "set_model": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () => live.runtime.setModel(command.model));
				return { command: "set_model" as const, session };
			}
			case "set_thinking": {
				const live = this.requireAttached(connection, command.sessionId);
				const session = await this.runOperation(connection, live, () =>
					live.runtime.setThinking(command.thinkingLevel),
				);
				return { command: "set_thinking" as const, session };
			}
		}
	}

	/** 断开连接：解绑其附加的所有会话，并在会话无引用后触发释放。 */
	async disconnect(connection: ConnectionState): Promise<void> {
		const sessions = [...connection.sessionIds]
			.map((id) => this.liveSessions.get(id))
			.filter((live): live is LiveSession => live !== undefined);
		connection.sessionIds.clear();
		for (const live of sessions) live.connections.delete(connection);
		const results = await Promise.allSettled(sessions.map((live) => this.maybeDispose(live)));
		for (const result of results) {
			if (result.status === "rejected") this.options.reportError(result.reason);
		}
	}

	/** 列出会话摘要：合并后端持久化数据与活跃会话的实时快照，并按连接标记附加状态。 */
	async listSummaries(connection?: ConnectionState): Promise<SessionSummary[]> {
		const stored = await this.options.backend.listSessions();
		const liveSnapshots = await Promise.all(
			[...this.liveSessions.values()]
				.filter((live) => !live.disposing)
				.map(async (live) => [live.id, await this.normalizedSnapshot(live)] as const),
		);
		const liveById = new Map(liveSnapshots);
		const summaries = stored.map((summary) => {
			const snapshot = liveById.get(summary.id);
			if (!snapshot) return { ...summary, attached: false };
			liveById.delete(summary.id);
			return { ...toSummary(snapshot), attached: connection?.sessionIds.has(summary.id) ?? false };
		});
		for (const snapshot of liveById.values()) {
			summaries.push({ ...toSummary(snapshot), attached: connection?.sessionIds.has(snapshot.id) ?? false });
		}
		return summaries;
	}

	/** 关闭会话管理器：等待所有打开中的会话结束，然后释放全部活跃会话。 */
	async close(): Promise<void> {
		const openingResults = await Promise.allSettled([...this.openingSessions.values()]);
		for (const result of openingResults) {
			if (result.status === "rejected") this.options.reportError(result.reason);
		}
		const sessions = [...this.liveSessions.values()];
		this.liveSessions.clear();
		await Promise.all(
			sessions.map(async (live) => {
				if (live.disposing) {
					await live.disposing;
					return;
				}
				live.unsubscribe();
				await live.runtime.dispose();
			}),
		);
	}

	/** 执行一个会话操作：计数防并发，结束后广播快照并考虑是否释放会话。 */
	private async runOperation(
		connection: ConnectionState,
		live: LiveSession,
		operation: () => Promise<void>,
	): Promise<SessionSnapshot> {
		live.operationCount += 1;
		try {
			await operation();
			return this.forConnection(await this.broadcastSnapshot(live), connection);
		} finally {
			live.operationCount -= 1;
			this.scheduleMaybeDispose(live);
		}
	}

	/** 获取（或并发等待）一个会话的活跃引用；会话已终止/释放时抛出对应错误。 */
	private async acquire(id: string, acquireRuntime: () => Promise<PiSessionRuntime>): Promise<LiveSession> {
		for (;;) {
			const existing = this.liveSessions.get(id);
			if (existing) {
				if (existing.terminal) throw new PiServerError("session_locked", `Session runtime is terminating: ${id}`);
				if (existing.disposing) {
					await existing.disposing;
					continue;
				}
				return existing;
			}
			const opening = this.openingSessions.get(id);
			if (opening) return opening;
			const pending = this.create(id, acquireRuntime);
			this.openingSessions.set(id, pending);
			try {
				return await pending;
			} finally {
				if (this.openingSessions.get(id) === pending) this.openingSessions.delete(id);
			}
		}
	}

	/** 创建并注册一个新的活跃会话：获取运行时、订阅事件；失败时释放运行时。 */
	private async create(id: string, acquireRuntime: () => Promise<PiSessionRuntime>): Promise<LiveSession> {
		const runtime = await acquireRuntime();
		if (this.options.isClosing()) {
			await runtime.dispose();
			throw new Error("PiServer closed while acquiring a session runtime");
		}
		let live: LiveSession | undefined;
		try {
			const snapshot = await runtime.snapshot();
			if (snapshot.id !== id) {
				throw new PiServerError(
					"invalid_request",
					`Backend returned session ${snapshot.id} for server-assigned session ${id}`,
				);
			}
			live = {
				id,
				runtime,
				connections: new Set(),
				unsubscribe: () => {},
				operationCount: 0,
				ready: false,
				terminal: false,
			};
			live.unsubscribe = runtime.subscribe((event) => this.handleRuntimeEvent(live!, event));
			this.liveSessions.set(id, live);
			live.ready = true;
			return live;
		} catch (error) {
			if (live) live.unsubscribe();
			try {
				await runtime.dispose();
			} catch (disposeError) {
				this.options.reportError(disposeError);
			}
			throw error;
		}
	}

	/** 处理运行时事件：错误触发终止，进度消息转发给附加连接，快照事件触发广播。 */
	private handleRuntimeEvent(live: LiveSession, event: PiSessionRuntimeEvent): void {
		if (event.type === "error") {
			void this.terminate(live, event.error).catch((error: unknown) => this.options.reportError(error));
			return;
		}
		if (event.type === "progress") {
			const envelope: EventEnvelope = {
				type: "event",
				event: { type: "session_progress", sessionId: live.id, progress: event.progress },
			};
			for (const connection of live.connections) void this.options.sendMessage(connection, envelope);
		} else {
			void this.broadcastSnapshot(live).catch((error: unknown) => this.options.reportError(error));
		}
		this.scheduleMaybeDispose(live);
	}

	/** 终止一个会话：标记终态、关闭其附加连接、触发释放（例如运行时出错时）。 */
	private async terminate(live: LiveSession, error: PiServerError): Promise<void> {
		if (live.terminal) return;
		live.terminal = true;
		this.options.reportError(error);
		live.unsubscribe();
		const connections = [...live.connections];
		await Promise.all(connections.map((connection) => this.options.closeConnection(connection.connection)));
		await Promise.all(connections.map((connection) => this.options.disconnect(connection)));
		await this.maybeDispose(live);
	}

	/** 获取会话的规范化快照：校验 ID 一致，并补充实时阶段、附加状态与锁定标记。 */
	private async normalizedSnapshot(live: LiveSession): Promise<SessionSnapshot> {
		const snapshot = await live.runtime.snapshot();
		if (snapshot.id !== live.id) {
			throw new PiServerError("invalid_request", `Runtime session ID changed from ${live.id} to ${snapshot.id}`);
		}
		return {
			...snapshot,
			phase: live.runtime.getPhase(),
			attached: live.connections.size > 0,
			locked: true,
		};
	}

	/** 依据指定连接调整快照的 attached 字段（表示该连接是否附加到该会话）。 */
	private forConnection(snapshot: SessionSnapshot, connection: ConnectionState): SessionSnapshot {
		return { ...snapshot, attached: connection.sessionIds.has(snapshot.id) };
	}

	/** 广播会话快照给所有附加连接，并返回该快照。 */
	private async broadcastSnapshot(live: LiveSession): Promise<SessionSnapshot> {
		const snapshot = await this.normalizedSnapshot(live);
		const envelope: EventEnvelope = { type: "event", event: { type: "session_snapshot", snapshot } };
		for (const connection of live.connections) void this.options.sendMessage(connection, envelope);
		return snapshot;
	}

	/** 将连接附加到会话：建立双向引用；连接已关闭时拒绝并尝试释放会话。 */
	private async attach(connection: ConnectionState, live: LiveSession): Promise<void> {
		if (connection.disconnected || connection.stage !== "ready" || connection.connection.closed) {
			await this.maybeDispose(live);
			throw new PiServerError("invalid_request", "Connection closed while attaching to a session");
		}
		connection.sessionIds.add(live.id);
		live.connections.add(connection);
	}

	/** 要求连接已附加到指定会话且会话存活，否则抛出对应协议错误。 */
	private requireAttached(connection: ConnectionState, sessionId: string): LiveSession {
		if (!connection.sessionIds.has(sessionId)) {
			throw new PiServerError("invalid_request", `Connection is not attached to session ${sessionId}`);
		}
		const live = this.liveSessions.get(sessionId);
		if (!live || live.terminal || live.disposing) {
			throw new PiServerError("not_found", `Session is not live: ${sessionId}`);
		}
		return live;
	}

	/** 安排一次释放检查（异步执行，异常上报但不中断）。 */
	private scheduleMaybeDispose(live: LiveSession): void {
		void this.maybeDispose(live).catch((error: unknown) => this.options.reportError(error));
	}

	/** 判断会话是否满足释放条件（无连接、无操作、空闲/终态），满足则释放运行时并从表移除。 */
	private async maybeDispose(live: LiveSession): Promise<void> {
		if (
			this.options.isClosing() ||
			!live.ready ||
			live.disposing ||
			live.connections.size > 0 ||
			live.operationCount > 0 ||
			(!live.terminal && live.runtime.getPhase() !== "idle")
		) {
			return live.disposing;
		}
		live.unsubscribe();
		live.disposing = (async () => {
			try {
				await live.runtime.dispose();
			} finally {
				if (this.liveSessions.get(live.id) === live) this.liveSessions.delete(live.id);
			}
		})();
		await live.disposing;
		if (!this.options.isClosing()) this.options.broadcastServerSnapshot();
	}
}

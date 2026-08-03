import type {
	SessionForkOptions,
	SessionForkSelection,
	SessionMetadata,
	SessionStorage,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";
import { ArraySessionIndex } from "./array-session-index.ts";
import { KeyedOperationQueue } from "./keyed-operation-queue.ts";
import {
	createSessionForkSelection,
	createSessionId,
	createTimestamp,
	readSessionEntriesForFork,
	type SessionRepository,
} from "./repository.ts";
import { createSession, type Session, type SessionContextBuildOptions } from "./session.ts";

/** 内存会话的创建选项，可选指定会话 id。 */
export type InMemorySessionCreateOptions = { id?: string };

/** 单个内存会话的完整状态：元数据 + 条目索引。 */
interface InMemorySessionState {
	metadata: SessionMetadata;
	entries: ArraySessionIndex;
}

/**
 * 内存会话后端：所有会话数据保存在内存的 Map 中，进程退出即丢失；
 * 常用于测试或需要轻量会话的场景。
 */
export class InMemorySessionBackend {
	/** 按会话 id 保存所有内存会话状态。 */
	private readonly sessions = new Map<string, InMemorySessionState>();
	/** 跨会话的操作队列，同一会话 id 的操作串行执行。 */
	private readonly operations = new KeyedOperationQueue<string>();
	/** 是否已释放。 */
	private disposed = false;
	/** 释放流程的 Promise。 */
	private disposePromise: Promise<void> | undefined;

	/** 创建并打开一个新内存会话，返回其存储句柄。 */
	create(options: InMemorySessionCreateOptions = {}): Promise<SessionStorage<SessionMetadata>> {
		this.assertOpen();
		const id = options.id ?? createSessionId();
		return this.operations.enqueue(id, () => {
			const state: InMemorySessionState = {
				metadata: { id, createdAt: createTimestamp() },
				entries: new ArraySessionIndex(),
			};
			this.sessions.set(id, state);
			return this.storage(state);
		});
	}

	/** 按元数据打开一个已有内存会话。 */
	open(metadata: SessionMetadata): Promise<SessionStorage<SessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => this.storage(this.getState(metadata)));
	}

	/** 列出所有内存会话的元数据。 */
	list(): Promise<SessionMetadata[]> {
		this.assertOpen();
		return this.operations.enqueueBarrier(() => [...this.sessions.values()].map((state) => state.metadata));
	}

	/** 删除一个内存会话。 */
	delete(metadata: SessionMetadata): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => {
			this.sessions.delete(metadata.id);
		});
	}

	/** 从源会话按选择策略派生一个新内存会话。 */
	fork(
		source: SessionMetadata,
		options: InMemorySessionCreateOptions,
		selection: SessionForkSelection,
	): Promise<SessionStorage<SessionMetadata>> {
		this.assertOpen();
		const id = options.id ?? createSessionId();
		const sourceEntries = this.operations.enqueue(source.id, () =>
			readSessionEntriesForFork(this.getState(source).entries, selection),
		);
		return this.operations.enqueue(id, async () => {
			const state: InMemorySessionState = {
				metadata: { id, createdAt: createTimestamp() },
				entries: new ArraySessionIndex(await sourceEntries),
			};
			this.sessions.set(id, state);
			return this.storage(state);
		});
	}

	/** 释放后端：标记为已释放并等待所有排队操作结束。 */
	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.disposePromise) {
			this.disposed = true;
			this.disposePromise = this.operations.drain();
		}
		await this.disposePromise;
	}

	/** 基于后端方法组装一个 SessionStorage 存储句柄。 */
	private storage(state: InMemorySessionState): SessionStorage<SessionMetadata> {
		const read = <T>(operation: (entries: ArraySessionIndex) => T): Promise<T> => {
			this.assertOpen();
			return this.operations.enqueue(state.metadata.id, () => operation(this.getState(state.metadata).entries));
		};
		return {
			metadata: state.metadata,
			readHead: () => read((entries) => entries.readHead()),
			readEntry: (id) => read((entries) => entries.readEntry(id)),
			readEntries: (options) => read((entries) => entries.readEntries(options)),
			appendEntry: (entry) => this.appendEntry(state.metadata, entry),
			findEntriesOnBranch: (query) => read((entries) => entries.findEntriesOnBranch(query)),
			readPathToRootOrCompaction: (leafId) => read((entries) => entries.readPathToRootOrCompaction(leafId)),
			getLabel: (id) => read((entries) => entries.getLabel(id)),
			getName: () => read((entries) => entries.getName()),
			getStats: () => read((entries) => entries.getStats()),
		};
	}

	/** 向内存会话追加一条条目。 */
	private appendEntry(metadata: SessionMetadata, entry: SessionTreeEntry): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => {
			this.getState(metadata).entries.append(entry);
		});
	}

	/** 若后端已释放则抛出错误。 */
	private assertOpen(): void {
		if (this.disposed) throw new SessionError("storage", "In-memory session repository is disposed");
	}

	/** 按元数据获取会话状态，不存在则报错。 */
	private getState(metadata: SessionMetadata): InMemorySessionState {
		const state = this.sessions.get(metadata.id);
		if (!state) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		return state;
	}
}

/** InMemorySessionRepository 的构造选项。 */
export interface InMemorySessionRepositoryOptions {
	/** 默认的上下文构建选项。 */
	contextBuildOptions?: SessionContextBuildOptions;
}

/**
 * 内存会话仓库：面向外部提供的门面，把内存后端存储句柄包装为 {@link Session}。
 * 数据不持久化，适合测试与临时会话场景。
 */
export class InMemorySessionRepository
	implements SessionRepository<SessionMetadata, InMemorySessionCreateOptions, void>
{
	/** 底层的内存后端。 */
	private readonly backend = new InMemorySessionBackend();
	/** 创建 Session 时使用的默认上下文构建选项。 */
	private readonly contextBuildOptions: SessionContextBuildOptions;

	/**
	 * 构造内存会话仓库。
	 * @param options - 可选的上下文构建选项。
	 */
	constructor(options: InMemorySessionRepositoryOptions = {}) {
		this.contextBuildOptions = options.contextBuildOptions ?? {};
	}

	/** 创建并打开一个新会话。 */
	async create(options: InMemorySessionCreateOptions = {}): Promise<Session<SessionMetadata>> {
		return createSession(await this.backend.create(options), this.contextBuildOptions);
	}

	/** 按元数据打开一个已有会话。 */
	async open(metadata: SessionMetadata): Promise<Session<SessionMetadata>> {
		return createSession(await this.backend.open(metadata), this.contextBuildOptions);
	}

	/** 列出所有会话元数据。 */
	async list(): Promise<SessionMetadata[]> {
		return await this.backend.list();
	}

	/** 删除一个会话。 */
	async delete(metadata: SessionMetadata): Promise<void> {
		await this.backend.delete(metadata);
	}

	/** 从源会话按选择策略派生一个新会话。 */
	async fork(
		source: SessionMetadata,
		options: SessionForkOptions & InMemorySessionCreateOptions,
	): Promise<Session<SessionMetadata>> {
		const { entryId: _entryId, position: _position, ...createOptions } = options;
		return createSession(
			await this.backend.fork(source, createOptions, createSessionForkSelection(options)),
			this.contextBuildOptions,
		);
	}

	/** 释放底层后端。 */
	async [Symbol.asyncDispose](): Promise<void> {
		await this.backend[Symbol.asyncDispose]();
	}
}

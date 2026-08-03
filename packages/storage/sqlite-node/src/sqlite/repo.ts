import type {
	SessionForkOptions,
	SessionForkSelection,
	SessionRepository,
	SessionStorage,
	SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import {
	createSession,
	createSessionForkSelection,
	createSessionId,
	getFileSystemResultOrThrow,
	readSessionEntriesForFork,
	type Session,
	type SessionContextBuildOptions,
	SessionError,
} from "@earendil-works/pi-agent-core";
import { applyMigrations } from "./migrations.ts";
import { SqliteSessionConnection } from "./storage/index.ts";
import { rowToMetadata, type SessionRow } from "./storage/sessions.ts";
import type {
	SqliteDatabase,
	SqliteDatabaseFactory,
	SqliteSessionCreateOptions,
	SqliteSessionListOptions,
	SqliteSessionMetadata,
	SqliteSessionRepositoryEnv,
} from "./types.ts";

/** 取路径的父目录部分（支持 / 与 \ 两种分隔符）。 */
function getParentPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (lastSlash < 0) return ".";
	if (lastSlash === 0) return normalized.slice(0, 1);
	return normalized.slice(0, lastSlash);
}

/** 对新打开的数据库执行基础 PRAGMA 配置（WAL、同步级别、忙等待超时）。 */
async function configureSqliteDatabase(db: SqliteDatabase): Promise<void> {
	await db.exec("PRAGMA journal_mode=WAL");
	await db.exec("PRAGMA synchronous=FULL");
	await db.exec("PRAGMA busy_timeout=5000");
}

/** 构建 SQLite 会话仓库后端所需的配置。 */
export type SqliteSessionBackendOptions = {
	env: SqliteSessionRepositoryEnv;
	sqlite: SqliteDatabaseFactory;
	databasePath: string;
};

/** 简单串行队列：保证所有入库操作按提交顺序依次执行，避免并发写冲突。 */
class SerialOperationQueue {
	private tail: Promise<void> = Promise.resolve();

	/** 把操作排到队尾，返回该操作的结果。 */
	enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** 等待队列中所有操作完成。 */
	async drain(): Promise<void> {
		await this.tail;
	}
}

/** SQLite 会话后端：管理数据库生命周期、串行化所有操作并缓存会话连接。 */
class SqliteSessionBackend {
	private readonly env: SqliteSessionRepositoryEnv;
	private readonly sqlite: SqliteDatabaseFactory;
	private readonly databasePathInput: string;
	private databasePath: string | undefined;
	private databasePromise: Promise<SqliteDatabase> | undefined;
	private database: SqliteDatabase | undefined;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;
	private readonly operations = new SerialOperationQueue();
	private readonly writers = new Map<string, SqliteSessionConnection>();

	/**
	 * @param options 后端配置，包含文件系统环境、SQLite 工厂与数据库路径。
	 */
	constructor(options: SqliteSessionBackendOptions) {
		this.env = options.env;
		this.sqlite = options.sqlite;
		this.databasePathInput = options.databasePath;
	}

	/** 创建一个新会话并返回其存储句柄。 */
	create(options: SqliteSessionCreateOptions): Promise<SessionStorage<SqliteSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			const path = await this.getDatabasePath();
			const connection = await db.transaction(() =>
				SqliteSessionConnection.create(db, path, {
					cwd: options.cwd,
					sessionId: options.id ?? createSessionId(),
					parentSessionId: options.parentSessionId,
					metadata: options.metadata,
				}),
			);
			this.writers.set(connection.metadata.id, connection);
			return this.storage(connection);
		});
	}

	/** 打开一个已存在的会话并返回其存储句柄。 */
	open(metadata: SqliteSessionMetadata): Promise<SessionStorage<SqliteSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(() => this.loadSession(metadata));
	}

	/** 校验会话数据库存在，加载（或复用）会话连接并包装成存储句柄。 */
	private async loadSession(metadata: SqliteSessionMetadata): Promise<SessionStorage<SqliteSessionMetadata>> {
		if (
			!getFileSystemResultOrThrow(await this.env.exists(metadata.path), `Failed to check database ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		const connection =
			this.writers.get(metadata.id) ?? (await SqliteSessionConnection.open(await this.getDatabase(), metadata));
		this.writers.set(metadata.id, connection);
		return this.storage(connection);
	}

	/** 列出会话，可按 cwd 过滤。 */
	list(options: SqliteSessionListOptions = {}): Promise<SqliteSessionMetadata[]> {
		this.assertOpen();
		return this.operations.enqueue(() => this.listSessions(options));
	}

	/** 从 sessions 表查询会话列表（按创建时间倒序）。 */
	private async listSessions(options: SqliteSessionListOptions): Promise<SqliteSessionMetadata[]> {
		const path = await this.getDatabasePath();
		if (!getFileSystemResultOrThrow(await this.env.exists(path), `Failed to check database ${path}`)) return [];
		const db = await this.getDatabase();
		const rows = options.cwd
			? await db
					.prepare(
						"SELECT id, created_at, metadata, cwd, parent_session_id, active_leaf_id FROM sessions WHERE cwd = ? ORDER BY created_at DESC",
					)
					.all<SessionRow>(options.cwd)
			: await db
					.prepare(
						"SELECT id, created_at, metadata, cwd, parent_session_id, active_leaf_id FROM sessions ORDER BY created_at DESC",
					)
					.all<SessionRow>();
		return rows.map((row) => rowToMetadata(row, path));
	}

	/** 向指定会话追加一条条目（复用或打开该会话的连接）。 */
	private appendEntry(metadata: SqliteSessionMetadata, entry: SessionTreeEntry): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const connection =
				this.writers.get(metadata.id) ?? (await SqliteSessionConnection.open(await this.getDatabase(), metadata));
			this.writers.set(metadata.id, connection);
			await connection.appendEntry(entry);
		});
	}

	/** 在事务中删除会话及其所有关联数据（条目、分支缓存、物化状态等）。 */
	delete(metadata: SqliteSessionMetadata): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			await db.transaction(async () => {
				await db.prepare("DELETE FROM branch_tips WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM branch_entries WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM session_entries WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM entry_materialized WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM session_materialized WHERE session_id = ?").run(metadata.id);
				await db.prepare("DELETE FROM session_sequences WHERE session_id = ?").run(metadata.id);
				const result = await db.prepare("DELETE FROM sessions WHERE id = ?").run(metadata.id);
				if (result.changes === 0) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
			});
			this.writers.delete(metadata.id);
		});
	}

	/** 基于源会话的条目选择，派生出一个新的分支会话。 */
	fork(
		source: SqliteSessionMetadata,
		options: SqliteSessionCreateOptions,
		selection: SessionForkSelection,
	): Promise<SessionStorage<SqliteSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const db = await this.getDatabase();
			const connection = await db.transaction(async () => {
				const sourceConnection = this.writers.get(source.id) ?? (await SqliteSessionConnection.open(db, source));
				this.writers.set(source.id, sourceConnection);
				const entries = await readSessionEntriesForFork(sourceConnection, selection);
				const connection = await SqliteSessionConnection.create(db, await this.getDatabasePath(), {
					cwd: options.cwd,
					sessionId: options.id ?? createSessionId(),
					parentSessionId: options.parentSessionId ?? source.id,
					metadata: options.metadata ?? source.metadata,
				});
				for (const entry of entries) await connection.appendEntry(entry, { transaction: false });
				return connection;
			});
			this.writers.set(connection.metadata.id, connection);
			return this.storage(connection);
		});
	}

	/** 异步释放后端：等所有操作完成后关闭数据库。 */
	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.disposePromise) {
			this.disposed = true;
			this.disposePromise = this.finishDisposal();
		}
		await this.disposePromise;
	}

	/** 清理资源：排空队列、关闭数据库并清空连接缓存。 */
	private async finishDisposal(): Promise<void> {
		await this.operations.drain();
		const db = this.database ?? (this.databasePromise ? await this.databasePromise : undefined);
		this.database = undefined;
		this.databasePromise = undefined;
		this.writers.clear();
		if (db) await db.close();
	}

	/** 校验后端尚未被释放，否则抛出错误。 */
	private assertOpen(): void {
		if (this.disposed) throw new SessionError("storage", "SQLite session repository is disposed");
	}

	/** 把连接包装成存储层要求的 {@link SessionStorage} 接口。 */
	private storage(connection: SqliteSessionConnection): SessionStorage<SqliteSessionMetadata> {
		const metadata = connection.metadata;
		return {
			metadata,
			readHead: () => this.read(metadata, (current) => current.readHead()),
			readEntry: (id) => this.read(metadata, (current) => current.readEntry(id)),
			readEntries: (options) => this.read(metadata, (current) => current.readEntries(options)),
			appendEntry: (entry) => this.appendEntry(metadata, entry),
			findEntriesOnBranch: (query) => this.read(metadata, (current) => current.findEntriesOnBranch(query)),
			readPathToRootOrCompaction: (leafId) =>
				this.read(metadata, (current) => current.readPathToRootOrCompaction(leafId)),
			getLabel: (id) => this.read(metadata, (current) => current.getLabel(id)),
			getName: () => this.read(metadata, (current) => current.getName()),
			getStats: () => this.read(metadata, (current) => current.getStats()),
		};
	}

	/** 在串行队列中执行一次读取操作，复用或打开会话连接。 */
	private read<T>(
		metadata: SqliteSessionMetadata,
		read: (connection: SqliteSessionConnection) => Promise<T>,
	): Promise<T> {
		this.assertOpen();
		return this.operations.enqueue(async () => {
			const connection =
				this.writers.get(metadata.id) ?? (await SqliteSessionConnection.open(await this.getDatabase(), metadata));
			this.writers.set(metadata.id, connection);
			return read(connection);
		});
	}

	/** 解析并缓存数据库文件的绝对路径。 */
	private async getDatabasePath(): Promise<string> {
		this.databasePath ??= getFileSystemResultOrThrow(
			await this.env.absolutePath(this.databasePathInput),
			`Failed to resolve SQLite sessions database ${this.databasePathInput}`,
		);
		return this.databasePath;
	}

	/** 获取（必要时惰性打开）共享的数据库实例。 */
	private async getDatabase(): Promise<SqliteDatabase> {
		if (!this.databasePromise) this.databasePromise = this.openDatabase();
		this.database = await this.databasePromise;
		return this.database;
	}

	/** 创建数据库目录、打开数据库并完成 PRAGMA 配置与迁移。 */
	private async openDatabase(): Promise<SqliteDatabase> {
		const path = await this.getDatabasePath();
		const directory = getParentPath(path);
		getFileSystemResultOrThrow(
			await this.env.createDir(directory, { recursive: true }),
			`Failed to create SQLite sessions directory ${directory}`,
		);
		const db = await this.sqlite.open(path);
		try {
			await configureSqliteDatabase(db);
			await applyMigrations(db);
			return db;
		} catch (error) {
			await db.close();
			throw error;
		}
	}
}

/** 构建 {@link SqliteSessionRepository} 时的配置选项。 */
export interface SqliteSessionRepositoryOptions extends SqliteSessionBackendOptions {
	/** 构造上层 {@link Session} 对象时的上下文配置。 */
	contextBuildOptions?: SessionContextBuildOptions;
}

/** 基于 SQLite 的会话仓库实现，负责会话的创建、打开、列举、删除与分支派生。 */
export class SqliteSessionRepository
	implements SessionRepository<SqliteSessionMetadata, SqliteSessionCreateOptions, SqliteSessionListOptions>
{
	private readonly backend: SqliteSessionBackend;
	private readonly contextBuildOptions: SessionContextBuildOptions;

	/**
	 * @param options 仓库配置，含后端选项与可选的上下文构建选项。
	 */
	constructor(options: SqliteSessionRepositoryOptions) {
		const { contextBuildOptions, ...backendOptions } = options;
		this.backend = new SqliteSessionBackend(backendOptions);
		this.contextBuildOptions = contextBuildOptions ?? {};
	}

	/** 创建新会话并包装成 {@link Session}。 */
	async create(options: SqliteSessionCreateOptions): Promise<Session<SqliteSessionMetadata>> {
		return createSession(await this.backend.create(options), this.contextBuildOptions);
	}

	/** 打开已有会话并包装成 {@link Session}。 */
	async open(metadata: SqliteSessionMetadata): Promise<Session<SqliteSessionMetadata>> {
		return createSession(await this.backend.open(metadata), this.contextBuildOptions);
	}

	/** 列出会话，可按 cwd 过滤。 */
	async list(options?: SqliteSessionListOptions): Promise<SqliteSessionMetadata[]> {
		return await this.backend.list(options);
	}

	/** 删除会话及其全部数据。 */
	async delete(metadata: SqliteSessionMetadata): Promise<void> {
		await this.backend.delete(metadata);
	}

	/** 从源会话按选择派生出一个分支会话。 */
	async fork(
		source: SqliteSessionMetadata,
		options: SessionForkOptions & SqliteSessionCreateOptions,
	): Promise<Session<SqliteSessionMetadata>> {
		const { entryId: _entryId, position: _position, ...createOptions } = options;
		return createSession(
			await this.backend.fork(source, createOptions, createSessionForkSelection(options)),
			this.contextBuildOptions,
		);
	}

	/** 释放底层后端资源。 */
	async [Symbol.asyncDispose](): Promise<void> {
		await this.backend[Symbol.asyncDispose]();
	}
}

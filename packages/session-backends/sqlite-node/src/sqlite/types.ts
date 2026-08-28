import type { FileSystem, SessionCreateOptions, SessionMetadata } from "@earendil-works/pi-agent-core";

/** 预编译 SQLite 语句执行后的结果。 */
export interface SqliteRunResult {
	/** 语句影响的行数。 */
	changes: number;
	/** 插入行的自增 ID（若后端暴露该值）。 */
	lastInsertRowid?: number;
}

/** SQLite 会话后端使用的预编译语句能力接口。 */
export interface SqliteStatement {
	run(...params: unknown[]): SqliteRunResult;
	get<TRow extends object>(...params: unknown[]): TRow | undefined;
	all<TRow extends object>(...params: unknown[]): TRow[];
	iterate<TRow extends object>(...params: unknown[]): Iterable<TRow>;
}

/** SQLite 会话后端使用的数据库能力接口。 */
export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	/** Runs a synchronous write transaction. The callback must not return a promise. */
	transaction<T>(fn: () => T): T;
	close(): void;
}

/** 按路径打开数据库的工厂接口。 */
export interface SqliteDatabaseFactory {
	open(path: string): Promise<SqliteDatabase>;
}

/** SQLite 会话的元数据，附带工作目录与数据库文件路径。 */
export interface SqliteSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	parentSessionId?: string;
	/** Current session name projected from SQLite global facts. */
	name?: string;
	/** Opaque application-owned metadata. */
	metadata?: Record<string, unknown>;
}

/** 创建 SQLite 会话时的选项。 */
export interface SqliteSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
	parentSessionId?: string;
	metadata?: Record<string, unknown>;
}

/** 列出 SQLite 会话时的过滤选项。 */
export interface SqliteSessionListOptions {
	cwd?: string;
}

/** 仓库所需的文件系统能力子集。 */
export type SqliteSessionRepositoryEnv = Pick<FileSystem, "absolutePath" | "createDir" | "exists">;

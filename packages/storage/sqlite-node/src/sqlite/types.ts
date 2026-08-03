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
	/** 执行写操作，返回执行结果。 */
	run(...params: unknown[]): Promise<SqliteRunResult>;
	/** 查询单行结果，无匹配返回 undefined。 */
	get<TRow extends object>(...params: unknown[]): Promise<TRow | undefined>;
	/** 查询多行结果。 */
	all<TRow extends object>(...params: unknown[]): Promise<TRow[]>;
}

/** SQLite 会话后端使用的数据库能力接口。 */
export interface SqliteDatabase {
	/** 执行一段原始 SQL。 */
	exec(sql: string): Promise<void>;
	/** 预编译一条 SQL 语句。 */
	prepare(sql: string): SqliteStatement;
	/** 在事务中执行回调。 */
	transaction<T>(fn: () => Promise<T>): Promise<T>;
	/** 关闭数据库连接。 */
	close(): Promise<void>;
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

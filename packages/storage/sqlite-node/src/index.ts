import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteDatabaseFactory, SqliteRunResult, SqliteStatement } from "./sqlite/types.ts";

/** 判断参数是否为命名的（对象形式）SQL 参数，区别于位置参数。 */
function isNamedParameters(value: unknown): value is Record<string, SQLInputValue> {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value) || ArrayBuffer.isView(value)) return false;
	return true;
}

/** 包装 node:sqlite 的 Statement，把它适配成存储层声明的异步 {@link SqliteStatement} 接口。 */
class NodeSqliteStatement implements SqliteStatement {
	private readonly statement: ReturnType<DatabaseSync["prepare"]>;

	constructor(statement: ReturnType<DatabaseSync["prepare"]>) {
		this.statement = statement;
	}

	/** 执行写操作，返回受影响行数与自增 ID。 */

	async run(...params: unknown[]): Promise<SqliteRunResult> {
		const [first, ...rest] = params;
		const result = isNamedParameters(first)
			? this.statement.run(first, ...(rest as SQLInputValue[]))
			: this.statement.run(...(params as SQLInputValue[]));
		return {
			changes: Number(result.changes),
			lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
		};
	}

	/** 查询单行结果，无匹配时返回 undefined。 */
	async get<TRow extends object>(...params: unknown[]): Promise<TRow | undefined> {
		const [first, ...rest] = params;
		return (
			isNamedParameters(first)
				? this.statement.get(first, ...(rest as SQLInputValue[]))
				: this.statement.get(...(params as SQLInputValue[]))
		) as TRow | undefined;
	}

	/** 查询多行结果，返回行对象数组。 */
	async all<TRow extends object>(...params: unknown[]): Promise<TRow[]> {
		const [first, ...rest] = params;
		return (
			isNamedParameters(first)
				? this.statement.all(first, ...(rest as SQLInputValue[]))
				: this.statement.all(...(params as SQLInputValue[]))
		) as TRow[];
	}
}

/** 包装 node:sqlite 的 DatabaseSync，把它适配成存储层声明的异步 {@link SqliteDatabase} 接口。 */
class NodeSqliteDatabase implements SqliteDatabase {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** 执行一段原始 SQL（可含多条语句）。 */
	async exec(sql: string): Promise<void> {
		this.db.exec(sql);
	}

	/** 预编译一条 SQL 语句，返回包装后的语句对象。 */
	prepare(sql: string): SqliteStatement {
		return new NodeSqliteStatement(this.db.prepare(sql));
	}

	/** 在事务中执行 `fn`，成功提交、失败回滚并重新抛出原始错误。 */
	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		this.db.exec("BEGIN");
		try {
			const result = await fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// 忽略回滚错误，优先抛出原始错误。
			}
			throw error;
		}
	}

	/** 关闭底层数据库连接。 */
	async close(): Promise<void> {
		this.db.close();
	}
}

/** 把一个已打开的 node:sqlite 数据库包装为存储层可用的 {@link SqliteDatabase}。 */
export function wrapNodeSqliteDatabase(db: DatabaseSync): SqliteDatabase {
	return new NodeSqliteDatabase(db);
}

/** 创建基于 node:sqlite 的数据库工厂，用于按路径打开新的数据库。 */
export function createNodeSqliteFactory(): SqliteDatabaseFactory {
	return {
		async open(path: string): Promise<SqliteDatabase> {
			return new NodeSqliteDatabase(new DatabaseSync(path));
		},
	};
}

// 重新导出 SQLite 会话后端及其类型，使本包成为一个完整的 node-sqlite 后端。
export * from "./sqlite/index.ts";

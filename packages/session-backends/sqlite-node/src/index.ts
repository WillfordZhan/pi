import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { sql } from "./sqlite/sql.ts";
import type { SqliteDatabase, SqliteDatabaseFactory, SqliteRunResult, SqliteStatement } from "./sqlite/types.ts";

/** 判断参数是否为命名的（对象形式）SQL 参数，区别于位置参数。 */
function isNamedParameters(value: unknown): value is Record<string, SQLInputValue> {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value) || ArrayBuffer.isView(value)) return false;
	return true;
}

function isAsyncResult(value: unknown): boolean {
	return value !== null && (typeof value === "object" || typeof value === "function") && "then" in value;
}

class NodeSqliteStatement implements SqliteStatement {
	private readonly statement: ReturnType<DatabaseSync["prepare"]>;

	constructor(statement: ReturnType<DatabaseSync["prepare"]>) {
		this.statement = statement;
	}

	run(...params: unknown[]): SqliteRunResult {
		const [first, ...rest] = params;
		const result = isNamedParameters(first)
			? this.statement.run(first, ...(rest as SQLInputValue[]))
			: this.statement.run(...(params as SQLInputValue[]));
		return {
			changes: Number(result.changes),
			lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
		};
	}

	get<TRow extends object>(...params: unknown[]): TRow | undefined {
		const [first, ...rest] = params;
		return (
			isNamedParameters(first)
				? this.statement.get(first, ...(rest as SQLInputValue[]))
				: this.statement.get(...(params as SQLInputValue[]))
		) as TRow | undefined;
	}

	all<TRow extends object>(...params: unknown[]): TRow[] {
		const [first, ...rest] = params;
		return (
			isNamedParameters(first)
				? this.statement.all(first, ...(rest as SQLInputValue[]))
				: this.statement.all(...(params as SQLInputValue[]))
		) as TRow[];
	}

	iterate<TRow extends object>(...params: unknown[]): Iterable<TRow> {
		const [first, ...rest] = params;
		return (
			isNamedParameters(first)
				? this.statement.iterate(first, ...(rest as SQLInputValue[]))
				: this.statement.iterate(...(params as SQLInputValue[]))
		) as Iterable<TRow>;
	}
}

/** 包装 node:sqlite 的 DatabaseSync，把它适配成存储层声明的异步 {@link SqliteDatabase} 接口。 */
class NodeSqliteDatabase implements SqliteDatabase {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	/** 预编译一条 SQL 语句，返回包装后的语句对象。 */
	prepare(sql: string): SqliteStatement {
		return new NodeSqliteStatement(this.db.prepare(sql));
	}

	transaction<T>(fn: () => T): T {
		sql`BEGIN IMMEDIATE`.exec(this);
		try {
			const result = fn();
			if (isAsyncResult(result)) {
				throw new TypeError("SQLite transaction callbacks must be synchronous");
			}
			sql`COMMIT`.exec(this);
			return result;
		} catch (error) {
			try {
				sql`ROLLBACK`.exec(this);
			} catch {
				// 忽略回滚错误，优先抛出原始错误。
			}
			throw error;
		}
	}

	close(): void {
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

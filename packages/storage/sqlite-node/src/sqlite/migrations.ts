import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase } from "./types.ts";

/** 一条数据库迁移：`id` 唯一标识，`order` 决定执行顺序，`sql` 是要执行的脚本。 */
export interface SqliteMigration {
	id: string;
	order: number;
	sql: string;
}

/** 读取迁移目录下指定相对路径的 SQL 文件内容。 */
async function loadMigrationSql(relativePath: string): Promise<string> {
	return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

/** 加载全部迁移定义（按顺序排列）。 */
export async function loadMigrations(): Promise<SqliteMigration[]> {
	return [
		{
			id: "001_initial.sql",
			order: 1,
			sql: await loadMigrationSql("./migrations/001_initial.sql"),
		},
		{
			id: "002_branch_tips.sql",
			order: 2,
			sql: await loadMigrationSql("./migrations/002_branch_tips.sql"),
		},
	];
}

/** 确保存在记录已执行迁移的表。 */
async function ensureMigrationsTable(db: SqliteDatabase): Promise<void> {
	await db.exec(`
CREATE TABLE IF NOT EXISTS migrations (
	id TEXT PRIMARY KEY,
	applied_at TEXT NOT NULL
);
`);
}

/** 对数据库按顺序执行尚未应用过的迁移，并在事务中记录迁移记录。 */
export async function applyMigrations(db: SqliteDatabase): Promise<void> {
	await ensureMigrationsTable(db);
	const migrations = await loadMigrations();
	const appliedRows = await db.prepare("SELECT id FROM migrations ORDER BY applied_at, id").all<{ id: string }>();
	const applied = new Set(appliedRows.map((row) => row.id));

	for (const migration of migrations) {
		if (applied.has(migration.id)) continue;
		await db.transaction(async () => {
			await db.exec(migration.sql);
			await db
				.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
				.run(migration.id, new Date().toISOString());
		});
		applied.add(migration.id);
	}
}

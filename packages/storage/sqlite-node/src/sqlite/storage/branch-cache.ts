import { uuidv7 } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "../types.ts";
import type { SessionEntryRow } from "./session-entries.ts";
import { invalidSession } from "./shared.ts";

/** 缓存的从根到叶子的路径信息。规范数据仍以会话条目表的 parent 链为准。 */
export interface CachedBranch {
	branchId: string;
	leafSeq: number;
}

/** 查询分支缓存时的过滤与排序选项。 */
export interface CachedBranchQuery {
	/** 在该类型（如 compaction）的条目处停止。 */
	stopAtType?: SessionEntryRow["type"];
	/** 在该条目 ID 处停止。 */
	stopAtId?: string;
	/** 结果排序方向，默认最新在前。 */
	order?: "newestFirst" | "oldestFirst";
}

/** 读取叶子条目 `leafId` 所属的缓存分支及其叶子序号。 */
export async function readCachedBranch(
	db: SqliteDatabase,
	sessionId: string,
	leafId: string,
): Promise<CachedBranch | undefined> {
	const membership = await db
		.prepare(
			"SELECT branch_id, entry_seq FROM branch_entries WHERE session_id = ? AND entry_id = ? ORDER BY branch_id LIMIT 1",
		)
		.get<{ branch_id: string; entry_seq: number }>(sessionId, leafId);
	if (!membership) return undefined;
	return { branchId: membership.branch_id, leafSeq: membership.entry_seq };
}

/** 校验缓存分支在 [startSeq, leafSeq] 区间内是否与规范条目表一致（无缺失、父链正确且包含叶子）。 */
export async function isCachedBranchValid(
	db: SqliteDatabase,
	sessionId: string,
	branch: CachedBranch,
	leafId: string,
	startSeq = 0,
): Promise<boolean> {
	const result = await db
		.prepare(
			`WITH path AS (
				SELECT
					b.entry_id,
					b.entry_seq,
					e.id AS stored_entry_id,
					e.parent_id,
					LAG(b.entry_id) OVER (ORDER BY b.entry_seq) AS previous_entry_id
				FROM branch_entries AS b
				LEFT JOIN session_entries AS e ON e.session_id = b.session_id AND e.id = b.entry_id
				WHERE b.session_id = ? AND b.branch_id = ? AND b.entry_seq BETWEEN ? AND ?
			)
			SELECT
				COUNT(*) AS row_count,
				COALESCE(SUM(
					stored_entry_id IS NULL OR
					(? = 0 AND previous_entry_id IS NULL AND parent_id IS NOT NULL) OR
					(previous_entry_id IS NOT NULL AND parent_id IS NOT previous_entry_id)
				), 0) AS invalid_count,
				COALESCE(MAX(entry_seq = ? AND entry_id = ?), 0) AS contains_leaf
			FROM path`,
		)
		.get<{ row_count: number; invalid_count: number; contains_leaf: number }>(
			sessionId,
			branch.branchId,
			startSeq,
			branch.leafSeq,
			startSeq,
			branch.leafSeq,
			leafId,
		);
	return result?.row_count !== 0 && result?.invalid_count === 0 && result.contains_leaf === 1;
}

/** 查找缓存分支中满足停止条件（类型或条目 ID）的最新条目的序号，用于缩短后续校验范围。 */
export async function readNewestCachedStopSeq(
	db: SqliteDatabase,
	sessionId: string,
	branch: CachedBranch,
	stopAtType: SessionEntryRow["type"] | undefined,
	stopAtId: string | undefined,
): Promise<number | undefined> {
	const predicates: string[] = [];
	const params: unknown[] = [sessionId, branch.branchId, branch.leafSeq];
	if (stopAtType !== undefined) {
		predicates.push("e.type = ?");
		params.push(stopAtType);
	}
	if (stopAtId !== undefined) {
		predicates.push("b.entry_id = ?");
		params.push(stopAtId);
	}
	if (predicates.length === 0) return undefined;
	const row = await db
		.prepare(
			`SELECT MAX(b.entry_seq) AS entry_seq
			FROM branch_entries AS b
			JOIN session_entries AS e ON e.session_id = b.session_id AND e.id = b.entry_id
			WHERE b.session_id = ? AND b.branch_id = ? AND b.entry_seq <= ?
				AND (${predicates.join(" OR ")})`,
		)
		.get<{ entry_seq: number | null }>(...params);
	return row?.entry_seq ?? undefined;
}

/** 按缓存分支顺序读取从 `startSeq` 到分支叶子的全部条目行。 */
export async function readCachedBranchRows(
	db: SqliteDatabase,
	sessionId: string,
	branch: CachedBranch,
	startSeq: number,
): Promise<SessionEntryRow[]> {
	return db
		.prepare(
			`SELECT e.session_id, e.id, e.entry_seq, e.parent_id, e.type, e.timestamp, e.payload
			FROM branch_entries AS b
			JOIN session_entries AS e ON e.session_id = b.session_id AND e.id = b.entry_id
			WHERE b.session_id = ? AND b.branch_id = ? AND b.entry_seq BETWEEN ? AND ?
			ORDER BY b.entry_seq`,
		)
		.all<SessionEntryRow>(sessionId, branch.branchId, startSeq, branch.leafSeq);
}

/** 按 {@link CachedBranchQuery} 的停止条件与排序方向查询缓存分支上的条目行。 */
export async function queryCachedBranchRows(
	db: SqliteDatabase,
	sessionId: string,
	branch: CachedBranch,
	query: CachedBranchQuery,
): Promise<SessionEntryRow[]> {
	const oldestFirst = query.order === "oldestFirst";
	const boundaryParams: unknown[] = [sessionId, branch.branchId, branch.leafSeq];
	const stopPredicates: string[] = [];
	if (query.stopAtType !== undefined) {
		stopPredicates.push("stop_entry.type = ?");
		boundaryParams.push(query.stopAtType);
	}
	if (query.stopAtId !== undefined) {
		stopPredicates.push("stop.entry_id = ?");
		boundaryParams.push(query.stopAtId);
	}

	const boundary = stopPredicates.length
		? `WITH boundary AS (
			SELECT ${oldestFirst ? "MIN" : "MAX"}(stop.entry_seq) AS entry_seq
			FROM branch_entries AS stop
			JOIN session_entries AS stop_entry
				ON stop_entry.session_id = stop.session_id AND stop_entry.id = stop.entry_id
			WHERE stop.session_id = ? AND stop.branch_id = ? AND stop.entry_seq <= ?
				AND (${stopPredicates.join(" OR ")})
		)`
		: "";
	const range = stopPredicates.length
		? `AND b.entry_seq ${oldestFirst ? "<=" : ">="} COALESCE(
			(SELECT entry_seq FROM boundary), ${oldestFirst ? branch.leafSeq : 0}
		)`
		: "";
	const sql = `${boundary}
		SELECT e.session_id, e.id, e.entry_seq, e.parent_id, e.type, e.timestamp, e.payload
		FROM branch_entries AS b
		JOIN session_entries AS e ON e.session_id = b.session_id AND e.id = b.entry_id
		WHERE b.session_id = ? AND b.branch_id = ? AND b.entry_seq <= ?
			${range}
		ORDER BY b.entry_seq ${oldestFirst ? "ASC" : "DESC"}`;

	const params = [...(stopPredicates.length === 0 ? [] : boundaryParams), sessionId, branch.branchId, branch.leafSeq];
	return db.prepare(sql).all<SessionEntryRow>(...params);
}

/** 读取缓存分支上指定类型的所有条目行（通常用于获取 compaction 记录）。 */
export async function readCachedEntryRowsByType(
	db: SqliteDatabase,
	sessionId: string,
	branch: CachedBranch,
	type: SessionEntryRow["type"],
): Promise<SessionEntryRow[]> {
	// 从通常更稀疏的条目类型表驱动连接：若从 branch_entries 排序，SQLite 会先扫描整条缓存路径再按类型过滤。
	return db
		.prepare(
			`SELECT e.session_id, e.id, e.entry_seq, e.parent_id, e.type, e.timestamp, e.payload
			FROM session_entries AS e INDEXED BY idx_session_entries_session_type
			CROSS JOIN branch_entries AS b
			WHERE e.session_id = ? AND e.type = ?
				AND b.session_id = e.session_id AND b.entry_id = e.id
				AND b.branch_id = ? AND b.entry_seq <= ?
			ORDER BY e.entry_seq DESC`,
		)
		.all<SessionEntryRow>(sessionId, type, branch.branchId, branch.leafSeq);
}

/** 读取某条目在指定缓存分支中的序号，用于定位 compaction 等条目的位置。 */
export async function readCachedEntrySeq(
	db: SqliteDatabase,
	sessionId: string,
	branchId: string,
	entryId: string,
): Promise<number | undefined> {
	const row = await db
		.prepare("SELECT entry_seq FROM branch_entries WHERE session_id = ? AND branch_id = ? AND entry_id = ?")
		.get<{ entry_seq: number }>(sessionId, branchId, entryId);
	return row?.entry_seq;
}

/** 从规范条目表沿父链重建到 `leafId` 的缓存分支，可替换旧分支。 */
export async function rebuildCachedBranch(
	db: SqliteDatabase,
	sessionId: string,
	leafId: string,
	branchIdToReplace?: string,
): Promise<void> {
	await db.exec("SAVEPOINT rebuild_branch_cache");
	try {
		// 找出需要替换的旧分支（显式指定或叶子当前所属分支）并删除。
		const tip = await db
			.prepare("SELECT branch_id FROM branch_tips WHERE session_id = ? AND tip_id = ?")
			.get<{ branch_id: string }>(sessionId, leafId);
		const branchIds = new Set([branchIdToReplace, tip?.branch_id].filter((id): id is string => id !== undefined));
		for (const branchId of branchIds) {
			await db.prepare("DELETE FROM branch_tips WHERE session_id = ? AND branch_id = ?").run(sessionId, branchId);
			await db.prepare("DELETE FROM branch_entries WHERE session_id = ? AND branch_id = ?").run(sessionId, branchId);
		}

		// 用递归 CTE 沿父链收集路径并写入新的分支缓存。
		const branchId = uuidv7();
		await db
			.prepare(
				`WITH RECURSIVE path(id, entry_seq, parent_id) AS (
					SELECT id, entry_seq, parent_id
					FROM session_entries
					WHERE session_id = ? AND id = ?
					UNION ALL
					SELECT parent.id, parent.entry_seq, parent.parent_id
					FROM session_entries AS parent
					JOIN path AS child ON child.parent_id = parent.id
					WHERE parent.session_id = ?
				)
				INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq)
				SELECT ?, ?, id, entry_seq FROM path`,
			)
			.run(sessionId, leafId, sessionId, sessionId, branchId);
		await db
			.prepare("INSERT INTO branch_tips (session_id, tip_id, branch_id) VALUES (?, ?, ?)")
			.run(sessionId, leafId, branchId);
		await db.exec("RELEASE SAVEPOINT rebuild_branch_cache");
	} catch (error) {
		try {
			await db.exec("ROLLBACK TO SAVEPOINT rebuild_branch_cache");
			await db.exec("RELEASE SAVEPOINT rebuild_branch_cache");
		} catch {
			// 保留原始的修复失败错误，不覆盖为回滚错误。
		}
		throw error;
	}
}

/** 在既有缓存分支末尾追加一个新条目，并把分支的叶子指针更新为新条目。 */
async function extendBranch(
	db: SqliteDatabase,
	sessionId: string,
	branchId: string,
	parentId: string,
	entryId: string,
	entrySeq: number,
): Promise<void> {
	await db
		.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
		.run(sessionId, branchId, entryId, entrySeq);
	const result = await db
		.prepare("UPDATE branch_tips SET tip_id = ? WHERE session_id = ? AND branch_id = ? AND tip_id = ?")
		.run(entryId, sessionId, branchId, parentId);
	if (result.changes !== 1) throw invalidSession(`branch tip ${parentId} changed during append`);
}

/** 在分支缓存中追加一个新条目；父条目不存在时走修复逻辑，必要时分裂出新的分支。 */
export async function appendEntryToBranchCache(
	db: SqliteDatabase,
	sessionId: string,
	entryId: string,
	entrySeq: number,
	parentId: string | null,
	repairParent: (parentId: string) => Promise<void>,
): Promise<void> {
	// 无父条目：新开一个分支作为根。
	if (parentId === null) {
		const branchId = uuidv7();
		await db
			.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
			.run(sessionId, branchId, entryId, entrySeq);
		await db
			.prepare("INSERT INTO branch_tips (session_id, tip_id, branch_id) VALUES (?, ?, ?)")
			.run(sessionId, entryId, branchId);
		return;
	}

	// 父条目是某分支的叶子：直接在该分支上追加。
	let tip = await db
		.prepare("SELECT branch_id FROM branch_tips WHERE session_id = ? AND tip_id = ?")
		.get<{ branch_id: string }>(sessionId, parentId);
	if (tip) {
		await extendBranch(db, sessionId, tip.branch_id, parentId, entryId, entrySeq);
		return;
	}

	// 父条目存在于某个分支中间：找到该分支，用于分裂出新分支。
	const source = await db
		.prepare(
			`SELECT b.branch_id, b.entry_seq
			FROM branch_entries AS b
			WHERE b.session_id = ? AND b.entry_id = ?
			ORDER BY b.branch_id
			LIMIT 1`,
		)
		.get<{ branch_id: string; entry_seq: number }>(sessionId, parentId);
	if (!source) {
		// 父条目不在任何缓存分支中：先修复父链，再尝试追加。
		await repairParent(parentId);
		tip = await db
			.prepare("SELECT branch_id FROM branch_tips WHERE session_id = ? AND tip_id = ?")
			.get<{ branch_id: string }>(sessionId, parentId);
		if (!tip) throw invalidSession(`branch cache repair did not create tip ${parentId}`);
		await extendBranch(db, sessionId, tip.branch_id, parentId, entryId, entrySeq);
		return;
	}

	// 复制父条目所在分支到父条目位置的路径，作为新分支的前缀。
	const branchId = uuidv7();
	await db
		.prepare(
			`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq)
			SELECT session_id, ?, entry_id, entry_seq
			FROM branch_entries
			WHERE session_id = ? AND branch_id = ? AND entry_seq <= ?`,
		)
		.run(branchId, sessionId, source.branch_id, source.entry_seq);
	await db
		.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
		.run(sessionId, branchId, entryId, entrySeq);
	await db
		.prepare("INSERT INTO branch_tips (session_id, tip_id, branch_id) VALUES (?, ?, ?)")
		.run(sessionId, entryId, branchId);
}

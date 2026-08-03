import type {
	SessionBranchQuery,
	SessionEntryCursorOptions,
	SessionHead,
	SessionStats,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";

/** 从条目中派生的聚合投影：会话名称、标签表与 token 统计。 */
interface SessionEntryProjection {
	name: string | undefined;
	labelsById: Map<string, string>;
	stats: SessionStats;
}

/** 创建一份全新的空投影。 */
function createProjection(): SessionEntryProjection {
	return {
		name: undefined,
		labelsById: new Map(),
		stats: { messageCount: 0, cachedTokens: 0, uncachedTokens: 0, totalTokens: 0, costTotal: 0 },
	};
}

/** 将一条条目并入投影：更新会话名/标签，并累加 assistant 消息的 token 用量。 */
function applyProjection(projection: SessionEntryProjection, entry: SessionTreeEntry): void {
	if (entry.type === "session_info") {
		projection.name = entry.name?.trim() || undefined;
	} else if (entry.type === "label") {
		const label = entry.label?.trim();
		if (label) projection.labelsById.set(entry.targetId, label);
		else projection.labelsById.delete(entry.targetId);
	}
	if (entry.type === "message") projection.stats.messageCount += 1;
	const usage =
		entry.type === "message"
			? entry.message.role === "assistant"
				? entry.message.usage
				: undefined
			: entry.type === "compaction" || entry.type === "branch_summary"
				? entry.usage
				: undefined;
	if (
		!usage ||
		typeof usage.input !== "number" ||
		typeof usage.output !== "number" ||
		typeof usage.cacheRead !== "number" ||
		typeof usage.cacheWrite !== "number" ||
		typeof usage.cost?.total !== "number"
	) {
		return;
	}
	projection.stats.cachedTokens += usage.cacheRead;
	projection.stats.uncachedTokens += usage.input + usage.cacheWrite;
	projection.stats.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	projection.stats.costTotal += usage.cost.total;
}

/** 基于数组的会话存储索引：保存有序条目并提供按 id 查找、分支回溯与派生投影。 */
export class ArraySessionIndex {
	/** 全部条目的顺序数组。 */
	private entries: SessionTreeEntry[] = [];
	/** 条目 id 到条目的映射，用于 O(1) 查找。 */
	private byId = new Map<string, SessionTreeEntry>();
	/** 当前叶子条目 id。 */
	private leafId: string | null = null;
	/** 由条目派生的聚合投影（名称、标签、统计）。 */
	private projection = createProjection();

	/**
	 * 构造索引。
	 * @param entries - 初始条目列表，将整体替换到索引中。
	 */
	constructor(entries: readonly SessionTreeEntry[] = []) {
		this.replace(entries);
	}

	/** 判断指定 id 的条目是否存在。 */
	has(id: string): boolean {
		return this.byId.has(id);
	}

	/** 追加一条条目，校验 id 唯一性并更新叶子指针与投影。 */
	append(entry: SessionTreeEntry): void {
		if (this.byId.has(entry.id)) {
			throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
		}
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.type === "leaf" ? entry.targetId : entry.id;
		applyProjection(this.projection, entry);
	}

	/** 用一组条目整体替换索引内容（重建映射、叶子指针与投影）。 */
	replace(entries: readonly SessionTreeEntry[]): void {
		const nextEntries = [...entries];
		const nextById = new Map<string, SessionTreeEntry>();
		const nextProjection = createProjection();
		let nextLeafId: string | null = null;
		for (const entry of nextEntries) {
			if (nextById.has(entry.id)) {
				throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
			}
			nextById.set(entry.id, entry);
			nextLeafId = entry.type === "leaf" ? entry.targetId : entry.id;
			applyProjection(nextProjection, entry);
		}
		this.entries = nextEntries;
		this.byId = nextById;
		this.leafId = nextLeafId;
		this.projection = nextProjection;
	}

	/** 返回当前会话头部（叶子条目 id），若叶子指针失效则报错。 */
	readHead(): SessionHead {
		if (this.leafId !== null && !this.byId.has(this.leafId)) {
			throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
		}
		return { leafId: this.leafId };
	}

	/** 按 id 读取单条条目。 */
	readEntry(id: string): SessionTreeEntry | undefined {
		return this.byId.get(id);
	}

	/** 按游标（起始序号 + 限制条数）切片读取条目。 */
	readEntries(options?: SessionEntryCursorOptions): readonly SessionTreeEntry[] {
		const start = options?.afterEntrySeq ?? 0;
		const end = options?.limit === undefined ? undefined : start + options.limit;
		return this.entries.slice(start, end);
	}

	/** 在分支上按查询条件回溯查找条目，支持方向、停止条件、类型过滤与条数限制。 */
	findEntriesOnBranch(query: SessionBranchQuery & { start: string | null }): readonly SessionTreeEntry[] {
		if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
			throw new RangeError("Session branch query limit must be a positive integer");
		}
		if (query.start === null) return [];
		const pathFromStart: SessionTreeEntry[] = [];
		const visited = new Set<string>();
		let current = this.byId.get(query.start);
		if (!current) throw new SessionError("not_found", `Entry ${query.start} not found`);
		while (current) {
			if (visited.has(current.id)) {
				throw new SessionError("invalid_session", `Session branch contains a cycle at ${current.id}`);
			}
			visited.add(current.id);
			pathFromStart.push(current);
			if (query.order !== "oldestFirst" && (current.id === query.stopAtId || current.type === query.stopAtType)) {
				break;
			}
			if (!current.parentId) break;
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		const traversal = query.order === "oldestFirst" ? pathFromStart.reverse() : pathFromStart;
		const stopIndex =
			query.order === "oldestFirst"
				? traversal.findIndex((entry) => entry.id === query.stopAtId || entry.type === query.stopAtType)
				: -1;
		const bounded = stopIndex === -1 ? traversal : traversal.slice(0, stopIndex + 1);
		const entries = bounded.filter(
			(entry) =>
				(query.type === undefined || entry.type === query.type) &&
				(query.customType === undefined || (entry.type === "custom" && entry.customType === query.customType)),
		);
		return query.limit === undefined ? entries : entries.slice(0, query.limit);
	}

	/** 返回指定条目 id 的标签。 */
	getLabel(id: string): string | undefined {
		return this.projection.labelsById.get(id);
	}

	/** 返回会话名称（未设置时返回 undefined）。 */
	getName(): string | undefined {
		return this.projection.name;
	}

	/** 返回会话统计信息的副本。 */
	getStats(): SessionStats {
		return { ...this.projection.stats };
	}

	/** 从指定叶子回溯到根或最近压缩点的路径，压缩点带保留尾部时提前停止。 */
	readPathToRootOrCompaction(requestedLeafId: string | null): readonly SessionTreeEntry[] {
		if (requestedLeafId === null) return [];
		const path: SessionTreeEntry[] = [];
		let stopAtEntryId: string | null = null;
		let current = this.byId.get(requestedLeafId);
		if (!current) throw new SessionError("not_found", `Entry ${requestedLeafId} not found`);
		while (current) {
			path.push(current);
			if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
			if (current.type === "compaction") {
				if (current.retainedTail) break;
				stopAtEntryId = current.firstKeptEntryId ?? null;
			}
			if (!current.parentId) break;
			const parent = this.byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path.reverse();
	}
}

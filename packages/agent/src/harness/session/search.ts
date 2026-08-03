import type {
	SessionCreateOptions,
	SessionMetadata,
	SessionSearch,
	SessionSearchHit,
	SessionSearchOptions,
} from "../types.ts";
import type { SessionRepository } from "./repository.ts";
import type { Session } from "./session.ts";

/** 扫描式搜索的数据来源：能列出并打开全部会话即可。 */
type ScanningSessionSearchSource<TMetadata extends SessionMetadata> = {
	list(): Promise<TMetadata[]>;
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
};

/**
 * 扫描式会话搜索：直接遍历并打开所有会话，对每条条目做全文子串匹配，
 * 因为不使用预建索引，所以无需维护索引状态。
 */
class ScanningSessionSearch<TMetadata extends SessionMetadata = SessionMetadata> implements SessionSearch<TMetadata> {
	/** 提供会话列表与打开能力的来源。 */
	private readonly source: ScanningSessionSearchSource<TMetadata>;

	/**
	 * 构造扫描式搜索。
	 * @param source - 会话列表/打开来源（通常是仓库）。
	 */
	constructor(source: ScanningSessionSearchSource<TMetadata>) {
		this.source = source;
	}

	/** 在全部会话中搜索文本，返回命中的会话与条目片段。 */
	async search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]> {
		const normalizedText = options.text.trim().toLowerCase();
		if (!normalizedText) return [];
		const hits: SessionSearchHit<TMetadata>[] = [];
		for (const metadata of await this.source.list()) {
			const cwd = (metadata as { cwd?: unknown }).cwd;
			if (options.cwd !== undefined && cwd !== options.cwd) continue;
			const session = await this.source.open(metadata);
			for (const entry of await session.getEntries()) {
				const payload = JSON.stringify(entry);
				if (!payload.toLowerCase().includes(normalizedText)) continue;
				hits.push({ metadata, entryId: entry.id, timestamp: entry.timestamp, snippet: payload });
			}
		}
		return hits;
	}
}

/** 创建基于扫描的会话搜索实现（无索引、实时全量匹配）。 */
export function createScanningSessionSearch<
	TMetadata extends SessionMetadata,
	TCreateOptions extends SessionCreateOptions,
	TListOptions,
>(source: Pick<SessionRepository<TMetadata, TCreateOptions, TListOptions>, "list" | "open">): SessionSearch<TMetadata> {
	return new ScanningSessionSearch(source);
}

import { type ImageContent, type TextContent, type Usage, uuidv7 } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.ts";
import type {
	ActiveToolsChangeEntry,
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	LabelEntry,
	LeafEntry,
	MessageEntry,
	ModelChangeEntry,
	SessionBranchQuery,
	SessionContext,
	SessionEntryCursorOptions,
	SessionInfoEntry,
	SessionMetadata,
	SessionStats,
	SessionStorage,
	SessionTreeEntry,
	ThinkingLevelChangeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";

/** 上下文条目转换器：对会话路径条目做整体变换（如过滤、重排），返回新的条目列表。 */
export type ContextEntryTransform = (entries: readonly SessionTreeEntry[]) => readonly SessionTreeEntry[];

/** 自定义条目投影器：把一条自定义条目投影为模型可见的消息数组；返回 undefined 表示跳过。 */
export type CustomEntryContextMessageProjector = (
	entry: CustomEntry,
	index: number,
	entries: readonly SessionTreeEntry[],
) => readonly AgentMessage[] | undefined;

/** 构建会话上下文（模型消息）时的可选配置。 */
export interface SessionContextBuildOptions {
	/** 在默认压缩转换之后额外应用的条目转换器。 */
	entryTransforms?: readonly ContextEntryTransform[];
	/** 可选的自定义条目投影器。默认情况下自定义条目不会出现在模型上下文中。 */
	entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
}

/** 从路径条目中推导会话上下文状态：当前思考级别、模型与启用的工具。 */
function deriveSessionContextState(pathEntries: readonly SessionTreeEntry[]): Omit<SessionContext, "messages"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let activeToolNames: string[] | null = null;

	for (const entry of pathEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "active_tools_change") {
			activeToolNames = [...entry.activeToolNames];
		}
	}

	return { thinkingLevel, model, activeToolNames };
}

/** 默认上下文转换：只保留最近的压缩条目及其保留的尾部，或从首个保留条目开始的后续内容。 */
export function defaultContextEntryTransform(pathEntries: readonly SessionTreeEntry[]): SessionTreeEntry[] {
	let compaction: CompactionEntry | null = null;
	for (const entry of pathEntries) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}
	if (!compaction) {
		return [...pathEntries];
	}

	const entries: SessionTreeEntry[] = [compaction];
	const compactionIdx = pathEntries.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);
	if (compaction.retainedTail) {
		for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
			entries.push(pathEntries[i]!);
		}
		return entries;
	}
	if (compaction.firstKeptEntryId) {
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = pathEntries[i]!;
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) entries.push(entry);
		}
	}
	for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
		entries.push(pathEntries[i]!);
	}
	return entries;
}

/** 按默认转换与用户附加的转换器构建上下文条目列表。 */
export function buildContextEntries(
	pathEntries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): SessionTreeEntry[] {
	let entries = defaultContextEntryTransform(pathEntries);
	for (const transform of options.entryTransforms ?? []) {
		entries = [...transform(entries)];
	}
	return entries;
}

/** 将单条会话条目转换为模型上下文消息：消息/自定义消息/压缩/分支摘要各按规则映射。 */
export function sessionEntryToContextMessages(
	entry: SessionTreeEntry,
	index: number,
	entries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): AgentMessage[] {
	if (entry.type === "message") {
		return [entry.message as AgentMessage];
	}
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(
				entry.customType,
				entry.content as string | (TextContent | ImageContent)[],
				entry.display,
				entry.details,
				entry.timestamp,
			),
		];
	}
	if (entry.type === "compaction") {
		return [
			createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
			...(entry.retainedTail ?? []),
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "custom") {
		return [...(options.entryProjectors?.[entry.customType]?.(entry, index, entries) ?? [])];
	}
	return [];
}

/** 根据会话路径条目构建完整的模型上下文（含思考级别、模型、工具与消息）。 */
export function buildSessionContext(
	pathEntries: readonly SessionTreeEntry[],
	options: SessionContextBuildOptions = {},
): SessionContext {
	const state = deriveSessionContextState(pathEntries);
	const contextEntries = buildContextEntries(pathEntries, options);
	const messages = contextEntries.flatMap((entry, index) =>
		sessionEntryToContextMessages(entry, index, contextEntries, options),
	);
	return { ...state, messages };
}

/**
 * 会话对象：封装底层存储，提供读取路径条目、追加各类条目、构建模型上下文、
 * 移动叶子指针等操作，并保证追加操作按序串行执行。
 */
export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
	/** 底层会话存储（JSONL 或内存实现）。 */
	private readonly storage: SessionStorage<TMetadata>;
	/** 会话元数据（id、创建时间、cwd 等）。 */
	private readonly metadata: TMetadata;
	/** 当前叶子条目 id，标识会话树中的当前位置。 */
	private leafId: string | null;
	/** 默认的上下文构建选项，在 buildContext 时与调用方选项合并。 */
	private readonly contextBuildOptions: SessionContextBuildOptions;
	/** 追加操作链的尾部 Promise，用于保证追加按序执行。 */
	private appendTail: Promise<void> = Promise.resolve();

	/**
	 * @internal 请通过 SessionRepository 构造会话实例。
	 * @param storage - 底层会话存储。
	 * @param leafId - 当前叶子条目 id。
	 * @param contextBuildOptions - 默认的上下文构建选项。
	 */
	constructor(
		storage: SessionStorage<TMetadata>,
		leafId: string | null,
		contextBuildOptions: SessionContextBuildOptions = {},
	) {
		this.storage = storage;
		this.metadata = storage.metadata;
		this.leafId = leafId;
		this.contextBuildOptions = contextBuildOptions;
	}

	/** 返回会话元数据。 */
	async getMetadata(): Promise<TMetadata> {
		return this.metadata;
	}
	/** 返回当前叶子条目 id。 */
	async getLeafId(): Promise<string | null> {
		return this.leafId;
	}
	/** 按 id 读取单条会话条目。 */
	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.storage.readEntry(id);
	}
	/** 按游标选项读取条目列表。 */
	async getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		return [...(await this.storage.readEntries(options))];
	}

	/** 读取从当前叶子（或指定条目）到根或最近压缩点的路径条目。 */
	async getBranch(fromId?: string | null): Promise<SessionTreeEntry[]> {
		return [...(await this.storage.readPathToRootOrCompaction(fromId === undefined ? this.leafId : fromId))];
	}

	/** 在分支上按查询条件查找条目，默认从当前叶子开始回溯。 */
	async findEntriesOnBranch(query: SessionBranchQuery = {}): Promise<SessionTreeEntry[]> {
		return [
			...(await this.storage.findEntriesOnBranch({
				...query,
				start: query.start === undefined ? this.leafId : query.start,
			})),
		];
	}

	/** 在分支上查找符合条件的第一条条目。 */
	async findEntryOnBranch(query: SessionBranchQuery = {}): Promise<SessionTreeEntry | undefined> {
		return (await this.findEntriesOnBranch({ ...query, limit: 1 }))[0];
	}

	/** 构建上下文条目列表（应用默认压缩转换与调用方附加转换器）。 */
	async buildContextEntries(options: SessionContextBuildOptions = {}): Promise<SessionTreeEntry[]> {
		return buildContextEntries(await this.getBranch(), this.mergeContextBuildOptions(options));
	}

	/** 构建完整的模型上下文（消息与派生状态）。 */
	async buildContext(options: SessionContextBuildOptions = {}): Promise<SessionContext> {
		return buildSessionContext(await this.getBranch(), this.mergeContextBuildOptions(options));
	}

	/** 合并默认与调用方提供的上下文构建选项，调用方选项优先。 */
	private mergeContextBuildOptions(options: SessionContextBuildOptions): SessionContextBuildOptions {
		return {
			entryTransforms: [...(this.contextBuildOptions.entryTransforms ?? []), ...(options.entryTransforms ?? [])],
			entryProjectors: {
				...(this.contextBuildOptions.entryProjectors ?? {}),
				...(options.entryProjectors ?? {}),
			},
		};
	}

	/** 返回指定条目的标签。 */
	async getLabel(id: string): Promise<string | undefined> {
		return this.storage.getLabel(id);
	}
	/** 返回会话统计信息（消息数、token 用量等）。 */
	async getSessionStats(): Promise<SessionStats> {
		return this.storage.getStats();
	}
	/** 返回会话名称。 */
	async getSessionName(): Promise<string | undefined> {
		return this.storage.getName();
	}

	/** 生成一条在会话内不重复的短条目 id（重试有限次数后回退到完整 uuid）。 */
	private async createEntryId(): Promise<string> {
		for (let i = 0; i < 100; i++) {
			const id = uuidv7().slice(-8);
			if (!(await this.getEntry(id))) return id;
		}
		return uuidv7();
	}

	/** 将追加操作串行入队，返回该条目；写入完成后更新叶子指针。 */
	private enqueueAppend<TEntry extends SessionTreeEntry>(
		createEntry: (base: Pick<SessionTreeEntry, "id" | "parentId" | "timestamp">) => TEntry,
	): Promise<TEntry> {
		const commit = this.appendTail.then(async () => {
			const entry = createEntry({
				id: await this.createEntryId(),
				parentId: this.leafId,
				timestamp: new Date().toISOString(),
			});
			await this.storage.appendEntry(entry);
			this.leafId = entry.type === "leaf" ? entry.targetId : entry.id;
			return entry;
		});
		this.appendTail = commit.then(
			() => undefined,
			() => undefined,
		);
		return commit;
	}

	/** 移动叶子指针到指定条目，并以 leaf 条目记录该移动。 */
	private async setLeafId(leafId: string | null): Promise<LeafEntry> {
		if (leafId !== null && !(await this.getEntry(leafId))) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		return this.enqueueAppend((base) => {
			return { ...base, type: "leaf", targetId: leafId };
		});
	}

	/** 追加一条类型化条目并返回其 id。 */
	private async appendTypedEntry<TEntry extends SessionTreeEntry>(
		createEntry: (base: Pick<SessionTreeEntry, "id" | "parentId" | "timestamp">) => TEntry,
	): Promise<string> {
		return (await this.enqueueAppend(createEntry)).id;
	}

	/** 追加一条消息条目，返回条目 id。 */
	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "message",
					message,
				}) satisfies MessageEntry,
		);
	}

	/** 追加一条思考级别变更条目。 */
	async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "thinking_level_change",
					thinkingLevel,
				}) satisfies ThinkingLevelChangeEntry,
		);
	}

	/** 追加一条模型变更条目。 */
	async appendModelChange(provider: string, modelId: string): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "model_change",
					provider,
					modelId,
				}) satisfies ModelChangeEntry,
		);
	}

	/** 追加一条启用工具变更条目。 */
	async appendActiveToolsChange(activeToolNames: string[]): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "active_tools_change",
					activeToolNames: [...activeToolNames],
				}) satisfies ActiveToolsChangeEntry,
		);
	}

	/** 追加一条压缩条目，记录摘要、首个保留条目与 token 统计。 */
	async appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string | undefined,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
		retainedTail?: AgentMessage[],
	): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "compaction",
					summary,
					firstKeptEntryId,
					tokensBefore,
					retainedTail,
					details,
					usage,
					fromHook,
				}) satisfies CompactionEntry<T>,
		);
	}

	/** 追加一条自定义数据条目（不直接作为模型消息）。 */
	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "custom",
					customType,
					data,
				}) satisfies CustomEntry,
		);
	}

	/** 追加一条自定义消息条目（可作为模型上下文展示）。 */
	async appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): Promise<string> {
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "custom_message",
					customType,
					content,
					display,
					details,
				}) satisfies CustomMessageEntry<T>,
		);
	}

	/** 为指定条目追加标签（label 为空字符串时删除标签）。 */
	async appendLabel(targetId: string, label: string | undefined): Promise<string> {
		if (!(await this.getEntry(targetId))) {
			throw new SessionError("not_found", `Entry ${targetId} not found`);
		}
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "label",
					targetId,
					label,
				}) satisfies LabelEntry,
		);
	}

	/** 追加会话名称条目，清洗掉换行并去除首尾空白。 */
	async appendSessionName(name: string): Promise<string> {
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "session_info",
					name: sanitizedName,
				}) satisfies SessionInfoEntry,
		);
	}

	/** 移动叶子指针到目标条目，可附加一条分支摘要条目。 */
	async moveTo(
		entryId: string | null,
		summary?: { summary: string; details?: unknown; usage?: Usage; fromHook?: boolean },
	): Promise<string | undefined> {
		if (entryId !== null && !(await this.getEntry(entryId))) {
			throw new SessionError("not_found", `Entry ${entryId} not found`);
		}
		await this.setLeafId(entryId);
		if (!summary) return undefined;
		return this.appendTypedEntry(
			(base) =>
				({
					...base,
					type: "branch_summary",
					fromId: entryId ?? "root",
					summary: summary.summary,
					details: summary.details,
					usage: summary.usage,
					fromHook: summary.fromHook,
				}) satisfies BranchSummaryEntry,
		);
	}
}

/** 为 SessionRepository 实现包装一个已打开的存储连接，返回对应的 {@link Session}。 */
export async function createSession<TMetadata extends SessionMetadata>(
	storage: SessionStorage<TMetadata>,
	contextBuildOptions: SessionContextBuildOptions = {},
): Promise<Session<TMetadata>> {
	return new Session(storage, (await storage.readHead()).leafId, contextBuildOptions);
}

import type { SessionTreeEntry, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { invalidSession, isRecord } from "./shared.ts";

/** 会话级物化汇总行：`payload` 为序列化的汇总 JSON。 */
export interface SessionMaterializedRow {
	session_id: string;
	payload: string;
}

/** 条目级物化行：记录需要单独存储的条目（目前仅 label）。 */
export interface EntryMaterializedRow {
	session_id: string;
	entry_seq: number;
	type: string;
	payload: string;
}

/** 模型思考配置：记录某模型（provider + modelId）使用过的思考等级。 */
export interface ModelThinkingConfig {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
}

/** 会话的物化状态：由条目流增量维护，避免全量回放。 */
export interface SessionMaterializedState {
	name: string | undefined;
	messageCount: number;
	cachedTokens: number;
	uncachedTokens: number;
	totalTokens: number;
	costTotal: number;
	labelsById: Map<string, string>;
	modelThinkingConfigs: ModelThinkingConfig[];
	currentModel: { provider: string; modelId: string } | null;
	currentThinkingLevel: ThinkingLevel | null;
}

/** 持久化到 session_materialized.payload 的汇总结构（不含标签映射）。 */
interface SessionMaterializedSummary {
	name?: string;
	messageCount: number;
	cachedTokens: number;
	uncachedTokens: number;
	totalTokens: number;
	costTotal: number;
	currentModel?: { provider: string; modelId: string } | null;
	currentThinkingLevel?: ThinkingLevel | null;
}

/** 模型思考配置的比较函数，用于排序与去重。 */
function compareModelThinkingConfig(left: ModelThinkingConfig, right: ModelThinkingConfig): number {
	return (
		left.provider.localeCompare(right.provider) ||
		left.modelId.localeCompare(right.modelId) ||
		left.thinkingLevel.localeCompare(right.thinkingLevel)
	);
}

/** 去重（按 provider/modelId/thinkingLevel）并排序模型思考配置。 */
function normalizeModelThinkingConfigs(configs: readonly ModelThinkingConfig[]): ModelThinkingConfig[] {
	const unique = new Map<string, ModelThinkingConfig>();
	for (const config of configs) {
		unique.set(`${config.provider}\u0000${config.modelId}\u0000${config.thinkingLevel}`, config);
	}
	return [...unique.values()].sort(compareModelThinkingConfig);
}

/** 把一条新的模型思考配置并入状态中的配置列表。 */
function addModelThinkingConfig(
	state: SessionMaterializedState,
	provider: string,
	modelId: string,
	thinkingLevel: ThinkingLevel,
): void {
	state.modelThinkingConfigs = normalizeModelThinkingConfigs([
		...state.modelThinkingConfigs,
		{ provider, modelId, thinkingLevel },
	]);
}

/** 判断值是否为合法的思考等级。 */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

/** 从 assistant 消息中提取用量与模型信息；格式不符时返回 undefined。 */
function getAssistantUsage(message: unknown):
	| {
			provider: string;
			modelId: string;
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			costTotal: number;
	  }
	| undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	if (typeof message.provider !== "string" || typeof message.model !== "string") return undefined;
	if (!isRecord(message.usage) || !isRecord(message.usage.cost)) return undefined;
	const { input, output, cacheRead, cacheWrite } = message.usage;
	const costTotal = message.usage.cost.total;
	if (
		typeof input !== "number" ||
		typeof output !== "number" ||
		typeof cacheRead !== "number" ||
		typeof cacheWrite !== "number" ||
		typeof costTotal !== "number"
	) {
		return undefined;
	}
	return {
		provider: message.provider,
		modelId: message.model,
		input,
		output,
		cacheRead,
		cacheWrite,
		costTotal,
	};
}

/** 创建一个全零/全空的初始物化状态。 */
export function createEmptyMaterializedState(): SessionMaterializedState {
	return {
		name: undefined,
		messageCount: 0,
		cachedTokens: 0,
		uncachedTokens: 0,
		totalTokens: 0,
		costTotal: 0,
		labelsById: new Map<string, string>(),
		modelThinkingConfigs: [],
		currentModel: null,
		currentThinkingLevel: null,
	};
}

/** 把一条会话条目增量应用到物化状态（更新名称、标签、token、成本与模型信息）。 */
export function applyEntryToMaterializedState(state: SessionMaterializedState, entry: SessionTreeEntry): void {
	switch (entry.type) {
		case "session_info":
			state.name = entry.name?.trim() || undefined;
			break;
		case "label": {
			const label = entry.label?.trim();
			if (label) {
				state.labelsById.set(entry.targetId, label);
			} else {
				state.labelsById.delete(entry.targetId);
			}
			break;
		}
		case "model_change":
			state.currentModel = { provider: entry.provider, modelId: entry.modelId };
			if (state.currentThinkingLevel) {
				addModelThinkingConfig(state, entry.provider, entry.modelId, state.currentThinkingLevel);
			}
			break;
		case "thinking_level_change":
			if (!isThinkingLevel(entry.thinkingLevel)) break;
			state.currentThinkingLevel = entry.thinkingLevel;
			if (state.currentModel) {
				addModelThinkingConfig(state, state.currentModel.provider, state.currentModel.modelId, entry.thinkingLevel);
			}
			break;
		case "message": {
			state.messageCount += 1;
			const usage = getAssistantUsage(entry.message);
			if (!usage) break;
			state.cachedTokens += usage.cacheRead;
			state.uncachedTokens += usage.input + usage.cacheWrite;
			state.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			state.costTotal += usage.costTotal;
			state.currentModel = { provider: usage.provider, modelId: usage.modelId };
			if (state.currentThinkingLevel) {
				addModelThinkingConfig(state, usage.provider, usage.modelId, state.currentThinkingLevel);
			}
			break;
		}
		case "compaction":
		case "branch_summary": {
			const usage = entry.usage;
			if (
				!isRecord(usage) ||
				!isRecord(usage.cost) ||
				typeof usage.input !== "number" ||
				typeof usage.output !== "number" ||
				typeof usage.cacheRead !== "number" ||
				typeof usage.cacheWrite !== "number" ||
				typeof usage.cost.total !== "number"
			) {
				break;
			}
			state.cachedTokens += usage.cacheRead;
			state.uncachedTokens += usage.input + usage.cacheWrite;
			state.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			state.costTotal += usage.cost.total;
			break;
		}
		case "active_tools_change":
		case "custom":
		case "custom_message":
		case "leaf":
			break;
		default: {
			const exhaustive: never = entry;
			void exhaustive;
			break;
		}
	}
}

/** 把物化状态中的汇总字段序列化为 JSON 字符串，用于持久化。 */
export function serializeSummary(state: SessionMaterializedState): string {
	const summary: SessionMaterializedSummary = {
		name: state.name,
		messageCount: state.messageCount,
		cachedTokens: state.cachedTokens,
		uncachedTokens: state.uncachedTokens,
		totalTokens: state.totalTokens,
		costTotal: state.costTotal,
		currentModel: state.currentModel,
		currentThinkingLevel: state.currentThinkingLevel,
	};
	return JSON.stringify(summary);
}

/** 解析并校验会话汇总 JSON，非法时抛出 invalid_session 错误。 */
function parseSummary(json: string): SessionMaterializedSummary {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		throw invalidSession(
			`materialized session summary is not valid JSON`,
			error instanceof Error ? error : undefined,
		);
	}
	if (!isRecord(parsed) || Array.isArray(parsed)) {
		throw invalidSession("materialized session summary is not an object");
	}
	const currentModel = parsed.currentModel;
	const currentThinkingLevel = parsed.currentThinkingLevel;
	if (
		(parsed.name !== undefined && typeof parsed.name !== "string") ||
		typeof parsed.messageCount !== "number" ||
		typeof parsed.cachedTokens !== "number" ||
		typeof parsed.uncachedTokens !== "number" ||
		typeof parsed.totalTokens !== "number" ||
		typeof parsed.costTotal !== "number" ||
		(currentModel !== undefined &&
			currentModel !== null &&
			(!isRecord(currentModel) ||
				typeof currentModel.provider !== "string" ||
				typeof currentModel.modelId !== "string")) ||
		(currentThinkingLevel !== undefined && currentThinkingLevel !== null && !isThinkingLevel(currentThinkingLevel))
	) {
		throw invalidSession("materialized session summary has invalid fields");
	}
	return {
		name: parsed.name?.trim() || undefined,
		messageCount: parsed.messageCount,
		cachedTokens: parsed.cachedTokens,
		uncachedTokens: parsed.uncachedTokens,
		totalTokens: parsed.totalTokens,
		costTotal: parsed.costTotal,
		currentModel:
			currentModel && isRecord(currentModel)
				? { provider: currentModel.provider as string, modelId: currentModel.modelId as string }
				: (currentModel ?? undefined),
		currentThinkingLevel: (currentThinkingLevel as ThinkingLevel | null | undefined) ?? undefined,
	};
}

/** 解析单条条目级物化数据的 JSON 载荷。 */
function parseEntryMaterializedPayload(row: EntryMaterializedRow): unknown {
	try {
		return JSON.parse(row.payload);
	} catch (error) {
		throw invalidSession(
			`materialized entry row ${row.entry_seq} is not valid JSON`,
			error instanceof Error ? error : undefined,
		);
	}
}

/** 从数据库行（汇总 + 条目级物化）重建完整的物化状态。 */
export function materializedStateFromRows(
	summaryRow: SessionMaterializedRow,
	entryRows: EntryMaterializedRow[],
): SessionMaterializedState {
	const summary = parseSummary(summaryRow.payload);
	const state: SessionMaterializedState = {
		name: summary.name,
		messageCount: summary.messageCount,
		cachedTokens: summary.cachedTokens,
		uncachedTokens: summary.uncachedTokens,
		totalTokens: summary.totalTokens,
		costTotal: summary.costTotal,
		labelsById: new Map<string, string>(),
		modelThinkingConfigs: [],
		currentModel: summary.currentModel ?? null,
		currentThinkingLevel: summary.currentThinkingLevel ?? null,
	};
	for (const row of entryRows) {
		const payload = parseEntryMaterializedPayload(row);
		if (!isRecord(payload)) throw invalidSession(`materialized entry row ${row.entry_seq} is not an object`);
		if (row.type === "label") {
			if (typeof payload.targetId !== "string") {
				throw invalidSession(`materialized label row ${row.entry_seq} is missing targetId`);
			}
			if (payload.label !== null && payload.label !== undefined && typeof payload.label !== "string") {
				throw invalidSession(`materialized label row ${row.entry_seq} has invalid label`);
			}
			const label = typeof payload.label === "string" ? payload.label.trim() : "";
			if (label) {
				state.labelsById.set(payload.targetId, label);
			} else {
				state.labelsById.delete(payload.targetId);
			}
		}
	}
	return state;
}

/** 把会话汇总转换为可写入 session_materialized 表的 (sessionId, payload) 元组。 */
export function materializedStateValues(
	sessionId: string,
	state: SessionMaterializedState,
): [sessionId: string, payload: string] {
	return [sessionId, serializeSummary(state)];
}

/** 生成写入 entry_materialized 表的行值；目前仅 label 条目需要单独物化存储。 */
export function entryMaterializedValues(
	entry: SessionTreeEntry,
): Array<{ type: EntryMaterializedRow["type"]; payload: string }> {
	switch (entry.type) {
		case "label":
			return [
				{
					type: "label",
					payload: JSON.stringify({ targetId: entry.targetId, label: entry.label ?? null }),
				},
			];
		case "model_change":
		case "thinking_level_change":
		case "message":
			return [];
		case "active_tools_change":
		case "branch_summary":
		case "compaction":
		case "custom":
		case "custom_message":
		case "leaf":
		case "session_info":
			return [];
		default: {
			const exhaustive: never = entry;
			void exhaustive;
			return [];
		}
	}
}

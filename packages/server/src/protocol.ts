import {
	type ImageContent as AiImageContent,
	type TextContent as AiTextContent,
	type Usage as AiUsage,
	type Api,
	type AssistantMessage,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
	type ToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type {
	AssistantTranscriptItem,
	JsonValue,
	ModelMetadata,
	ThinkingLevel,
	ToolTranscriptItem,
	Usage,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";

/** 编译期断言辅助：仅接受字面量 true，用于类型级校验。 */
type Assert<T extends true> = T;
/** 编译期断言辅助：判断 T 的所有键恰好等于 Keys（无多余、无缺失）。 */
type ExactKeys<T, Keys extends keyof T> = keyof T extends Keys ? true : false;
/** 编译期断言：pi-ai 的思考级别集合能匹配协议中的思考级别集合。 */
type _AiThinkingLevelsFitProtocol = Assert<ModelThinkingLevel extends ThinkingLevel ? true : false>;
/** 编译期断言：协议中的思考级别集合能匹配 pi-ai 的思考级别集合。 */
type _ProtocolThinkingLevelsFitAi = Assert<ThinkingLevel extends ModelThinkingLevel ? true : false>;
/** pi-ai 模型输入类型数组的元素类型。 */
type AiModelInput = Model<Api>["input"][number];
/** 协议模型元数据输入类型数组的元素类型。 */
type ProtocolModelInput = ModelMetadata["input"][number];
/** 编译期断言：pi-ai 的模型输入能匹配协议模型元数据的输入。 */
type _AiModelInputsFitProtocol = Assert<AiModelInput extends ProtocolModelInput ? true : false>;
/** 编译期断言：协议的模型输入能匹配 pi-ai 的模型输入。 */
type _ProtocolModelInputsFitAi = Assert<ProtocolModelInput extends AiModelInput ? true : false>;
/**
 * 逐个枚举被映射以及有意省略的 pi-ai 字段，使新增字段时在此处编译失败以强制同步协议映射。
 * 提供者重放元数据、诊断信息、缓存写入保留时长拆分、模型传输设置、
 * 定价分层以及延迟工具可用性等字段有意保留在服务端内部，不对外传输。
 */
type _AiTextContentFieldsAccountedFor = Assert<ExactKeys<AiTextContent, "type" | "text" | "textSignature">>;
/** 编译期断言：pi-ai 思考内容字段已逐一枚举。 */
type _AiThinkingContentFieldsAccountedFor = Assert<
	ExactKeys<
		Extract<AssistantMessage["content"][number], { type: "thinking" }>,
		"type" | "thinking" | "thinkingSignature" | "redacted"
	>
>;
/** 编译期断言：pi-ai 图片内容字段已逐一枚举。 */
type _AiImageContentFieldsAccountedFor = Assert<ExactKeys<AiImageContent, "type" | "data" | "mimeType">>;
/** 编译期断言：pi-ai 工具调用字段已逐一枚举。 */
type _AiToolCallFieldsAccountedFor = Assert<
	ExactKeys<ToolCall, "type" | "id" | "name" | "arguments" | "thoughtSignature">
>;
/** 编译期断言：pi-ai 用量字段已逐一枚举。 */
type _AiUsageFieldsAccountedFor = Assert<
	ExactKeys<
		AiUsage,
		"input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "reasoning" | "totalTokens" | "cost"
	>
>;
/** 编译期断言：pi-ai 用量成本字段已逐一枚举。 */
type _AiUsageCostFieldsAccountedFor = Assert<
	ExactKeys<AiUsage["cost"], "input" | "output" | "cacheRead" | "cacheWrite" | "total">
>;
/** 编译期断言：pi-ai 模型字段已逐一枚举。 */
type _AiModelFieldsAccountedFor = Assert<
	ExactKeys<
		Model<Api>,
		| "id"
		| "name"
		| "api"
		| "provider"
		| "baseUrl"
		| "reasoning"
		| "thinkingLevelMap"
		| "input"
		| "cost"
		| "contextWindow"
		| "maxTokens"
		| "headers"
		| "compat"
	>
>;
/** 编译期断言：pi-ai 模型成本字段已逐一枚举。 */
type _AiModelCostFieldsAccountedFor = Assert<
	ExactKeys<Model<Api>["cost"], "input" | "output" | "cacheRead" | "cacheWrite" | "tiers">
>;
/** 编译期断言：pi-ai 用户消息字段已逐一枚举。 */
type _AiUserMessageFieldsAccountedFor = Assert<ExactKeys<UserMessage, "role" | "content" | "timestamp">>;
/** 编译期断言：pi-ai 助手消息字段已逐一枚举。 */
type _AiAssistantMessageFieldsAccountedFor = Assert<
	ExactKeys<
		AssistantMessage,
		| "role"
		| "content"
		| "api"
		| "provider"
		| "model"
		| "responseModel"
		| "responseId"
		| "diagnostics"
		| "usage"
		| "stopReason"
		| "errorMessage"
		| "rawStopReason"
		| "timestamp"
	>
>;
/** 编译期断言：pi-ai 工具结果消息字段已逐一枚举。 */
type _AiToolResultMessageFieldsAccountedFor = Assert<
	ExactKeys<
		ToolResultMessage,
		"role" | "toolCallId" | "toolName" | "content" | "details" | "usage" | "addedToolNames" | "isError" | "timestamp"
	>
>;

/** 将助手消息转换为协议抄本条目时的附加选项。 */
export interface AssistantTranscriptOptions {
	/** 抄本条目的唯一 ID。 */
	id: string;
}

/** 将用户消息转换为协议抄本条目时的附加选项。 */
export interface UserTranscriptOptions {
	/** 抄本条目的唯一 ID。 */
	id: string;
}

/** 将工具结果消息转换为协议抄本条目时的附加选项。 */
export interface ToolTranscriptOptions {
	/** 抄本条目的唯一 ID。 */
	id: string;
	/** 对应的工具调用，用于校验并补充输入参数。 */
	call: ToolCall;
}

/** 将可选数值规范化为非负整数；非法或缺失时返回 undefined。 */
function nonNegativeInteger(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

/** 将数值规范化为非负数；非有限数值按 0 处理。 */
function nonNegativeNumber(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** 校验字符串标识符（必须为非空字符串），返回原值，用于协议字段的输入校验。 */
function identifier(value: string, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

/** 校验协议时间戳（必须为非负安全整数），返回原值。 */
function timestamp(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new TypeError("Protocol timestamps must be non-negative integers");
	return value;
}

/** 校验并复制一个来自执行边界的值，使其落入协议约定的 JSON 兼容子集（拒绝非有限数与循环引用）。 */
export function toProtocolJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Protocol JSON numbers must be finite");
		return value;
	}
	if (typeof value !== "object") throw new TypeError(`Unsupported protocol JSON value: ${typeof value}`);
	if (seen.has(value)) throw new TypeError("Protocol JSON values must not contain circular references");
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Protocol JSON objects must be plain objects");
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) return Array.from(value, (entry) => toProtocolJsonValue(entry, seen));
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) result[key] = toProtocolJsonValue(entry, seen);
		return result;
	} finally {
		seen.delete(value);
	}
}

/** 有损地净化工具诊断详情：确保其结果不影响执行语义（例如把 BigInt、Date 转为字符串）。 */
export function sanitizeProtocolDetails(value: unknown, seen = new Set<object>()): JsonValue | undefined {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
	if (value instanceof Date) return value.toISOString();
	if (typeof value !== "object") return String(value);
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	try {
		if (Array.isArray(value)) return Array.from(value, (entry) => sanitizeProtocolDetails(entry, seen) ?? null);
		const result: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) {
			const normalized = sanitizeProtocolDetails(entry, seen);
			if (normalized !== undefined) result[key] = normalized;
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

/** 将 pi-ai 的用量数据转换为协议用量的规范形式（缺省字段补零、非法值收敛为 0）。 */
export function toProtocolUsage(usage: AiUsage | undefined): Usage | undefined {
	if (!usage) return undefined;
	const reasoning = nonNegativeInteger(usage.reasoning);
	const result = {
		input: nonNegativeInteger(usage.input) ?? 0,
		output: nonNegativeInteger(usage.output) ?? 0,
		cacheRead: nonNegativeInteger(usage.cacheRead) ?? 0,
		cacheWrite: nonNegativeInteger(usage.cacheWrite) ?? 0,
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: nonNegativeInteger(usage.totalTokens) ?? 0,
		cost: {
			input: nonNegativeNumber(usage.cost.input),
			output: nonNegativeNumber(usage.cost.output),
			cacheRead: nonNegativeNumber(usage.cost.cacheRead),
			cacheWrite: nonNegativeNumber(usage.cost.cacheWrite),
			total: nonNegativeNumber(usage.cost.total),
		},
	} satisfies Usage;
	return result;
}

/** 将 pi-ai 模型元数据转换为协议元数据，供客户端展示与选择模型。 */
export function toProtocolModelMetadata(model: Model<Api>, authenticated: boolean): ModelMetadata {
	const result = {
		provider: identifier(model.provider, "Model provider"),
		id: identifier(model.id, "Model id"),
		name: identifier(model.name, "Model name"),
		api: identifier(model.api, "Model API"),
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: Math.max(1, Math.floor(model.contextWindow)),
		maxTokens: Math.max(1, Math.floor(model.maxTokens)),
		cost: {
			input: nonNegativeNumber(model.cost.input),
			output: nonNegativeNumber(model.cost.output),
			cacheRead: nonNegativeNumber(model.cost.cacheRead),
			cacheWrite: nonNegativeNumber(model.cost.cacheWrite),
		},
		supportedThinkingLevels: getSupportedThinkingLevels(model),
		authenticated,
	} satisfies ModelMetadata;
	return result;
}

/** 将 pi-ai 用户消息内容转换为协议抄本的用户内容（字符串展开为单条文本）。 */
function toProtocolUserContent(content: UserMessage["content"]): UserTranscriptItem["content"] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((part) => {
		switch (part.type) {
			case "text":
				return { type: "text", text: part.text };
			case "image":
				return { type: "image", data: part.data, mimeType: part.mimeType };
			default: {
				const exhaustive: never = part;
				return exhaustive;
			}
		}
	});
}

/** 将 pi-ai 用户消息转换为协议抄本条目（校验 ID 与时间戳）。 */
export function toProtocolUserMessage(message: UserMessage, options: UserTranscriptOptions): UserTranscriptItem {
	const result = {
		id: identifier(options.id, "Transcript item id"),
		role: "user",
		content: toProtocolUserContent(message.content),
		timestamp: timestamp(message.timestamp),
	} satisfies UserTranscriptItem;
	return result;
}

/** 将 pi-ai 助手消息内容转换为协议抄本的助手内容（文本/思考/工具调用）。 */
function toProtocolAssistantContent(message: AssistantMessage): AssistantTranscriptItem["content"] {
	return message.content.map((part) => {
		switch (part.type) {
			case "text":
				return { type: "text", text: part.text };
			case "thinking":
				return {
					type: "thinking",
					thinking: part.thinking,
					...(part.redacted === undefined ? {} : { redacted: part.redacted }),
				};
			case "toolCall":
				return {
					type: "toolCall",
					toolCallId: identifier(part.id, "Tool call id"),
					toolName: identifier(part.name, "Tool call name"),
					input: toProtocolJsonValue(part.arguments),
				};
			default: {
				const exhaustive: never = part;
				return exhaustive;
			}
		}
	});
}

/** 将 pi-ai 助手消息转换为协议抄本条目，并根据停止原因映射为不同状态（流式中/完成/错误/中止）。 */
export function toProtocolAssistantMessage(
	message: AssistantMessage,
	options: AssistantTranscriptOptions,
): AssistantTranscriptItem {
	const usage = toProtocolUsage(message.usage);
	const common = {
		id: identifier(options.id, "Transcript item id"),
		role: "assistant",
		content: toProtocolAssistantContent(message),
		model: {
			provider: identifier(message.provider, "Assistant provider"),
			id: identifier(message.model, "Assistant model"),
		},
		...(message.responseModel === undefined
			? {}
			: { responseModel: identifier(message.responseModel, "Assistant response model") }),
		...(usage ? { usage } : {}),
		timestamp: timestamp(message.timestamp),
	} as const;
	switch (message.stopReason) {
		case "pending":
			return { ...common, status: "streaming" } satisfies AssistantTranscriptItem;
		case "stop":
		case "length":
		case "toolUse":
			return {
				...common,
				status: "complete",
				stopReason: message.stopReason,
			} satisfies AssistantTranscriptItem;
		case "error":
			if (message.errorMessage?.length === 0) {
				throw new TypeError("Assistant error messages must not be empty");
			}
			return {
				...common,
				status: "error",
				stopReason: "error",
				...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
			} satisfies AssistantTranscriptItem;
		case "aborted":
			return {
				...common,
				status: "aborted",
				stopReason: "aborted",
				...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
			} satisfies AssistantTranscriptItem;
		default: {
			const exhaustive: never = message.stopReason;
			return exhaustive;
		}
	}
}

/** 将工具结果内容转换为协议抄本的工具内容（文本/图片）。 */
function toProtocolToolContent(content: Array<AiTextContent | AiImageContent>): ToolTranscriptItem["content"] {
	return content.map((part) => {
		switch (part.type) {
			case "text":
				return { type: "text", text: part.text };
			case "image":
				return { type: "image", data: part.data, mimeType: part.mimeType };
			default: {
				const exhaustive: never = part;
				return exhaustive;
			}
		}
	});
}

/** 将 pi-ai 工具结果消息转换为协议抄本条目，并校验其结果确实对应给定的工具调用。 */
export function toProtocolToolResultMessage(
	message: ToolResultMessage,
	options: ToolTranscriptOptions,
): ToolTranscriptItem {
	const callId = identifier(options.call.id, "Tool call id");
	const callName = identifier(options.call.name, "Tool call name");
	if (identifier(message.toolCallId, "Tool result call id") !== callId) {
		throw new TypeError(`Tool result ${message.toolCallId} does not match tool call ${callId}`);
	}
	if (identifier(message.toolName, "Tool result name") !== callName) {
		throw new TypeError(`Tool result ${message.toolName} does not match tool call ${callName}`);
	}
	const details = sanitizeProtocolDetails(message.details);
	const usage = toProtocolUsage(message.usage);
	const common = {
		id: identifier(options.id, "Transcript item id"),
		role: "tool",
		toolCallId: callId,
		toolName: callName,
		input: toProtocolJsonValue(options.call.arguments),
		content: toProtocolToolContent(message.content),
		...(details === undefined ? {} : { details }),
		...(usage ? { usage } : {}),
		timestamp: timestamp(message.timestamp),
	} as const;
	return message.isError
		? ({ ...common, status: "error", isError: true } satisfies ToolTranscriptItem)
		: ({ ...common, status: "complete", isError: false } satisfies ToolTranscriptItem);
}

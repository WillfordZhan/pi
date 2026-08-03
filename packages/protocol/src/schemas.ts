import Type, { type Static } from "typebox";

/** 协议版本号。客户端与服务器必须一致才能通信。 */
export const PROTOCOL_VERSION = 2 as const;

/** 通用 ID 模式：非空字符串。 */
const IdSchema = Type.String({ minLength: 1 });
/** 通用时间戳模式：非负整数（毫秒）。 */
const TimestampSchema = Type.Integer({ minimum: 0 });
/** 创建不允许额外属性的严格对象模式，用于避免拼写错误的字段被悄悄接受。 */
const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

/** JSON 值类型：null、布尔、数字、字符串，或它们的数组/对象递归组合。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** 递归的 JSON 值模式，用于任意嵌套的 JSON 数据字段。 */
const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);
/** 递归 JSON 值的公开模式，供其他 schema 引用任意 JSON 数据字段。 */
export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

/** 思考级别模式：`off` 表示关闭思考，其余为递增的思考强度。 */
export const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
/** 思考级别类型，取自 {@link ThinkingLevelSchema}。 */
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

/** 会话阶段模式。与 AgentHarnessPhase 保持一致，使适配器无需第二套阶段词汇表。 */
export const SessionPhaseSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("turn"),
	Type.Literal("compaction"),
	Type.Literal("branch_summary"),
	Type.Literal("retry"),
]);
/** 会话阶段类型。 */
export type SessionPhase = Static<typeof SessionPhaseSchema>;

/** 模型引用模式：provider + 模型 id。 */
export const ModelRefSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
});
/** 模型引用类型。 */
export type ModelRef = Static<typeof ModelRefSchema>;

/** 模型成本模式：输入/输出/缓存读取/缓存写入的单价。 */
export const ModelCostSchema = StrictObject({
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
});

/** 模型元数据模式：描述模型的身份、能力、成本与支持的思考级别。 */
export const ModelMetadataSchema = StrictObject({
	provider: IdSchema,
	id: IdSchema,
	name: Type.String({ minLength: 1 }),
	api: IdSchema,
	reasoning: Type.Boolean(),
	input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
	contextWindow: Type.Integer({ minimum: 1 }),
	maxTokens: Type.Integer({ minimum: 1 }),
	cost: ModelCostSchema,
	supportedThinkingLevels: Type.Array(ThinkingLevelSchema, { minItems: 1 }),
	authenticated: Type.Boolean(),
});
/** 模型元数据类型。 */
export type ModelMetadata = Static<typeof ModelMetadataSchema>;

/** 文本内容块模式。 */
export const TextContentSchema = StrictObject({
	type: Type.Literal("text"),
	text: Type.String(),
});
/** 思考内容块模式；`redacted` 为 true 表示思考内容已被脱敏。 */
export const ThinkingContentSchema = StrictObject({
	type: Type.Literal("thinking"),
	thinking: Type.String(),
	redacted: Type.Optional(Type.Boolean()),
});
/** 图片内容块模式，`data` 为 base64 编码的图片数据。 */
export const ImageContentSchema = StrictObject({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String({ minLength: 1 }),
});
/** 工具调用内容块模式。 */
export const ToolCallContentSchema = StrictObject({
	type: Type.Literal("toolCall"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
});
/** 用户消息内容：文本或图片。 */
export const UserContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
/** 助手消息内容：文本、思考或工具调用。 */
export const AssistantContentSchema = Type.Union([TextContentSchema, ThinkingContentSchema, ToolCallContentSchema]);
/** 工具消息内容：文本或图片。 */
export const ToolContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);
/** 文本内容块的静态类型。 */
export type TextContent = Static<typeof TextContentSchema>;
/** 思考内容块的静态类型。 */
export type ThinkingContent = Static<typeof ThinkingContentSchema>;
/** 图片内容块的静态类型。 */
export type ImageContent = Static<typeof ImageContentSchema>;
/** 工具调用内容块的静态类型。 */
export type ToolCallContent = Static<typeof ToolCallContentSchema>;

/** token 用量与成本模式。 */
export const UsageSchema = StrictObject({
	input: Type.Integer({ minimum: 0 }),
	output: Type.Integer({ minimum: 0 }),
	cacheRead: Type.Integer({ minimum: 0 }),
	cacheWrite: Type.Integer({ minimum: 0 }),
	reasoning: Type.Optional(Type.Integer({ minimum: 0 })),
	totalTokens: Type.Integer({ minimum: 0 }),
	cost: StrictObject({
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		total: Type.Number({ minimum: 0 }),
	}),
});
/** 用量与成本类型。 */
export type Usage = Static<typeof UsageSchema>;

/** 用户消息在会话记录（transcript）中的条目模式。 */
export const UserTranscriptItemSchema = StrictObject({
	id: IdSchema,
	role: Type.Literal("user"),
	content: Type.Array(UserContentSchema),
	timestamp: TimestampSchema,
});
/** 助手消息条目的公共字段。 */
const AssistantTranscriptItemProperties = {
	id: IdSchema,
	role: Type.Literal("assistant"),
	content: Type.Array(AssistantContentSchema),
	model: ModelRefSchema,
	responseModel: Type.Optional(Type.String({ minLength: 1 })),
	usage: Type.Optional(UsageSchema),
	timestamp: TimestampSchema,
} as const;
/** 流式中状态的助手消息条目。 */
const StreamingAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("streaming"),
});
/** 完成状态的助手消息条目。 */
const CompleteAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("complete"),
	stopReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse")]),
});
/** 出错状态的助手消息条目。 */
const ErrorAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("error"),
	stopReason: Type.Literal("error"),
	errorMessage: Type.Optional(Type.String({ minLength: 1 })),
});
/** 中止状态的助手消息条目。 */
const AbortedAssistantTranscriptItemSchema = StrictObject({
	...AssistantTranscriptItemProperties,
	status: Type.Literal("aborted"),
	stopReason: Type.Literal("aborted"),
	errorMessage: Type.Optional(Type.String()),
});
/** 助手消息条目模式的联合：流式中、完成、出错、中止四种状态。 */
export const AssistantTranscriptItemSchema = Type.Union([
	StreamingAssistantTranscriptItemSchema,
	CompleteAssistantTranscriptItemSchema,
	ErrorAssistantTranscriptItemSchema,
	AbortedAssistantTranscriptItemSchema,
]);
/** 工具消息条目的公共字段。 */
const ToolTranscriptItemProperties = {
	id: IdSchema,
	role: Type.Literal("tool"),
	toolCallId: IdSchema,
	toolName: IdSchema,
	input: JsonValueSchema,
	content: Type.Array(ToolContentSchema),
	details: Type.Optional(JsonValueSchema),
	usage: Type.Optional(UsageSchema),
	timestamp: TimestampSchema,
} as const;
/** 运行中状态的工具消息条目。 */
const RunningToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("running"),
	isError: Type.Literal(false),
});
/** 完成状态的工具消息条目。 */
const CompleteToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("complete"),
	isError: Type.Literal(false),
});
/** 出错状态的工具消息条目。 */
const ErrorToolTranscriptItemSchema = StrictObject({
	...ToolTranscriptItemProperties,
	status: Type.Literal("error"),
	isError: Type.Literal(true),
});
/** 工具消息条目模式的联合：运行中、完成、出错三种状态。 */
export const ToolTranscriptItemSchema = Type.Union([
	RunningToolTranscriptItemSchema,
	CompleteToolTranscriptItemSchema,
	ErrorToolTranscriptItemSchema,
]);
/** 会话记录条目的联合模式：用户、助手或工具条目。 */
export const TranscriptItemSchema = Type.Union([
	UserTranscriptItemSchema,
	AssistantTranscriptItemSchema,
	ToolTranscriptItemSchema,
]);
/** 用户消息条目的静态类型。 */
export type UserTranscriptItem = Static<typeof UserTranscriptItemSchema>;
/** 助手消息条目的静态类型。 */
export type AssistantTranscriptItem = Static<typeof AssistantTranscriptItemSchema>;
/** 工具消息条目的静态类型。 */
export type ToolTranscriptItem = Static<typeof ToolTranscriptItemSchema>;
/** 会话记录条目的静态类型。 */
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

/** 归一化的增量活动事件。会话快照（snapshot）仍然是权威数据。 */
export const TranscriptProgressSchema = Type.Union([
	StrictObject({
		type: Type.Literal("item_started"),
		item: TranscriptItemSchema,
	}),
	StrictObject({
		type: Type.Literal("assistant_delta"),
		messageId: IdSchema,
		contentIndex: Type.Integer({ minimum: 0 }),
		kind: Type.Union([Type.Literal("text"), Type.Literal("thinking"), Type.Literal("toolCall")]),
		delta: Type.String(),
	}),
	StrictObject({
		type: Type.Literal("item_updated"),
		item: Type.Union([AssistantTranscriptItemSchema, ToolTranscriptItemSchema]),
	}),
	StrictObject({
		type: Type.Literal("item_finished"),
		item: Type.Union([
			CompleteAssistantTranscriptItemSchema,
			ErrorAssistantTranscriptItemSchema,
			AbortedAssistantTranscriptItemSchema,
			CompleteToolTranscriptItemSchema,
			ErrorToolTranscriptItemSchema,
		]),
	}),
]);
/** 增量活动事件的静态类型。 */
export type TranscriptProgress = Static<typeof TranscriptProgressSchema>;

/** 会话摘要（summary 与 snapshot 共用的）公共字段。 */
const SessionSummaryProperties = {
	id: IdSchema,
	name: Type.Optional(Type.String()),
	cwd: Type.String({ minLength: 1 }),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
	phase: SessionPhaseSchema,
	model: ModelRefSchema,
	thinkingLevel: ThinkingLevelSchema,
	attached: Type.Boolean(),
	locked: Type.Boolean(),
} as const;

/** 会话摘要模式：不含完整记录，用于列表展示。 */
export const SessionSummarySchema = StrictObject(SessionSummaryProperties);
/** 会话完整快照模式：包含记录、版本号与待处理的 steer 队列。 */
export const SessionSnapshotSchema = StrictObject({
	...SessionSummaryProperties,
	revision: Type.Integer({ minimum: 0 }),
	transcript: Type.Array(TranscriptItemSchema),
	queuedSteer: Type.Array(UserTranscriptItemSchema),
	queuedSteerCount: Type.Integer({ minimum: 0 }),
});
/** 会话摘要的静态类型。 */
export type SessionSummary = Static<typeof SessionSummarySchema>;
/** 会话快照的静态类型。 */
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;

/** 服务器快照模式：协议版本、会话摘要列表与模型元数据列表。 */
export const ServerSnapshotSchema = StrictObject({
	serverId: IdSchema,
	protocolVersion: Type.Literal(PROTOCOL_VERSION),
	revision: Type.Integer({ minimum: 0 }),
	sessions: Type.Array(SessionSummarySchema),
	models: Type.Array(ModelMetadataSchema),
});
/** 服务器快照的静态类型。 */
export type ServerSnapshot = Static<typeof ServerSnapshotSchema>;

/** 协议错误码模式：认证失败、版本不匹配、繁忙、会话被锁定、未找到、非法请求。 */
export const ProtocolErrorCodeSchema = Type.Union([
	Type.Literal("auth"),
	Type.Literal("version"),
	Type.Literal("busy"),
	Type.Literal("session_locked"),
	Type.Literal("not_found"),
	Type.Literal("invalid_request"),
]);
/** 协议错误模式：错误码、消息与可选的细节。 */
export const ProtocolErrorSchema = StrictObject({
	code: ProtocolErrorCodeSchema,
	message: Type.String(),
	details: Type.Optional(JsonValueSchema),
});
/** 协议错误码的静态类型。 */
export type ProtocolErrorCode = Static<typeof ProtocolErrorCodeSchema>;
/** 协议错误的静态类型。 */
export type ProtocolError = Static<typeof ProtocolErrorSchema>;

/** prompt/steer 命令共用的负载字段。 */
const PromptPayloadProperties = {
	sessionId: IdSchema,
	text: Type.String(),
} as const;

/** 列出会话命令模式。 */
export const ListCommandSchema = StrictObject({ command: Type.Literal("list") });
/** 创建会话命令模式，可选指定 cwd、名称、模型与思考级别。 */
export const CreateCommandSchema = StrictObject({
	command: Type.Literal("create"),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	name: Type.Optional(Type.String()),
	model: Type.Optional(ModelRefSchema),
	thinkingLevel: Type.Optional(ThinkingLevelSchema),
});
/** 附加（进入）会话命令模式。 */
export const AttachCommandSchema = StrictObject({ command: Type.Literal("attach"), sessionId: IdSchema });
/** 分离（退出）会话命令模式。 */
export const DetachCommandSchema = StrictObject({ command: Type.Literal("detach"), sessionId: IdSchema });
/** 发送提示词命令模式。 */
export const PromptCommandSchema = StrictObject({ command: Type.Literal("prompt"), ...PromptPayloadProperties });
/** 发送转向（steer）命令模式，用于向队列中插入用户消息。 */
export const SteerCommandSchema = StrictObject({ command: Type.Literal("steer"), ...PromptPayloadProperties });
/** 中止会话命令模式。 */
export const AbortCommandSchema = StrictObject({ command: Type.Literal("abort"), sessionId: IdSchema });
/** 切换会话模型命令模式。 */
export const SetModelCommandSchema = StrictObject({
	command: Type.Literal("set_model"),
	sessionId: IdSchema,
	model: ModelRefSchema,
});
/** 设置会话思考级别命令模式。 */
export const SetThinkingCommandSchema = StrictObject({
	command: Type.Literal("set_thinking"),
	sessionId: IdSchema,
	thinkingLevel: ThinkingLevelSchema,
});
/** 客户端所有命令的联合模式。 */
export const CommandSchema = Type.Union([
	ListCommandSchema,
	CreateCommandSchema,
	AttachCommandSchema,
	DetachCommandSchema,
	PromptCommandSchema,
	SteerCommandSchema,
	AbortCommandSchema,
	SetModelCommandSchema,
	SetThinkingCommandSchema,
]);
/** 命令的静态类型。 */
export type Command = Static<typeof CommandSchema>;
/** 命令名称类型，即命令的 `command` 字段。 */
export type CommandName = Command["command"];

/** 创建会话命令的结果模式。 */
export const CreateResultSchema = StrictObject({
	command: Type.Literal("create"),
	session: SessionSnapshotSchema,
});
/** 附加命令的结果模式。 */
export const AttachResultSchema = StrictObject({
	command: Type.Literal("attach"),
	session: SessionSnapshotSchema,
});
/** 提示词命令的结果模式。 */
export const PromptResultSchema = StrictObject({
	command: Type.Literal("prompt"),
	session: SessionSnapshotSchema,
});
/** 转向命令的结果模式。 */
export const SteerResultSchema = StrictObject({
	command: Type.Literal("steer"),
	session: SessionSnapshotSchema,
});
/** 中止命令的结果模式。 */
export const AbortResultSchema = StrictObject({
	command: Type.Literal("abort"),
	session: SessionSnapshotSchema,
});
/** 切换模型命令的结果模式。 */
export const SetModelResultSchema = StrictObject({
	command: Type.Literal("set_model"),
	session: SessionSnapshotSchema,
});
/** 设置思考级别命令的结果模式。 */
export const SetThinkingResultSchema = StrictObject({
	command: Type.Literal("set_thinking"),
	session: SessionSnapshotSchema,
});

/** 列出会话命令的结果模式。 */
export const ListResultSchema = StrictObject({
	command: Type.Literal("list"),
	sessions: Type.Array(SessionSummarySchema),
});
/** 分离命令的结果模式。 */
export const DetachResultSchema = StrictObject({
	command: Type.Literal("detach"),
	sessionId: IdSchema,
});
/** 命令结果的联合模式。 */
export const CommandResultSchema = Type.Union([
	ListResultSchema,
	CreateResultSchema,
	AttachResultSchema,
	DetachResultSchema,
	PromptResultSchema,
	SteerResultSchema,
	AbortResultSchema,
	SetModelResultSchema,
	SetThinkingResultSchema,
]);
/** 命令结果的静态类型。 */
export type CommandResult = Static<typeof CommandResultSchema>;

/** 根据具体命令类型提取对应的命令结果类型，用于类型安全的按命令分发。 */
export type ResultForCommand<TCommand extends Command> = TCommand["command"] extends "list"
	? Static<typeof ListResultSchema>
	: TCommand["command"] extends "detach"
		? Static<typeof DetachResultSchema>
		: Extract<CommandResult, { command: TCommand["command"] }>;

/** 客户端必须发送的第一帧。版本号特意为整数，而非可被强转的字符串。 */
export const ClientHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Integer({ minimum: 0 }),
	token: Type.String({ minLength: 1 }),
});
/** 客户端 hello 帧的静态类型。 */
export type ClientHello = Static<typeof ClientHelloSchema>;

/** 客户端请求信封模式：请求 id + 命令。 */
export const RequestEnvelopeSchema = StrictObject({
	type: Type.Literal("request"),
	id: IdSchema,
	request: CommandSchema,
});
/** 客户端请求信封的静态类型。 */
export type RequestEnvelope = Static<typeof RequestEnvelopeSchema>;
/** 客户端消息联合模式：hello 帧或请求信封。 */
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestEnvelopeSchema]);
/** 客户端消息的静态类型。 */
export type ClientMessage = Static<typeof ClientMessageSchema>;

/** 服务器事件模式：快照、进度或会话移除。 */
export const ServerEventSchema = Type.Union([
	StrictObject({ type: Type.Literal("server_snapshot"), snapshot: ServerSnapshotSchema }),
	StrictObject({ type: Type.Literal("session_snapshot"), snapshot: SessionSnapshotSchema }),
	StrictObject({
		type: Type.Literal("session_progress"),
		sessionId: IdSchema,
		progress: TranscriptProgressSchema,
	}),
	StrictObject({ type: Type.Literal("session_removed"), sessionId: IdSchema }),
]);
/** 服务器事件的静态类型。 */
export type ServerEvent = Static<typeof ServerEventSchema>;

/** 服务器 hello 帧模式：确认协议版本并携带初始快照。 */
export const ServerHelloSchema = StrictObject({
	type: Type.Literal("hello"),
	version: Type.Literal(PROTOCOL_VERSION),
	connectionId: IdSchema,
	snapshot: ServerSnapshotSchema,
});
/** 服务器 hello 失败帧模式。 */
export const ServerHelloErrorSchema = StrictObject({
	type: Type.Literal("hello_error"),
	error: ProtocolErrorSchema,
});
/** 服务器响应信封模式：成功携带结果，失败携带错误。 */
export const ResponseEnvelopeSchema = Type.Union([
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(true),
		result: CommandResultSchema,
	}),
	StrictObject({
		type: Type.Literal("response"),
		id: IdSchema,
		ok: Type.Literal(false),
		error: ProtocolErrorSchema,
	}),
]);
/** 服务器事件信封模式。 */
export const EventEnvelopeSchema = StrictObject({
	type: Type.Literal("event"),
	event: ServerEventSchema,
});
/** 服务器消息的联合模式：hello、hello 失败、响应信封或事件信封。 */
export const ServerMessageSchema = Type.Union([
	ServerHelloSchema,
	ServerHelloErrorSchema,
	ResponseEnvelopeSchema,
	EventEnvelopeSchema,
]);
/** 服务器 hello 帧的静态类型。 */
export type ServerHello = Static<typeof ServerHelloSchema>;
/** 服务器 hello 失败帧的静态类型。 */
export type ServerHelloError = Static<typeof ServerHelloErrorSchema>;
/** 服务器响应信封的静态类型。 */
export type ResponseEnvelope = Static<typeof ResponseEnvelopeSchema>;
/** 服务器事件信封的静态类型。 */
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;
/** 服务器消息的静态类型。 */
export type ServerMessage = Static<typeof ServerMessageSchema>;

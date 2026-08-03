// 核心 Agent 模块
export { uuidv7 } from "@earendil-works/pi-ai";
export * from "./agent.ts";
// Agent 循环函数
export * from "./agent-loop.ts";
export * from "./harness/agent-harness.ts";
export {
	type BranchPreparation,
	type BranchSummaryDetails,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	generateBranchSummary,
	prepareBranchEntries,
} from "./harness/compaction/branch-summarization.ts";
export {
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	generateSummaryWithUsage,
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "./harness/compaction/compaction.ts";
export * from "./harness/messages.ts";
export * from "./harness/prompt-templates.ts";
export {
	JsonlSessionRepository,
	type JsonlSessionRepositoryFileSystem,
	type JsonlSessionRepositoryOptions,
	loadJsonlSessionMetadata,
} from "./harness/session/jsonl-repo.ts";
export {
	type InMemorySessionCreateOptions,
	InMemorySessionRepository,
	type InMemorySessionRepositoryOptions,
} from "./harness/session/memory-repo.ts";
export * from "./harness/session/repository.ts";
export * from "./harness/session/search.ts";
export {
	buildContextEntries,
	buildSessionContext,
	type ContextEntryTransform,
	type CustomEntryContextMessageProjector,
	createSession,
	defaultContextEntryTransform,
	type SessionContextBuildOptions,
	sessionEntryToContextMessages,
} from "./harness/session/session.ts";
export * from "./harness/skills.ts";
export * from "./harness/system-prompt.ts";
export * from "./harness/tools/index.ts";
// Agent Harness（工具链/会话管理/压缩等）
export * from "./harness/types.ts";
export * from "./harness/utils/shell-output.ts";
export * from "./harness/utils/truncate.ts";
// MCP Streamable HTTP 工具适配
export {
	connectMcpServer,
	type McpAgentTool,
	type McpServerConnection,
	type McpServerConnectionOptions,
	type McpToolResultDetails,
} from "./mcp-adapter.ts";
// 代理工具函数
export * from "./proxy.ts";
// 默认 Stream 配置
export { setDefaultStreamFn } from "./stream-fn.ts";
// 类型定义
export * from "./types.ts";

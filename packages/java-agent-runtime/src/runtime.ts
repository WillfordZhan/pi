/**
 * 基于 Pi AgentSession 的会话 Runtime。
 *
 * 每个 HTTP 请求都从 Pi SessionManager 还原同一会话，再由 Pi 执行完整 agent loop；
 * Java 仅作为 Tool Provider，不进入 Pi 的推理、Guardrail 或 Tool 生命周期。
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Api, Model } from "../../ai/src/types.ts";
import { contentText } from "../../ai/src/utils/text.ts";
import { getAgentDir } from "../../coding-agent/src/config.ts";
import type { AgentSession, AgentSessionEvent } from "../../coding-agent/src/core/agent-session.ts";
import { ModelRuntime } from "../../coding-agent/src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../../coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../coding-agent/src/core/sdk.ts";
import { type SessionEntry, SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import type { RuntimeConfig } from "./config.ts";

import { JavaConversationStoreClient } from "./java-conversation-store.ts";
import { type JavaMcpCallerContext, JavaMcpClient } from "./java-mcp.ts";

export interface ConversationResponse {
	conversationId: string;
	response: string;
}

export type ConversationEventListener = (event: AgentSessionEvent) => void;

export interface StartedConversation {
	conversationId: string;
	result: Promise<ConversationResponse>;
	abort: () => void;
}

interface OpenedConversationSession {
	session: AgentSession;
	sessionManager: SessionManager;
}

interface RunningConversation {
	session: AgentSession;
	caller: JavaMcpCallerContext;
}

export class ConversationNotFoundError extends Error {
	constructor(conversationId: string) {
		super(`Conversation not found: ${conversationId}`);
		this.name = "ConversationNotFoundError";
	}
}

/** 已签名的当前调用人不属于目标会话时拒绝续聊，避免仅凭会话 ID 越权读取历史上下文。 */
export class ConversationAccessDeniedError extends Error {
	constructor() {
		super("conversation access denied");
	}
}

export class ConversationAbortedError extends Error {
	constructor() {
		super("conversation aborted");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 新会话在创建时写入最小调用人范围；续聊必须与 Java 本次签名上下文完全一致。
 * 旧 JSONL 没有该条目时按拒绝处理，宁可要求用户新建会话，也不能放开历史上下文访问。
 */
export function assertConversationCaller(entries: readonly SessionEntry[], caller: JavaMcpCallerContext): void {
	const context = entries.find((entry) => entry.type === "custom" && entry.customType === "java_gateway_context");
	if (!context || context.type !== "custom" || !isRecord(context.data)) throw new ConversationAccessDeniedError();
	if (context.data.tenantId !== caller.tenantId || context.data.userId !== caller.userId) {
		throw new ConversationAccessDeniedError();
	}
}

function lastAssistantText(session: AgentSession): string {
	for (let index = session.messages.length - 1; index >= 0; index -= 1) {
		const message = session.messages[index];
		if (message.role === "assistant") return contentText(message.content, "");
	}
	return "";
}

export class PiConversationRuntime {
	private readonly config: RuntimeConfig;
	private readonly modelRuntime: ModelRuntime;
	private readonly model: Model<Api>;
	private readonly javaMcp: JavaMcpClient;
	private readonly javaConversationStore: JavaConversationStoreClient;
	private readonly conversationQueues = new Map<string, Promise<void>>();
	private readonly runningConversations = new Map<string, RunningConversation>();

	private constructor(config: RuntimeConfig, modelRuntime: ModelRuntime, model: Model<Api>) {
		this.config = config;
		this.modelRuntime = modelRuntime;
		this.model = model;
		this.javaMcp = new JavaMcpClient({
			baseUrl: config.javaMcpBaseUrl,
			internalToken: config.javaMcpToken,
			timeoutMs: config.mcpTimeoutMs,
		});
		this.javaConversationStore = new JavaConversationStoreClient(config);
	}

	static async create(config: RuntimeConfig): Promise<PiConversationRuntime> {
		const modelRuntime = await ModelRuntime.create({ modelsPath: null });
		const apiKey = resolveQwenApiKey(config);
		registerQwenProvider(modelRuntime, config, apiKey);
		if (apiKey) await modelRuntime.setRuntimeApiKey(config.modelProvider, apiKey, { allowNetwork: false });
		const model = modelRuntime.getModel(config.modelProvider, config.modelId);
		if (!model) {
			throw new Error(`Pi model is not registered: ${config.modelProvider}/${config.modelId}`);
		}
		return new PiConversationRuntime(config, modelRuntime, model);
	}

	async createConversation(query: string, caller: JavaMcpCallerContext): Promise<ConversationResponse> {
		return this.startConversation(query, caller, true).result;
	}

	async chat(conversationId: string, query: string, caller: JavaMcpCallerContext): Promise<ConversationResponse> {
		return this.startConversation(query, caller, false, undefined, conversationId).result;
	}

	startConversation(
		query: string,
		caller: JavaMcpCallerContext,
		create: boolean,
		onEvent?: ConversationEventListener,
		existingConversationId?: string,
	): StartedConversation {
		const conversationId = create ? randomUUID().replaceAll("-", "") : existingConversationId;
		if (!conversationId) throw new ConversationNotFoundError("");
		const abortController = new AbortController();
		return {
			conversationId,
			result: this.runConversation(conversationId, caller, query, create, onEvent, abortController.signal),
			abort: () => abortController.abort(),
		};
	}

	async interrupt(conversationId: string, caller: JavaMcpCallerContext): Promise<boolean> {
		const running = this.runningConversations.get(conversationId);
		if (!running) return false;
		if (running.caller.tenantId !== caller.tenantId || running.caller.userId !== caller.userId) {
			throw new ConversationAccessDeniedError();
		}
		await running.session.abort();
		return true;
	}

	private async runConversation(
		conversationId: string,
		caller: JavaMcpCallerContext,
		query: string,
		create: boolean,
		onEvent?: ConversationEventListener,
		signal?: AbortSignal,
	): Promise<ConversationResponse> {
		let release: (() => void) | undefined;
		const previous = this.conversationQueues.get(conversationId) ?? Promise.resolve();
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.then(() => current);
		this.conversationQueues.set(conversationId, queued);
		await previous;
		if (signal?.aborted) throw new ConversationAbortedError();

		try {
			const opened = await this.openSession(conversationId, caller, create);
			const { session, sessionManager } = opened;
			const abortSession = () => void session.abort();
			signal?.addEventListener("abort", abortSession, { once: true });
			const unsubscribe = onEvent ? session.subscribe(onEvent) : undefined;
			this.runningConversations.set(conversationId, { session, caller });
			try {
				if (signal?.aborted) throw new ConversationAbortedError();
				let promptFailure: unknown;
				try {
					await session.prompt(query, { source: "rpc" });
				} catch (error) {
					promptFailure = error;
				}
				const response = lastAssistantText(session);
				const assistant = session.messages.at(-1);
				if (!promptFailure && assistant?.role === "assistant" && assistant.errorMessage) {
					promptFailure = new Error(assistant.errorMessage);
				}
				// Pi 已先持久化 JSONL；Java 同步失败时不写 marker，下一次会自动幂等补传。
				await this.syncConversation(sessionManager, conversationId, caller);
				if (promptFailure) throw promptFailure;
				return { conversationId, response };
			} finally {
				if (this.runningConversations.get(conversationId)?.session === session) {
					this.runningConversations.delete(conversationId);
				}
				unsubscribe?.();
				signal?.removeEventListener("abort", abortSession);
				session.dispose();
			}
		} finally {
			release?.();
			if (this.conversationQueues.get(conversationId) === queued) this.conversationQueues.delete(conversationId);
		}
	}

	private async openSession(
		conversationId: string,
		caller: JavaMcpCallerContext,
		create: boolean,
	): Promise<OpenedConversationSession> {
		const sessionManager = create
			? SessionManager.create(this.config.workingDirectory, this.config.sessionDirectory, { id: conversationId })
			: await this.openExistingSession(conversationId, caller);
		if (create) {
			// 管理台只读取最小的 Java 调用人范围，避免把签名上下文或业务快照写入本地会话文件。
			sessionManager.appendCustomEntry("java_gateway_context", caller);
		}
		const customTools = await this.javaMcp.createTools({ conversationId, caller });
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.config.workingDirectory,
			agentDir: getAgentDir(),
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: this.config.workingDirectory,
			modelRuntime: this.modelRuntime,
			model: this.model,
			sessionManager,
			resourceLoader,
			customTools,
			noTools: "builtin",
		});
		return { session, sessionManager };
	}

	private async syncConversation(
		sessionManager: SessionManager,
		conversationId: string,
		caller: JavaMcpCallerContext,
	): Promise<void> {
		const entries = sessionManager.getEntries();
		await this.javaConversationStore.sync(conversationId, caller, entries);
		sessionManager.appendCustomEntry(
			JavaConversationStoreClient.syncMarkerType,
			this.javaConversationStore.markSynced(entries),
		);
	}

	private async openExistingSession(conversationId: string, caller: JavaMcpCallerContext): Promise<SessionManager> {
		const sessions = await SessionManager.list(this.config.workingDirectory, this.config.sessionDirectory);
		const target = sessions.find((session) => session.id === conversationId);
		if (!target) throw new ConversationNotFoundError(conversationId);
		const session = SessionManager.open(target.path, this.config.sessionDirectory, this.config.workingDirectory);
		assertConversationCaller(session.getEntries(), caller);
		return session;
	}
}

/** 兼容旧 QWEN_API_KEY_FILE，优先使用直接注入的密钥。 */
function resolveQwenApiKey(config: RuntimeConfig): string | undefined {
	if (config.qwenApiKey) return config.qwenApiKey;
	if (!config.qwenApiKeyFile) return undefined;
	return readFileSync(config.qwenApiKeyFile, "utf8").trim() || undefined;
}

/**
 * 旧 Runtime 使用 DashScope OpenAI 兼容接口；在 Pi Runtime 内注册为标准 Provider，
 * 仅替换 Agent Runtime，不改变现有 Qwen 密钥和模型配置语义。
 */
function registerQwenProvider(modelRuntime: ModelRuntime, config: RuntimeConfig, apiKey: string | undefined): void {
	modelRuntime.registerProvider(config.modelProvider, {
		name: "DashScope",
		baseUrl: config.qwenApiBase,
		apiKey,
		api: "openai-completions",
		authHeader: true,
		models: [
			{
				id: config.modelId,
				name: config.modelId,
				api: "openai-completions",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				// DashScope qwen-plus 的 max_tokens 上限是 32768；超出会在整轮开始前被拒绝。
				maxTokens: 32_768,
				compat: {
					thinkingFormat: "qwen",
					supportsDeveloperRole: false,
					supportsStore: false,
					supportsReasoningEffort: false,
				},
			},
		],
	});
}

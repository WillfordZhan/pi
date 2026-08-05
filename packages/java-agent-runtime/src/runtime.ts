/**
 * 基于 Pi AgentSession 的会话 Runtime。
 *
 * 每个 HTTP 请求都从 Pi SessionManager 还原同一会话，再由 Pi 执行完整 agent loop；
 * Java 仅作为 Tool Provider，不进入 Pi 的推理、Guardrail 或 Tool 生命周期。
 */

import { randomUUID } from "node:crypto";
import { type Api, contentText, type Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeConfig } from "./config.ts";
import { type JavaMcpCallerContext, JavaMcpClient } from "./java-mcp.ts";

export interface ConversationResponse {
	conversationId: string;
	response: string;
}

export class ConversationNotFoundError extends Error {
	constructor(conversationId: string) {
		super(`Conversation not found: ${conversationId}`);
		this.name = "ConversationNotFoundError";
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
	private readonly conversationQueues = new Map<string, Promise<void>>();

	private constructor(config: RuntimeConfig, modelRuntime: ModelRuntime, model: Model<Api>) {
		this.config = config;
		this.modelRuntime = modelRuntime;
		this.model = model;
		this.javaMcp = new JavaMcpClient({
			baseUrl: config.javaMcpBaseUrl,
			internalToken: config.javaMcpToken,
		});
	}

	static async create(config: RuntimeConfig): Promise<PiConversationRuntime> {
		const modelRuntime = await ModelRuntime.create({ modelsPath: null });
		const model = modelRuntime.getModel(config.modelProvider, config.modelId);
		if (!model) {
			throw new Error(`Pi model is not registered: ${config.modelProvider}/${config.modelId}`);
		}
		return new PiConversationRuntime(config, modelRuntime, model);
	}

	async createConversation(query: string, caller: JavaMcpCallerContext): Promise<ConversationResponse> {
		const conversationId = randomUUID().replaceAll("-", "");
		return this.runConversation(conversationId, caller, query, true);
	}

	async chat(conversationId: string, query: string, caller: JavaMcpCallerContext): Promise<ConversationResponse> {
		return this.runConversation(conversationId, caller, query, false);
	}

	private async runConversation(
		conversationId: string,
		caller: JavaMcpCallerContext,
		query: string,
		create: boolean,
	): Promise<ConversationResponse> {
		let release: (() => void) | undefined;
		const previous = this.conversationQueues.get(conversationId) ?? Promise.resolve();
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.then(() => current);
		this.conversationQueues.set(conversationId, queued);
		await previous;

		try {
			const session = await this.openSession(conversationId, caller, create);
			try {
				await session.prompt(query, { source: "rpc" });
				return { conversationId, response: lastAssistantText(session) };
			} finally {
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
	): Promise<AgentSession> {
		const sessionManager = create
			? SessionManager.create(this.config.workingDirectory, this.config.sessionDirectory, { id: conversationId })
			: await this.openExistingSession(conversationId);
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
		return session;
	}

	private async openExistingSession(conversationId: string): Promise<SessionManager> {
		const sessions = await SessionManager.list(this.config.workingDirectory, this.config.sessionDirectory);
		const target = sessions.find((session) => session.id === conversationId);
		if (!target) throw new ConversationNotFoundError(conversationId);
		return SessionManager.open(target.path, this.config.sessionDirectory, this.config.workingDirectory);
	}
}

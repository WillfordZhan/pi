/**
 * Java 风味 MCP 到 Pi Tool 的适配层。
 *
 * Java 继续拥有工具目录、鉴权和业务执行；Pi 只将目录转换成自己的 ToolDefinition，
 * 因此工具选择、Agent loop 与工具生命周期完全由 Pi 控制。
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface JavaMcpCallerContext {
	tenantId: string;
	// Java 用户主键可能超过 JavaScript 安全整数范围，必须以十进制字符串跨越 Pi Runtime。
	userId: string;
}

interface JavaMcpToolDescriptor {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

interface JavaMcpEnvelope<T> {
	code?: number;
	msg?: string;
	data?: T;
}

interface JavaMcpListPayload {
	tools?: JavaMcpToolDescriptor[];
}

interface JavaMcpCallPayload {
	ok?: boolean;
	errorCode?: string;
	message?: string;
	preview?: string;
	payload?: unknown;
}

export interface JavaMcpClientOptions {
	baseUrl: string;
	internalToken: string;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
}

export interface CreateJavaMcpToolsOptions {
	conversationId: string;
	caller: JavaMcpCallerContext;
}

class JavaMcpRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JavaMcpRequestError";
	}
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toToolParameters(inputSchema: unknown): Record<string, unknown> {
	if (isJsonObject(inputSchema) && inputSchema.type === "object") return inputSchema;
	return { type: "object", properties: {}, additionalProperties: true };
}

function formatToolResult(payload: JavaMcpCallPayload): string {
	if (payload.ok === false) {
		return `Java tool failed${payload.errorCode ? ` (${payload.errorCode})` : ""}: ${payload.message ?? "unknown error"}`;
	}
	// preview 只适合人读，payload 才是模型继续推理所需的结构化业务结果。
	if (payload.payload !== undefined) return JSON.stringify({ preview: payload.preview, payload: payload.payload });
	if (payload.preview) return payload.preview;
	return payload.message ?? "Java tool completed without a result";
}

export class JavaMcpClient {
	private readonly baseUrl: string;
	private readonly internalToken: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(options: JavaMcpClientOptions) {
		this.baseUrl = options.baseUrl;
		this.internalToken = options.internalToken;
		this.timeoutMs = options.timeoutMs;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async createTools(options: CreateJavaMcpToolsOptions): Promise<ToolDefinition[]> {
		const response = await this.post<JavaMcpListPayload>("/tools/list", {});
		return (response.tools ?? [])
			.filter((tool) => tool.name.trim().length > 0)
			.map((tool) => this.toPiTool(tool, options));
	}

	private toPiTool(tool: JavaMcpToolDescriptor, options: CreateJavaMcpToolsOptions): ToolDefinition {
		const client = this;
		return {
			name: tool.name,
			label: tool.name,
			description: tool.description?.trim() || tool.name,
			parameters: toToolParameters(tool.inputSchema),
			async execute(toolCallId, params, signal) {
				const args = isJsonObject(params) ? params : {};
				const response = await client.callTool(
					{
						conversationId: options.conversationId,
						toolCallId,
						toolName: tool.name,
						args,
						context: options.caller,
					},
					signal,
				);
				return {
					content: [{ type: "text", text: formatToolResult(response) }],
					details: response,
				};
			},
		};
	}

	private async callTool(
		body: {
			conversationId: string;
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			context: JavaMcpCallerContext;
		},
		signal: AbortSignal | undefined,
	): Promise<JavaMcpCallPayload> {
		return this.post<JavaMcpCallPayload>("/tools/call", body, signal);
	}

	private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
		const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-AI-MCP-TOKEN": this.internalToken,
			},
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
		const raw = await response.text();
		let envelope: JavaMcpEnvelope<T>;
		try {
			envelope = JSON.parse(raw) as JavaMcpEnvelope<T>;
		} catch {
			throw new JavaMcpRequestError(`Java MCP returned invalid JSON with status ${response.status}`);
		}
		if (!response.ok || (envelope.code !== undefined && envelope.code !== 200)) {
			throw new JavaMcpRequestError(envelope.msg || `Java MCP request failed with status ${response.status}`);
		}
		if (envelope.data === undefined) throw new JavaMcpRequestError("Java MCP response data is missing");
		return envelope.data;
	}
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	StreamableHTTPClientTransport,
	type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	type CallToolResult,
	CallToolResultSchema,
	type ContentBlock,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type { AgentHarnessTool } from "./harness/types.ts";
import type { AgentToolResult } from "./types.ts";

const MCP_CLIENT_VERSION = "1.0.0";

/** Configuration for one remote MCP server connection. */
export interface McpServerConnectionOptions {
	/** Stable name used in MCP client identity and tool-result diagnostics. */
	name: string;
	/** Streamable HTTP endpoint, typically ending in `/mcp`. */
	url: URL;
	/** Static headers added to every transport request, for example a service bearer token. */
	headers?: Record<string, string>;
}

/** Raw MCP diagnostics retained outside the model-visible tool result. */
export interface McpToolResultDetails {
	serverName: string;
	toolName: string;
	result: CallToolResult;
}

/** A dynamically discovered MCP tool that can run with any AgentHarness turn context. */
export type McpAgentTool<TContext extends object | undefined = undefined> = AgentHarnessTool<
	TContext,
	TSchema,
	McpToolResultDetails
>;

/** Connected MCP tools and their shared connection lifecycle. */
export interface McpServerConnection<TContext extends object | undefined = undefined> {
	tools: McpAgentTool<TContext>[];
	close(): Promise<void>;
}

/**
 * Small protocol boundary used by discovery and mapping.
 *
 * The production implementation delegates to the official SDK. Keeping the SDK's
 * overloaded methods behind this boundary also makes result mapping testable without
 * opening sockets or starting a real MCP server.
 *
 * @internal
 */
export interface McpClientPort {
	listTools(params?: { cursor?: string }): Promise<{ tools: Tool[]; nextCursor?: string }>;
	callTool(
		params: { name: string; arguments?: Record<string, unknown> },
		signal?: AbortSignal,
	): Promise<CallToolResult>;
	close(): Promise<void>;
}

type AgentToolContent = AgentToolResult<unknown>["content"][number];

/** Convert MCP-only content types to concise text while preserving the raw block in details. */
function mapMcpContent(block: ContentBlock): AgentToolContent {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
		case "audio":
			return { type: "text", text: `[Audio content: ${block.mimeType}]` };
		case "resource_link":
			return {
				type: "text",
				text: `[Resource: ${block.title ?? block.name}] ${block.uri}`,
			};
		case "resource": {
			const resource = block.resource;
			if ("text" in resource) {
				return { type: "text", text: `[Resource: ${resource.uri}]\n${resource.text}` };
			}
			return {
				type: "text",
				text: `[Binary resource: ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ""}]`,
			};
		}
	}
}

/**
 * Build the model-visible result without duplicating structured output that a
 * standards-compliant server has already supplied as text. Raw MCP data remains in
 * details for UI, logging, and application-level inspection.
 */
function mapMcpResult(
	serverName: string,
	toolName: string,
	result: CallToolResult,
): AgentToolResult<McpToolResultDetails> {
	const content = result.content.map(mapMcpContent);
	if (result.structuredContent !== undefined && !content.some((block) => block.type === "text")) {
		content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
	}
	if (content.length === 0) {
		content.push({ type: "text", text: "MCP tool returned no content." });
	}

	return {
		content,
		details: { serverName, toolName, result },
	};
}

function getMcpErrorMessage(toolName: string, result: CallToolResult): string {
	const message = result.content
		.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return message || `MCP tool "${toolName}" failed`;
}

async function listAllTools(client: McpClientPort): Promise<Tool[]> {
	const tools: Tool[] = [];
	const toolNames = new Set<string>();
	const cursors = new Set<string>();
	let cursor: string | undefined;

	do {
		const page = await client.listTools(cursor === undefined ? undefined : { cursor });
		for (const tool of page.tools) {
			if (toolNames.has(tool.name)) {
				throw new Error(`MCP server returned duplicate tool name "${tool.name}"`);
			}
			toolNames.add(tool.name);
			tools.push(tool);
		}

		cursor = page.nextCursor;
		if (cursor !== undefined) {
			if (cursors.has(cursor)) {
				throw new Error(`MCP server repeated tools/list cursor "${cursor}"`);
			}
			cursors.add(cursor);
		}
	} while (cursor !== undefined);

	return tools;
}

/**
 * Create one lifecycle object from an initialized client.
 *
 * @internal Exported for focused adapter tests; it is not re-exported from the
 * package entry point.
 */
export async function createMcpConnection<TContext extends object | undefined = undefined>(
	serverName: string,
	client: McpClientPort,
): Promise<McpServerConnection<TContext>> {
	const definitions = await listAllTools(client);
	const tools = definitions.map<McpAgentTool<TContext>>((definition) => ({
		name: definition.name,
		label: definition.title ?? definition.annotations?.title ?? definition.name,
		description: definition.description ?? "",
		// MCP already supplies JSON Schema. Passing the same object keeps validation and
		// provider-visible schema semantics intact instead of translating a subset.
		parameters: definition.inputSchema,
		execute: async (_toolCallId, params, signal) => {
			const result = await client.callTool(
				{ name: definition.name, arguments: params as Record<string, unknown> },
				signal,
			);
			if (result.isError === true) {
				throw new Error(getMcpErrorMessage(definition.name, result));
			}
			return mapMcpResult(serverName, definition.name, result);
		},
	}));

	let closed = false;
	return {
		tools,
		close: async () => {
			if (closed) return;
			closed = true;
			await client.close();
		},
	};
}

/** Connect to a Streamable HTTP MCP server and expose its tools to AgentHarness. */
export async function connectMcpServer<TContext extends object | undefined = undefined>(
	options: McpServerConnectionOptions,
): Promise<McpServerConnection<TContext>> {
	if (options.name.trim() === "") {
		throw new Error("MCP server name must not be empty");
	}

	const transportOptions: StreamableHTTPClientTransportOptions = {};
	if (options.headers !== undefined) {
		transportOptions.requestInit = { headers: { ...options.headers } };
	}

	const transport = new StreamableHTTPClientTransport(options.url, transportOptions);
	const client = new Client({ name: `pi-agent-core/${options.name}`, version: MCP_CLIENT_VERSION });
	const port: McpClientPort = {
		listTools: (params) => client.listTools(params),
		callTool: async (params, signal) => {
			const result = await client.callTool(params, CallToolResultSchema, { signal });
			// Task-based MCP execution returns a handle instead of an immediate content
			// result. The adapter deliberately rejects it until it can expose polling and
			// cancellation semantics without hiding a long-running ERP operation.
			const parsed = CallToolResultSchema.safeParse(result);
			if (!parsed.success) {
				throw new Error(`MCP tool "${params.name}" returned an unsupported task response`);
			}
			return parsed.data;
		},
		close: () => client.close(),
	};

	try {
		await client.connect(transport);
		return await createMcpConnection<TContext>(options.name, port);
	} catch (error) {
		// Initialization can fail after the transport allocates resources. Cleanup is
		// best-effort so the original connection error remains the observable failure.
		await client.close().catch(() => undefined);
		throw error;
	}
}

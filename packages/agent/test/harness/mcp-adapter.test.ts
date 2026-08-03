import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpConnection, type McpClientPort } from "../../src/mcp-adapter.ts";

function createClient(options: {
	listTools: McpClientPort["listTools"];
	callTool?: McpClientPort["callTool"];
}): McpClientPort & { close: ReturnType<typeof vi.fn> } {
	const close = vi.fn(async () => undefined);
	return {
		listTools: options.listTools,
		callTool:
			options.callTool ??
			(async () => ({
				content: [{ type: "text", text: "ok" }],
			})),
		close,
	};
}

describe("MCP adapter", () => {
	it("discovers paginated tools, preserves schemas, and maps tool results", async () => {
		const inputSchema: Tool["inputSchema"] = {
			type: "object",
			properties: { keyword: { type: "string" } },
			required: ["keyword"],
		};
		const lookupTool: Tool = {
			name: "material_lookup",
			title: "Material lookup",
			description: "Find a material",
			inputSchema,
		};
		const createTool: Tool = {
			name: "material_in_create",
			description: "Create an inbound record",
			inputSchema: { type: "object" },
		};
		const cursors: Array<string | undefined> = [];
		const signal = new AbortController().signal;
		const calls: Array<{ name: string; arguments?: Record<string, unknown>; signal?: AbortSignal }> = [];
		const client = createClient({
			listTools: async (params) => {
				cursors.push(params?.cursor);
				return params?.cursor === undefined
					? { tools: [lookupTool], nextCursor: "page-2" }
					: { tools: [createTool] };
			},
			callTool: async (params, receivedSignal) => {
				calls.push({ ...params, signal: receivedSignal });
				return {
					content: [
						{ type: "text", text: "found" },
						{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
					],
					structuredContent: { materialId: "m-1" },
				};
			},
		});

		const connection = await createMcpConnection("erp", client);

		expect(cursors).toEqual([undefined, "page-2"]);
		expect(connection.tools.map((tool) => tool.name)).toEqual(["material_lookup", "material_in_create"]);
		expect(connection.tools[0]?.label).toBe("Material lookup");
		expect(connection.tools[0]?.parameters).toBe(inputSchema);

		const result = await connection.tools[0]!.execute("call-1", { keyword: "ore" }, signal, undefined, undefined);
		expect(calls).toEqual([{ name: "material_lookup", arguments: { keyword: "ore" }, signal }]);
		expect(result.content).toEqual([
			{ type: "text", text: "found" },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		]);
		expect(result.details).toMatchObject({
			serverName: "erp",
			toolName: "material_lookup",
			result: { structuredContent: { materialId: "m-1" } },
		});
	});

	it("makes structured-only results visible to the model", async () => {
		const structuredContent = { recordId: "record-1", created: true };
		const client = createClient({
			listTools: async () => ({ tools: [{ name: "create", inputSchema: { type: "object" } }] }),
			callTool: async () => ({ content: [], structuredContent }),
		});
		const connection = await createMcpConnection("erp", client);

		const result = await connection.tools[0]!.execute("call-2", {}, undefined, undefined, undefined);

		expect(result.content).toEqual([{ type: "text", text: JSON.stringify(structuredContent, null, 2) }]);
	});

	it("turns MCP tool errors into failed agent tool executions", async () => {
		const errorResult: CallToolResult = {
			content: [{ type: "text", text: "record already exists" }],
			isError: true,
		};
		const client = createClient({
			listTools: async () => ({ tools: [{ name: "create", inputSchema: { type: "object" } }] }),
			callTool: async () => errorResult,
		});
		const connection = await createMcpConnection("erp", client);

		await expect(connection.tools[0]!.execute("call-3", {}, undefined, undefined, undefined)).rejects.toThrow(
			"record already exists",
		);
	});

	it("rejects repeated pagination cursors", async () => {
		const client = createClient({
			listTools: async () => ({ tools: [], nextCursor: "same-cursor" }),
		});

		await expect(createMcpConnection("erp", client)).rejects.toThrow(
			'MCP server repeated tools/list cursor "same-cursor"',
		);
	});

	it("closes the shared client once", async () => {
		const client = createClient({ listTools: async () => ({ tools: [] }) });
		const connection = await createMcpConnection("erp", client);

		await connection.close();
		await connection.close();

		expect(client.close).toHaveBeenCalledTimes(1);
	});
});

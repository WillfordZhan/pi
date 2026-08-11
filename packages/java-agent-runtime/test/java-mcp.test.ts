import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { JavaMcpClient } from "../src/java-mcp.ts";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("JavaMcpClient", () => {
	it("discovers Java tools and forwards Pi tool calls with the caller context", async () => {
		let receivedCall: Record<string, unknown> | undefined;
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			if (request.url === "/tools/list") {
				response.end(
					JSON.stringify({
						code: 200,
						data: {
							tools: [
								{
									name: "plan_search",
									description: "Search plans",
									progressText: "正在查询生产计划",
									successText: "已查询生产计划",
									inputSchema: {
										type: "object",
										properties: { keyword: { type: "string" } },
										required: ["keyword"],
									},
								},
							],
						},
					}),
				);
				return;
			}
			receivedCall = JSON.parse(body) as Record<string, unknown>;
			response.end(
				JSON.stringify({ code: 200, data: { ok: true, preview: "found one plan", payload: { count: 1 } } }),
			);
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");

		const client = new JavaMcpClient({
			baseUrl: `http://127.0.0.1:${address.port}`,
			internalToken: "mcp-token",
			timeoutMs: 1000,
		});
		const tools = await client.createTools({
			conversationId: "conversation-1",
			caller: { tenantId: "100", userId: "7" },
		});
		const [tool] = tools;

		const result = await tool.execute("tool-call-1", { keyword: "today" }, undefined, undefined, {} as never);

		expect(result.content).toEqual([{ type: "text", text: '{"preview":"found one plan","payload":{"count":1}}' }]);
		expect(result.details).toMatchObject({
			presentation: { progressText: "正在查询生产计划", successText: "已查询生产计划" },
		});
		expect(client.getPresentationCatalog(tools)).toEqual({
			plan_search: { progressText: "正在查询生产计划", successText: "已查询生产计划" },
		});
		expect(receivedCall).toMatchObject({
			conversationId: "conversation-1",
			toolCallId: "tool-call-1",
			toolName: "plan_search",
			args: { keyword: "today" },
			context: { tenantId: "100", userId: "7" },
		});
	});

	it("marks a Java business failure as a Pi tool error", async () => {
		let requestCount = 0;
		const client = new JavaMcpClient({
			baseUrl: "http://java-mcp.local",
			internalToken: "mcp-token",
			timeoutMs: 1000,
			fetchImpl: async () => {
				requestCount += 1;
				return new Response(
					JSON.stringify(
						requestCount === 1
							? { code: 200, data: { tools: [{ name: "plan_search", inputSchema: { type: "object" } }] } }
							: {
									code: 200,
									data: { ok: false, errorCode: "tool_args_invalid", message: "物料不存在" },
								},
					),
				);
			},
		});
		const [tool] = await client.createTools({
			conversationId: "conversation-1",
			caller: { tenantId: "100", userId: "7" },
		});

		await expect(tool.execute("tool-call-1", {}, undefined, undefined, {} as never)).rejects.toThrow(
			"Java tool failed (tool_args_invalid): 物料不存在",
		);
	});
});

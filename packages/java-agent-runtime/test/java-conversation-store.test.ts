import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config.ts";
import { JavaConversationStoreClient } from "../src/java-conversation-store.ts";

const fetchMock = vi.fn<typeof fetch>();

afterEach(() => {
	vi.unstubAllGlobals();
	fetchMock.mockReset();
});

describe("JavaConversationStoreClient", () => {
	it("syncs raw entries through the versioned neutral contract", async () => {
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					code: 200,
					data: { conversationId: "conversation-1", acceptedEntryIds: ["entry-1"], latestEntryOrder: 1 },
				}),
				{ status: 200 },
			),
		);
		const config: RuntimeConfig = {
			port: 8000,
			workingDirectory: "/tmp",
			sessionDirectory: "/tmp/sessions",
			gatewayToken: "gateway-token",
			contextSignSecret: "context-secret",
			clockSkewSeconds: 30,
			javaMcpBaseUrl: "http://java/ai/mcp",
			javaMcpToken: "mcp-token",
			javaGatewayBaseUrl: "http://java",
			manageConsoleDirectory: "/tmp/console",
			mcpTimeoutMs: 1_000,
			modelProvider: "dashscope",
			modelId: "qwen-plus",
			qwenApiBase: "http://model",
		};
		const client = new JavaConversationStoreClient(config);

		await client.sync("conversation-1", { tenantId: "100", userId: "200" }, [
			{
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-08-05T10:00:00Z",
				message: { role: "user", content: [{ type: "text", text: "查询计划" }], timestamp: Date.now() },
			},
		]);

		expect(fetchMock).toHaveBeenCalledWith(
			"http://java/ai/internal/store/v2/conversations/conversation-1/entries",
			expect.objectContaining({
				method: "PUT",
				headers: expect.objectContaining({ "X-AI-GW-TOKEN": "gateway-token" }),
			}),
		);
	});
});

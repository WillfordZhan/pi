import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../coding-agent/src/core/session-manager.ts";
import type { RuntimeConfig } from "../src/config.ts";
import { JavaConversationStoreClient, restoreConversationSession } from "../src/java-conversation-store.ts";

const fetchMock = vi.fn<typeof fetch>();
const temporaryDirectories: string[] = [];

function runtimeConfig(sessionDirectory = "/tmp/sessions"): RuntimeConfig {
	return {
		port: 8000,
		workingDirectory: "/tmp",
		sessionDirectory,
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
}

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-10T10:00:00Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1_786_336_800_000 },
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	fetchMock.mockReset();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("JavaConversationStoreClient", () => {
	it("syncs raw entries through the versioned neutral contract", async () => {
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					code: 200,
					data: { conversationId: "conversation-1", acceptedEntryIds: ["entry-1"] },
				}),
				{ status: 200 },
			),
		);
		const config = runtimeConfig();
		const client = new JavaConversationStoreClient(config);

		await expect(
			client.sync("conversation-1", { tenantId: "100", userId: "200" }, [
				{
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: "2026-08-05T10:00:00Z",
					message: { role: "user", content: [{ type: "text", text: "查询计划" }], timestamp: Date.now() },
				},
			]),
		).resolves.toBe(true);

		expect(fetchMock).toHaveBeenCalledWith(
			"http://java/ai/internal/store/v2/conversations/conversation-1/entries",
			expect.objectContaining({
				method: "PUT",
				headers: expect.objectContaining({ "X-AI-GW-TOKEN": "gateway-token" }),
			}),
		);
	});

	it("replaces image Base64 with a lightweight Java query projection", async () => {
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					code: 200,
					data: { conversationId: "conversation-1", acceptedEntryIds: ["entry-1"] },
				}),
				{ status: 200 },
			),
		);
		const config = runtimeConfig();
		const imageData = "large-image-base64";

		await new JavaConversationStoreClient(config).sync("conversation-1", { tenantId: "100", userId: "200" }, [
			{
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-08-05T10:00:00Z",
				message: {
					role: "user",
					content: [
						{ type: "text", text: "检查图片" },
						{ type: "image", mimeType: "image/png", data: imageData },
					],
					timestamp: Date.now(),
				},
			},
		]);

		const request = fetchMock.mock.calls[0]?.[1];
		const body = String(request?.body ?? "");
		expect(body).not.toContain(imageData);
		expect(body).toContain("本轮包含 1 张图片");
		expect(body).toContain('"id":"entry-1"');
	});

	it("does not create a marker-worthy sync when the JSONL has no new entries", async () => {
		vi.stubGlobal("fetch", fetchMock);
		const config = runtimeConfig();

		await expect(
			new JavaConversationStoreClient(config).sync("conversation-1", { tenantId: "100", userId: "200" }, [
				{
					type: "custom",
					customType: JavaConversationStoreClient.syncMarkerType,
					id: "marker-1",
					parentId: null,
					timestamp: "2026-08-05T10:00:00Z",
				},
			]),
		).resolves.toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("syncs the boundary marker when later entries depend on it", async () => {
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					code: 200,
					data: { conversationId: "conversation-1", acceptedEntryIds: ["marker-1", "user-2"] },
				}),
				{ status: 200 },
			),
		);
		const client = new JavaConversationStoreClient(runtimeConfig());
		const first = userEntry("user-1", null, "第一轮");
		const marker: SessionEntry = {
			type: "custom",
			customType: JavaConversationStoreClient.syncMarkerType,
			data: { lastEntryId: first.id },
			id: "marker-1",
			parentId: first.id,
			timestamp: "2026-08-10T10:01:00Z",
		};

		await client.sync("conversation-1", { tenantId: "100", userId: "200" }, [
			first,
			marker,
			userEntry("user-2", marker.id, "第二轮"),
		]);

		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { entries: SessionEntry[] };
		expect(body.entries.map((entry) => entry.id)).toEqual(["marker-1", "user-2"]);
	});

	it("restores complete context when legacy Java entries omit a sync marker", () => {
		const sessionDirectory = mkdtempSync(join(tmpdir(), "pi-java-store-restore-"));
		temporaryDirectories.push(sessionDirectory);
		const context: SessionEntry = {
			type: "custom",
			customType: "java_gateway_context",
			data: { tenantId: "100", userId: "200" },
			id: "context",
			parentId: null,
			timestamp: "2026-08-10T10:00:00Z",
		};
		const first = userEntry("user-1", context.id, "第一轮");
		const second = userEntry("user-2", "missing-marker", "第二轮");

		const manager = restoreConversationSession(runtimeConfig(sessionDirectory), "conversation-1", [
			context,
			first,
			second,
		]);

		expect(manager.buildSessionContext().messages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "第一轮" }] },
			{ role: "user", content: [{ type: "text", text: "第二轮" }] },
		]);
		expect(manager.getEntry("missing-marker")).toMatchObject({
			type: "custom",
			customType: JavaConversationStoreClient.syncMarkerType,
			parentId: "user-1",
		});
	});

	it("rejects an empty restore instead of creating a new conversation", () => {
		const sessionDirectory = mkdtempSync(join(tmpdir(), "pi-java-store-empty-"));
		temporaryDirectories.push(sessionDirectory);

		expect(() => restoreConversationSession(runtimeConfig(sessionDirectory), "conversation-1", [])).toThrow(
			"conversation store has no entries to restore",
		);
	});

	it("rejects malformed Java entries before they reach SessionManager", async () => {
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					code: 200,
					data: [{ type: "message", id: "entry-1", parentId: null, message: { role: "user" } }],
				}),
				{ status: 200 },
			),
		);

		await expect(new JavaConversationStoreClient(runtimeConfig()).listEntries("conversation-1")).rejects.toThrow(
			"conversation store entries response invalid",
		);
	});

	it("treats a Java business error in an HTTP 200 response as a gateway failure", async () => {
		vi.stubGlobal("fetch", fetchMock);
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ code: 500, msg: "系统错误", data: null }), { status: 200 }),
		);
		const config = runtimeConfig();

		await expect(new JavaConversationStoreClient(config).searchConversations({})).rejects.toMatchObject({
			statusCode: 502,
			message: "系统错误",
		});
	});
});

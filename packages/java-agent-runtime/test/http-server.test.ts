import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.ts";
import { createHttpServer, normalizeTenantId, normalizeUserId } from "../src/http-server.ts";
import type { PiConversationRuntime } from "../src/runtime.ts";

const servers: Array<ReturnType<typeof createHttpServer>> = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("normalizeTenantId", () => {
	it("accepts Java gateway tenant IDs serialized as either strings or safe integers", () => {
		expect(normalizeTenantId("100")).toBe("100");
		expect(normalizeTenantId(100)).toBe("100");
		expect(normalizeTenantId(1.5)).toBe("");
	});
});

describe("normalizeUserId", () => {
	it("preserves Java Long user IDs without converting them to JavaScript numbers", () => {
		expect(normalizeUserId("9007199254740993")).toBe("9007199254740993");
		expect(normalizeUserId(7)).toBe("7");
		expect(normalizeUserId("0")).toBe("");
	});
});

describe("SSE conversation", () => {
	it("aborts the Pi session when the Java SSE client disconnects", async () => {
		let rejectConversation: (reason: Error) => void = () => undefined;
		let resolveAbort: () => void = () => undefined;
		const aborted = new Promise<void>((resolve) => {
			resolveAbort = resolve;
		});
		const runtime = {
			startConversation: () => ({
				conversationId: "conversation-1",
				result: new Promise((_, reject: (reason: Error) => void) => {
					rejectConversation = reject;
				}),
				abort: () => {
					resolveAbort();
					rejectConversation(new Error("aborted"));
				},
			}),
		} as unknown as PiConversationRuntime;
		const config: RuntimeConfig = {
			port: 0,
			workingDirectory: "/tmp",
			sessionDirectory: "/tmp",
			gatewayToken: "gateway-token",
			contextSignSecret: "context-secret",
			clockSkewSeconds: 30,
			javaMcpBaseUrl: "http://127.0.0.1:1/ai/mcp",
			javaMcpToken: "mcp-token",
			javaGatewayBaseUrl: "http://127.0.0.1:1",
			manageConsoleDirectory: "/tmp",
			mcpTimeoutMs: 1_000,
			modelProvider: "dashscope",
			modelId: "qwen3.7-plus",
			qwenApiBase: "http://127.0.0.1:1",
		};
		const server = createHttpServer(runtime, config);
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		const contextPayload = Buffer.from(
			JSON.stringify({ tenantId: "100", userId: "7", exp: Math.floor(Date.now() / 1000) + 60 }),
		).toString("base64url");
		const signature = createHmac("sha256", config.contextSignSecret).update(contextPayload).digest("base64url");
		const client = httpRequest({
			hostname: "127.0.0.1",
			port,
			path: "/ai/conversations",
			method: "POST",
			headers: {
				Accept: "text/event-stream",
				"Content-Type": "application/json",
				"X-AI-GW-TOKEN": config.gatewayToken,
				"X-AI-BIZ-CONTEXT": `v1.${contextPayload}.${signature}`,
			},
		});
		client.on("response", (response) => response.once("data", () => client.destroy()));
		client.on("error", () => undefined);
		client.end(JSON.stringify({ query: "生成计划" }));

		await expect(
			Promise.race([
				aborted,
				new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1_000)),
			]),
		).resolves.toBeUndefined();
	});
});

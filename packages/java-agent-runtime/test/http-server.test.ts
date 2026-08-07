import { createHmac } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.ts";
import { createHttpServer, isPathInsideDirectory, normalizeTenantId, normalizeUserId } from "../src/http-server.ts";
import type { PiConversationRuntime } from "../src/runtime.ts";

const servers: Array<ReturnType<typeof createHttpServer>> = [];
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

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

describe("isPathInsideDirectory", () => {
	it("rejects a sibling directory that only shares the management console prefix", () => {
		expect(isPathInsideDirectory("/tmp/console", "/tmp/console/assets/index.js")).toBe(true);
		expect(isPathInsideDirectory("/tmp/console", "/tmp/console-private/index.js")).toBe(false);
	});
});

describe("Java management proxy", () => {
	it("forwards Java session cookies in both directions", async () => {
		const upstreamCookies: string[] = [];
		const javaGateway = createServer((request, response) => {
			upstreamCookies.push(request.headers.cookie ?? "");
			response.setHeader("Content-Type", "application/json");
			if (request.url === "/unified/login") response.setHeader("Set-Cookie", "JAVA_SESSION=abc; Path=/; HttpOnly");
			response.end("{}");
		});
		servers.push(javaGateway);
		await new Promise<void>((resolve) => javaGateway.listen(0, "127.0.0.1", resolve));
		const javaPort = (javaGateway.address() as AddressInfo).port;
		const config: RuntimeConfig = {
			port: 0,
			workingDirectory: "/tmp",
			sessionDirectory: "/tmp",
			gatewayToken: "gateway-token",
			contextSignSecret: "context-secret",
			clockSkewSeconds: 30,
			javaMcpBaseUrl: `http://127.0.0.1:${javaPort}/ai/mcp`,
			javaMcpToken: "mcp-token",
			javaGatewayBaseUrl: `http://127.0.0.1:${javaPort}`,
			manageConsoleDirectory: "/tmp",
			mcpTimeoutMs: 1_000,
			modelProvider: "dashscope",
			modelId: "qwen3.7-plus",
			qwenApiBase: "http://127.0.0.1:1",
		};
		const runtime = {} as PiConversationRuntime;
		const server = createHttpServer(runtime, config);
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const runtimePort = (server.address() as AddressInfo).port;

		const login = await fetch(`http://127.0.0.1:${runtimePort}/unified/login`, { method: "POST" });
		expect(login.headers.get("set-cookie")).toContain("JAVA_SESSION=abc");
		await fetch(`http://127.0.0.1:${runtimePort}/common/currentUserInfo`, {
			headers: { Cookie: "JAVA_SESSION=abc" },
		});
		expect(upstreamCookies).toEqual(["", "JAVA_SESSION=abc"]);
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

describe("multipart conversation", () => {
	it("processes image-only input before handing it to the Pi runtime", async () => {
		let capturedInput: unknown;
		const runtime = {
			createConversation: async (input: unknown) => {
				capturedInput = input;
				return { conversationId: "conversation-image", response: "ok" };
			},
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
		const formData = new FormData();
		formData.append("images", new Blob([Buffer.from(TINY_PNG_BASE64, "base64")], { type: "image/png" }), "one.png");

		const response = await fetch(`http://127.0.0.1:${port}/ai/conversations`, {
			method: "POST",
			headers: {
				"X-AI-GW-TOKEN": config.gatewayToken,
				"X-AI-BIZ-CONTEXT": `v1.${contextPayload}.${signature}`,
			},
			body: formData,
		});

		expect(response.status).toBe(200);
		expect(capturedInput).toMatchObject({
			query: "请分析这些图片",
			images: [{ type: "image", mimeType: "image/png", data: TINY_PNG_BASE64 }],
		});
	});

	it("rejects more than five images before starting a conversation", async () => {
		let started = false;
		const runtime = {
			createConversation: async () => {
				started = true;
				return { conversationId: "unexpected", response: "unexpected" };
			},
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
		const formData = new FormData();
		for (let index = 0; index < 6; index += 1) {
			formData.append(
				"images",
				new Blob([Buffer.from(TINY_PNG_BASE64, "base64")], { type: "image/png" }),
				`${index}.png`,
			);
		}

		const response = await fetch(`http://127.0.0.1:${port}/ai/conversations`, {
			method: "POST",
			headers: {
				"X-AI-GW-TOKEN": config.gatewayToken,
				"X-AI-BIZ-CONTEXT": `v1.${contextPayload}.${signature}`,
			},
			body: formData,
		});

		expect(response.status).toBe(413);
		expect(started).toBe(false);
	});
});

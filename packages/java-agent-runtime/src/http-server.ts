/**
 * Java Gateway 的 HTTP 接入层。
 *
 * 该层只校验 Java 内网调用身份、解析调用人上下文并转交 PiConversationRuntime；
 * 不能在这里加入 Agent 编排或业务 Tool 规则。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RuntimeConfig } from "./config.ts";
import type { JavaMcpCallerContext } from "./java-mcp.ts";
import { ConversationNotFoundError, type PiConversationRuntime } from "./runtime.ts";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

class HttpRequestError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.name = "HttpRequestError";
		this.statusCode = statusCode;
	}
}

function getHeader(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name.toLowerCase()];
	return Array.isArray(value) ? value[0] : value;
}

function requireGatewayToken(request: IncomingMessage, config: RuntimeConfig): void {
	if (getHeader(request, "x-ai-gw-token") !== config.gatewayToken) {
		throw new HttpRequestError(401, "unauthorized gateway request");
	}
}

function parseCallerContext(request: IncomingMessage): JavaMcpCallerContext {
	const rawContext = getHeader(request, "x-ai-biz-context");
	if (!rawContext) throw new HttpRequestError(401, "missing business context");
	const parts = rawContext.split(".");
	if (parts.length !== 3 || parts[0] !== "v1") throw new HttpRequestError(401, "invalid business context");

	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		throw new HttpRequestError(401, "invalid business context");
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new HttpRequestError(401, "invalid business context");
	}
	const data = payload as Record<string, unknown>;
	const tenantId = typeof data.tenantId === "string" ? data.tenantId.trim() : "";
	const rawUserId = data.userId;
	const userId = typeof rawUserId === "string" ? Number(rawUserId) : typeof rawUserId === "number" ? rawUserId : NaN;
	const expiresAt = typeof data.exp === "number" ? data.exp : 0;
	if (!tenantId || !Number.isSafeInteger(userId) || userId < 1 || expiresAt <= Math.floor(Date.now() / 1000)) {
		throw new HttpRequestError(401, "invalid or expired business context");
	}
	return { tenantId, userId };
}

async function readJsonBody(request: IncomingMessage): Promise<{ query: string }> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.length;
		if (totalBytes > MAX_REQUEST_BODY_BYTES) throw new HttpRequestError(413, "request body too large");
		chunks.push(buffer);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpRequestError(400, "invalid JSON request body");
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new HttpRequestError(400, "request body must be a JSON object");
	}
	const query = (payload as Record<string, unknown>).query;
	if (typeof query !== "string" || !query.trim()) throw new HttpRequestError(400, "query is required");
	return { query: query.trim() };
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
	response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

export function createHttpServer(runtime: PiConversationRuntime, config: RuntimeConfig): Server {
	return createServer(async (request, response) => {
		try {
			if (request.method === "GET" && request.url === "/healthz") {
				writeJson(response, 200, { status: "ok" });
				return;
			}
			requireGatewayToken(request, config);
			const caller = parseCallerContext(request);
			const url = new URL(request.url ?? "/", "http://pi-runtime.local");
			if (request.method === "POST" && url.pathname === "/ai/conversations") {
				const { query } = await readJsonBody(request);
				writeJson(response, 200, await runtime.createConversation(query, caller));
				return;
			}
			const chatMatch = /^\/ai\/conversations\/([A-Za-z0-9._-]+)\/chat$/u.exec(url.pathname);
			if (request.method === "POST" && chatMatch) {
				const { query } = await readJsonBody(request);
				writeJson(response, 200, await runtime.chat(chatMatch[1], query, caller));
				return;
			}
			throw new HttpRequestError(404, "not found");
		} catch (error) {
			if (error instanceof HttpRequestError) {
				writeJson(response, error.statusCode, { detail: error.message });
				return;
			}
			if (error instanceof ConversationNotFoundError) {
				writeJson(response, 404, { detail: error.message });
				return;
			}
			writeJson(response, 502, { detail: error instanceof Error ? error.message : "Pi runtime failed" });
		}
	});
}

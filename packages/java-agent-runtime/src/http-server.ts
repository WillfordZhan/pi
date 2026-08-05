/**
 * Java Gateway 的 HTTP 接入层。
 *
 * 该层只校验 Java 内网调用身份、解析调用人上下文并转交 PiConversationRuntime；
 * 不能在这里加入 Agent 编排或业务 Tool 规则。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, relative } from "node:path";
import type { RuntimeConfig } from "./config.ts";
import type { JavaMcpCallerContext } from "./java-mcp.ts";
import { ManagementRequestError, PiManagementService } from "./management.ts";
import { ConversationAccessDeniedError, ConversationNotFoundError, type PiConversationRuntime } from "./runtime.ts";

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

/**
 * Java 的 deptId 在不同序列化配置下可能是 JSON number 或 string；Pi 内部统一保存为 string，
 * 避免签名上下文因表示类型不同而拒绝合法的工厂范围。
 */
export function normalizeTenantId(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	return "";
}

/**
 * Java Long 类型的用户主键不能转换为 JavaScript number，否则雪花 ID 会丢失精度。
 * Pi 到 Java MCP 始终保留原始十进制文本，由 Java 再绑定为 Long。
 */
export function normalizeUserId(value: unknown): string {
	if (typeof value === "string" && /^[1-9]\d*$/u.test(value.trim())) return value.trim();
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
	return "";
}

function parseCallerContext(request: IncomingMessage, config: RuntimeConfig): JavaMcpCallerContext {
	const rawContext = getHeader(request, "x-ai-biz-context");
	if (!rawContext) throw new HttpRequestError(401, "missing business context");
	const parts = rawContext.split(".");
	if (parts.length !== 3 || parts[0] !== "v1") throw new HttpRequestError(401, "invalid business context");
	const expectedSignature = createHmac("sha256", config.contextSignSecret).update(parts[1]).digest("base64url");
	const actualSignature = Buffer.from(parts[2]);
	const expectedSignatureBuffer = Buffer.from(expectedSignature);
	if (
		actualSignature.length !== expectedSignatureBuffer.length ||
		!timingSafeEqual(actualSignature, expectedSignatureBuffer)
	) {
		throw new HttpRequestError(401, "invalid business context signature");
	}

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
	const tenantId = normalizeTenantId(data.tenantId);
	const userId = normalizeUserId(data.userId);
	const expiresAt = typeof data.exp === "number" ? data.exp : 0;
	// 签名已验证后再逐项校验，返回可定位的协议错误而不回显业务上下文内容。
	if (!tenantId) throw new HttpRequestError(401, "invalid business context tenantId");
	if (!userId) throw new HttpRequestError(401, "invalid business context userId");
	if (expiresAt + config.clockSkewSeconds <= Math.floor(Date.now() / 1000)) {
		throw new HttpRequestError(401, "expired business context");
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
	if (response.destroyed || response.writableEnded) return;
	response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

function acceptsEventStream(request: IncomingMessage): boolean {
	return getHeader(request, "accept")?.toLowerCase().includes("text/event-stream") ?? false;
}

function writeSse(response: ServerResponse, event: string, data: Record<string, unknown>): void {
	if (response.destroyed || response.writableEnded) return;
	response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamConversation(
	response: ServerResponse,
	runtime: PiConversationRuntime,
	caller: JavaMcpCallerContext,
	query: string,
	conversationId?: string,
): Promise<void> {
	response.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	const started = runtime.startConversation(
		query,
		caller,
		!conversationId,
		(event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				writeSse(response, "answer_delta", {
					conversation_id: started.conversationId,
					delta: event.assistantMessageEvent.delta,
				});
				return;
			}
			if (event.type === "tool_execution_start") {
				writeSse(response, "tool_call", {
					conversation_id: started.conversationId,
					tool_call_id: event.toolCallId,
					name: event.toolName,
					arguments: event.args,
				});
				return;
			}
			if (event.type === "tool_execution_end") {
				writeSse(response, "tool_result", {
					conversation_id: started.conversationId,
					tool_call_id: event.toolCallId,
					name: event.toolName,
					is_error: event.isError,
				});
			}
		},
		conversationId,
	);
	let clientDisconnected = false;
	const abortOnClose = () => {
		clientDisconnected = true;
		started.abort();
	};
	response.once("close", abortOnClose);
	writeSse(response, "conversation_started", { conversation_id: started.conversationId });
	try {
		const result = await started.result;
		writeSse(response, "final", { conversation_id: result.conversationId, answer: result.response });
	} catch (error) {
		if (!clientDisconnected) {
			writeSse(response, "conversation_failed", {
				conversation_id: started.conversationId,
				detail: error instanceof Error ? error.message : "Pi runtime failed",
			});
		}
	} finally {
		response.off("close", abortOnClose);
		if (!clientDisconnected) response.end();
	}
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.length;
		if (totalBytes > MAX_REQUEST_BODY_BYTES) throw new HttpRequestError(413, "request body too large");
		chunks.push(buffer);
	}
	try {
		const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("not an object");
		return payload as Record<string, unknown>;
	} catch {
		throw new HttpRequestError(400, "invalid JSON request body");
	}
}

function contentType(path: string): string {
	return (
		{ ".css": "text/css", ".js": "text/javascript", ".html": "text/html", ".svg": "image/svg+xml" }[extname(path)] ??
		"application/octet-stream"
	);
}

/** 静态文件必须位于管理台根目录内，不能用字符串前缀判断目录归属。 */
export function isPathInsideDirectory(directory: string, target: string): boolean {
	const path = relative(directory, target);
	return path !== "" && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function serveManageConsole(response: ServerResponse, config: RuntimeConfig, pathname: string): boolean {
	const resource = pathname.replace(/^\/ai\/management\/console\/?/u, "") || "index.html";
	const directory = normalize(config.manageConsoleDirectory);
	const target = normalize(join(directory, resource));
	if (!isPathInsideDirectory(directory, target) || !existsSync(target) || !statSync(target).isFile()) return false;
	response.writeHead(200, { "Content-Type": contentType(target) });
	createReadStream(target).pipe(response);
	return true;
}

async function proxyJava(
	response: ServerResponse,
	management: PiManagementService,
	request: IncomingMessage,
	url: URL,
): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	const authorization = getHeader(request, "authorization") ?? "";
	const method = request.method ?? "GET";
	const requestBody = Buffer.concat(chunks);
	// GET/HEAD 不允许携带 body；浏览器管理台读取会话时也会走这条通用代理。
	const accept = getHeader(request, "accept");
	const eventStream = accept?.toLowerCase().includes("text/event-stream") ?? false;
	const abortController = eventStream ? new AbortController() : undefined;
	const abortUpstream = () => abortController?.abort();
	if (eventStream) response.once("close", abortUpstream);
	try {
		const upstream = await management.proxyJava(
			method,
			`${url.pathname}${url.search}`,
			authorization,
			requestBody.length > 0 && method !== "GET" && method !== "HEAD" ? requestBody : undefined,
			accept,
			abortController?.signal,
		);
		if (!eventStream || !upstream.body) {
			const body = Buffer.from(await upstream.arrayBuffer());
			response.writeHead(upstream.status, {
				"Content-Type": upstream.headers.get("content-type") ?? "application/json",
			});
			response.end(body);
			return;
		}
		response.writeHead(upstream.status, {
			"Content-Type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
			"Cache-Control": upstream.headers.get("cache-control") ?? "no-cache",
			Connection: "keep-alive",
		});
		const reader = upstream.body.getReader();
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				if (response.destroyed) break;
				response.write(next.value);
			}
		} finally {
			if (response.destroyed) await reader.cancel();
			reader.releaseLock();
		}
		if (!response.destroyed) response.end();
	} finally {
		if (eventStream) response.off("close", abortUpstream);
	}
}

export function createHttpServer(runtime: PiConversationRuntime, config: RuntimeConfig): Server {
	const management = new PiManagementService(config);
	return createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://pi-runtime.local");
			if (request.method === "GET" && request.url === "/healthz") {
				writeJson(response, 200, { status: "ok" });
				return;
			}
			if (request.method === "GET" && url.pathname.startsWith("/ai/management/console")) {
				if (serveManageConsole(response, config, url.pathname)) return;
				throw new HttpRequestError(404, "manage console is not built");
			}
			if (
				url.pathname === "/unified/login" ||
				url.pathname === "/common/currentUserInfo" ||
				url.pathname.startsWith("/api/ai")
			) {
				await proxyJava(response, management, request, url);
				return;
			}
			if (url.pathname === "/ai/management/session/me" && request.method === "GET") {
				writeJson(response, 200, await management.session(getHeader(request, "authorization") ?? ""));
				return;
			}
			if (url.pathname === "/ai/management/depts" && request.method === "GET") {
				writeJson(response, 200, await management.depts(getHeader(request, "authorization") ?? ""));
				return;
			}
			if (url.pathname === "/ai/management/depts/switch" && request.method === "POST") {
				writeJson(
					response,
					200,
					await management.switchDept(getHeader(request, "authorization") ?? "", await readJsonObject(request)),
				);
				return;
			}
			if (url.pathname === "/ai/management/users/search" && request.method === "POST") {
				writeJson(
					response,
					200,
					await management.searchUsers(getHeader(request, "authorization") ?? "", await readJsonObject(request)),
				);
				return;
			}
			if (url.pathname === "/ai/management/conversations/search" && request.method === "POST") {
				writeJson(
					response,
					200,
					await management.searchConversations(
						getHeader(request, "authorization") ?? "",
						await readJsonObject(request),
					),
				);
				return;
			}
			if (url.pathname === "/ai/management/tools/catalog" && request.method === "GET") {
				writeJson(response, 200, await management.toolCatalog(getHeader(request, "authorization") ?? ""));
				return;
			}
			const timelineMatch = /^\/ai\/management\/conversations\/([A-Za-z0-9._-]+)\/timeline$/u.exec(url.pathname);
			if (timelineMatch && request.method === "GET") {
				writeJson(
					response,
					200,
					await management.timeline(getHeader(request, "authorization") ?? "", timelineMatch[1]),
				);
				return;
			}
			const turnsMatch = /^\/ai\/management\/conversations\/([A-Za-z0-9._-]+)\/turns$/u.exec(url.pathname);
			if (turnsMatch && request.method === "GET") {
				writeJson(response, 200, await management.turns(getHeader(request, "authorization") ?? "", turnsMatch[1]));
				return;
			}
			const turnEventsMatch = /^\/ai\/management\/conversations\/([A-Za-z0-9._-]+)\/turns\/(\d+)\/events$/u.exec(
				url.pathname,
			);
			if (turnEventsMatch && request.method === "GET") {
				writeJson(
					response,
					200,
					await management.turn(
						getHeader(request, "authorization") ?? "",
						turnEventsMatch[1],
						Number(turnEventsMatch[2]),
					),
				);
				return;
			}
			const eventMatch = /^\/ai\/management\/conversations\/([A-Za-z0-9._-]+)\/events\/(\d+)$/u.exec(url.pathname);
			if (eventMatch && request.method === "GET") {
				writeJson(
					response,
					200,
					await management.event(getHeader(request, "authorization") ?? "", eventMatch[1], Number(eventMatch[2])),
				);
				return;
			}
			requireGatewayToken(request, config);
			const caller = parseCallerContext(request, config);
			if (request.method === "POST" && url.pathname === "/ai/conversations") {
				const { query } = await readJsonBody(request);
				if (acceptsEventStream(request)) {
					await streamConversation(response, runtime, caller, query);
					return;
				}
				const result = await runtime.createConversation(query, caller);
				writeJson(response, 200, { ...result, conversation_id: result.conversationId, accepted: true });
				return;
			}
			const chatMatch = /^\/ai\/conversations\/([A-Za-z0-9._-]+)\/chat$/u.exec(url.pathname);
			if (request.method === "POST" && chatMatch) {
				const { query } = await readJsonBody(request);
				if (acceptsEventStream(request)) {
					await streamConversation(response, runtime, caller, query, chatMatch[1]);
					return;
				}
				const result = await runtime.chat(chatMatch[1], query, caller);
				writeJson(response, 200, { ...result, conversation_id: result.conversationId, accepted: true });
				return;
			}
			const interruptMatch = /^\/ai\/conversations\/([A-Za-z0-9._-]+)\/interrupt$/u.exec(url.pathname);
			if (request.method === "POST" && interruptMatch) {
				const interrupted = await runtime.interrupt(interruptMatch[1], caller);
				writeJson(response, 200, {
					conversation_id: interruptMatch[1],
					accepted: true,
					interrupted,
				});
				return;
			}
			const messagesMatch = /^\/ai\/conversations\/([A-Za-z0-9._-]+)\/messages$/u.exec(url.pathname);
			if (request.method === "GET" && messagesMatch) {
				const afterMessageId = Number(url.searchParams.get("after_message_id") ?? 0);
				writeJson(
					response,
					200,
					await management.messages(
						messagesMatch[1],
						Number.isSafeInteger(afterMessageId) ? afterMessageId : 0,
						caller,
					),
				);
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
			if (error instanceof ConversationAccessDeniedError) {
				writeJson(response, 403, { detail: error.message });
				return;
			}
			if (error instanceof ManagementRequestError) {
				writeJson(response, error.statusCode, { detail: error.message });
				return;
			}
			writeJson(response, 502, { detail: error instanceof Error ? error.message : "Pi runtime failed" });
		}
	});
}

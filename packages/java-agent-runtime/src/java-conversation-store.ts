/** Java v2 原生会话 Entry 持久化客户端。 */

import { contentText } from "../../ai/src/utils/text.ts";
import type { SessionEntry } from "../../coding-agent/src/core/session-manager.ts";
import type { RuntimeConfig } from "./config.ts";
import type { JavaMcpCallerContext } from "./java-mcp.ts";

const SYNC_MARKER_TYPE = "java_store_sync";

interface JavaStoreEnvelope<T> {
	code?: number;
	msg?: string;
	data?: T;
}

interface JavaStoreSyncResponse {
	conversationId: string;
	acceptedEntryIds: string[];
	latestEntryOrder: number | null;
}

/** Java 会话库的 HTTP 失败需要保留状态码，调用方才能区分权限拒绝与服务故障。 */
export class JavaConversationStoreError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

function firstUserQuery(entries: readonly SessionEntry[]): string {
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") {
			return contentText(entry.message.content, "");
		}
	}
	return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entriesToSync(entries: readonly SessionEntry[]): SessionEntry[] {
	let lastMarkerIndex = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === SYNC_MARKER_TYPE) {
			lastMarkerIndex = index;
			break;
		}
	}
	return entries
		.slice(lastMarkerIndex + 1)
		.filter((entry) => !(entry.type === "custom" && entry.customType === SYNC_MARKER_TYPE));
}

/**
 * Pi JSONL 是 AgentSession 的恢复真相；此客户端只复制已落盘的增量 Entry。
 * 成功后由调用方写入本地 marker，失败时下次会从上一个 marker 自动重放。
 */
export class JavaConversationStoreClient {
	private readonly baseUrl: string;
	private readonly gatewayToken: string;
	private readonly timeoutMs: number;

	constructor(config: RuntimeConfig) {
		this.baseUrl = config.javaGatewayBaseUrl;
		this.gatewayToken = config.gatewayToken;
		this.timeoutMs = config.mcpTimeoutMs;
	}

	async sync(conversationId: string, caller: JavaMcpCallerContext, entries: readonly SessionEntry[]): Promise<void> {
		const pending = entriesToSync(entries);
		if (!pending.length) return;
		const initialQuery = firstUserQuery(entries);
		if (!initialQuery) throw new Error("conversation store sync requires a user message");

		await this.request<JavaStoreSyncResponse>(
			`/ai/internal/store/v2/conversations/${encodeURIComponent(conversationId)}/entries`,
			"PUT",
			{ deptId: caller.tenantId, userId: caller.userId, initialQuery, entries: pending },
		);
	}

	/** 管理台读取 Java 索引，避免逐个扫描 Pi 本地 JSONL 文件。 */
	async searchConversations(request: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>("/ai/internal/store/v2/conversations/search", "POST", request);
	}

	/** Entry 保持 Pi 原始结构返回，由管理层按当前 Pi 版本统一投影。 */
	async listEntries(conversationId: string, caller?: JavaMcpCallerContext): Promise<unknown[]> {
		const ownerQuery = caller
			? `?deptId=${encodeURIComponent(caller.tenantId)}&userId=${encodeURIComponent(caller.userId)}`
			: "";
		const entries = await this.request<unknown[]>(
			`/ai/internal/store/v2/conversations/${encodeURIComponent(conversationId)}/entries${ownerQuery}`,
			"GET",
		);
		if (!Array.isArray(entries)) throw new Error("conversation store entries response invalid");
		return entries;
	}

	markSynced(entries: readonly SessionEntry[]): { lastEntryId: string } {
		const lastEntry = entries.at(-1);
		if (!lastEntry) throw new Error("conversation store sync has no entry to mark");
		return { lastEntryId: lastEntry.id };
	}

	static get syncMarkerType(): string {
		return SYNC_MARKER_TYPE;
	}

	private async request<T>(path: string, method: "GET" | "POST" | "PUT", body?: unknown): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				"X-AI-GW-TOKEN": this.gatewayToken,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		const raw: unknown = await response.json().catch(() => undefined);
		const envelope = isRecord(raw) ? (raw as JavaStoreEnvelope<T>) : {};
		if (!response.ok || envelope.code !== 200 || envelope.data === undefined) {
			throw new JavaConversationStoreError(
				response.status || 502,
				envelope.msg || `conversation store request failed with status ${response.status}`,
			);
		}
		return envelope.data;
	}
}

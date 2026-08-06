/** Java v2 原生会话 Entry 持久化客户端。 */

import { contentText } from "../../ai/src/utils/text.ts";
import { type SessionEntry, SessionManager } from "../../coding-agent/src/core/session-manager.ts";
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
 * Java 索引必须携带创建会话时的调用人范围，不能从管理台当前登录人反推，
 * 否则管理员补偿历史数据时会把原会话归属写错。
 */
function callerFromEntries(entries: readonly SessionEntry[]): JavaMcpCallerContext | undefined {
	const context = entries.find((entry) => entry.type === "custom" && entry.customType === "java_gateway_context");
	if (!context || context.type !== "custom" || !isRecord(context.data)) return undefined;
	const tenantId = typeof context.data.tenantId === "string" ? context.data.tenantId : "";
	const userId = typeof context.data.userId === "string" ? context.data.userId : "";
	return tenantId && userId ? { tenantId, userId } : undefined;
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

	async sync(
		conversationId: string,
		caller: JavaMcpCallerContext,
		entries: readonly SessionEntry[],
	): Promise<boolean> {
		const pending = entriesToSync(entries);
		if (!pending.length) return false;
		const initialQuery = firstUserQuery(entries);
		if (!initialQuery) throw new Error("conversation store sync requires a user message");

		await this.request<JavaStoreSyncResponse>(
			`/ai/internal/store/v2/conversations/${encodeURIComponent(conversationId)}/entries`,
			"PUT",
			{ deptId: caller.tenantId, userId: caller.userId, initialQuery, entries: pending },
		);
		return true;
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
			// Java 的 R<T> 业务异常仍可能使用 HTTP 200；若把 200 原样转给管理台，
			// 浏览器会把错误 JSON 当成空分页结果，掩盖真实的索引故障。
			const statusCode = response.ok ? 502 : response.status || 502;
			throw new JavaConversationStoreError(
				statusCode,
				envelope.msg || `conversation store request failed with status ${response.status}`,
			);
		}
		return envelope.data;
	}
}

/**
 * 历史 JSONL 可能产生于 Java 表创建之前。管理台首次检索时补偿未标记的会话，
 * 成功后才追加 marker；Java 以 Entry ID 去重，因此中断重试不会重复写入数据。
 */
export async function syncPendingConversationEntries(
	config: RuntimeConfig,
	store: JavaConversationStoreClient,
): Promise<number> {
	const sessions = await SessionManager.list(config.workingDirectory, config.sessionDirectory);
	let synchronized = 0;
	for (const session of sessions) {
		const manager = SessionManager.open(session.path, config.sessionDirectory, config.workingDirectory);
		const entries = manager.getEntries();
		const caller = callerFromEntries(entries);
		if (!caller || !(await store.sync(session.id, caller, entries))) continue;
		manager.appendCustomEntry(JavaConversationStoreClient.syncMarkerType, store.markSynced(entries));
		synchronized += 1;
	}
	return synchronized;
}

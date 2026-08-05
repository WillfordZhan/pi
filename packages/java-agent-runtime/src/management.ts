/** Pi 管理台的会话投影与 Java 管理接口访问。 */

import { contentText } from "../../ai/src/utils/text.ts";
import { type SessionEntry, SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import type { RuntimeConfig } from "./config.ts";
import { JavaConversationStoreClient, JavaConversationStoreError } from "./java-conversation-store.ts";
import { type JavaMcpCallerContext, JavaMcpClient } from "./java-mcp.ts";

export class ManagementRequestError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

type GatewayContext = { tenantId: string; userId: string };
type SessionEvent = Record<string, unknown>;
type SessionOwner = GatewayContext & { updatedAt: Date };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventSummary(type: string, data: Record<string, unknown>): string {
	if (type === "user_message" || type === "assistant_message") return String(data.content ?? "").slice(0, 160);
	if (type === "tool_call") return `调用工具 ${String(data.name ?? "")}`;
	if (type === "tool_result") return `工具返回 ${String(data.toolName ?? "")}`;
	return type;
}

function projectEntries(entries: SessionEntry[]): SessionEvent[] {
	const events: SessionEvent[] = [];
	let turnIndex = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			turnIndex += 1;
			const data = { content: contentText(message.content, "") };
			events.push({
				id: events.length + 1,
				event_type: "user_message",
				turn_index: turnIndex,
				created_at: entry.timestamp,
				data,
				summary: eventSummary("user_message", data),
				visible_in_messages: true,
				include_in_context: true,
			});
			continue;
		}
		if (message.role === "toolResult") {
			const data = { toolName: message.toolName, content: contentText(message.content, "") };
			events.push({
				id: events.length + 1,
				event_type: "tool_result",
				turn_index: turnIndex,
				created_at: entry.timestamp,
				data,
				summary: eventSummary("tool_result", data),
				visible_in_messages: false,
				include_in_context: true,
			});
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") {
				const data = { id: block.id, name: block.name, arguments: block.arguments };
				events.push({
					id: events.length + 1,
					event_type: "tool_call",
					turn_index: turnIndex,
					created_at: entry.timestamp,
					data,
					summary: eventSummary("tool_call", data),
					visible_in_messages: false,
					include_in_context: true,
				});
			}
		}
		const content = contentText(message.content, "");
		if (content) {
			const data = { content };
			events.push({
				id: events.length + 1,
				event_type: "assistant_message",
				turn_index: turnIndex,
				created_at: entry.timestamp,
				data,
				summary: eventSummary("assistant_message", data),
				visible_in_messages: true,
				include_in_context: true,
			});
		}
	}
	return events;
}

function sessionContext(entries: SessionEntry[]): GatewayContext | undefined {
	const entry = entries.find((item) => item.type === "custom" && item.customType === "java_gateway_context");
	if (!entry || entry.type !== "custom" || !isRecord(entry.data)) return undefined;
	const data = entry.data;
	const tenantId = typeof data.tenantId === "string" ? data.tenantId : "";
	const userId = typeof data.userId === "string" ? data.userId : "";
	return tenantId && userId ? { tenantId, userId } : undefined;
}

function value(payload: Record<string, unknown>, camelCase: string, snakeCase: string): unknown {
	return payload[camelCase] ?? payload[snakeCase];
}

/** 管理台日期筛选统一按会话创建时间的闭区间处理，非法时间不能静默放宽检索范围。 */
export function conversationCreatedInRange(createdAt: Date, createdFrom?: Date, createdTo?: Date): boolean {
	return (!createdFrom || createdAt >= createdFrom) && (!createdTo || createdAt <= createdTo);
}

function optionalDate(payload: Record<string, unknown>, camelCase: string, snakeCase: string): Date | undefined {
	const raw = value(payload, camelCase, snakeCase);
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw !== "string") throw new ManagementRequestError(400, `${snakeCase} must be an ISO date-time`);
	const date = new Date(raw);
	if (Number.isNaN(date.getTime())) throw new ManagementRequestError(400, `${snakeCase} must be an ISO date-time`);
	return date;
}

function normalizeDept(raw: unknown, currentDeptId?: string): Record<string, unknown> | undefined {
	if (!isRecord(raw)) return undefined;
	const deptId = raw.deptId === undefined ? "" : String(raw.deptId);
	if (!deptId) return undefined;
	return { deptId, deptName: String(raw.deptName ?? ""), current: deptId === currentDeptId };
}

/**
 * Pi 的会话真相源是 JSONL，用户列表必须由 JSONL 的创建人范围汇总，不能回查旧 Runtime 的会话表。
 * 用户资料尚未写入 JSONL 时以 userId 作为稳定展示名，避免为了显示昵称重新引入旧存储依赖。
 */
export function aggregateSessionUsers(
	owners: readonly SessionOwner[],
	deptId: string,
	keyword: string,
): Record<string, unknown>[] {
	const users = new Map<string, { conversationCount: number; lastConversationAt: Date }>();
	for (const owner of owners) {
		if (owner.tenantId !== deptId) continue;
		const current = users.get(owner.userId);
		users.set(owner.userId, {
			conversationCount: (current?.conversationCount ?? 0) + 1,
			lastConversationAt:
				current && current.lastConversationAt > owner.updatedAt ? current.lastConversationAt : owner.updatedAt,
		});
	}
	const normalizedKeyword = keyword.trim().toLowerCase();
	return [...users.entries()]
		.map(([userId, summary]) => ({
			userId,
			username: userId,
			deptId,
			conversationCount: summary.conversationCount,
			lastConversationAt: summary.lastConversationAt.toISOString(),
		}))
		.filter((item) => !normalizedKeyword || item.userId.toLowerCase().includes(normalizedKeyword))
		.sort((left, right) => right.lastConversationAt.localeCompare(left.lastConversationAt));
}

export class PiManagementService {
	private readonly mcp: JavaMcpClient;
	private readonly conversationStore: JavaConversationStoreClient;
	private readonly config: RuntimeConfig;

	constructor(config: RuntimeConfig) {
		this.config = config;
		this.mcp = new JavaMcpClient({
			baseUrl: config.javaMcpBaseUrl,
			internalToken: config.javaMcpToken,
			timeoutMs: config.mcpTimeoutMs,
		});
		this.conversationStore = new JavaConversationStoreClient(config);
	}

	async currentUser(authorization: string): Promise<Record<string, unknown>> {
		const payload = await this.javaJson("GET", "/common/currentUserInfo", authorization);
		const user = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
		const roles = user?.rolePermission;
		const isAdmin = Array.isArray(roles) && roles.some((role) => role === "admin");
		if (!user) throw new ManagementRequestError(401, "manage auth rejected");
		if (!isAdmin && Number(user.debugPrivilege) !== 1)
			throw new ManagementRequestError(403, "manage permission denied");
		return user;
	}

	async session(authorization: string): Promise<Record<string, unknown>> {
		const user = await this.currentUser(authorization);
		const [depts, current] = await Promise.all([
			this.javaJson("GET", "/dept/groupByDept?findType=0", authorization),
			this.javaJson("GET", "/homePage/getBeforeDept", authorization),
		]);
		const currentDept = isRecord(current) ? normalizeDept(current.data) : undefined;
		const rows = isRecord(depts) && isRecord(depts.data) && Array.isArray(depts.data.rows) ? depts.data.rows : [];
		const items = rows
			.map((item) => normalizeDept(item, String(currentDept?.deptId ?? "")))
			.filter((item): item is Record<string, unknown> => Boolean(item));
		if (currentDept && !items.some((item) => item.deptId === currentDept.deptId))
			items.push({ ...currentDept, current: true });
		return { user, depts: items, current_dept: currentDept ?? null };
	}

	async depts(authorization: string): Promise<Record<string, unknown>> {
		const state = await this.session(authorization);
		const current = isRecord(state.current_dept) ? state.current_dept : undefined;
		return { current_dept_id: current?.deptId ?? null, items: state.depts };
	}

	async switchDept(authorization: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
		await this.currentUser(authorization);
		const deptId = String(value(payload, "deptId", "dept_id") ?? "").trim();
		if (!deptId) throw new ManagementRequestError(400, "dept_id is required");
		const response = await this.proxyJava(
			"POST",
			`/homePage/changeDept?deptId=${encodeURIComponent(deptId)}`,
			authorization,
		);
		if (!response.ok) throw new ManagementRequestError(response.status || 502, "manage dept switch failed");
		const state = await this.session(authorization);
		return { current_dept: state.current_dept ?? null, items: state.depts };
	}

	async searchUsers(authorization: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
		await this.currentUser(authorization);
		const deptId = String(value(payload, "deptId", "dept_id") ?? "").trim();
		if (!deptId) throw new ManagementRequestError(400, "dept_id is required");
		const pageNum = Math.max(1, Number(value(payload, "pageNum", "page_num") ?? 1) || 1);
		const pageSize = Math.min(100, Math.max(1, Number(value(payload, "pageSize", "page_size") ?? 20) || 20));
		const keyword = String(value(payload, "keyword", "keyword") ?? "");
		const sessions = await SessionManager.list(this.config.workingDirectory, this.config.sessionDirectory);
		const owners = sessions.flatMap((session) => {
			const manager = SessionManager.open(session.path, this.config.sessionDirectory, this.config.workingDirectory);
			const context = sessionContext(manager.getEntries());
			return context ? [{ ...context, updatedAt: session.modified }] : [];
		});
		const items = aggregateSessionUsers(owners, deptId, keyword);
		const offset = (pageNum - 1) * pageSize;
		return { total: items.length, pageNum, pageSize, items: items.slice(offset, offset + pageSize) };
	}

	async searchConversations(
		authorization: string,
		payload: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		await this.currentUser(authorization);
		const pageNum = Math.max(1, Number(value(payload, "pageNum", "page_num") ?? 1) || 1);
		const pageSize = Math.min(100, Math.max(1, Number(value(payload, "pageSize", "page_size") ?? 20) || 20));
		const deptId = String(value(payload, "deptId", "dept_id") ?? "");
		const userId = String(value(payload, "userId", "user_id") ?? "");
		const keyword = String(value(payload, "keyword", "keyword") ?? "").trim();
		const createdFrom = optionalDate(payload, "createdFrom", "created_from");
		const createdTo = optionalDate(payload, "createdTo", "created_to");
		if (createdFrom && createdTo && createdFrom > createdTo) {
			throw new ManagementRequestError(400, "created_from must be before created_to");
		}
		return this.conversationStore.searchConversations({
			pageNum,
			pageSize,
			deptId,
			userId,
			keyword,
			createdFrom: createdFrom?.toISOString(),
			createdTo: createdTo?.toISOString(),
		});
	}

	async timeline(authorization: string, conversationId: string): Promise<Record<string, unknown>> {
		await this.currentUser(authorization);
		const events = projectEntries(await this.entries(conversationId));
		const messages = events
			.filter((event) => Boolean(event.visible_in_messages))
			.map((event) => ({
				message_id: event.id,
				turn_index: event.turn_index,
				role: event.event_type === "user_message" ? "user" : "assistant",
				content: isRecord(event.data) ? (event.data.content ?? "") : "",
				created_at: event.created_at,
				status: "final",
				anchor_event_id: event.id,
			}));
		return { conversation: { conversationId }, messages };
	}

	async messages(
		conversationId: string,
		afterMessageId: number,
		caller: JavaMcpCallerContext,
	): Promise<Record<string, unknown>> {
		const events = projectEntries(await this.entries(conversationId, caller));
		const messages = events
			.filter((event) => Number(event.id) > afterMessageId && Boolean(event.visible_in_messages))
			.map((event) => ({
				id: event.id,
				conversation_id: conversationId,
				message_type: event.event_type === "assistant_message" ? "final" : "user_message",
				role: event.event_type === "user_message" ? "user" : "assistant",
				content: isRecord(event.data) ? (event.data.content ?? "") : "",
				data: event.data ?? {},
				created_at: event.created_at,
			}));
		return { conversation_id: conversationId, messages };
	}

	async turns(authorization: string, conversationId: string): Promise<Record<string, unknown>> {
		await this.currentUser(authorization);
		const events = projectEntries(await this.entries(conversationId));
		const groups = new Map<number, SessionEvent[]>();
		for (const event of events) {
			const index = Number(event.turn_index);
			groups.set(index, [...(groups.get(index) ?? []), event]);
		}
		return {
			conversation_id: conversationId,
			turns: [...groups.entries()].map(([turnIndex, turnEvents]) => ({
				turn_index: turnIndex,
				anchor_event_id: turnEvents[0]?.id,
				query: isRecord(turnEvents[0]?.data) ? (turnEvents[0].data.content ?? null) : null,
				status: "final",
				event_count: turnEvents.length,
				assistant_message_event_id:
					turnEvents.find((event) => event.event_type === "assistant_message")?.id ?? null,
				assistant_preview: turnEvents.find((event) => event.event_type === "assistant_message")?.summary ?? null,
				events: turnEvents.map((event) => ({ ...event, raw_json: JSON.stringify(event) })),
			})),
		};
	}

	async turn(authorization: string, conversationId: string, turnIndex: number): Promise<Record<string, unknown>> {
		const payload = await this.turns(authorization, conversationId);
		const turn = Array.isArray(payload.turns)
			? payload.turns.find((item) => isRecord(item) && item.turn_index === turnIndex)
			: undefined;
		if (!turn) throw new ManagementRequestError(404, "turn not found");
		return { conversation_id: conversationId, turn };
	}

	async event(authorization: string, conversationId: string, eventId: number): Promise<Record<string, unknown>> {
		await this.currentUser(authorization);
		const event = projectEntries(await this.entries(conversationId)).find((item) => item.id === eventId);
		if (!event) throw new ManagementRequestError(404, "event not found");
		return { conversation_id: conversationId, event: { ...event, raw_json: JSON.stringify(event) } };
	}

	async toolCatalog(authorization: string): Promise<Record<string, unknown>> {
		await this.currentUser(authorization);
		const tools = await this.mcp.createTools({
			conversationId: "management-catalog",
			caller: { tenantId: "management", userId: "1" },
		});
		const descriptors = tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
			output_schema: {},
		}));
		return {
			providers: [
				{
					provider_type: "mcp",
					provider_key: "java-mcp",
					name: "Java MCP",
					description: "Java MCP 业务工具",
					url: this.config.javaMcpBaseUrl,
					status: "connected",
					tools: descriptors,
				},
				{
					provider_type: "internal",
					provider_key: "pi-runtime",
					name: "Pi Runtime",
					description: "Pi AgentSession 会话运行时",
					tools: [],
				},
			],
			summary: { tool_count: descriptors.length, provider_count: 2 },
		};
	}

	async proxyJava(
		method: string,
		path: string,
		authorization: string,
		body?: Buffer,
		accept?: string,
		signal?: AbortSignal,
	): Promise<Response> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (authorization) headers.Authorization = authorization;
		if (accept) headers.Accept = accept;
		const request: RequestInit = {
			method,
			headers,
			signal,
		};
		if (body && method !== "GET" && method !== "HEAD") request.body = body;
		return fetch(`${this.config.javaGatewayBaseUrl}${path}`, request);
	}

	/** Java 只保存原始 Entry；这里校验为对象后再按 Pi SessionEntry 进行展示投影。 */
	private async entries(conversationId: string, caller?: JavaMcpCallerContext): Promise<SessionEntry[]> {
		try {
			const entries = await this.conversationStore.listEntries(conversationId, caller);
			return entries.filter(isRecord) as unknown as SessionEntry[];
		} catch (error) {
			if (error instanceof JavaConversationStoreError) {
				throw new ManagementRequestError(error.statusCode, error.message);
			}
			throw error;
		}
	}

	private async javaJson(
		method: string,
		path: string,
		authorization: string,
		request?: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const response = await this.proxyJava(
			method,
			path,
			authorization,
			request ? Buffer.from(JSON.stringify(request)) : undefined,
		);
		const payload: unknown = await response.json().catch(() => undefined);
		if (!response.ok || !isRecord(payload))
			throw new ManagementRequestError(response.status || 502, "manage gateway request failed");
		return payload;
	}
}

import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../coding-agent/src/core/session-manager.ts";
import { aggregateSessionUsers, conversationCreatedInRange, projectEntries } from "../src/management.ts";

describe("aggregateSessionUsers", () => {
	it("lists Pi JSONL session owners without depending on the legacy conversation table", () => {
		const items = aggregateSessionUsers(
			[
				{ tenantId: "100", userId: "7", updatedAt: new Date("2026-08-05T00:00:00.000Z") },
				{ tenantId: "100", userId: "7", updatedAt: new Date("2026-08-05T01:00:00.000Z") },
				{ tenantId: "100", userId: "8", updatedAt: new Date("2026-08-04T01:00:00.000Z") },
				{ tenantId: "101", userId: "9", updatedAt: new Date("2026-08-05T02:00:00.000Z") },
			],
			"100",
			"",
		);

		expect(items).toEqual([
			{
				userId: "7",
				username: "7",
				deptId: "100",
				conversationCount: 2,
				lastConversationAt: "2026-08-05T01:00:00.000Z",
			},
			{
				userId: "8",
				username: "8",
				deptId: "100",
				conversationCount: 1,
				lastConversationAt: "2026-08-04T01:00:00.000Z",
			},
		]);
	});
});

describe("conversationCreatedInRange", () => {
	it("keeps conversations created within the selected inclusive date range", () => {
		const createdAt = new Date("2026-08-05T12:00:00.000Z");
		expect(conversationCreatedInRange(createdAt, new Date("2026-08-05T12:00:00.000Z"))).toBe(true);
		expect(conversationCreatedInRange(createdAt, undefined, new Date("2026-08-05T12:00:00.000Z"))).toBe(true);
		expect(conversationCreatedInRange(createdAt, new Date("2026-08-05T12:00:01.000Z"))).toBe(false);
	});
});

describe("projectEntries", () => {
	it("uses the catalog snapshot that was active when each tool call was written", () => {
		const entries = [
			{
				type: "custom",
				customType: "java_tool_presentations",
				data: { query_plan: { progressText: "正在查询旧计划", successText: "已查询旧计划" } },
			},
			{
				type: "message",
				timestamp: "2026-08-05T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "query_plan", arguments: {} }],
				},
			},
			{
				type: "message",
				timestamp: "2026-08-05T10:00:01.500Z",
				message: { role: "toolResult", toolCallId: "call-1", toolName: "query_plan", content: [], isError: false },
			},
			{
				type: "custom",
				customType: "java_tool_presentations",
				data: { query_plan: { progressText: "正在查询新计划", successText: "已查询新计划" } },
			},
			{
				type: "message",
				timestamp: "2026-08-05T10:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-2", name: "query_plan", arguments: {} }],
				},
			},
			{
				type: "message",
				timestamp: "2026-08-05T10:00:02.500Z",
				message: { role: "toolResult", toolCallId: "call-2", toolName: "query_plan", content: [], isError: false },
			},
		] as unknown as SessionEntry[];

		const events = projectEntries(entries);
		expect(
			events
				.filter((event) => event.event_type === "tool_call")
				.map((event) => (event.data as Record<string, unknown>).display_text),
		).toEqual(["正在查询旧计划", "正在查询新计划"]);
	});

	it("keeps Pi tool calls and results in the Java-indexed turn detail", () => {
		const entries = [
			{
				type: "custom",
				id: "presentation-1",
				parentId: null,
				timestamp: "2026-08-05T09:59:59.000Z",
				customType: "java_tool_presentations",
				data: {
					query_plan: { progressText: "正在查询生产计划", successText: "已查询生产计划" },
				},
			},
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: "2026-08-05T10:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "查询计划" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-08-05T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "query_plan", arguments: { planId: "1" } }],
					api: "openai-completions",
					provider: "openai",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "result-1",
				parentId: "assistant-1",
				timestamp: "2026-08-05T10:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "query_plan",
					content: [{ type: "text", text: "计划已找到" }],
					isError: false,
					timestamp: 3,
				},
			},
		] as SessionEntry[];

		const events = projectEntries(entries);
		expect(events.map((event) => event.event_type)).toEqual(["user_message", "tool_call", "tool_result"]);
		expect(events[1]?.data).toMatchObject({ display_text: "正在查询生产计划", tool_call_id: "call-1" });
		expect(events[2]?.data).toMatchObject({ display_text: "已查询生产计划", tool_call_id: "call-1" });
		expect(events.slice(1).every((event) => event.visible_in_messages)).toBe(true);
		expect(JSON.stringify(events)).not.toContain("planId");
		expect(JSON.stringify(events)).not.toContain("计划已找到");
	});

	it("marks an orphan tool call as interrupted after the runtime is no longer running", () => {
		const entries = [
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp: "2026-08-05T10:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "query_plan", arguments: { secret: "raw" } }],
					api: "openai-completions",
					provider: "openai",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
		] as SessionEntry[];

		const [event] = projectEntries(entries);
		expect(event).toMatchObject({
			event_type: "tool_result",
			data: { tool_call_id: "call-1", display_text: "业务处理结果未知，请勿重复操作", is_error: true },
		});
		expect(JSON.stringify(event)).not.toContain("raw");
	});

	it("distinguishes an aborted tool from an ordinary business failure", () => {
		const entries = [
			{
				type: "message",
				id: "tool-result-1",
				parentId: null,
				timestamp: "2026-08-12T08:20:19.498Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "query_stock",
					content: [{ type: "text", text: "This operation was aborted" }],
					isError: true,
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "tool-result-1",
				timestamp: "2026-08-12T08:20:19.500Z",
				message: {
					role: "assistant",
					content: [],
					stopReason: "aborted",
					errorMessage: "Request aborted",
				},
			},
		] as unknown as SessionEntry[];

		const [event] = projectEntries(entries);
		expect(event).toMatchObject({
			event_type: "tool_result",
			data: {
				tool_call_id: "call-1",
				display_text: "连接中断，业务处理结果未知，请勿重复操作",
				is_error: true,
				failure_kind: "interrupted",
			},
		});
	});
});

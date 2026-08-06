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
	it("keeps Pi tool calls and results in the Java-indexed turn detail", () => {
		const entries = [
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

		expect(projectEntries(entries).map((event) => event.event_type)).toEqual([
			"user_message",
			"tool_call",
			"tool_result",
		]);
	});
});

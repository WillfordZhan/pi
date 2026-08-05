import { describe, expect, it } from "vitest";
import { aggregateSessionUsers } from "../src/management.ts";

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

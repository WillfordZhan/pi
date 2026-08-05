import { describe, expect, it } from "vitest";
import type { CustomEntry } from "../../coding-agent/src/core/session-manager.ts";
import { assertConversationCaller, ConversationAccessDeniedError } from "../src/runtime.ts";

const caller = { tenantId: "100", userId: "9007199254740993" };

function contextEntry(data: Record<string, unknown>): CustomEntry {
	return {
		type: "custom",
		customType: "java_gateway_context",
		data,
		id: "context",
		parentId: null,
		timestamp: "2026-08-05T00:00:00.000Z",
	};
}

describe("assertConversationCaller", () => {
	it("only permits the caller that created the session", () => {
		expect(() => assertConversationCaller([contextEntry(caller)], caller)).not.toThrow();
		expect(() =>
			assertConversationCaller([contextEntry({ tenantId: "101", userId: caller.userId })], caller),
		).toThrow(ConversationAccessDeniedError);
	});

	it("fails closed for legacy sessions without caller metadata", () => {
		expect(() => assertConversationCaller([], caller)).toThrow(ConversationAccessDeniedError);
	});
});

import { describe, expect, it } from "vitest";
import { normalizeTenantId, normalizeUserId } from "../src/http-server.ts";

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

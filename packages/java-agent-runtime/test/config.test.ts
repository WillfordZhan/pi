import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config.ts";

describe("loadRuntimeConfig", () => {
	it("keeps the Python Runtime environment variable contract", () => {
		const config = loadRuntimeConfig({
			PI_RUNTIME_CWD: "/tmp/pi-runtime",
			AI_GATEWAY_INTERNAL_TOKEN: "gateway-token",
			AI_GATEWAY_CONTEXT_SIGN_SECRET: "context-secret",
			MCP_BASE_URL: "http://127.0.0.1:10002/epservice/ai/mcp/",
			MCP_API_TOKEN: "mcp-token",
			MCP_TIMEOUT_SECONDS: "12",
			QWEN_MODEL: "qwen3.7-plus",
			QWEN_API_KEY_FILE: "config/apikey.txt",
		});

		expect(config).toMatchObject({
			gatewayToken: "gateway-token",
			contextSignSecret: "context-secret",
			javaMcpBaseUrl: "http://127.0.0.1:10002/epservice/ai/mcp",
			javaMcpToken: "mcp-token",
			mcpTimeoutMs: 12_000,
			modelProvider: "dashscope",
			modelId: "qwen3.7-plus",
			qwenApiKeyFile: "config/apikey.txt",
			qwenApiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		});
		expect(config.sessionDirectory).toBe("/tmp/pi-runtime/sessions");
	});
});

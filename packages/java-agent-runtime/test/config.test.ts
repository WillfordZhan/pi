import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config.ts";

describe("loadRuntimeConfig", () => {
	it("keeps the Python Runtime environment variable contract", () => {
		const config = loadRuntimeConfig({
			APP_ENV_FILE: "/tmp/legacy-runtime/.env",
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
			javaGatewayBaseUrl: "http://127.0.0.1:10002/epservice",
			mcpTimeoutMs: 12_000,
			modelProvider: "dashscope",
			modelId: "qwen3.7-plus",
			qwenApiKeyFile: "/tmp/legacy-runtime/config/apikey.txt",
			qwenApiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		});
		expect(config.sessionDirectory).toBe("/tmp/pi-runtime/sessions");
		expect(config.manageConsoleDirectory).toContain("packages/java-agent-runtime/static/manage-console");
		expect(config.weCom).toBeUndefined();
	});

	it("loads the optional WeCom test channel without converting large ERP IDs to numbers", () => {
		const config = loadRuntimeConfig({
			PI_RUNTIME_CWD: "/tmp/pi-runtime",
			AI_GATEWAY_INTERNAL_TOKEN: "gateway-token",
			AI_GATEWAY_CONTEXT_SIGN_SECRET: "context-secret",
			MCP_BASE_URL: "http://127.0.0.1:10002/epservice/ai/mcp",
			MCP_API_TOKEN: "mcp-token",
			WECOM_BOT_ID: "bot-id",
			WECOM_BOT_SECRET: "bot-secret",
			WECOM_ALLOWED_USER_ID: "wecom-user",
			WECOM_TEST_ERP_USER_ID: "1942403262651006977",
			WECOM_TEST_DEPT_ID: "1955839459465793537",
			WECOM_TEST_DEPT_NAME: "ERP开发工厂",
		});

		expect(config.weCom).toEqual({
			botId: "bot-id",
			botSecret: "bot-secret",
			allowedUserId: "wecom-user",
			testErpUserId: "1942403262651006977",
			testDeptId: "1955839459465793537",
			testDeptName: "ERP开发工厂",
		});
	});
});

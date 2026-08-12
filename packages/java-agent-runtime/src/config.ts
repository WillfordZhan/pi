/**
 * Java Agent Runtime 的部署配置。
 *
 * Runtime 只读取部署环境变量：Java 仍然是前端入口，Pi 自己负责会话与 Agent 运行。
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimeConfig {
	port: number;
	workingDirectory: string;
	sessionDirectory: string;
	gatewayToken: string;
	contextSignSecret: string;
	clockSkewSeconds: number;
	javaMcpBaseUrl: string;
	javaMcpToken: string;
	javaGatewayBaseUrl: string;
	manageConsoleDirectory: string;
	mcpTimeoutMs: number;
	modelProvider: string;
	modelId: string;
	qwenApiKey?: string;
	qwenApiKeyFile?: string;
	qwenApiBase: string;
	weCom?: WeComChannelConfig;
}

/** 企业微信测试 Channel 只保存部署配置，不在 Runtime 内推导或查询 ERP 身份。 */
export interface WeComChannelConfig {
	botId: string;
	botSecret: string;
	allowedUserId?: string;
	testErpUserId: string;
	testDeptId: string;
	testDeptName: string;
}

function requiredEnvironment(name: string, environment: NodeJS.ProcessEnv): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function parsePort(value: string | undefined): number {
	const port = Number(value ?? "8000");
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("PI_RUNTIME_PORT must be an integer between 1 and 65535");
	}
	return port;
}

function parsePositiveNumber(name: string, value: string | undefined, fallback: number): number {
	const parsed = Number(value ?? fallback);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
	return parsed;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/u, "");
}

function decimalId(name: string, value: string | undefined): string {
	const normalized = value?.trim() ?? "";
	if (!/^[1-9]\d*$/u.test(normalized)) throw new Error(`${name} must be a positive decimal integer`);
	return normalized;
}

/**
 * BotID 与 Secret 必须成对出现；完全不配置时保持现有纯 HTTP Runtime 行为。
 * 固定 ERP 身份仅用于单人白名单联调，正式接入应由 Java Gateway 动态解析。
 */
function loadWeComChannelConfig(environment: NodeJS.ProcessEnv): WeComChannelConfig | undefined {
	const botId = environment.WECOM_BOT_ID?.trim() ?? "";
	const botSecret = environment.WECOM_BOT_SECRET?.trim() ?? "";
	if (!botId && !botSecret) return undefined;
	if (!botId || !botSecret) throw new Error("WECOM_BOT_ID and WECOM_BOT_SECRET must be configured together");
	return {
		botId,
		botSecret,
		allowedUserId: environment.WECOM_ALLOWED_USER_ID?.trim() || undefined,
		testErpUserId: decimalId("WECOM_TEST_ERP_USER_ID", environment.WECOM_TEST_ERP_USER_ID),
		testDeptId: decimalId("WECOM_TEST_DEPT_ID", environment.WECOM_TEST_DEPT_ID),
		testDeptName: requiredEnvironment("WECOM_TEST_DEPT_NAME", environment),
	};
}

function resolveKeyFile(
	value: string | undefined,
	environment: NodeJS.ProcessEnv,
	workingDirectory: string,
): string | undefined {
	if (!value?.trim()) return undefined;
	if (isAbsolute(value)) return value;
	// 旧运行时把相对密钥路径写在 APP_ENV_FILE 中；迁移后仍以该配置文件所在目录为基准。
	return resolve(environment.APP_ENV_FILE ? dirname(resolve(environment.APP_ENV_FILE)) : workingDirectory, value);
}

/**
 * 复用旧 Python Runtime 的 APP_ENV_FILE 约定，避免部署时维护两套密钥配置。
 */
export function loadRuntimeEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
	const envFile = resolve(environment.APP_ENV_FILE ?? ".env");
	if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
	const workingDirectory = resolve(environment.PI_RUNTIME_CWD ?? process.cwd());
	const runtimeDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const javaMcpBaseUrl = trimTrailingSlash(requiredEnvironment("MCP_BASE_URL", environment));
	return {
		port: parsePort(environment.PI_RUNTIME_PORT),
		workingDirectory,
		sessionDirectory: resolve(workingDirectory, environment.PI_RUNTIME_SESSION_DIR ?? "sessions"),
		gatewayToken: requiredEnvironment("AI_GATEWAY_INTERNAL_TOKEN", environment),
		contextSignSecret: requiredEnvironment("AI_GATEWAY_CONTEXT_SIGN_SECRET", environment),
		clockSkewSeconds: parsePositiveNumber(
			"AI_GATEWAY_CLOCK_SKEW_SECONDS",
			environment.AI_GATEWAY_CLOCK_SKEW_SECONDS,
			30,
		),
		javaMcpBaseUrl,
		javaMcpToken: requiredEnvironment("MCP_API_TOKEN", environment),
		javaGatewayBaseUrl: trimTrailingSlash(
			environment.JAVA_GATEWAY_BASE_URL?.trim() || javaMcpBaseUrl.replace(/\/ai\/mcp$/u, ""),
		),
		manageConsoleDirectory: resolve(
			environment.PI_RUNTIME_MANAGE_CONSOLE_DIR ?? resolve(runtimeDirectory, "static/manage-console"),
		),
		mcpTimeoutMs: parsePositiveNumber("MCP_TIMEOUT_SECONDS", environment.MCP_TIMEOUT_SECONDS, 10) * 1000,
		modelProvider: environment.PI_RUNTIME_MODEL_PROVIDER?.trim() || "dashscope",
		modelId: environment.QWEN_MODEL?.trim() || "qwen3.7-plus",
		qwenApiKey: environment.QWEN_API_KEY?.trim() || undefined,
		qwenApiKeyFile: resolveKeyFile(environment.QWEN_API_KEY_FILE, environment, workingDirectory),
		qwenApiBase: environment.QWEN_API_BASE?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1",
		weCom: loadWeComChannelConfig(environment),
	};
}

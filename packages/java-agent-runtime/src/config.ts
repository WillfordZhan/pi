/**
 * Java Agent Runtime 的部署配置。
 *
 * Runtime 只读取部署环境变量：Java 仍然是前端入口，Pi 自己负责会话与 Agent 运行。
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface RuntimeConfig {
	port: number;
	workingDirectory: string;
	sessionDirectory: string;
	gatewayToken: string;
	contextSignSecret: string;
	clockSkewSeconds: number;
	javaMcpBaseUrl: string;
	javaMcpToken: string;
	mcpTimeoutMs: number;
	modelProvider: string;
	modelId: string;
	qwenApiKey?: string;
	qwenApiKeyFile?: string;
	qwenApiBase: string;
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

/**
 * 复用旧 Python Runtime 的 APP_ENV_FILE 约定，避免部署时维护两套密钥配置。
 */
export function loadRuntimeEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
	const envFile = resolve(environment.APP_ENV_FILE ?? ".env");
	if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
	const workingDirectory = resolve(environment.PI_RUNTIME_CWD ?? process.cwd());
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
		javaMcpBaseUrl: trimTrailingSlash(requiredEnvironment("MCP_BASE_URL", environment)),
		javaMcpToken: requiredEnvironment("MCP_API_TOKEN", environment),
		mcpTimeoutMs: parsePositiveNumber("MCP_TIMEOUT_SECONDS", environment.MCP_TIMEOUT_SECONDS, 10) * 1000,
		modelProvider: environment.PI_RUNTIME_MODEL_PROVIDER?.trim() || "dashscope",
		modelId: environment.QWEN_MODEL?.trim() || "qwen3.7-plus",
		qwenApiKey: environment.QWEN_API_KEY?.trim() || undefined,
		qwenApiKeyFile: environment.QWEN_API_KEY_FILE?.trim() || undefined,
		qwenApiBase: environment.QWEN_API_BASE?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1",
	};
}

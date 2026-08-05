/**
 * Java Agent Runtime 的部署配置。
 *
 * Runtime 只读取部署环境变量：Java 仍然是前端入口，Pi 自己负责会话与 Agent 运行。
 */

import { resolve } from "node:path";

export interface RuntimeConfig {
	port: number;
	workingDirectory: string;
	sessionDirectory: string;
	gatewayToken: string;
	javaMcpBaseUrl: string;
	javaMcpToken: string;
	modelProvider: string;
	modelId: string;
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

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/u, "");
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
	const workingDirectory = resolve(environment.PI_RUNTIME_CWD ?? process.cwd());
	return {
		port: parsePort(environment.PI_RUNTIME_PORT),
		workingDirectory,
		sessionDirectory: resolve(environment.PI_RUNTIME_SESSION_DIR ?? `${workingDirectory}/sessions`),
		gatewayToken: requiredEnvironment("PI_RUNTIME_GATEWAY_TOKEN", environment),
		javaMcpBaseUrl: trimTrailingSlash(requiredEnvironment("JAVA_MCP_BASE_URL", environment)),
		javaMcpToken: requiredEnvironment("JAVA_MCP_TOKEN", environment),
		modelProvider: environment.PI_RUNTIME_MODEL_PROVIDER?.trim() || "qwen-token-plan-cn",
		modelId: environment.PI_RUNTIME_MODEL_ID?.trim() || "qwen3.7-plus",
	};
}

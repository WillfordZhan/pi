import { EventEmitter } from "node:events";
import * as undici from "undici";

/** 默认的 HTTP 空闲超时（毫秒）。 */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node 默认的 250ms 会在高延迟路由上终止有效的连接尝试。
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

/** HTTP 空闲超时的可选配置项（用于设置界面展示）。 */
export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

/** 模块加载时的全局 fetch 引用，用于判断是否应安装 undici 全局。 */
const originalGlobalFetch = globalThis.fetch;
/** 由本模块安装的全局 fetch；用于检测调用方是否替换过 fetch。 */
let installedGlobalFetch: typeof globalThis.fetch | undefined;

/** 解析 HTTP 空闲超时配置：接受数字、"disabled" 或空字符串，非法值返回 undefined。 */
export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

/** 把超时毫秒数格式化为可读的标签（匹配预设选项或换算为秒）。 */
export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

/** 将配置的代理 URL 应用到 HTTP_PROXY / HTTPS_PROXY 环境变量（仅当二者未设置时）。 */
export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

/** 忽略 undici 内部派发器错误（避免未处理的 error 事件导致进程崩溃）。 */
const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici 在终止流式 fetch 响应体时会发出内部 Client "error" 事件。响应体流仍会
// 通过 reader.read() 拒绝；这里的监听器只是为了阻止 EventEmitter 对未处理
// "error" 事件的特殊处理导致 pi 崩溃。
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

/** 创建单个连接数的 undici Client，并挂上错误监听。 */
function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

/** 按连接数选择创建 Pool 或单个 Client：连接数为 1 时直接用 Client。 */
function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

/** 配置全局 HTTP 派发器（空闲超时、代理、H2 等），并保持 fetch 与派发器同实现。 */
export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	// 让 fetch 与派发器使用同一套 undici 实现。否则 Node 26.0 内置的 fetch 可能
	// 通过 npm undici 的派发器消费压缩响应但不解压，导致 response.json() 失败。
	// 若调用方在模块加载后替换过 fetch，则保留其有意为之的覆盖。
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}

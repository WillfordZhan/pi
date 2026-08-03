// 对 provider HTTP 错误对象的共享归一化处理。
//
// 位于代理/网关后面的接口可能返回非 2xx 响应，其响应体无法被 provider SDK
// 折叠进 `error.message`。SDK 错误对象仍携带 HTTP 状态码以及原始/解析后的响应体，
// 但字段名因 SDK 而异。因此只读 `error.message` 的 provider catch 块会丢失响应体，
// 并抛出如 `"403 status code (no body)"` 或 `"Unknown: UnknownError"` 的不透明消息。
//
// `normalizeProviderError` 探测已知的 SDK 字段形状（Mistral、`openai`、
// `@google/genai`、AWS Bedrock）并返回一个结构体，供各 provider 拼装成展示字符串。
// `messageCarriesBody` 标志捕获 Anthropic / `@google/genai` 的常见路径：
// 这些 SDK 已把响应体折叠进 message，因此 provider 可以保留它而不会重复打印。

/** 错误响应体字符串的最大长度（字符数），超出会被截断。 */
export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

/**
 * 归一化后的 provider 错误对象，统一了不同 SDK 错误对象的字段形状。
 * provider 层用它拼装面向用户的错误展示字符串。
 */
export interface NormalizedProviderError {
	/** HTTP 状态码；若能从 SDK 错误对象中提取到才有值。 */
	status?: number;
	/** 原始 HTTP 响应体原因，已去除首尾空白并按上限截断。 */
	body?: string;
	/** `error.message`；若抛出值不是 `Error` 实例，则为 `safeJsonStringify(error)` 的结果。 */
	message: string;
	/** 为 true 时表示 `message` 已包含响应体（无需再单独拼接 body）。 */
	messageCarriesBody: boolean;
}

/** 各 provider SDK 错误对象可能带有的字段形状集合，用于统一探测。 */
type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

/**
 * 将任意抛出的值归一化为 {@link NormalizedProviderError}。
 * 若传入的不是 `Error` 实例，则直接序列化；否则探测状态码、响应体并判断 message 是否已包含 body。
 */
export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return {
		status,
		body,
		message: error.message,
		messageCarriesBody,
	} satisfies NormalizedProviderError;
}

/**
 * 探测 HTTP 状态码，按 SDK 字段顺序取第一个数字命中值：
 * `statusCode`（Mistral）→ `status`（`openai`、`@google/genai`）→
 * `$metadata.httpStatusCode`（Bedrock）→ `$response.statusCode`（Bedrock）。
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

/**
 * 探测原始响应体原因，按 SDK 字段顺序取第一个可用命中值：
 * `body` 字符串（Mistral）→ `error` 解析后的 JSON 响应体对象（`openai` SDK 的 `this.error`）
 * → `$response.body`（Bedrock）。空对象和不可读的响应流视为无响应体，
 * 以免展示成 `"{}"` 或序列化的流内部结构。选中的响应体会被截断到上限。
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

/** 从 SDK 错误对象中挑出一个可用的原始响应体文本。 */
function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

/** 判断值是否是 Node 风格的读取流（带有 `pipe` 方法），这类对象不能作为响应体。 */
function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * 只有“纯对象”才被视为 HTTP 响应体。SDK 错误字段可能保存类实例而非解析后的响应体——
 * AWS SDK v3 的 `$response.body` 就是 HTTP 流/响应包装对象，序列化它会产生
 * `{"_events":...}` 之类的垃圾，并会在拼装展示字符串时“覆盖” `error.message`。
 * `error.message` 才是 SDK 放入真实反序列化异常文本的地方，因此类实例应排除在外：
 * 类实例视为无响应体、`messageCarriesBody` 保持 true，真实消息得以保留。
 * 与上面的 `pipe` 探测互补：Web ReadableStream（用 pipeTo/pipeThrough、无 `pipe`）
 * 和非流式 SDK 包装类都过不了原型检查，而解析后的 JSON 响应体（本就是纯对象）仍能通过。
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).length > 0;
}

/**
 * 将归一化错误拼装成展示字符串。当 message 已包含响应体（Anthropic / `@google/genai`
 * 常见路径）或未提取到状态码/响应体时，原样返回 message；否则展示状态码与响应体，
 * 可带可选的前缀。
 *
 * - 无前缀：`"<status>: <body>"`
 * - 有前缀：`"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		return prefix !== undefined && norm.status !== undefined
			? `${prefix} (${norm.status}): ${norm.message}`
			: norm.message;
	}
	return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

/** 将文本截断到 `maxChars` 字符，超出时在末尾附加省略说明。 */
export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

/** 安全地序列化任意值为字符串；序列化失败时回退为 `String(value)`。 */
export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

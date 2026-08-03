/**
 * Google Generative AI 与 Google Vertex 两个 provider 共享的通用工具。
 */

import { type Content, FinishReason, FunctionCallingConfigMode, type Part } from "@google/genai";
import type { Context, ImageContent, Model, StopReason, TextContent, Tool } from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

/** Google provider 的 API 类型：Google AI Studio 或 Vertex。 */
type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Gemini 3 模型的思考级别。
 * 与 Google 的 ThinkingLevel 枚举值保持一致。
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

/**
 * 判断流式返回的 Gemini `Part` 是否应被当作“思考”内容。
 *
 * 协议说明（Gemini / Vertex AI 思考签名）：
 * - `thought: true` 是思考内容（思考摘要）的确定标记。
 * - `thoughtSignature` 是模型内部思考过程的加密表示，用于在多轮交互中保留推理上下文。
 * - `thoughtSignature` 可以出现在任何 part 类型上（text、functionCall 等），它并不表示
 *   该 part 本身是思考内容。
 * - 对非 functionCall 响应，签名会出现在最后一个 part 上，用于上下文回放。
 * - 持久化/回放模型输出时，带签名的 part 必须原样保留，不要跨 part 合并或移动签名。
 *
 * 参见：https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * 在流式过程中保留思考签名。
 *
 * 某些后端只在某个 part/block 的第一个 delta 中发送 `thoughtSignature`，后续 delta 可能省略。
 * 该辅助函数会保留当前 block 最后一次非空的签名。
 *
 * 注意：它不会跨不同的响应 part 合并或移动签名，只防止同一流式 block 内
 * 签名被 `undefined` 覆盖。
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Google API 要求思考签名为 base64 编码（TYPE_BYTES）。
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

/** 判断思考签名是否为合法的 base64 字符串。 */
function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * 仅当消息来自同一 provider/模型且签名为合法 base64 时才保留签名。
 * 跨 provider/模型时签名不可复用，直接丢弃。
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * 通过 Google API 调用、需要在函数调用/响应中携带显式工具调用 ID 的模型
 * （如 Claude、GPT-OSS 系列）。
 */
export function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

/** 解析 Gemini 主版本号（如 gemini-3 → 3），无法识别时返回 undefined。 */
function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

/** Gemini 3+ 支持在 functionResponse 内嵌套多模态（图片）内容；其余模型需单独的图片轮次。 */
function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

/**
 * 将内部消息转换为 Gemini 的 Content[] 格式。
 * 处理用户/模型/工具结果三类消息，并在跨 provider/模型时正确剥离或保留思考签名。
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// 只有当消息来自同一 provider 且同一模型时才保留思考块
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					// 跳过空文本块——除非它带有思考签名。Gemini 可能把签名挂在可见文本为空的 part 上
					// 并需要回显；丢弃它会导致推理链断裂，模型会间歇性地在任务中途以
					// 只有思考、没有工具调用的 STOP 结束本轮。
					if ((!block.text || block.text.trim() === "") && !thoughtSignature) continue;
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// 仅当同一 provider 且同一模型时才保留为思考块
					// 否则转换为纯文本（不带 thought 标记，避免模型模仿它们）
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						// 与文本块规则一致：空思考块仅在无签名时才被丢弃
						// （与 anthropic 转换器的处理方式保持一致）。
						if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature) continue;
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						// 跨 provider/模型：签名不可用，空块保持丢弃。
						if (!block.thinking || block.thinking.trim() === "") continue;
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(thoughtSignature && { thoughtSignature }),
					};
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// 提取文本和图片内容
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ 支持在 functionResponse.parts 内嵌套图片等多模态内容。
			// Claude 等 Cloud Code Assist 背后的非 Gemini 模型以及 Gemini < 3 仍需要单独的图片轮次。
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// 按 SDK 文档约定：成功用 "output" 键，出错用 "error" 键
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API 要求所有函数响应放在同一个 user 轮次中。
			// 检查最后一条内容是否已是带 functionResponse 的 user 轮次，是则合并进去。
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// 对于 Gemini < 3，将图片放在单独的 user 消息中发送
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

/** JSON Schema 的元声明关键字集合，转换为 OpenAPI 参数时需要剔除。 */
const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions", // pre-draft-2019-09 中 $defs 的等价物
]);

/**
 * 从 schema 对象中递归剔除 JSON Schema 元声明关键字。
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

/**
 * 将工具转换为 Gemini 的 function declarations 格式。
 *
 * 默认使用 `parametersJsonSchema`，它支持完整的 JSON Schema（包括 anyOf、oneOf、const 等）。
 * 将 `useParameters` 设为 true 则改用旧式的 `parameters` 字段（OpenAPI 3.03 Schema）。
 * Cloud Code Assist 下的 Claude 模型需要后者，因为该 API 会把 `parameters` 翻译成
 * Anthropic 的 `input_schema`。
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				...(useParameters
					? { parameters: sanitizeForOpenApi(tool.parameters as unknown) }
					: { parametersJsonSchema: tool.parameters }),
			})),
		},
	];
}

/** Gemini 3+ 在校验模式的工具调用中会强制要求必需的函数参数。 */
export function supportsGoogleStrictToolSampling(modelId: string): boolean {
	const majorVersion = getGeminiMajorVersion(modelId);
	return majorVersion !== undefined && majorVersion >= 3;
}

/** 将工具选择字符串映射为 Gemini 的 FunctionCallingConfigMode。 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

/**
 * 解析 Google 的函数调用模式。若存在需要严格采样的工具则返回 VALIDATED；
 * `toolChoice` 为 none/any 时直接映射；否则按 toolChoice 映射或返回 undefined（不限制）。
 */
export function resolveGoogleFunctionCallingMode(
	tools: Tool[],
	toolChoice: string | undefined,
	supportsStrictMode: boolean,
): FunctionCallingConfigMode | undefined {
	const useStrictMode = tools.some((tool) => resolveJsonSchemaStrictSampling(tool, supportsStrictMode) === true);
	if (toolChoice === "none" || toolChoice === "any") {
		return mapToolChoice(toolChoice);
	}
	if (useStrictMode) {
		return FunctionCallingConfigMode.VALIDATED;
	}
	return toolChoice ? mapToolChoice(toolChoice) : undefined;
}

/**
 * 将 Gemini 的 FinishReason 映射为内部统一的 StopReason。
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * 将字符串形式的结束原因映射为内部 StopReason（用于原始 API 响应）。
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

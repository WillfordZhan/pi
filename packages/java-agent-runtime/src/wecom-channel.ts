/**
 * 企业微信智能机器人到 PiConversationRuntime 的最小协议适配层。
 *
 * 该层只负责企业微信访问控制、消息去重和会话路由；Agent loop、会话持久化与
 * ERP Tool 生命周期仍完全由 Pi Runtime 承担，不能在这里增加业务编排规则。
 */

import { generateReqId, type TextMessage, WSClient, type WsFrame, type WsFrameHeaders } from "@wecom/aibot-node-sdk";
import type { WeComChannelConfig } from "./config.ts";
import type { PiConversationRuntime } from "./runtime.ts";

const MAX_SEEN_MESSAGE_IDS = 1_000;
const MAX_REPLY_BYTES = 20_480;

type ConversationStarter = Pick<PiConversationRuntime, "startConversation">;
type ReplyStream = (frame: WsFrameHeaders, streamId: string, content: string, finish?: boolean) => Promise<unknown>;

/** 按 Unicode 字符边界截断，避免企业微信拒绝超过 20480 UTF-8 字节的流式回复。 */
export function truncateUtf8(value: string, maxBytes = MAX_REPLY_BYTES): string {
	let bytes = 0;
	let result = "";
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character);
		if (bytes + characterBytes > maxBytes) break;
		result += character;
		bytes += characterBytes;
	}
	return result;
}

/** 可独立测试的消息处理核心；生产环境由 startWeComChannel 绑定官方 SDK。 */
export class WeComMessageChannel {
	private readonly runtime: ConversationStarter;
	private readonly config: WeComChannelConfig;
	private readonly replyStream: ReplyStream;
	private readonly conversationIds = new Map<string, string>();
	private readonly seenMessageIds = new Set<string>();

	constructor(runtime: ConversationStarter, config: WeComChannelConfig, replyStream: ReplyStream) {
		this.runtime = runtime;
		this.config = config;
		this.replyStream = replyStream;
	}

	async handleTextMessage(frame: WsFrame<TextMessage>): Promise<void> {
		const message = frame.body;
		if (!message) return;
		if (message.chattype !== "single") {
			await this.replyFinal(frame, "测试阶段仅支持单聊。");
			return;
		}

		const weComUserId = message.from.userid.trim();
		if (!this.config.allowedUserId) {
			// 探测模式必须在 Pi 调用之前结束，避免尚未识别的企微成员继承固定 ERP 管理员身份。
			await this.replyFinal(frame, `你的企业微信 userid：${weComUserId}`);
			return;
		}
		if (weComUserId !== this.config.allowedUserId) {
			await this.replyFinal(frame, "当前账号未获准使用该测试机器人。");
			return;
		}
		if (this.seenMessageIds.has(message.msgid)) return;

		this.rememberMessage(message.msgid);
		try {
			await this.runConversation(frame, weComUserId, message.text.content);
		} catch (error) {
			// 只有企微回复通道本身失败才会逃逸到这里；允许企业微信重投后再次处理该消息。
			this.seenMessageIds.delete(message.msgid);
			throw error;
		}
	}

	private async runConversation(frame: WsFrame<TextMessage>, weComUserId: string, query: string): Promise<void> {
		const streamId = generateReqId("pi");
		await this.replyStream(frame, streamId, "正在处理中…", false);
		try {
			const conversationId = this.conversationIds.get(weComUserId);
			const started = this.runtime.startConversation(
				{
					query,
					images: [],
					businessContext: {
						userId: this.config.testErpUserId,
						tenantDeptId: this.config.testDeptId,
						deptName: this.config.testDeptName,
						furnaces: [],
					},
				},
				{ tenantId: this.config.testDeptId, userId: this.config.testErpUserId },
				!conversationId,
				undefined,
				conversationId,
			);
			this.conversationIds.set(weComUserId, started.conversationId);
			const result = await started.result;
			await this.replyStream(frame, streamId, truncateUtf8(result.response.trim() || "Pi 未返回文本结果。"), true);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`WeCom Pi conversation failed for userid=${weComUserId}: ${detail}`);
			await this.replyStream(frame, streamId, "Pi 处理失败，请稍后重试。", true);
		}
	}

	private rememberMessage(messageId: string): void {
		this.seenMessageIds.add(messageId);
		if (this.seenMessageIds.size <= MAX_SEEN_MESSAGE_IDS) return;
		const oldest = this.seenMessageIds.values().next().value;
		if (oldest) this.seenMessageIds.delete(oldest);
	}

	private async replyFinal(frame: WsFrameHeaders, content: string): Promise<void> {
		await this.replyStream(frame, generateReqId("pi"), truncateUtf8(content), true);
	}
}

/** 启动官方 WebSocket SDK，并返回与 Runtime 进程生命周期绑定的断开函数。 */
export function startWeComChannel(runtime: PiConversationRuntime, config: WeComChannelConfig): () => void {
	const client = new WSClient({
		botId: config.botId,
		secret: config.botSecret,
		maxReconnectAttempts: -1,
		logger: {
			debug() {},
			info(message) {
				console.info(`WeCom: ${message}`);
			},
			warn(message) {
				console.warn(`WeCom: ${message}`);
			},
			error(message) {
				console.error(`WeCom: ${message}`);
			},
		},
	});
	const channel = new WeComMessageChannel(runtime, config, (frame, streamId, content, finish) =>
		client.replyStream(frame, streamId, content, finish),
	);
	client.on("authenticated", () => console.info("WeCom bot authenticated"));
	client.on("message.text", (frame) => {
		void channel.handleTextMessage(frame).catch((error: unknown) => {
			const detail = error instanceof Error ? error.message : String(error);
			console.error(`WeCom message reply failed for req_id=${frame.headers.req_id}: ${detail}`);
		});
	});
	client.connect();
	return () => client.disconnect();
}

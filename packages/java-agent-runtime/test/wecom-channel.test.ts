import { MessageType, type TextMessage, type WsFrame } from "@wecom/aibot-node-sdk";
import { describe, expect, it, vi } from "vitest";
import type { WeComChannelConfig } from "../src/config.ts";
import type { PiConversationRuntime } from "../src/runtime.ts";
import { truncateUtf8, WeComMessageChannel } from "../src/wecom-channel.ts";

const baseConfig: WeComChannelConfig = {
	botId: "bot-id",
	botSecret: "bot-secret",
	allowedUserId: "allowed-user",
	testErpUserId: "1942403262651006977",
	testDeptId: "1955839459465793537",
	testDeptName: "ERP开发工厂",
};

function textFrame(messageId: string, userId = "allowed-user", chatType: "single" | "group" = "single") {
	return {
		headers: { req_id: `request-${messageId}` },
		body: {
			msgid: messageId,
			aibotid: "bot-id",
			chattype: chatType,
			from: { userid: userId },
			msgtype: MessageType.Text,
			text: { content: `query-${messageId}` },
		},
	} satisfies WsFrame<TextMessage>;
}

function runtimeWithResponses(responses: Array<Promise<string>>) {
	let index = 0;
	return {
		startConversation(_input, _caller, create, _onEvent, existingConversationId) {
			const conversationId = create ? "conversation-1" : (existingConversationId ?? "missing-conversation");
			const response = responses[index] ?? Promise.resolve("fallback");
			index += 1;
			return {
				conversationId,
				result: response.then((text) => ({ conversationId, response: text })),
				abort() {},
			};
		},
	} satisfies Pick<PiConversationRuntime, "startConversation">;
}

describe("WeComMessageChannel", () => {
	it("keeps discovery, group, and unauthorized messages outside Pi", async () => {
		const runtime = runtimeWithResponses([]);
		const startConversation = vi.spyOn(runtime, "startConversation");
		const replies: string[] = [];
		const reply = async (_frame: unknown, _streamId: string, content: string) => {
			replies.push(content);
		};

		await new WeComMessageChannel(runtime, { ...baseConfig, allowedUserId: undefined }, reply).handleTextMessage(
			textFrame("discovery", "discover-me"),
		);
		await new WeComMessageChannel(runtime, baseConfig, reply).handleTextMessage(
			textFrame("group", "allowed-user", "group"),
		);
		await new WeComMessageChannel(runtime, baseConfig, reply).handleTextMessage(
			textFrame("unauthorized", "other-user"),
		);

		expect(startConversation).not.toHaveBeenCalled();
		expect(replies).toEqual([
			"你的企业微信 userid：discover-me",
			"测试阶段仅支持单聊。",
			"当前账号未获准使用该测试机器人。",
		]);
	});

	it("deduplicates messages and reuses the first Pi conversation", async () => {
		const runtime = runtimeWithResponses([Promise.resolve("answer-1"), Promise.resolve("answer-2")]);
		const startConversation = vi.spyOn(runtime, "startConversation");
		const replies: Array<{ content: string; finish: boolean | undefined }> = [];
		const channel = new WeComMessageChannel(runtime, baseConfig, async (_frame, _streamId, content, finish) => {
			replies.push({ content, finish });
		});

		await channel.handleTextMessage(textFrame("message-1"));
		await channel.handleTextMessage(textFrame("message-1"));
		await channel.handleTextMessage(textFrame("message-2"));

		expect(startConversation).toHaveBeenCalledTimes(2);
		expect(startConversation.mock.calls[0]?.[0]).toMatchObject({
			businessContext: {
				userId: baseConfig.testErpUserId,
				tenantDeptId: baseConfig.testDeptId,
				deptName: baseConfig.testDeptName,
				furnaces: [],
			},
		});
		expect(startConversation.mock.calls[0]?.[2]).toBe(true);
		expect(startConversation.mock.calls[1]?.[2]).toBe(false);
		expect(startConversation.mock.calls[1]?.[4]).toBe("conversation-1");
		expect(replies).toEqual([
			{ content: "正在处理中…", finish: false },
			{ content: "answer-1", finish: true },
			{ content: "正在处理中…", finish: false },
			{ content: "answer-2", finish: true },
		]);
	});

	it("finishes a failed Pi turn and continues processing later messages", async () => {
		const runtime = runtimeWithResponses([
			Promise.reject(new Error("model unavailable")),
			Promise.resolve("recovered"),
		]);
		const replies: string[] = [];
		const channel = new WeComMessageChannel(runtime, baseConfig, async (_frame, _streamId, content) => {
			replies.push(content);
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await channel.handleTextMessage(textFrame("failed"));
		await channel.handleTextMessage(textFrame("recovered"));

		expect(replies).toEqual(["正在处理中…", "Pi 处理失败，请稍后重试。", "正在处理中…", "recovered"]);
		expect(error).toHaveBeenCalledOnce();
		error.mockRestore();
	});

	it("truncates replies on UTF-8 character boundaries", () => {
		expect(truncateUtf8("中文A", 7)).toBe("中文A");
		expect(truncateUtf8("中文A", 6)).toBe("中文");
	});
});

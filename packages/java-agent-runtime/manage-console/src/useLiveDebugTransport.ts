// 模块说明：在线调试使用 Pi 的 Block / SSE 会话接口，SSE 只消费 Pi AgentSession 原生事件。

import type { MessageInstance } from "antd/es/message/interface";
import { useState } from "react";

import { apiFetch, apiStream } from "./api";
import type {
  ConversationInputResponse,
  CreateConversationResponse,
  EffectiveOutputMode,
  RequestOutputMode,
  SseConversationEvent,
  TimelineMessage,
} from "./types";

type PollStatus = "idle" | "connecting" | "connected" | "error";

export const MAX_LIVE_IMAGE_COUNT = 5;
export const MAX_LIVE_IMAGE_BYTES = 10 * 1024 * 1024;

type UseLiveDebugTransportArgs = {
  message: MessageInstance;
  refreshLiveTimeline: (conversationId: string, autoSelectLatest?: boolean) => Promise<void>;
};

type UseLiveDebugTransportResult = {
  liveConversationId: string;
  liveInput: string;
  liveImages: File[];
  liveActionLoading: boolean;
  liveAwaitingTerminal: boolean;
  livePollStatus: PollStatus;
  liveOutputMode: RequestOutputMode;
  liveActiveOutputMode: EffectiveOutputMode;
  setLiveInput: (value: string) => void;
  addLiveImages: (files: File[]) => void;
  removeLiveImage: (index: number) => void;
  setLiveOutputMode: (value: RequestOutputMode) => void;
  openLiveConversation: (conversationId: string) => void;
  resetLiveTransport: () => void;
  handleLivePrimaryAction: () => Promise<void>;
  buildPreviewMessages: (messages: TimelineMessage[]) => TimelineMessage[];
};

export function useLiveDebugTransport({ message, refreshLiveTimeline }: UseLiveDebugTransportArgs): UseLiveDebugTransportResult {
  const [liveConversationId, setLiveConversationId] = useState("");
  const [liveInput, setLiveInput] = useState("");
  const [liveImages, setLiveImages] = useState<File[]>([]);
  const [liveActionLoading, setLiveActionLoading] = useState(false);
  const [livePollStatus, setLivePollStatus] = useState<PollStatus>("idle");
  const [liveOutputMode, setLiveOutputMode] = useState<RequestOutputMode>("sse");
  const [liveActiveOutputMode, setLiveActiveOutputMode] = useState<EffectiveOutputMode>("sse");
  const [liveStreamingAnswer, setLiveStreamingAnswer] = useState("");
  const [livePendingUserMessage, setLivePendingUserMessage] = useState("");

  async function handleLivePrimaryAction() {
    const query = liveInput.trim();
    if (!query && liveImages.length === 0) return;

    // File 对象必须在清空编辑区前固化成本轮快照，否则用户继续选择图片时会污染正在发送的请求。
    const images = liveImages;
    const pendingText = [query, images.length > 0 ? `[本轮包含 ${images.length} 张图片]` : ""]
      .filter(Boolean)
      .join("\n");

    setLiveActionLoading(true);
    setLivePollStatus("connecting");
    setLiveActiveOutputMode(liveOutputMode);
    setLiveStreamingAnswer("");
    // Pi 的持久化消息要等本轮结束后才能重新投影；先展示本次输入，避免用户误以为 Enter 未发送。
    setLivePendingUserMessage(pendingText);
    // 输入已经固化为本轮临时 user 消息，发送开始即清空编辑区，允许用户准备下一条内容。
    setLiveInput("");
    setLiveImages([]);
    try {
      if (liveOutputMode === "sse") {
        await runSse(query, images);
      } else {
        await runBlock(query, images);
      }
      setLivePollStatus("idle");
    } catch (error) {
      setLivePollStatus("error");
      message.error(`发送失败: ${String(error)}`);
    } finally {
      // 无论成功还是失败，临时消息都由下一次 timeline 投影或错误状态收口，不能遗留到下一轮。
      setLivePendingUserMessage("");
      setLiveActionLoading(false);
    }
  }

  async function runBlock(query: string, images: File[]) {
    const path = liveConversationId ? `/api/ai/conversations/${liveConversationId}/chat` : "/api/ai/conversations";
    const payload = await apiFetch<CreateConversationResponse | ConversationInputResponse>(path, {
      method: "POST",
      body: buildConversationBody(query, images),
    });
    setLiveConversationId(payload.conversation_id);
    await refreshLiveTimeline(payload.conversation_id, true);
  }

  async function runSse(query: string, images: File[]) {
    const path = liveConversationId ? `/api/ai/conversations/${liveConversationId}/chat` : "/api/ai/conversations";
    let streamedConversationId = liveConversationId;
    let failureMessage = "";
    await apiStream(
      path,
      { method: "POST", body: buildConversationBody(query, images) },
      {
        onOpen: () => setLivePollStatus("connected"),
        onEvent: (event) => {
          const conversationId = typeof event.data?.conversation_id === "string" ? event.data.conversation_id : streamedConversationId;
          if (conversationId) {
            streamedConversationId = conversationId;
            setLiveConversationId(conversationId);
          }
          if (event.event === "conversation_failed") {
            failureMessage = String(event.data?.detail || "Pi 会话执行失败");
            return;
          }
          handleSseEvent(event);
        },
      }
    );
    if (failureMessage) throw new Error(failureMessage);
    // 以 SSE EOF 作为本轮结束信号：即使中间 final 事件被代理层截断，Pi 已落盘的消息也能回显。
    if (streamedConversationId) await refreshLiveTimeline(streamedConversationId, true);
    setLiveStreamingAnswer("");
  }

  function handleSseEvent(event: SseConversationEvent) {
    if (event.event === "answer_delta") {
      const delta = typeof event.data?.delta === "string" ? event.data.delta : "";
      if (delta) setLiveStreamingAnswer((current) => current + delta);
      return;
    }
    if (event.event === "final") {
      const answer = typeof event.data?.answer === "string" ? event.data.answer : "";
      if (answer) setLiveStreamingAnswer(answer);
      return;
    }
  }

  return {
    liveConversationId,
    liveInput,
    liveImages,
    liveActionLoading,
    liveAwaitingTerminal: false,
    livePollStatus,
    liveOutputMode,
    liveActiveOutputMode,
    setLiveInput,
    addLiveImages: (files) => {
      // 浏览器校验只负责即时反馈；Runtime 会基于真实字节再次执行相同上限，不能依赖前端作为安全边界。
      if (liveImages.length + files.length > MAX_LIVE_IMAGE_COUNT) {
        message.error(`每次最多上传 ${MAX_LIVE_IMAGE_COUNT} 张图片`);
        return;
      }
      const oversized = files.find((file) => file.size > MAX_LIVE_IMAGE_BYTES);
      if (oversized) {
        message.error(`${oversized.name} 超过单张 10 MiB 限制`);
        return;
      }
      if (files.some((file) => file.size === 0)) {
        message.error("不能上传空图片");
        return;
      }
      setLiveImages((current) => [...current, ...files]);
    },
    removeLiveImage: (index) => setLiveImages((current) => current.filter((_, itemIndex) => itemIndex !== index)),
    setLiveOutputMode,
    openLiveConversation: setLiveConversationId,
    resetLiveTransport: () => {
      setLiveConversationId("");
      setLiveInput("");
      setLiveImages([]);
      setLiveStreamingAnswer("");
      setLivePendingUserMessage("");
      setLivePollStatus("idle");
    },
    handleLivePrimaryAction,
    buildPreviewMessages: (messages) => buildLivePreviewMessages(messages, livePendingUserMessage, liveStreamingAnswer, liveActionLoading),
  };
}

/** 有图片时使用 multipart；纯文字继续走原 JSON 协议，避免无意义地改变现有调用链。 */
function buildConversationBody(query: string, images: File[]): BodyInit {
  if (images.length === 0) return JSON.stringify({ query });
  const formData = new FormData();
  if (query) formData.append("query", query);
  for (const image of images) formData.append("images", image, image.name);
  return formData;
}

export function resolveEffectiveOutputMode(outputMode: RequestOutputMode): EffectiveOutputMode {
  return outputMode;
}

export function buildLivePreviewMessages(
  liveMessages: TimelineMessage[],
  livePendingUserMessage: string,
  liveStreamingAnswer: string,
  liveAwaitingTerminal: boolean
): TimelineMessage[] {
  if (!liveAwaitingTerminal && !livePendingUserMessage && !liveStreamingAnswer) return liveMessages;
  const lastMessage = liveMessages[liveMessages.length - 1];
  const turnIndex = lastMessage?.role === "user" ? lastMessage.turn_index : (lastMessage?.turn_index || 0) + 1;
  return [
    ...liveMessages,
    ...(livePendingUserMessage
      ? [
          {
            message_id: -1,
            turn_index: turnIndex || 1,
            role: "user" as const,
            content: livePendingUserMessage,
            created_at: "sending",
            status: "sending",
          },
        ]
      : []),
    {
      message_id: -1,
      turn_index: turnIndex || 1,
      role: "assistant",
      content: liveStreamingAnswer || "思考中...",
      created_at: "streaming",
      status: liveStreamingAnswer ? "streaming" : "thinking",
    },
  ];
}

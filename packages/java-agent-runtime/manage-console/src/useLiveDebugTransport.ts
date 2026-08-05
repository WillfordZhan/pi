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

type UseLiveDebugTransportArgs = {
  message: MessageInstance;
  refreshLiveTimeline: (conversationId: string, autoSelectLatest?: boolean) => Promise<void>;
};

type UseLiveDebugTransportResult = {
  liveConversationId: string;
  liveInput: string;
  liveActionLoading: boolean;
  liveAwaitingTerminal: boolean;
  livePollStatus: PollStatus;
  liveOutputMode: RequestOutputMode;
  liveActiveOutputMode: EffectiveOutputMode;
  setLiveInput: (value: string) => void;
  setLiveOutputMode: (value: RequestOutputMode) => void;
  openLiveConversation: (conversationId: string) => void;
  resetLiveTransport: () => void;
  handleLivePrimaryAction: () => Promise<void>;
  buildPreviewMessages: (messages: TimelineMessage[]) => TimelineMessage[];
};

export function useLiveDebugTransport({ message, refreshLiveTimeline }: UseLiveDebugTransportArgs): UseLiveDebugTransportResult {
  const [liveConversationId, setLiveConversationId] = useState("");
  const [liveInput, setLiveInput] = useState("");
  const [liveActionLoading, setLiveActionLoading] = useState(false);
  const [livePollStatus, setLivePollStatus] = useState<PollStatus>("idle");
  const [liveOutputMode, setLiveOutputMode] = useState<RequestOutputMode>("sse");
  const [liveActiveOutputMode, setLiveActiveOutputMode] = useState<EffectiveOutputMode>("sse");
  const [liveStreamingAnswer, setLiveStreamingAnswer] = useState("");

  async function handleLivePrimaryAction() {
    const query = liveInput.trim();
    if (!query) return;

    setLiveActionLoading(true);
    setLivePollStatus("connecting");
    setLiveActiveOutputMode(liveOutputMode);
    setLiveStreamingAnswer("");
    try {
      if (liveOutputMode === "sse") {
        await runSse(query);
      } else {
        await runBlock(query);
      }
      setLiveInput("");
      setLivePollStatus("idle");
    } catch (error) {
      setLivePollStatus("error");
      message.error(`发送失败: ${String(error)}`);
    } finally {
      setLiveActionLoading(false);
    }
  }

  async function runBlock(query: string) {
    const path = liveConversationId ? `/api/ai/conversations/${liveConversationId}/chat` : "/api/ai/conversations";
    const payload = await apiFetch<CreateConversationResponse | ConversationInputResponse>(path, {
      method: "POST",
      body: JSON.stringify({ query }),
    });
    setLiveConversationId(payload.conversation_id);
    await refreshLiveTimeline(payload.conversation_id, true);
  }

  async function runSse(query: string) {
    const path = liveConversationId ? `/api/ai/conversations/${liveConversationId}/chat` : "/api/ai/conversations";
    let streamedConversationId = liveConversationId;
    let failureMessage = "";
    await apiStream(
      path,
      { method: "POST", body: JSON.stringify({ query }) },
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
          void handleSseEvent(event, conversationId);
        },
      }
    );
    if (failureMessage) throw new Error(failureMessage);
  }

  async function handleSseEvent(event: SseConversationEvent, conversationId: string) {
    if (event.event === "answer_delta") {
      const delta = typeof event.data?.delta === "string" ? event.data.delta : "";
      if (delta) setLiveStreamingAnswer((current) => current + delta);
      return;
    }
    if (event.event === "final") {
      const answer = typeof event.data?.answer === "string" ? event.data.answer : "";
      if (answer) setLiveStreamingAnswer(answer);
      if (conversationId) await refreshLiveTimeline(conversationId, true);
      setLiveStreamingAnswer("");
      return;
    }
  }

  return {
    liveConversationId,
    liveInput,
    liveActionLoading,
    liveAwaitingTerminal: false,
    livePollStatus,
    liveOutputMode,
    liveActiveOutputMode,
    setLiveInput,
    setLiveOutputMode,
    openLiveConversation: setLiveConversationId,
    resetLiveTransport: () => {
      setLiveConversationId("");
      setLiveInput("");
      setLiveStreamingAnswer("");
      setLivePollStatus("idle");
    },
    handleLivePrimaryAction,
    buildPreviewMessages: (messages) => buildLivePreviewMessages(messages, liveStreamingAnswer, liveActionLoading),
  };
}

export function resolveEffectiveOutputMode(outputMode: RequestOutputMode): EffectiveOutputMode {
  return outputMode;
}

export function buildLivePreviewMessages(
  liveMessages: TimelineMessage[],
  liveStreamingAnswer: string,
  liveAwaitingTerminal: boolean
): TimelineMessage[] {
  if (!liveAwaitingTerminal && !liveStreamingAnswer) return liveMessages;
  const lastMessage = liveMessages[liveMessages.length - 1];
  const turnIndex = lastMessage?.role === "user" ? lastMessage.turn_index : (lastMessage?.turn_index || 0) + 1;
  return [
    ...liveMessages,
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

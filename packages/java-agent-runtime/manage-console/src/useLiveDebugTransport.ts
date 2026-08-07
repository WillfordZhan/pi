// 模块说明：在线调试统一使用 SSE 会话接口，并直接消费 Pi AgentSession 原生事件。

import type { MessageInstance } from "antd/es/message/interface";
import { useEffect, useRef, useState } from "react";

import { apiFetch, apiStream } from "./api";
import type { SseConversationEvent, TimelineMessage } from "./types";

type PollStatus = "idle" | "connecting" | "connected" | "error";

export const MAX_LIVE_IMAGE_COUNT = 5;
export const MAX_LIVE_IMAGE_BYTES = 10 * 1024 * 1024;
// 百炼要求 Base64 Data URI 不超过 10 MiB；7 MiB 原音频编码后仍保留 JSON 与协议开销余量。
export const MAX_LIVE_AUDIO_BYTES = 7 * 1024 * 1024;
export const MAX_LIVE_RECORDING_MS = 5 * 60 * 1000;

type UseLiveDebugTransportArgs = {
  message: MessageInstance;
  refreshLiveTimeline: (conversationId: string, autoSelectLatest?: boolean) => Promise<void>;
};

type UseLiveDebugTransportResult = {
  liveConversationId: string;
  liveInput: string;
  liveImages: File[];
  liveActionLoading: boolean;
  liveRecording: boolean;
  liveRecordingSeconds: number;
  liveVoiceActionLoading: boolean;
  liveAwaitingTerminal: boolean;
  livePollStatus: PollStatus;
  setLiveInput: (value: string) => void;
  addLiveImages: (files: File[]) => void;
  removeLiveImage: (index: number) => void;
  toggleLiveRecording: () => Promise<void>;
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
  const [liveRecording, setLiveRecording] = useState(false);
  const [liveRecordingSeconds, setLiveRecordingSeconds] = useState(0);
  const [liveVoiceActionLoading, setLiveVoiceActionLoading] = useState(false);
  const [livePollStatus, setLivePollStatus] = useState<PollStatus>("idle");
  const [liveStreamingAnswer, setLiveStreamingAnswer] = useState("");
  const [livePendingUserMessage, setLivePendingUserMessage] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const recordingDeadlineRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef(0);
  const disposedRef = useRef(false);

  useEffect(() => {
    return () => {
      // 卸载页面时不能继续把录音提交给后端；同时主动释放麦克风，避免浏览器仍显示“正在使用”。
      disposedRef.current = true;
      clearRecordingTimers();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      stopMicrophoneTracks();
    };
  }, []);

  async function handleLivePrimaryAction() {
    if (liveRecording || liveVoiceActionLoading) {
      message.warning("请先完成当前录音和转写，再发送给 Pi");
      return;
    }
    const query = liveInput.trim();
    if (!query && liveImages.length === 0) return;

    // File 对象必须在清空编辑区前固化成本轮快照，否则用户继续选择图片时会污染正在发送的请求。
    const images = liveImages;
    const pendingText = [query, images.length > 0 ? `[本轮包含 ${images.length} 张图片]` : ""]
      .filter(Boolean)
      .join("\n");

    setLiveActionLoading(true);
    setLivePollStatus("connecting");
    setLiveStreamingAnswer("");
    // Pi 的持久化消息要等本轮结束后才能重新投影；先展示本次输入，避免用户误以为 Enter 未发送。
    setLivePendingUserMessage(pendingText);
    // 输入已经固化为本轮临时 user 消息，发送开始即清空编辑区，允许用户准备下一条内容。
    setLiveInput("");
    setLiveImages([]);
    try {
      // Management Console 只有一条在线调试链路，统一使用 SSE 获取文本增量和 Tool 生命周期事件。
      await runSse(query, images);
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
    liveRecording,
    liveRecordingSeconds,
    liveVoiceActionLoading,
    liveAwaitingTerminal: false,
    livePollStatus,
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
    toggleLiveRecording,
    openLiveConversation: setLiveConversationId,
    resetLiveTransport: () => {
      discardLiveRecording();
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

  async function toggleLiveRecording() {
    if (liveRecording) {
      stopLiveRecording();
      return;
    }
    if (liveActionLoading || liveVoiceActionLoading) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      message.error("当前浏览器不支持录音，请使用 Chromium 浏览器");
      return;
    }

    setLiveVoiceActionLoading(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (disposedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = chooseSupportedRecordingMimeType();
      if (!mimeType) {
        stream.getTracks().forEach((track) => track.stop());
        message.error("当前浏览器没有可供转写的录音格式");
        return;
      }
      const chunks: BlobPart[] = [];
      // 先登记 stream，确保 MediaRecorder 初始化异常时 catch 分支也能释放麦克风。
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };
      recorder.onstop = () => {
        recorderRef.current = null;
        clearRecordingTimers();
        stopMicrophoneTracks();
        if (disposedRef.current) {
          return;
        }
        setLiveRecording(false);
        void transcribeRecordedChunks(chunks, recorder.mimeType || mimeType);
      };
      recorder.start();
      recordingStartedAtRef.current = Date.now();
      setLiveRecordingSeconds(0);
      setLiveRecording(true);
      recordingTimerRef.current = window.setInterval(() => {
        setLiveRecordingSeconds(Math.floor((Date.now() - recordingStartedAtRef.current) / 1000));
      }, 1000);
      recordingDeadlineRef.current = window.setTimeout(() => {
        if (recorderRef.current === recorder && recorder.state !== "inactive") {
          message.info("已达到 5 分钟录音上限，正在开始转写");
          stopLiveRecording();
        }
      }, MAX_LIVE_RECORDING_MS);
    } catch (error) {
      stopMicrophoneTracks();
      message.error(`无法开始录音: ${getMediaErrorMessage(error)}`);
    } finally {
      if (!disposedRef.current) {
        setLiveVoiceActionLoading(false);
      }
    }
  }

  function stopLiveRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    clearRecordingTimers();
    recorder.stop();
  }

  async function transcribeRecordedChunks(chunks: BlobPart[], mimeType: string) {
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) {
      message.error("录音内容为空，请重新录制");
      return;
    }
    if (blob.size > MAX_LIVE_AUDIO_BYTES) {
      message.error("录音超过 7 MiB 限制，请缩短后重试");
      return;
    }

    setLiveVoiceActionLoading(true);
    try {
      const suffix = recordingFileSuffix(mimeType);
      const audio = new File([blob], `recording.${suffix}`, { type: mimeType });
      const formData = new FormData();
      formData.append("audio", audio, audio.name);
      // 转写接口不会创建 Pi 会话；成功后只写回编辑框，发送仍由用户显式触发。
      const response = await apiFetch<{ text: string }>("/api/ai/asr/transcriptions", {
        method: "POST",
        body: formData,
      });
      const text = response.text.trim();
      if (!text) {
        throw new Error("没有识别到可用文字");
      }
      setLiveInput((current) => (current.trim() ? `${current}\n${text}` : text));
      message.success("转写完成，确认文字后再发送");
    } catch (error) {
      message.error(`转写失败: ${getMediaErrorMessage(error)}`);
    } finally {
      if (!disposedRef.current) {
        setLiveVoiceActionLoading(false);
      }
    }
  }

  function discardLiveRecording() {
    clearRecordingTimers();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    stopMicrophoneTracks();
    setLiveRecording(false);
    setLiveRecordingSeconds(0);
    setLiveVoiceActionLoading(false);
  }

  function clearRecordingTimers() {
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (recordingDeadlineRef.current !== null) {
      window.clearTimeout(recordingDeadlineRef.current);
      recordingDeadlineRef.current = null;
    }
  }

  function stopMicrophoneTracks() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }
}

function chooseSupportedRecordingMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

function recordingFileSuffix(mimeType: string): string {
  if (mimeType.startsWith("audio/mp4")) return "m4a";
  if (mimeType.startsWith("audio/ogg")) return "ogg";
  return "webm";
}

function getMediaErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "未获得麦克风权限，请在浏览器中允许后重试";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "请检查麦克风和网络后重试";
}

/** 有图片时使用 multipart；纯文字继续走原 JSON 协议，避免无意义地改变现有调用链。 */
function buildConversationBody(query: string, images: File[]): BodyInit {
  if (images.length === 0) return JSON.stringify({ query });
  const formData = new FormData();
  if (query) formData.append("query", query);
  for (const image of images) formData.append("images", image, image.name);
  return formData;
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

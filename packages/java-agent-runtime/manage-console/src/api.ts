export const AUTH_STORAGE_KEY = "ai-chat.authorization";

import type { SseConversationEvent } from "./types";

// 模块说明：统一管理 Pi 管理台的同源 HTTP/SSE 传输层，所有请求均由 Pi 网关处理。

export type SearchPayload = {
  page_num: number;
  page_size: number;
  dept_id?: string;
  user_id?: string;
  username?: string;
  mobile_no?: string;
  keyword?: string;
  event_type?: string;
};

export class ApiRequestError extends Error {
  status?: number;
  code?: string | number;
  payload?: unknown;
  userMessage: string;

  constructor(args: {
    message: string;
    userMessage: string;
    status?: number;
    code?: string | number;
    payload?: unknown;
  }) {
    super(args.message);
    this.name = "ApiRequestError";
    this.status = args.status;
    this.code = args.code;
    this.payload = args.payload;
    this.userMessage = args.userMessage;
  }
}

export function resolveApiUrl(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const authorization = window.sessionStorage.getItem(AUTH_STORAGE_KEY) || "";
  const headers = new Headers(init?.headers || {});
  if (authorization && !headers.has("Authorization")) {
    headers.set("Authorization", authorization);
  }
  if (!headers.has("Content-Type") && init?.body) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(resolveApiUrl(path), {
      ...init,
      headers,
    });
  } catch (error) {
    throw wrapTransportError(error);
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    throw buildApiRequestError(response.status, payload);
  }
  return payload as T;
}

type StreamHandler = {
  onOpen?: (response: Response) => void;
  onEvent?: (event: SseConversationEvent) => void;
};

// 管理台需要自己感知 SSE 分帧，而不是等浏览器帮我们组装成整包数据。
// 这里统一收口成一个轻量工具，避免把解析细节散落在页面组件里。
export async function apiStream(path: string, init: RequestInit, handler: StreamHandler): Promise<void> {
  const authorization = window.sessionStorage.getItem(AUTH_STORAGE_KEY) || "";
  const headers = new Headers(init.headers || {});
  if (authorization && !headers.has("Authorization")) {
    headers.set("Authorization", authorization);
  }
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "text/event-stream");

  let response: Response;
  try {
    response = await fetch(resolveApiUrl(path), {
      ...init,
      headers,
    });
  } catch (error) {
    throw wrapTransportError(error);
  }
  if (!response.ok) {
    const errorText = await response.text();
    let payload: unknown = errorText;
    if (errorText) {
      try {
        payload = JSON.parse(errorText);
      } catch {
        payload = errorText;
      }
    }
    throw buildApiRequestError(response.status, payload);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const payloadText = await response.text();
    throw new Error(payloadText || "upstream did not return text/event-stream");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("stream response body is not readable");
  }

  handler.onOpen?.(response);

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    buffer = drainSseBuffer(buffer, handler);
  }

  const tail = buffer + decoder.decode();
  drainSseBuffer(tail, handler, true);
}

function drainSseBuffer(source: string, handler: StreamHandler, flush = false): string {
  const normalized = source.replace(/\r\n/g, "\n");
  let cursor = 0;

  while (true) {
    const delimiterIndex = normalized.indexOf("\n\n", cursor);
    if (delimiterIndex < 0) {
      break;
    }
    const block = normalized.slice(cursor, delimiterIndex);
    cursor = delimiterIndex + 2;
    emitSseBlock(block, handler);
  }

  const remaining = normalized.slice(cursor);
  if (flush && remaining.trim()) {
    emitSseBlock(remaining, handler);
    return "";
  }
  return remaining;
}

function emitSseBlock(block: string, handler: StreamHandler): void {
  if (!block.trim()) {
    return;
  }

  let id = "";
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  const rawData = dataLines.join("\n");
  let data: Record<string, unknown> | null = null;
  if (rawData) {
    try {
      data = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      data = { text: rawData };
    }
  }
  handler.onEvent?.({
    id: id || undefined,
    event,
    data,
    rawData,
  });
}

export async function login(mobileNo: string, password: string): Promise<string> {
  const payload = await apiFetch<{ code: number; data?: { token?: string }; msg?: string }>(
    "/unified/login",
    {
      method: "POST",
      body: JSON.stringify({
        mobileNo,
        password,
        code: "20251107合信辰内部调试接口",
      }),
    }
  );
  const token = payload?.data?.token || "";
  if (!token) {
    throw new ApiRequestError({
      message: "login succeeded without token",
      userMessage: "登录成功但未返回 token，请联系管理员检查网关登录接口。",
      payload,
    });
  }
  const normalized = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  window.sessionStorage.setItem(AUTH_STORAGE_KEY, normalized);
  return normalized;
}

export function getUserFacingErrorMessage(error: unknown, fallback = "请求失败，请稍后重试"): string {
  if (error instanceof ApiRequestError) {
    return error.userMessage || fallback;
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

function wrapTransportError(error: unknown): ApiRequestError {
  return new ApiRequestError({
    message: error instanceof Error ? error.message : "network request failed",
    userMessage: "网络请求失败，请检查服务是否启动或稍后重试。",
  });
}

function buildApiRequestError(status: number, payload: unknown): ApiRequestError {
  const code = readPayloadCode(payload);
  const userMessage = readPayloadMessage(payload) || `请求失败（HTTP ${status}）`;
  return new ApiRequestError({
    message: userMessage,
    userMessage,
    status,
    code,
    payload,
  });
}

function readPayloadCode(payload: unknown): string | number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const candidate = payload.code;
  if (typeof candidate === "string" || typeof candidate === "number") {
    return candidate;
  }
  return undefined;
}

function readPayloadMessage(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.trim();
  }
  if (!isRecord(payload)) {
    return "";
  }
  const candidates = [payload.msg, payload.message, payload.detail, payload.error, payload.description];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

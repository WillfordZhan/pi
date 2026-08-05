# Pi Java Agent Runtime

Java AI Gateway 的 Pi 会话 Runtime。Java 负责把前端消息转发进来并提供风味 MCP Tool；Pi 负责会话、Skill、Agent loop、Guardrail、Tool 生命周期和 Qwen 调用。

## 运行配置

```bash
PI_RUNTIME_PORT=8000
PI_RUNTIME_GATEWAY_TOKEN=<与 Java ai.gateway.internalToken 一致>
JAVA_MCP_BASE_URL=http://java-app:8080
JAVA_MCP_TOKEN=<与 Java ai.mcp.internalToken 一致>
QWEN_TOKEN_PLAN_CN_API_KEY=<Qwen Token Plan CN API Key>
```

可选项：

- `PI_RUNTIME_MODEL_PROVIDER`：默认 `qwen-token-plan-cn`
- `PI_RUNTIME_MODEL_ID`：默认 `qwen3.7-plus`
- `PI_RUNTIME_CWD`：Pi 资源加载工作目录
- `PI_RUNTIME_SESSION_DIR`：Pi JSONL 会话目录，默认 `${PI_RUNTIME_CWD}/sessions`

Runtime 提供：

- `POST /ai/conversations`，请求体 `{ "query": "..." }`
- `POST /ai/conversations/{conversationId}/chat`，请求体 `{ "query": "..." }`
- `GET /healthz`

两个聊天接口均返回 `{ "conversationId": "...", "response": "..." }`。Java 请求必须携带既有 `X-AI-GW-TOKEN` 与 `X-AI-BIZ-CONTEXT`；Pi 只从已认证的网关上下文提取 `tenantId`、`userId`，并在调用 Java MCP Tool 时附带它们。

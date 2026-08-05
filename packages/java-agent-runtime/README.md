# Pi Java Agent Runtime

Java AI Gateway 的 Pi 会话 Runtime。Java 负责把前端消息转发进来并提供风味 MCP Tool；Pi 负责会话、Skill、Agent loop、Guardrail、Tool 生命周期和 Qwen 调用。

## 运行配置

```bash
PI_RUNTIME_PORT=8000
MCP_BASE_URL=http://java-app:8080/ai/mcp
MCP_API_TOKEN=<与 Java ai.mcp.internalToken 一致>
MCP_TIMEOUT_SECONDS=10
AI_GATEWAY_INTERNAL_TOKEN=<与 Java ai.gateway.internalToken 一致>
AI_GATEWAY_CONTEXT_SIGN_SECRET=<与 Java ai.gateway.contextSignSecret 一致>
AI_GATEWAY_CLOCK_SKEW_SECONDS=30
QWEN_MODEL=qwen3.7-plus
QWEN_API_KEY=<DashScope API Key>
# 或沿用旧运行时文件方式
QWEN_API_KEY_FILE=config/apikey.txt
QWEN_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
```

可选项：

- `PI_RUNTIME_MODEL_PROVIDER`：默认 `dashscope`
- `PI_RUNTIME_CWD`：Pi 资源加载工作目录
- `PI_RUNTIME_SESSION_DIR`：Pi JSONL 会话目录，默认 `${PI_RUNTIME_CWD}/sessions`

启动时默认读取当前目录 `.env`，也可通过旧有 `APP_ENV_FILE` 指定环境文件。`QWEN_API_KEY` 优先；为空时读取 `QWEN_API_KEY_FILE`。旧 Python Runtime 的会话存储、Dify 和编排变量不再使用。

Runtime 提供：

- `POST /ai/conversations`，请求体 `{ "query": "..." }`
- `POST /ai/conversations/{conversationId}/chat`，请求体 `{ "query": "..." }`
- `GET /healthz`

两个聊天接口均返回 `{ "conversationId": "...", "response": "..." }`。Java 请求必须携带既有 `X-AI-GW-TOKEN` 与 `X-AI-BIZ-CONTEXT`；Pi 会验证既有 HMAC 上下文签名与有效期，只提取 `tenantId`、`userId` 并在调用 Java MCP Tool 时附带它们。

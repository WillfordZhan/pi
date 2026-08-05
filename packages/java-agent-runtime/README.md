# Pi Java Agent Runtime

Java AI Gateway 的 Pi 会话 Runtime。Java 负责把前端消息转发进来并提供风味 MCP Tool；Pi 负责会话、Skill、Agent loop、Guardrail、Tool 生命周期和 Qwen 调用。

## 运行配置

在本目录创建 `.env` 后，直接执行以下命令即可构建并启动 Pi Agent 与管理台：

```bash
cd packages/java-agent-runtime
npm run start
```

管理台地址为 `http://127.0.0.1:8000/ai/management/console/`。`.env` 可参考本目录的 `.env.example`；不需要在命令行重复传入环境变量。启动脚本会自动把 Pi 资源工作目录定位到项目根目录。

```bash
PI_RUNTIME_PORT=8000
MCP_BASE_URL=http://java-app:8080/ai/mcp
JAVA_GATEWAY_BASE_URL=http://java-app:8080
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
- `PI_RUNTIME_MANAGE_CONSOLE_DIR`：管理台构建目录，默认 `${PI_RUNTIME_CWD}/packages/java-agent-runtime/static/manage-console`
- `JAVA_GATEWAY_BASE_URL`：Java 外部 Gateway 地址；省略时由 `MCP_BASE_URL` 自动去掉 `/ai/mcp` 推导

启动时默认读取当前目录 `.env`，也可通过旧有 `APP_ENV_FILE` 指定环境文件。`QWEN_API_KEY` 优先；为空时读取 `QWEN_API_KEY_FILE`。旧 Python Runtime 的会话存储、Dify 和编排变量不再使用。

Runtime 提供：

- `POST /ai/conversations`，请求体 `{ "query": "..." }`
- `POST /ai/conversations/{conversationId}/chat`，请求体 `{ "query": "..." }`
- `GET /healthz`
- `GET /ai/management/console/`，Pi 托管的原管理台页面

两个聊天接口均返回 `{ "conversationId": "...", "response": "..." }`。Java 请求必须携带既有 `X-AI-GW-TOKEN` 与 `X-AI-BIZ-CONTEXT`；Pi 会验证既有 HMAC 上下文签名与有效期，只提取 `tenantId`、`userId` 并在调用 Java MCP Tool 时附带它们。

管理台支持 Block 与 SSE：浏览器请求 `/api/ai/**` 经 Java Gateway 回到 Pi；SSE 直接投影 Pi AgentSession 的文本增量和 Tool 生命周期事件。Pi 管理 API 读取同一份 JSONL，投影会话、消息、Tool 调用和结果；不会恢复旧 Python 运行时或事件库。

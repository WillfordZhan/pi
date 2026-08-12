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

- `POST /ai/conversations`
- `POST /ai/conversations/{conversationId}/chat`
- `GET /healthz`
- `GET /ai/management/console/`，Pi 托管的原管理台页面

## 企业微信测试 Channel

Runtime 可以复用同一个 `PiConversationRuntime` 实例连接企业微信智能机器人。该能力默认关闭；只有同时配置 BotID 与 Secret 时才建立 WebSocket 长连接：

```bash
WECOM_BOT_ID=<企业微信机器人 BotID>
WECOM_BOT_SECRET=<企业微信机器人 Secret>
WECOM_ALLOWED_USER_ID=<允许联调的企业微信 userid>
WECOM_TEST_ERP_USER_ID=<固定测试 ERP userId>
WECOM_TEST_DEPT_ID=<固定测试工厂 deptId>
WECOM_TEST_DEPT_NAME=<固定测试工厂名称>
```

首次联调时将 `WECOM_ALLOWED_USER_ID` 留空。机器人只回复发送人的企业微信 `userid`，不会创建 Pi 会话、调用模型或执行 ERP Tool；确认该 ID 后填入配置并重启 Runtime。测试 Channel 只接受该用户的单聊文字，使用固定 ERP 身份和工厂语义调用现有 Pi AgentSession 与 Java MCP Tool。

固定身份和进程内会话映射只用于联调。扩大机器人可见范围前，必须改为由 Java Gateway 将企业微信用户映射到真实 ERP 用户和当前工厂。Bot Secret 只能存放在本地 `.env` 或部署密钥中，不能提交仓库。

## Docker 部署到 Star2 DEV

Docker 构建分为两个阶段：`builder` 在 Linux 环境安装依赖并构建全部 Pi workspace 与管理台；`runtime` 只复制生产依赖和构建产物，并以非 root 用户启动 `dist/main.js`。镜像固定构建为 `linux/amd64`，与 Star2 的 `x86_64` 架构一致。

### 1. 本地构建并导出镜像

以下命令必须在仓库根目录执行，因为 Java Runtime 会复用 monorepo 内的 Pi 包：

```bash
docker buildx build \
  --platform linux/amd64 \
  --file packages/java-agent-runtime/Dockerfile \
  --tag pi-java-agent-runtime:dev \
  --load \
  .

docker image inspect pi-java-agent-runtime:dev --format '{{.Architecture}}'
docker save pi-java-agent-runtime:dev | gzip > /tmp/pi-java-agent-runtime-dev.tar.gz
```

架构检查必须输出 `amd64`。然后把镜像和 Compose 文件传到 Star2：

```bash
ssh iot@vpc-star-2.allthinkstars.com 'mkdir -p /home/iot/app/python/pi-runtime'
scp /tmp/pi-java-agent-runtime-dev.tar.gz \
  iot@vpc-star-2.allthinkstars.com:/home/iot/app/python/pi-runtime/
scp packages/java-agent-runtime/docker-compose.yml \
  packages/java-agent-runtime/.env.star2.example \
  iot@vpc-star-2.allthinkstars.com:/home/iot/app/python/pi-runtime/
```

### 2. 准备宿主机配置和持久化目录

登录 Star2 后执行：

```bash
cd /home/iot/app/python/pi-runtime
mkdir -p config data/agent data/sessions data/workspace
cp .env.star2.example .env
chmod 600 .env
```

编辑 `.env`，把三个 `replace-me` 替换成 Java iot-app 当前使用的相同密钥。把 DashScope Key 写入 `config/apikey.txt`，并限制文件权限：

```bash
chmod 700 config data data/agent data/sessions data/workspace
chmod 600 config/apikey.txt
```

`.env`、`config/apikey.txt` 和 `data/` 只保存在 Star2，不进入镜像，也不提交 Git。Runtime 会把 Pi 会话写入 `data/sessions`，容器重建后仍可恢复。

### 3. 导入并启动

```bash
cd /home/iot/app/python/pi-runtime
gzip -dc pi-java-agent-runtime-dev.tar.gz | docker load
docker compose config --quiet
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8000/healthz
```

Compose 通过 `127.0.0.1:8000:8000` 只向 Star2 本机暴露 Runtime。Nginx 继续代理 `127.0.0.1:8000`；Pi 容器通过 `host.docker.internal:10002` 调用现有 Java iot-app。

### 4. 后续更新

代码变化后重新构建、传输并 `docker load` 镜像。如果 `docker-compose.yml` 同时有变化，也要覆盖服务器上的旧文件；Docker 拉取或导入镜像不会自动更新 Compose。最后再次执行：

```bash
docker compose up -d
```

Compose 会在镜像或启动配置变化时重建 Pi 容器，不会删除宿主机的 `.env`、Key 和 `data/`。

两个聊天接口同时接受纯文字 JSON `{ "query": "..." }`，以及包含可选 `query`、最多五个重复 `images` 文件字段的 `multipart/form-data`。单张原图不能超过 10 MiB；仅上传图片时 Runtime 自动使用“请分析这些图片”。图片会先经过 Pi `processImage` 的格式识别、方向处理、缩放与压缩，再与文字共同发送给模型。

两个聊天接口均返回 `{ "conversationId": "...", "response": "..." }`。Java 请求必须携带既有 `X-AI-GW-TOKEN` 与 `X-AI-BIZ-CONTEXT`；Pi 会验证既有 HMAC 上下文签名与有效期，只提取 `tenantId`、`userId` 并在调用 Java MCP Tool 时附带它们。Pi Session JSONL 保留处理后的图片以支持后续追问；Java 管理查询索引只保存图片数量占位，不复制 Base64。

管理台固定使用 SSE：浏览器请求 `/api/ai/**` 经 Java Gateway 回到 Pi，并直接投影 Pi AgentSession 的文本增量和 Tool 生命周期事件。管理台不再提供 Block/SSE 选择器；Runtime 与 Java Gateway 的 Block HTTP API 仍保留给其他调用方。Pi 管理 API 读取同一份 JSONL，投影会话、消息、Tool 调用和结果；不会恢复旧 Python 运行时或事件库。

## 管理台语音转文字

管理台的“语音输入”采用浏览器录音、Java Gateway 调用阿里云百炼非实时 ASR 的方式。录音结束后，Java 的 `POST /api/ai/asr/transcriptions` 只返回转写文字；管理台将文字填入输入框，用户修改并确认后，才会走上述 SSE 对话链路。音频不会发送给 Pi Runtime，也不会写进 Pi 会话 JSONL。

阿里云配置属于 Java Gateway 的部署配置，不属于本目录的 Pi `.env`。在 Java 的 Nacos 配置或部署环境变量中提供：

```yaml
ai:
  asr:
    # 建议使用当前百炼 Workspace 的北京专属推理地址；旧 dashscope 域名也可兼容。
    endpoint: https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
    api-key: ${AI_ASR_API_KEY}
    model: fun-asr-flash-2026-06-15
    connect-timeout-ms: 5000
    read-timeout-ms: 30000
    max-audio-bytes: 7340032
```

`AI_ASR_API_KEY` 只能配置在 Java 部署环境或 Nacos 密钥中，不能放入浏览器、Pi `.env` 或仓库。第一版录音最长 5 分钟，原始录音最大 7 MiB；该限制为 Base64 编码后的百炼 10 MiB 输入上限保留了传输余量。

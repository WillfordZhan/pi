# 企业微信 Pi Runtime 测试 Channel 设计

## 目标

在现有 Pi Java Agent Runtime 进程中接入企业微信智能机器人 WebSocket 长连接，完成单聊文字消息接收、Pi AgentSession 执行和企业微信回复，用于验证企业微信到 ERP MCP Tool 的端到端链路。

第一版使用固定测试 ERP 身份，但不把具体用户、工厂或机器人凭证写入代码。所有部署值均通过未提交的环境变量注入。

## 范围

第一版包含：

- 使用企业微信官方 Node SDK，通过 `BotID + Secret` 建立 WebSocket 长连接。
- 接收单聊文字消息。
- 仅允许配置白名单中的一个企业微信 `userid` 调用 Pi。
- 未配置白名单时进入身份探测模式：只向发送人返回其企业微信 `userid`，不创建 Pi 会话、不调用模型和 ERP Tool。
- 使用固定配置的 ERP `userId`、`deptId` 与工厂名称作为 Pi 调用人和业务上下文。
- 将 Pi 文本响应回复到企业微信。
- 同一 Runtime 进程内，同一企业微信单聊复用同一个 Pi 会话。
- 对消息 ID 做进程内去重，避免 WebSocket 重投造成重复模型调用或重复 Tool 执行。

第一版不包含：

- 群聊。
- 图片、语音、文件和模板卡片。
- 主动推送。
- 企业微信用户与 ERP 用户的动态绑定。
- 会话映射和消息去重状态的跨进程持久化。
- 多 Runtime 副本协调。

## 当前代码事实

`packages/java-agent-runtime/src/runtime.ts` 中的 `PiConversationRuntime` 已提供创建会话、续聊、会话内串行和 AgentSession 事件订阅能力。`startConversation()` 会立即返回 `conversationId`、执行结果 Promise 和中断函数，因此 Channel 不需要调用本机 HTTP 或重新实现 SSE 解析。

Runtime 会把 `tenantId + userId` 写入 Pi JSONL 的 `java_gateway_context`。续聊时会校验这两个值，Java MCP Tool 调用也复用该调用人上下文。

Java Gateway 创建会话时已在签名头中提供 `conversationContext`，但 Runtime 原先只保留 `tenantId + userId`，导致工厂名称和炉号语义丢失。共享 Runtime 现在会校验该上下文与调用人一致，将其单独写入 Pi JSONL，并作为系统上下文恢复；企业微信测试 Channel 复用同一结构，避免为具体问题增加关键词规则。

DEV 数据库只读查询确认，本次测试身份为：

- ERP `userId`：`1942403262651006977`
- 当前工厂 `deptId`：`1955839459465793537`
- 当前工厂名称：`ERP开发工厂`

该用户是调试管理员。当前工厂来自 `tb_debug_user_cut`，符合 `AppUserDeptService.getFactoryDeptId()` 的现有优先级，不能使用用户默认部门 `100` 代替。

## 架构

新增一个企业微信 Channel 模块，职责只包括企业微信协议适配、访问控制、消息去重和企业微信会话到 Pi 会话的进程内映射。它不实现 Agent 编排、Tool 规则或 ERP 身份解析。

```text
企业微信智能机器人
  -> 官方 WebSocket SDK
  -> 企业微信 Channel
       1. 校验单聊与 userid 白名单
       2. 按 msgid 去重
       3. 查找或创建 Pi conversationId
  -> PiConversationRuntime.startConversation()
  -> AgentSession.prompt()
  -> Java MCP Tool
  -> 企业微信回复
```

Channel 与 HTTP Server 共用同一个 `PiConversationRuntime` 实例。这样 Pi 会话、模型、Skill、Agent loop 和 MCP Tool 仍只有一套实现。

## 配置

新增以下部署配置：

```env
WECOM_BOT_ID=<企业微信机器人 BotID>
WECOM_BOT_SECRET=<企业微信机器人 Secret>
WECOM_ALLOWED_USER_ID=<允许联调的企业微信 userid>
WECOM_TEST_ERP_USER_ID=<固定测试 ERP userId>
WECOM_TEST_DEPT_ID=<固定测试工厂 deptId>
WECOM_TEST_DEPT_NAME=<固定测试工厂名称>
```

规则：

- `WECOM_BOT_ID` 和 `WECOM_BOT_SECRET` 同时为空时不启动企业微信 Channel，现有 Runtime 行为不变。
- 两者只配置一个时启动失败，避免误以为机器人已经接入。
- Bot 凭证完整但测试 ERP 身份缺失或格式非法时启动失败。
- `WECOM_ALLOWED_USER_ID` 可以暂时为空；此时只运行安全的身份探测模式。
- Secret 只存在于本地忽略的 `.env` 或部署密钥，不进入代码、规格、日志和版本库。

## 消息处理

### 身份探测模式

当 `WECOM_ALLOWED_USER_ID` 为空时，收到单聊文字消息后只回复当前 `from.userid`。该分支在访问 Pi Runtime 之前结束，不能创建会话、调用模型或执行 ERP Tool。

### 正常测试模式

当发送人的 `from.userid` 与白名单完全一致时：

1. 使用企业微信 `msgid` 检查进程内去重集合；重复消息直接忽略。
2. 按 `from.userid` 查找进程内 Pi `conversationId`。
3. 没有映射时调用 `startConversation(input, caller, true)`，立即保存返回的 `conversationId`。
4. 已有映射时调用 `startConversation(input, caller, false, listener, conversationId)`。
5. `caller` 固定来自 `WECOM_TEST_ERP_USER_ID` 和 `WECOM_TEST_DEPT_ID`，可信业务上下文同时携带 `WECOM_TEST_DEPT_NAME`。
6. 等待 Pi 完成并将最终文本通过企业微信流式消息结束帧回复。

第一版先发送“正在处理中”占位，再发送最终答案，不按每个模型 token 更新企业微信。这样仍复用企业微信流式消息协议，同时避免高频 WebSocket 更新、节流状态和累计 UTF-8 截断逻辑。需要验证真实逐字体验时再增加节流更新。

## 安全边界

- 固定 ERP 身份属于临时联调能力，不能作为正式用户身份方案。
- 企业微信白名单在调用 Pi 之前校验，不能只依赖机器人可见范围。
- 群聊直接拒绝，因为同一群内存在多个实际用户，不能共享固定管理员身份和 Pi 会话。
- 未授权用户只收到拒绝提示，不返回 ERP 身份、工厂或 Runtime 配置。
- 日志只记录消息 ID、企业微信 userid、会话 ID 和错误摘要，不记录 Bot Secret、完整消息正文或签名上下文。
- 正式上线必须由 Java Gateway 将企业微信 userid 映射成真实 ERP 用户和当前工厂，并生成现有 HMAC 业务上下文；届时删除固定测试身份配置。

## 状态与失败处理

- WebSocket 认证、心跳和重连交给企业微信官方 SDK。
- 单个消息处理失败时，用同一个企业微信请求帧返回简短失败提示，不终止 Channel。
- Pi 返回空文本时回复统一兜底文案。
- Runtime 重启后，企业微信到 Pi 会话的内存映射消失；下一条消息创建新 Pi 会话。Pi JSONL 本身仍保留，但第一版不增加额外索引表来恢复映射。
- 消息去重集合设置固定上限；超过上限时移除最早记录，防止常驻进程无界增长。

## 验证

增加一个聚焦测试文件，至少覆盖：

- 未配置白名单时只返回企微 userid，不调用 Pi。
- 非白名单用户不能调用 Pi。
- 群聊不能调用 Pi。
- 同一个 `msgid` 不会执行两次。
- 同一允许用户的第二条消息复用第一次返回的 `conversationId`。
- Pi 执行失败时返回企微错误提示，后续消息仍可处理。

实现后运行该测试，并按仓库规则执行 `npm run check`。不运行全量 `npm test` 或 `npm run build`。

## 后续正式化触发条件

完成文字收发联调后，只有在准备扩大机器人可见范围或进入真实业务使用时，才建设动态身份映射、持久会话路由、媒体消息和多副本协调。正式身份链路应统一放在 Java Gateway，而不是继续增加静态企微用户配置。

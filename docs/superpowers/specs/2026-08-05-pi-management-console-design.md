# Pi 管理台迁移设计

## 目标

将旧 `ats_iot_ai/app_manage` 管理台迁入 Pi。浏览器只访问 Pi Runtime；Java 继续负责登录、用户、工厂和外部 AI Gateway，Pi 继续负责 AgentSession、会话回放与 Java MCP Tool。

## 运行边界

```text
浏览器 -> Pi 管理台静态页
       -> Pi 管理 API -> Pi Session JSONL / Java 管理接口 / Java MCP
       -> Pi /api/ai 代理 -> Java Gateway -> Pi 内部会话接口
```

Pi 在新会话 JSONL 中追加 `java_gateway_context` 自定义条目，仅保存 `tenantId` 与 `userId`，供管理员按工厂和用户检索。JSONL 是管理台会话、回放和 Tool 调用记录的唯一来源；不恢复 Python Event Store、Python Guardrail 或 Python Agent Runtime。

## 接口与交互

- 保留 `/ai/management/**`、`/unified/login`、`/common/currentUserInfo` 与 `/api/ai/**` 页面路径。
- Pi 透明代理 Java 登录、用户、工厂和外部 AI Gateway 请求，并透传浏览器 Authorization。
- Pi 管理 API 将原生 Session Entry 投影为旧页面需要的 conversations、timeline、turns 和 events。
- Tool 目录只展示 Java MCP Tool 与 Pi Session Runtime 信息。
- 在线调试支持 Block 与 SSE。SSE 直接投影 Pi AgentSession 的文本增量和 Tool 生命周期事件，经 Java 既有 SSE Gateway 转发；不恢复旧 Python 轮询事件流或中断状态机。

## 前端迁移

迁入原 React 源码与固定版本依赖，Pi 构建至 `packages/java-agent-runtime/static/manage-console` 并托管 `/ai/management/console/`。在线调试 UI 提供 Block 与 SSE，由 Pi 原生 AgentSession 事件驱动。

## 验证

- 管理 Runtime 单测：Session 元数据、会话投影、Tool 目录与网关鉴权。
- 管理台前端构建。
- Pi 全仓 `npm run check`。
- 本地登录后执行生产计划查询，确认 Tool 调用和会话回放一致。

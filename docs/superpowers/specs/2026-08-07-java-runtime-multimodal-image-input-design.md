# Java Runtime 多图片输入设计

## 目标

在不接入 OSS 的第一版中，让 Pi Runtime Management Console 能够把可选文字与一至五张图片一起提交给 Java AI Gateway，再由 Java 携带可信租户、用户上下文转发给 Pi Java Agent Runtime。Runtime 复用 Pi 已有的 `processImage` 预处理能力，并通过 `AgentSession.prompt()` 将文字和图片同时发送给当前 Qwen 模型；后续切换到支持视觉输入的 OpenAI Codex 模型时继续使用同一套上层协议。

第一版只验证在线识图和同一会话内的后续追问，不建设 OSS、图片管理表、历史图片下载或缩略图服务。

## 已确认约束

- 每次请求最多五张图片。
- 每张原始图片不超过 10 MiB，空文件不接受。
- 文字可以为空；仅上传图片时，Runtime 使用“请分析这些图片”作为默认文字。
- 创建会话与继续对话都支持图片，Block 与 SSE 共用同一输入协议。
- Java Gateway 继续作为唯一外部入口，负责解析当前登录人并注入签名后的租户、用户上下文。
- 图片格式由 Runtime 根据文件内容判断，不能只相信浏览器上传的文件名或 `Content-Type`。
- 第一版在 Management Console 验证，不修改旧静态 AI Chat 页面和小程序。

## 方案选择

采用 `multipart/form-data` 端到端透传方案：

```text
Management Console
  -> Pi 管理台同源代理 /api/ai/**
  -> Java AI Gateway /api/ai/**
  -> Pi Runtime 内部接口 /ai/**
  -> processImage
  -> AgentSession.prompt(text, { images })
  -> Qwen / 后续支持视觉输入的 Codex 模型
```

不采用以下方案：

- JSON 内嵌 Base64：会额外增加约三分之一的传输体积，并在浏览器、Java 与 Runtime 中制造更大的字符串副本。
- 浏览器直连 Runtime：会绕过 Java 登录态、租户范围和业务上下文签名，破坏现有安全边界。
- 第一版接入 OSS：在线识图不依赖永久图片地址，提前建设上传、授权、清理和生命周期管理会扩大改动范围。

## HTTP 协议

创建会话与继续对话沿用现有 URL：

```text
POST /api/ai/conversations
POST /api/ai/conversations/{conversationId}/chat
```

Management Console 使用以下 multipart 字段：

```text
query   可选，UTF-8 文字
images  可重复文件字段，最多五个
```

Runtime 内部的 `/ai/conversations` 与 `/ai/conversations/{conversationId}/chat` 接受两种内容类型：

- `application/json`：继续承载纯文字请求，`query` 必填。
- `multipart/form-data`：承载文字与图片，`query` 可选；文字和图片不能同时为空。

这不是两套业务链路。两种请求在 HTTP 解析完成后都归一成同一个“本轮文字 + 已处理图片”输入，再进入同一个会话执行方法。

## Management Console

在线调试输入区增加原生多文件选择能力，不增加前端依赖：

- 使用隐藏的 `<input type="file" multiple accept="image/*">` 和现有按钮样式。
- 选择后展示本地缩略图、文件名、大小和删除按钮。
- 再次选择图片时追加到现有列表，达到五张后禁止继续添加。
- 浏览器先检查数量与单文件大小，给出即时提示；Runtime 仍执行权威校验。
- 发送时使用 `FormData`。公共 HTTP 工具遇到 `FormData` 时不得手工设置 `Content-Type`，由浏览器写入正确的 multipart boundary。
- 请求开始后清空已发送文字和图片；失败通过现有消息提示报告，不自动重传大文件。

本地缩略图只使用 `URL.createObjectURL()`，图片删除、发送或组件卸载时释放 URL，不上传到额外存储。

## Pi 管理台同源代理

Management Console 由 Pi Runtime 托管，但浏览器的 `/api/ai/**` 仍需先经过 Java Gateway，因此 Pi 的同源代理必须：

- 保留浏览器原始 `Content-Type`，不能把 multipart 强制改成 `application/json`。
- 保留 `Accept`，确保 Block 与 SSE 行为不变。
- 对会话上传请求设置独立的有界请求体上限；普通管理 JSON 接口继续使用原有小请求上限。
- 超过上限时在进入 Java 前返回 `413`，避免无界缓冲。

第一版允许同源代理有界缓冲完整上传体。五张 10 MiB 图片加 multipart 元数据后，请求体上限设为 52 MiB。以后只有在并发大图片上传造成可观测内存压力时，才改为真正的流式请求体转发。

## Java Gateway

Java Controller 为 JSON 与 multipart 使用各自的 Spring MVC 入口。multipart 由 Spring 拆成 `query` 和 `MultipartFile` 后，现有 `AiGatewayProxyService` 使用 JDK 流重新编码 multipart。Gateway 不解析图片语义，也不执行压缩，只负责：

1. 解析当前 ERP 登录人。
2. 生成带租户 ID、用户 ID、过期时间的签名业务上下文。
3. 保留 multipart 字段语义，将文字和图片流转发到 Pi Runtime。
4. 按现有逻辑返回 Block 响应或持续转发 SSE。

这样图片预处理只有 Pi Runtime 一份实现，Java 不复制图像算法。Java 转发时使用稳定序号作为文件名，避免外部文件名污染 multipart 头；图片字节采用有界流复制，不拼成 Java Base64 或大字符串。Java 侧使用现有 JDK/Spring 能力，不新增 multipart HTTP 客户端依赖。

## Runtime 校验与图片预处理

Runtime 使用 Node 22 原生 `Request.formData()` 解析有界 multipart 请求，不引入新的解析库。处理顺序如下：

```text
读取有界请求体
  -> 解析 multipart
  -> 校验字段、数量、单图原始大小
  -> 读取文件头并识别真实格式
  -> 逐张调用 processImage
  -> 组合默认文字与图片处理提示
  -> session.prompt(query, { source: "rpc", images })
```

真实格式识别复用 `detectSupportedImageMimeType()`，首版接受 JPEG、静态 PNG、GIF、WebP 与 BMP；伪造后缀、未知格式和 APNG 均拒绝。格式识别通过后复用 `processImage()` 默认处理能力：

- 识别 JPEG/WebP EXIF 方向；发生重编码时把方向写入输出像素，未重编码时保留原始文件及其 EXIF。
- 超限时按比例缩放，最长边不超过 2000 像素。
- 尝试 PNG 与多档 JPEG 质量编码。
- 单张处理后的 Base64 小于约 4.5 MiB。
- 将格式转换和尺寸映射提示追加到本轮文字，使模型理解图片变换。

任意一张图片校验或处理失败时，整次请求失败，不静默遗漏部分图片。这样用户不会误以为模型已经分析了全部附件。

## 会话持久化边界

Pi `AgentSession` 会把处理后的图片 Base64 写入本地 Session JSONL。这是第一版有意保留的行为：后续追问“第二张图里是什么”时，模型仍能从会话上下文取得图片。

Java 会话索引不复制图片 Base64。同步到 Java 前，仅对含图片的用户消息生成存储投影：

```text
原始 Pi JSONL：文字块 + 图片 Base64 块
Java 查询索引：文字块 + “本轮包含 N 张图片”的文字占位
```

Entry ID、父子关系、时间和文字内容保持不变，因此现有幂等 marker、会话检索和时间线投影仍可工作。Management Console 历史回放第一版只显示图片数量，不显示历史缩略图。

这个规则是既有“Java 保存 Pi 原始 Entry”约定的图片例外：Pi JSONL 仍是完整会话真相源，Java 只承担不含大二进制内容的管理查询读模型。未来接入 OSS 后，可在 Java 投影中保存受权限控制的对象引用，再增加历史图片展示。

## 泛化与耦合评估

- 能力落在通用的创建会话、继续对话输入协议中，没有匹配具体问题文本、图片名称或页面流程。
- Management Console 只是第一验证客户端；小程序和其他 Java 调用方以后可以复用同一 multipart 字段与错误语义。
- Java 只承担身份上下文和字节转发，图片格式、压缩与模型输入统一由 Runtime 负责，没有形成两套图像规则。
- 新增耦合仅限明确的协议字段 `query`、`images` 和现有模型 `ImageContent`，没有增加图片 DTO 层、Provider 专属分支或临时黑名单。
- Java 存储投影是当前无 OSS 条件下的容量保护，不承担运行时上下文职责；接入 OSS 后替换为对象引用，不需要改变 Agent 输入协议。
- 已知成本是 Pi JSONL 仍会保存处理后的 Base64。第一版用它换取同一会话内可追问；只有磁盘增长成为可观测问题时，才建设 OSS 与会话附件生命周期。

## 错误边界

- `400`：multipart 结构错误、字段类型错误、文字与图片同时为空。
- `401/403`：沿用现有 Gateway Token、业务上下文签名与会话归属校验。
- `413`：总请求体超限、图片超过五张、单图超过 10 MiB。
- `415`：文件内容不是支持的图片格式。
- `422`：图片可以识别但 `processImage` 无法完成转换或压缩。
- `502`：沿用现有 Java Gateway、模型或 Runtime 上游失败语义。

SSE 在响应头尚未发送前发生的输入错误使用普通 JSON 错误响应；进入 Agent 执行后发生的错误继续使用现有 `conversation_failed` 事件。

## 验证

### Runtime 聚焦测试

- JSON 纯文字请求保持可用。
- multipart 文字加单图、多图能够形成正确的 `ImageContent[]`。
- 纯图片请求使用默认文字。
- 超过五张、单张超过 10 MiB、总请求体超限分别返回 `413`。
- 伪造 MIME、未知格式、空图片被拒绝。
- Java 同步投影不包含 Base64，仍保留文字、图片数量与 Entry ID。

### Java 聚焦测试

- JSON 与 multipart 的请求字节、原始 `Content-Type` 都能转发。
- Gateway Token 与签名业务上下文仍会注入。
- Block 与 SSE 保持现有状态码、响应类型和输出行为。

### Management Console 验证

- 分别发送一张图、五张图、文字加图片、纯图片。
- 删除待发送图片、重复选择图片以及选择超大图片时提示正确。
- 分别使用 Block 与 SSE，确认模型回复、Tool 调用和同一会话续聊正常。
- 刷新历史会话后确认显示文字和图片数量占位，不产生 Base64 页面响应。

代码实现完成后运行受影响的聚焦测试与仓库要求的 `npm run check`。Management Console 的真实模型验证使用当前 `qwen3.7-plus`，不调用付费测试提供方编写自动化测试。

## 第一版明确不做

- OSS 上传、签名 URL、跨租户图片授权与对象生命周期清理。
- 历史图片缩略图、下载和重新发送。
- OCR、智能裁剪、敏感信息脱敏、病毒扫描。
- 图片自动重试、断点续传和并发上传优化。
- 为未来 Codex 模型预先增加独立 Provider 分支；模型切换继续由 Pi `ModelRuntime` 负责。

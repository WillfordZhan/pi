# ERP 数字员工 SSE 稳定性修复设计

## 问题

ERP 数字员工的正常问答在模型思考或 Tool 执行超过 30 秒时，被 Spring MVC 的异步请求默认超时主动断开。Pi 随后把下游断开传播为 Agent abort，前端恢复历史时同时展示 Tool 失败和连接中断，造成一次故障显示两条失败提示。

## 设计

- Pi Runtime 在 SSE 会话期间每 15 秒发送 `ping`，业务事件与终态协议保持不变；请求结束、失败或断开时必须清理定时器。
- Java Gateway 为 `iot-app`、`iot-erp` 与 `iot-erp-*` 的异步 MVC 请求配置 10 分钟总超时，并复用项目已有 `threadPoolTaskExecutor`，避免每个流创建无界线程。
- Pi 会话历史把因连接中断产生的 `This operation was aborted` 投影为“连接中断，业务处理结果未知，请勿重复操作”；其他 Tool 错误继续使用“本次业务处理未完成”。
- ERP 前端恢复中断历史后不再追加第二条“连接已中断”，但没有任何服务端中断状态时仍保留连接提示。

## 验证

- Pi HTTP 测试确认静默执行期间能收到 `ping`，结束后不残留定时器。
- Pi 投影测试确认 abort 与普通业务错误使用不同文案。
- Java Spring 上下文测试确认 ERP 实例化应用名会装配 10 分钟异步超时和已有线程池。
- ERP 前端执行静态检查，并验证断流恢复只生成一条状态提示。

## 发布

- Pi Runtime 重建并重启 Star2 `pi-runtime`，检查健康状态。
- Java 合并推送 `dev`，等待 `iot-erp` 镜像成功后发布 DEV `iot-erp-1`。
- ERP 前端只提交，不在本次任务中部署。

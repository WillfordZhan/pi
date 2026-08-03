/**
 * 测试辅助模块：提供测试用会话后端/运行时、协议测试客户端与测试服务器工厂，
 * 供传输层一致性测试与服务器协议测试复用。
 */
export { Deferred, TEST_MODEL, TEST_TOKEN, TestSessionBackend, TestSessionRuntime } from "./backend.ts";
export type { WireChannel } from "./client.ts";
export { connectUnixTestClient, ProtocolTestClient } from "./client.ts";
export type { TestServer, TestServerOptions } from "./server.ts";
export { createTestServer } from "./server.ts";

import { PiServer } from "../server.ts";
import type { PiServerOptions, PiSessionBackend } from "../types.ts";
import { TEST_TOKEN, TestSessionBackend } from "./backend.ts";

/** 测试服务器的选项：继承 PiServerOptions，但令牌与后端可选（带默认值）。 */
export interface TestServerOptions extends Omit<PiServerOptions, "token"> {
	token?: string;
	backend?: PiSessionBackend;
}

/** 测试服务器：包含尚未启动的 PiServer 与配套的会话后端。 */
export interface TestServer {
	server: PiServer;
	backend: PiSessionBackend;
}

/** 创建一台未启动的 PiServer，使用确定性的默认值，供传输层一致性测试使用。 */
export function createTestServer(options: TestServerOptions): TestServer {
	const backend = options.backend ?? new TestSessionBackend();
	return {
		server: new PiServer(backend, {
			token: options.token ?? TEST_TOKEN,
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serverId: options.serverId,
			onError: options.onError,
		}),
		backend,
	};
}

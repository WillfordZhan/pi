import { PiServer } from "../server.ts";
import type { PiServerOptions, PiServerService } from "../types.ts";
import { TestServerService } from "./service.ts";

export interface TestServerOptions extends PiServerOptions {
	service?: PiServerService;
}

/** 测试服务器：包含尚未启动的 PiServer 与配套的会话后端。 */
export interface TestServer {
	server: PiServer;
	service: PiServerService;
}

/** 创建一台未启动的 PiServer，使用确定性的默认值，供传输层一致性测试使用。 */
export function createTestServer(options: TestServerOptions): TestServer {
	const service = options.service ?? new TestServerService();
	return {
		server: new PiServer(service, {
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serverId: options.serverId,
			onError: options.onError,
		}),
		service,
	};
}

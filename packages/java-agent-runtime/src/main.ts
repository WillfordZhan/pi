/** Java Agent Runtime 进程入口。 */

import { loadRuntimeConfig, loadRuntimeEnvironment } from "./config.ts";
import { createHttpServer } from "./http-server.ts";
import { PiConversationRuntime } from "./runtime.ts";
import { startWeComChannel } from "./wecom-channel.ts";

loadRuntimeEnvironment();
const config = loadRuntimeConfig();
const runtime = await PiConversationRuntime.create(config);
const server = createHttpServer(runtime, config);
let stopWeComChannel: (() => void) | undefined;

server.listen(config.port, () => {
	const baseUrl = `http://127.0.0.1:${config.port}`;
	console.info(`Pi API: ${baseUrl}`);
	console.info(`Management Console: ${baseUrl}/ai/management/console/`);
	if (config.weCom) stopWeComChannel = startWeComChannel(runtime, config.weCom);
});

/** HTTP 与企业微信长连接共用进程生命周期，退出时必须主动停止 SDK 的心跳与重连定时器。 */
function shutdown(): void {
	stopWeComChannel?.();
	server.close();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

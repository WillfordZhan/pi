/** Java Agent Runtime 进程入口。 */

import { loadRuntimeConfig, loadRuntimeEnvironment } from "./config.ts";
import { createHttpServer } from "./http-server.ts";
import { PiConversationRuntime } from "./runtime.ts";

loadRuntimeEnvironment();
const config = loadRuntimeConfig();
const runtime = await PiConversationRuntime.create(config);
const server = createHttpServer(runtime, config);

server.listen(config.port, () => {
	const baseUrl = `http://127.0.0.1:${config.port}`;
	console.info(`Pi API: ${baseUrl}`);
	console.info(`Management Console: ${baseUrl}/ai/management/console/`);
});

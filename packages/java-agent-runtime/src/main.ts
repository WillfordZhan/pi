/** Java Agent Runtime 进程入口。 */

import { loadRuntimeConfig } from "./config.ts";
import { createHttpServer } from "./http-server.ts";
import { PiConversationRuntime } from "./runtime.ts";

const config = loadRuntimeConfig();
const runtime = await PiConversationRuntime.create(config);
const server = createHttpServer(runtime, config);

server.listen(config.port, () => {
	console.info(`Pi Java Agent Runtime listening on port ${config.port}`);
});

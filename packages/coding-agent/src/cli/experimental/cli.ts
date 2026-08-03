import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type PiCommandContext, piCommand } from "./commands/pi.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";

/** 实验性 CLI 所需的全部上下文：由 pi、server、client 三个子命令的上下文合并而成。 */
export type ExperimentalCliContext = PiCommandContext & ServerCommandContext & ClientCommandContext;

/** 实验性 CLI 命令树：以 pi 为根命令，注册 server 与 client 两个子命令。 */
export const experimentalCli = piCommand.command(serverCommand).command(clientCommand);

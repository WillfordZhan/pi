import type { AuthInput } from "../auth.ts";
import { Command } from "../command.ts";
import {
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseLegacyOptions,
	transportOption,
	unsupportedLegacyOptions,
} from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";

/** 解析后的 `server` 子命令调用：可携带认证信息与要监听的传输地址列表。 */
export interface ServerCommand {
	readonly command: "server";
	readonly auth?: AuthInput;
	readonly listen?: readonly TransportAddress[];
}

/** `server` 子命令的上下文：提供运行服务端的方法。 */
export interface ServerCommandContext {
	runServer(command: ServerCommand): void | Promise<void>;
}

/** server 子命令的 --listen 传输地址选项。 */
const listenOption = transportOption("--listen");

/** server 子命令：启动服务端并监听一个或多个传输地址。 */
export const serverCommand = new Command<ServerCommand, ServerCommandContext>("server")
	.option(listenOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const listen = input.values(listenOption);
		const { errors: optionErrors } = parseLegacyOptions(input);
		const errors = [...authErrors, ...optionErrors, ...unsupportedLegacyOptions("server", input)];
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "server",
				...(auth === undefined ? {} : { auth }),
				...(listen.length === 0 ? {} : { listen }),
			},
		};
	})
	.action((command, context) => context.runServer(command));

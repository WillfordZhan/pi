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

/** 解析后的 `client` 子命令调用：可携带认证信息与要连接的传输地址。 */
export interface ClientCommand {
	readonly command: "client";
	readonly auth?: AuthInput;
	readonly connect?: TransportAddress;
}

/** `client` 子命令的上下文：提供运行客户端会话的方法。 */
export interface ClientCommandContext {
	runClient(command: ClientCommand): void | Promise<void>;
}

/** client 子命令的 --connect 传输地址选项。 */
const connectOption = transportOption("--connect");

/** client 子命令：连接一个远程会话，接收 --connect 与认证选项。 */
export const clientCommand = new Command<ClientCommand, ClientCommandContext>("client")
	.option(connectOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const connect = input.value(connectOption);
		const { errors: optionErrors } = parseLegacyOptions(input);
		const errors = [...authErrors, ...optionErrors, ...unsupportedLegacyOptions("client", input)];
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "client",
				...(auth === undefined ? {} : { auth }),
				...(connect === undefined ? {} : { connect }),
			},
		};
	})
	.action((command, context) => context.runClient(command));

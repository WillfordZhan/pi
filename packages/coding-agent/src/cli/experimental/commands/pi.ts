import type { Args } from "../../args.ts";
import type { AuthInput } from "../auth.ts";
import { Command } from "../command.ts";
import {
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseLegacyOptions,
	transportOption,
} from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";

/** 解析后的 `pi` 根命令调用：可携带认证信息、监听地址以及旧式 CLI 选项。 */
export interface PiCommand {
	readonly command: "pi";
	readonly auth?: AuthInput;
	readonly options: Args;
	readonly listen?: readonly TransportAddress[];
}

/** `pi` 根命令的上下文：提供运行 pi 会话的方法。 */
export interface PiCommandContext {
	runPi(command: PiCommand): void | Promise<void>;
}

/** pi 根命令的 --listen 传输地址选项。 */
const listenOption = transportOption("--listen");

/** pi 根命令：可监听一个或多个传输地址，同时接受旧式 CLI 选项。 */
export const piCommand = new Command<PiCommand, PiCommandContext>("pi")
	.option(listenOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const listen = input.values(listenOption);
		const { options, errors: optionErrors } = parseLegacyOptions(input);
		const errors = [...authErrors, ...optionErrors];
		if (options.unknownFlags.has("connect")) errors.push("--connect is only valid for client mode");
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "pi",
				options,
				...(auth === undefined ? {} : { auth }),
				...(listen.length === 0 ? {} : { listen }),
			},
		};
	})
	.action((command, context) => context.runPi(command));

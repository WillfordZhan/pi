import { type Args, parseArgs } from "../args.ts";
import { type AuthInput, parseAuthInput } from "./auth.ts";
import { type CommandOption, type ParsedCommandInput, stringOption, valueOption } from "./command.ts";
import { parseTransportAddress, type TransportAddress } from "./transport-address.ts";

/** 认证 token 选项（--auth-token）。 */
export const authTokenOption = stringOption("--auth-token");
/** 认证 token 文件选项（--auth-token-file）。 */
export const authTokenFileOption = stringOption("--auth-token-file");

/** 创建传输地址选项：把 `--listen` / `--connect` 的参数值解析为传输地址。 */
export function transportOption(name: "--listen" | "--connect"): CommandOption<TransportAddress> {
	return valueOption(name, (value) => {
		const result = parseTransportAddress(value, name);
		return result.address
			? { ok: true, value: result.address }
			: { ok: false, error: result.error ?? `Invalid ${name} address "${value}"` };
	});
}

/** 从已解析的命令输入中提取认证选项并解析。 */
export function parseAuth(input: ParsedCommandInput): { auth?: AuthInput; errors: string[] } {
	return parseAuthInput({
		authToken: input.value(authTokenOption),
		authTokenFile: input.value(authTokenFileOption),
	});
}

/** 用旧的参数解析器处理剩余参数，返回旧式选项及错误信息。 */
export function parseLegacyOptions(input: ParsedCommandInput): { options: Args; errors: string[] } {
	const options = parseArgs([...input.remainingArgs]);
	return {
		options,
		errors: options.diagnostics
			.filter((diagnostic) => diagnostic.type === "error")
			.map((diagnostic) => diagnostic.message),
	};
}

/** 若剩余参数非空，提示实验性命令暂不支持旧版 CLI 选项。 */
export function unsupportedLegacyOptions(command: string, input: ParsedCommandInput): string[] {
	if (input.remainingArgs.length === 0) return [];
	return [`The experimental ${command} command does not support existing CLI options yet`];
}

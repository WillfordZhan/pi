/** 认证输入：直接携带 token，或指定包含 token 的文件路径。 */
export type AuthInput =
	| { readonly type: "token"; readonly token: string }
	| { readonly type: "file"; readonly path: string };

/** 原始认证选项：对应命令行 `--auth-token` 与 `--auth-token-file` 两个参数。 */
export interface RawAuthOptions {
	readonly authToken?: string;
	readonly authTokenFile?: string;
}

/**
 * 解析认证选项：token 与文件两种方式互斥，二者同时提供时报错。
 * 返回可用的认证输入，以及解析过程中产生的错误信息。
 */
export function parseAuthInput(options: RawAuthOptions): { auth?: AuthInput; errors: string[] } {
	if (options.authToken !== undefined && options.authTokenFile !== undefined) {
		return { errors: ["--auth-token and --auth-token-file are mutually exclusive"] };
	}
	if (options.authToken !== undefined) {
		return { auth: { type: "token", token: options.authToken }, errors: [] };
	}
	if (options.authTokenFile !== undefined) {
		return { auth: { type: "file", path: options.authTokenFile }, errors: [] };
	}
	return { errors: [] };
}

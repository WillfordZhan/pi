import { posix } from "node:path";

/** Unix 域套接字传输地址。 */
export interface UnixTransportAddress {
	readonly transport: "unix";
	readonly path: string;
}

/** 支持的传输地址类型（目前仅 Unix 域套接字一种）。 */
export type TransportAddress = UnixTransportAddress;

/**
 * 解析传输地址字符串（如 `unix:///path/to/socket`）。
 * 依次校验协议、授权信息、绝对路径等，返回地址或错误信息。
 */
export function parseTransportAddress(
	value: string,
	option: "--listen" | "--connect",
): { address?: TransportAddress; error?: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `Invalid ${option} address "${value}"` };
	}
	if (url.protocol !== "unix:") {
		return { error: `Unsupported ${option} transport "${url.protocol}"` };
	}
	if (url.hostname || url.port || url.username || url.password) {
		return { error: "Unix transport address must not include an authority" };
	}
	if (
		!value.startsWith("unix:///") ||
		value.startsWith("unix:////") ||
		value.includes("?") ||
		value.includes("#") ||
		url.href !== value
	) {
		return { error: `Invalid ${option} address "${value}"` };
	}
	let path: string;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		return { error: `Invalid ${option} address "${value}"` };
	}
	if (path.includes("\0")) {
		return { error: `Invalid ${option} address "${value}"` };
	}
	if (!posix.isAbsolute(path)) {
		return { error: "Unix transport address requires an absolute path" };
	}
	return { address: { transport: "unix", path } };
}

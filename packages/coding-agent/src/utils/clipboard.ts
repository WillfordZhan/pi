import { type ExecFileSyncOptionsWithStringEncoding, execFileSync, execSync, spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.ts";
import { clipboard } from "./clipboard-native.ts";

/** 平台剪贴板命令的执行选项：以管道输入文本，超时 5 秒。 */
type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

/** 通过 xclip（失败时回退 xsel）把文本写入 X11 剪贴板。 */
function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		execSync("xsel --clipboard --input", options);
	}
}

/** OSC 52 序列编码后允许的最大长度，避免超大载荷破坏终端渲染。 */
const MAX_OSC52_ENCODED_LENGTH = 100_000;

/** 判断是否处于远程会话（SSH / Mosh）。 */
function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

/** 通过 OSC 52 转义序列把文本写入终端剪贴板；过长或写入失败返回 false。 */
function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

/** 读取剪贴板的返回结果：成功携带文本（可能为 null），失败为 ok: false。 */
type ClipboardReadResult = { ok: true; text: string | null } | { ok: false };

/** 读取剪贴板时使用的执行选项（utf8、大缓冲、5 秒超时）。 */
const READ_CLIPBOARD_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
	encoding: "utf8",
	maxBuffer: 50 * 1024 * 1024,
	timeout: 5000,
};

/** 通过 wl-paste 读取 Wayland 剪贴板纯文本。 */
function readWaylandClipboardText(): ClipboardReadResult {
	try {
		const text = execFileSync("wl-paste", ["--no-newline", "--type", "text"], READ_CLIPBOARD_OPTIONS);
		return { ok: true, text: text || null };
	} catch {
		return { ok: false };
	}
}

/** 从系统剪贴板读取纯文本。 */
export async function readClipboardText(): Promise<string | null> {
	if (platform() === "linux" && isWaylandSession() && process.env.WAYLAND_DISPLAY) {
		const result = readWaylandClipboardText();
		if (result.ok) {
			return result.text;
		}
	}

	if (!clipboard) {
		return null;
	}

	try {
		const text = await clipboard.getText();
		return text || null;
	} catch {
		return null;
	}
}

/** 把文本复制到系统剪贴板：优先原生实现，随后回退平台命令，最后用 OSC 52。 */
export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// 优先直接写剪贴板。先发 OSC 52 可能让终端与原生 addon 并发写入同一剪贴板，
	// 且非常大的 OSC 52 载荷可能使终端渲染失步。
	//
	// 在 Linux 上跳过原生 addon。底层 `clipboard-rs` crate 仅支持 X11，
	// 且 `set_text` 返回后并不保留选区所有权；因此在纯 Wayland 合成器
	// （Hyprland、Niri 等）甚至部分 X11 会话中，调用成功返回却并未真正写入剪贴板。
	// 下面的平台工具（wl-copy、xclip、xsel）会正确守护进程并保持所有权。
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// 回退到平台相关的剪贴板工具。
	}

	const remote = isRemoteSession();
	if (copied && !remote) {
		return;
	}

	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	if (!copied) {
		try {
			if (p === "darwin") {
				execSync("pbcopy", options);
				copied = true;
			} else if (p === "win32") {
				execSync("clip", options);
				copied = true;
			} else {
				// Linux。尝试 Termux、Wayland 或 X11 剪贴板工具。
				if (process.env.TERMUX_VERSION) {
					try {
						execSync("termux-clipboard-set", options);
						copied = true;
					} catch {
						// 回退到 Wayland 或 X11 工具。
					}
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						try {
							// 先确认 wl-copy 存在（spawn 的 error 是异步的，不会被捕获）
							execSync("which wl-copy", { stdio: "ignore" });
							// execSync 调用 wl-copy 会因 fork 行为而挂起，因此改用 spawn。
							// 等待其退出码，仅在干净退出时才算成功，这样失败的 wl-copy
							// 会继续回退到 xclip / OSC 52。
							const wlCopyExit = await new Promise<number>((resolve) => {
								const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
								proc.on("error", () => resolve(1));
								proc.on("close", (code) => resolve(code ?? 1));
								proc.stdin.on("error", () => {
									// 若 wl-copy 提前退出则忽略 EPIPE 错误
								});
								proc.stdin.write(text);
								proc.stdin.end();
							});
							if (wlCopyExit === 0) {
								copied = true;
							} else if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						} catch {
							if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						copyToX11Clipboard(options);
						copied = true;
					}
				}
			}
		} catch {
			// 回退到 OSC 52 兜底方案。
		}
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}

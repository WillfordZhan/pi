import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/** 终端图片协议：Kitty、iTerm2 或 null（不支持图片）。 */
export type ImageProtocol = "kitty" | "iterm2" | null;

/** 终端的特性能力：是否支持图片、真彩色和 OSC 8 超链接。 */
export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
}

/** 终端单元格的像素尺寸。 */
export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

/** 图片的像素尺寸。 */
export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

/** 渲染图片时的选项。 */
export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	/** Kitty 图片 ID。若提供，会复用/替换该 ID 对应的已有图片。 */
	imageId?: number;
	/** 是否让 Kitty 在放置图片后执行默认的光标移动。 */
	moveCursor?: boolean;
}

let cachedCapabilities: TerminalCapabilities | null = null;
let capabilityOverrides: Partial<TerminalCapabilities> = {};

// 默认单元格尺寸——TUI 收到终端查询响应后会更新它
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

/** 获取当前终端单元格的像素尺寸。 */
export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

/** 设置终端单元格的像素尺寸。 */
export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

/**
 * 探测当前挂载的 tmux 客户端是否会把 OSC 8 超链接转发给外层终端。
 * 仅当 tmux 的 `client_termfeatures` 包含 `hyperlinks` 时才会重发超链接，否则会剥离它们。
 * 任何错误时回退为 false。
 */
function probeTmuxHyperlinks(): boolean {
	try {
		const termfeatures = execSync("tmux display-message -p '#{client_termfeatures}'", {
			encoding: "utf8",
			timeout: 250,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return termfeatures
			.split(",")
			.map((feature) => feature.trim())
			.includes("hyperlinks");
	} catch {
		return false;
	}
}

function detectCapabilitiesFromEnvironment(tmuxForwardsHyperlink: () => boolean): TerminalCapabilities {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const terminalEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
	const hasTrueColorHint = colorTerm === "truecolor" || colorTerm === "24bit";
	const isWindowsConsole = process.platform === "win32";

	// 仅当 tmux 确认会转发时才开启 OSC 8 超链接。
	// 图片协议在 tmux 下不可靠，因此保持 `images: null`。
	if (process.env.TMUX || term.startsWith("tmux")) {
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: tmuxForwardsHyperlink() };
	}

	// screen 不转发 OSC 8 超链接，因此这里关闭超链接。
	if (term.startsWith("screen")) {
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
	}

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	// Warp 支持 Kitty 图形协议和 OSC 8 超链接。
	if (termProgram === "warpterminal" || process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL_SESSION_UUID) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}

	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		return { images: "iterm2", trueColor: true, hyperlinks: true };
	}

	if (process.env.WT_SESSION) {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (termProgram === "vscode") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (termProgram === "alacritty") {
		return { images: null, trueColor: true, hyperlinks: true };
	}

	if (terminalEmulator === "jetbrains-jediterm") {
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Windows Terminal does not always set WT_SESSION, for example when it hosts
	// a cmd.exe launched directly from Win+R. Modern Windows consoles support
	// truecolor; keep hyperlinks off unless we positively detected support above.
	if (isWindowsConsole) {
		return { images: null, trueColor: true, hyperlinks: false };
	}

	// Unknown terminal: be conservative. OSC 8 is rendered invisibly as "just
	// text" on terminals that swallow it, which means the URL disappears from
	// the rendered output. Default to the legacy `text (url)` behavior unless we
	// have positively identified a hyperlink-capable terminal above.
	return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
}

function parseBooleanCapabilityOverride(value: string | undefined): boolean | undefined {
	return value === "1" ? true : value === "0" ? false : undefined;
}

export function detectCapabilities(tmuxForwardsHyperlink: () => boolean = probeTmuxHyperlinks): TerminalCapabilities {
	const hyperlinks = parseBooleanCapabilityOverride(process.env.PI_HYPERLINKS);
	const detected = detectCapabilitiesFromEnvironment(
		hyperlinks === undefined ? tmuxForwardsHyperlink : () => hyperlinks,
	);
	const imageProtocol = process.env.PI_IMAGE_PROTOCOL?.toLowerCase();
	const images =
		imageProtocol === "kitty" || imageProtocol === "iterm2"
			? imageProtocol
			: imageProtocol === "none" || imageProtocol === "0"
				? null
				: undefined;
	const trueColor = parseBooleanCapabilityOverride(process.env.PI_TRUE_COLOR);
	return {
		...detected,
		...(images !== undefined ? { images } : {}),
		...(trueColor !== undefined ? { trueColor } : {}),
		...(hyperlinks !== undefined ? { hyperlinks } : {}),
	};
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		const hyperlinks = capabilityOverrides.hyperlinks;
		cachedCapabilities = {
			...detectCapabilities(hyperlinks === undefined ? undefined : () => hyperlinks),
			...capabilityOverrides,
		};
	}
	return cachedCapabilities;
}

/** 清空终端能力缓存（下次调用会重新探测）。 */
export function resetCapabilitiesCache(): void {
	cachedCapabilities = null;
}

/** Override selected auto-detected capabilities. */
export function setCapabilityOverrides(overrides: Partial<TerminalCapabilities>): void {
	if (
		capabilityOverrides.images === overrides.images &&
		capabilityOverrides.trueColor === overrides.trueColor &&
		capabilityOverrides.hyperlinks === overrides.hyperlinks
	) {
		return;
	}
	capabilityOverrides = { ...overrides };
	cachedCapabilities = null;
}

/** Override the cached capabilities. Useful in tests to exercise both code paths. */
export function setCapabilities(caps: TerminalCapabilities): void {
	cachedCapabilities = caps;
}

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";

/** 判断一行文本是否包含终端图片转义序列。 */
export function isImageLine(line: string): boolean {
	// 快路径：序列在行首（单行图片）
	if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
		return true;
	}
	// 慢路径：序列在其它位置（多行图片带光标上移前缀）
	return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}

/**
 * 为 Kitty 图形协议生成一个随机图片 ID。
 * 使用随机 ID 以避免不同模块实例（如主应用与扩展）之间的冲突。
 */
export function allocateImageId(): number {
	// 使用 [1, 0xffffffff] 范围内的随机 ID 以避免冲突
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

/**
 * 把 base64 编码的图片数据编码为 Kitty 图形协议序列。
 * 大图会自动分块传输（每块 4096 字符）。
 */
export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
		/** 是否在放置后让 Kitty 执行默认光标移动。默认：true。 */
		moveCursor?: boolean;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.moveCursor === false) params.push("C=1");
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	if (base64Data.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	// 分块传输：首个块携带参数，中间块 m=1，末尾块 m=0
	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/**
 * 按 ID 删除一张 Kitty 图片。
 * 使用大写 'I' 同时释放图片数据。
 */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/**
 * 删除所有可见的 Kitty 图片。
 * 使用大写 'A' 同时释放图片数据。
 */
export function deleteAllKittyImages(): string {
	return "\x1b_Ga=d,d=A,q=2\x1b\\";
}

/** 删除所有可见的 Kitty 图片放置（placement），但保留已上传的图片数据。 */
export function deleteAllKittyPlacements(): string {
	return "\x1b_Ga=d,d=a,q=2\x1b\\";
}

/** 把 base64 编码的图片数据编码为 iTerm2 内联图片序列。 */
export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [
		`inline=${options.inline !== false ? 1 : 0}`,
		`size=${Buffer.byteLength(base64Data, "base64")}`,
	];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toString("base64");
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

/** 图片在终端中占用的单元格尺寸。 */
export interface ImageCellSize {
	columns: number;
	rows: number;
}

/** Kitty 图片的元数据：ID、占用单元格数与像素尺寸。 */
export interface KittyImageMetadata extends ImageCellSize {
	imageId: number;
	widthPx: number;
	heightPx: number;
}

/** 注册表中的 Kitty 图片元数据：额外记录传输代数。 */
interface RegisteredKittyImageMetadata extends KittyImageMetadata {
	transmissionGeneration: number;
}

/** Kitty 图片放置（placement）信息：用于把传输序列替换为仅放置命令。 */
export interface KittyImagePlacement {
	imageId: number;
	transmissionGeneration: number;
	transmissionBytes: number;
	estimatedDecodedBytes: number;
	sequence: string;
	replacementLine: string;
}

/** 已注册的 Kitty 图片元数据表：imageId -> 元数据。 */
const kittyImageMetadata = new Map<number, RegisteredKittyImageMetadata>();
/** 全局传输代数计数器，每次注册递增。 */
let kittyTransmissionGeneration = 0;

/** 注册一张 Kitty 图片的元数据；超过 1000 条时淘汰最旧的记录。 */
export function registerKittyImageMetadata(metadata: KittyImageMetadata): void {
	kittyTransmissionGeneration += 1;
	kittyImageMetadata.delete(metadata.imageId);
	kittyImageMetadata.set(metadata.imageId, { ...metadata, transmissionGeneration: kittyTransmissionGeneration });
	if (kittyImageMetadata.size > 1000) {
		const oldestImageId = kittyImageMetadata.keys().next().value;
		if (oldestImageId !== undefined) kittyImageMetadata.delete(oldestImageId);
	}
}

/** 从一行 Kitty 序列中提取已注册的图片元数据。 */
function getRegisteredKittyImageMetadata(line: string): RegisteredKittyImageMetadata | undefined {
	const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
	if (!controls) return undefined;
	const imageId = /(?:^|,)i=(\d+)(?:,|$)/.exec(controls)?.[1];
	return imageId === undefined ? undefined : kittyImageMetadata.get(Number.parseInt(imageId, 10));
}

/** 获取一行 Kitty 序列中图片的公开元数据（不含传输代数）。 */
export function getKittyImageMetadata(line: string): KittyImageMetadata | undefined {
	const metadata = getRegisteredKittyImageMetadata(line);
	if (!metadata) return undefined;
	return {
		imageId: metadata.imageId,
		columns: metadata.columns,
		rows: metadata.rows,
		widthPx: metadata.widthPx,
		heightPx: metadata.heightPx,
	};
}

/** 放置命令允许携带的控制参数键（其余控制参数会被剥离）。 */
const KITTY_PLACEMENT_CONTROL_KEYS = new Set([
	"i",
	"p",
	"x",
	"y",
	"w",
	"h",
	"X",
	"Y",
	"c",
	"r",
	"C",
	"U",
	"z",
	"P",
	"Q",
	"H",
	"V",
]);

/** 为 {@link renderImage} 生成的图片行构建仅放置（placement）命令。 */
export function getKittyImagePlacement(line: string): KittyImagePlacement | undefined {
	const match = /\x1b_G([^;]*);/.exec(line);
	const metadata = getRegisteredKittyImageMetadata(line);
	if (!match || !metadata) return undefined;

	// 跳过分块传输的中间块，定位到完整传输结束位置
	let commandStart = match.index;
	let commandControls = match[1];
	let transmissionEnd: number;
	while (true) {
		const terminator = line.indexOf("\x1b\\", commandStart + KITTY_PREFIX.length);
		if (terminator === -1) return undefined;
		transmissionEnd = terminator + 2;
		if (!/(?:^|,)m=1(?:,|$)/.test(commandControls)) break;
		commandStart = transmissionEnd;
		if (!line.startsWith(KITTY_PREFIX, commandStart)) return undefined;
		const controlsEnd = line.indexOf(";", commandStart + KITTY_PREFIX.length);
		if (controlsEnd === -1) return undefined;
		commandControls = line.slice(commandStart + KITTY_PREFIX.length, controlsEnd);
	}

	const controls = match[1]
		.split(",")
		.filter((control) => KITTY_PLACEMENT_CONTROL_KEYS.has(control.split("=", 1)[0] ?? ""));
	const sequence = `\x1b_Ga=p,q=2,${controls.join(",")}\x1b\\`;
	return {
		imageId: metadata.imageId,
		transmissionGeneration: metadata.transmissionGeneration,
		transmissionBytes: transmissionEnd - match.index,
		estimatedDecodedBytes: metadata.widthPx * metadata.heightPx * 4,
		sequence,
		replacementLine: `${line.slice(0, match.index)}${sequence}${line.slice(transmissionEnd)}`,
	};
}

/**
 * 裁剪一张 Kitty 图片行：只显示指定范围内的行。
 * 通过调整 y/h/r 控制参数实现源图像区域的裁剪。
 */
export function cropKittyImageLine(line: string, hiddenRows: number, visibleRows: number): string {
	const metadata = getKittyImageMetadata(line);
	const match = /\x1b_G([^;]*);/.exec(line);
	if (!metadata || !match || hiddenRows < 0 || hiddenRows >= metadata.rows || visibleRows <= 0) return line;
	const croppedRows = Math.min(visibleRows, metadata.rows - hiddenRows);
	if (hiddenRows === 0 && croppedRows === metadata.rows) return line;
	const sourceY = Math.floor((metadata.heightPx * hiddenRows) / metadata.rows);
	const sourceEnd = Math.ceil((metadata.heightPx * (hiddenRows + croppedRows)) / metadata.rows);
	const sourceHeight = Math.max(1, Math.min(metadata.heightPx, sourceEnd) - sourceY);
	const controls = match[1].split(",").filter((control) => !/^[yhr]=/.test(control));
	controls.push(`y=${sourceY}`, `h=${sourceHeight}`, `r=${croppedRows}`);
	return `${line.slice(0, match.index)}\x1b_G${controls.join(",")};${line.slice(match.index + match[0].length)}`;
}

/**
 * 根据图片尺寸、单元格尺寸和最大占用单元格数，计算图片应占用的单元格大小。
 * 在不超过宽度/高度限制的前提下尽量保持宽高比。
 */
export function calculateImageCellSize(
	imageDimensions: ImageDimensions,
	maxWidthCells: number,
	maxHeightCells?: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): ImageCellSize {
	const maxWidth = Math.max(1, Math.floor(maxWidthCells));
	const maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells));
	const imageWidth = Math.max(1, imageDimensions.widthPx);
	const imageHeight = Math.max(1, imageDimensions.heightPx);

	const widthScale = (maxWidth * cellDimensions.widthPx) / imageWidth;
	const heightScale = maxHeight === undefined ? widthScale : (maxHeight * cellDimensions.heightPx) / imageHeight;
	const scale = Math.min(widthScale, heightScale);

	const scaledWidthPx = imageWidth * scale;
	const scaledHeightPx = imageHeight * scale;
	const columns = Math.ceil(scaledWidthPx / cellDimensions.widthPx);
	const rows = Math.ceil(scaledHeightPx / cellDimensions.heightPx);

	return {
		columns: Math.max(1, Math.min(maxWidth, columns)),
		rows: Math.max(1, maxHeight === undefined ? rows : Math.min(maxHeight, rows)),
	};
}

/** 计算图片在指定目标宽度下所占的行数（保持宽高比）。 */
export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	return calculateImageCellSize(imageDimensions, targetWidthCells, undefined, cellDimensions).rows;
}

/** 解析 base64 PNG 数据的像素尺寸（从 PNG 头读取）。 */
export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 24) {
			return null;
		}

		// 校验 PNG 魔数
		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

/** 解析 base64 JPEG 数据的像素尺寸（遍历标记段找 SOF 帧）。 */
export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 2) {
			return null;
		}

		// 校验 JPEG 魔数
		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			// SOF0/SOF1/SOF2 帧头包含宽高
			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

/** 解析 base64 GIF 数据的像素尺寸（从逻辑屏幕描述符读取）。 */
export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

/** 解析 base64 WebP 数据的像素尺寸（支持 VP8、VP8L 和 VP8X 三种块格式）。 */
export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

/** 根据 MIME 类型解析对应图片格式的像素尺寸；不支持的类型返回 null。 */
export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

/**
 * 按终端能力渲染一张图片：返回图片转义序列和占用的单元格尺寸。
 * 终端不支持图片时返回 null（调用方可回退到文本显示）。
 */
export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence: string; columns: number; rows: number; imageId?: number } | null {
	const caps = getCapabilities();

	if (!caps.images) {
		return null;
	}

	const maxWidth = options.maxWidthCells ?? 80;
	const size = calculateImageCellSize(imageDimensions, maxWidth, options.maxHeightCells, getCellDimensions());

	if (caps.images === "kitty") {
		if (options.imageId !== undefined) {
			registerKittyImageMetadata({
				imageId: options.imageId,
				columns: size.columns,
				rows: size.rows,
				widthPx: imageDimensions.widthPx,
				heightPx: imageDimensions.heightPx,
			});
		}
		const sequence = encodeKitty(base64Data, {
			columns: size.columns,
			rows: size.rows,
			imageId: options.imageId,
			moveCursor: options.moveCursor,
		});
		return { sequence, columns: size.columns, rows: size.rows, imageId: options.imageId };
	}

	if (caps.images === "iterm2") {
		const sequence = encodeITerm2(base64Data, {
			width: size.columns,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, columns: size.columns, rows: size.rows };
	}

	return null;
}

/**
 * 用 OSC 8 超链接序列包裹文本。
 * 在支持 OSC 8 的终端（Ghostty、Kitty、WezTerm、iTerm2、VSCode 等）中，
 * 文本会被渲染为可点击的超链接；不支持的终端会忽略转义序列，
 * 仅显示纯文本。
 *
 * @param text - 要显示的可见文本
 * @param url - 链接到的 URL
 */
export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** 把以 home 开头的绝对路径缩短为 ~/... 以紧凑显示。 */
function shortenImagePath(filename: string): string {
	const home = homedir();
	if (home && (filename === home || filename.startsWith(`${home}/`) || filename.startsWith(`${home}\\`))) {
		return `~${filename.slice(home.length)}`;
	}
	return filename;
}

/**
 * 终端无法渲染内联图片时的文本回退显示。
 * 绝对路径会缩短为 ~/...，且在支持 OSC 8 超链接时链接到 file://，
 * 保证完整路径仍可打开。
 */
export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) {
		const display = shortenImagePath(filename);
		if (getCapabilities().hyperlinks && isAbsolute(filename)) {
			parts.push(hyperlink(display, pathToFileURL(filename).href));
		} else {
			parts.push(display);
		}
	}
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}

import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type EditorTheme,
	getCapabilities,
	type MarkdownTheme,
	type RgbColor,
	type SelectListTheme,
	type SettingsListTheme,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { getCustomThemesDir, getThemesDir } from "../../../config.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { closeWatcher, watchWithErrorHandler } from "../../../utils/fs-watch.ts";
import { highlight, supportsLanguage } from "../../../utils/syntax-highlight.ts";
import { stripBom } from "../../../utils/text.ts";

// ============================================================================
// 类型与 Schema
// ============================================================================

/** 主题颜色值的 Schema：可以是十六进制、变量引用（如 "primary"）或空字符串，也可以是 0-255 的 256 色索引。 */
const ColorValueSchema = Type.Union([
	Type.String(), // 十六进制 "#ff0000"、变量引用 "primary" 或空字符串 ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256 色索引
]);

/** 解析后的颜色值类型。 */
type ColorValue = Static<typeof ColorValueSchema>;

/** 主题 JSON 文件的完整 Schema：定义所有必需/可选的颜色令牌。 */
const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// 核心 UI（10 色）
		accent: ColorValueSchema,
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		thinkingText: ColorValueSchema,
		// Backgrounds & Content Text (11 required, 3 optional)
		selectedBg: ColorValueSchema,
		scrollbarThumb: Type.Optional(ColorValueSchema),
		searchMatchBg: Type.Optional(ColorValueSchema),
		searchMatchText: Type.Optional(ColorValueSchema),
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		customMessageBg: ColorValueSchema,
		customMessageText: ColorValueSchema,
		customMessageLabel: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown（10 色）
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// 工具 Diff（3 色）
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// 语法高亮（9 色）
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// 思考级别边框（6 色）
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
		thinkingXhigh: ColorValueSchema,
		thinkingMax: Type.Optional(ColorValueSchema),
		// Bash 模式（1 色）
		bashMode: ColorValueSchema,
	}),
	export: Type.Optional(
		Type.Object({
			pageBg: Type.Optional(ColorValueSchema),
			cardBg: Type.Optional(ColorValueSchema),
			infoBg: Type.Optional(ColorValueSchema),
		}),
	),
});

/** 解析后的主题 JSON 类型。 */
type ThemeJson = Static<typeof ThemeJsonSchema>;

/** 编译后的主题 JSON 校验器。 */
const validateThemeJson = Compile(ThemeJsonSchema);

/** 主题中可用的前景色令牌名称。 */
export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "searchMatchText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax"
	| "bashMode";

/** 主题中可用的背景色令牌名称。 */
export type ThemeBg =
	| "selectedBg"
	| "scrollbarThumb"
	| "searchMatchBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

type OptionalThemeColor = "thinkingMax" | "searchMatchText";
type OptionalThemeBg = "scrollbarThumb" | "searchMatchBg";

type ColorMode = "truecolor" | "256color";

// ============================================================================
// 颜色工具函数
// ============================================================================

/** 把十六进制颜色字符串解析为 RGB 分量。 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

// 6x6x6 颜色立方体的通道值（索引 0-5）
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

// 灰度渐变值（索引 232-255，从 8 到 238 共 24 级灰度）
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

/** 在颜色立方体值中查找与给定值最接近的索引。 */
function findClosestCubeIndex(value: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - CUBE_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

/** 在灰度渐变值中查找与给定灰度最接近的索引。 */
function findClosestGrayIndex(gray: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - GRAY_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

/** 计算两个 RGB 颜色之间的加权欧氏距离（人眼对绿色更敏感）。 */
function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

/** 把 RGB 颜色映射到最接近的 256 色索引（颜色立方体或灰度）。 */
function rgbTo256(r: number, g: number, b: number): number {
	// 在 6x6x6 立方体中查找最接近的颜色
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	const cubeR = CUBE_VALUES[rIdx];
	const cubeG = CUBE_VALUES[gIdx];
	const cubeB = CUBE_VALUES[bIdx];
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

	// 查找最接近的灰度
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx];
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

	// 检查颜色是否有明显饱和度（色相是否重要）
	// 若最大最小通道差值较大，优先用立方体以保留色调
	const maxC = Math.max(r, g, b);
	const minC = Math.min(r, g, b);
	const spread = maxC - minC;

	// 仅当颜色接近中性（spread < 10）且灰度确实更接近时才用灰度
	if (spread < 10 && grayDist < cubeDist) {
		return grayIndex;
	}

	return cubeIndex;
}

/** 把十六进制颜色转换为 256 色索引。 */
function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

/** 生成前景色 ANSI 转义序列；空串表示使用默认前景色。 */
function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[38;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

/** 生成背景色 ANSI 转义序列；空串表示使用默认背景色。 */
function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[48;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[48;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

/** 解析颜色值中的变量引用（递归展开，检测循环引用与缺失变量）。 */
function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

/** 解析一组颜色对象中的所有变量引用。 */
function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

function withThemeColorFallbacks(colors: ThemeJson["colors"]): ThemeJson["colors"] & {
	thinkingMax: ColorValue;
	scrollbarThumb: ColorValue;
	searchMatchBg: ColorValue;
	searchMatchText: ColorValue;
} {
	return {
		...colors,
		thinkingMax: colors.thinkingMax ?? colors.thinkingXhigh,
		scrollbarThumb: colors.scrollbarThumb ?? colors.selectedBg,
		searchMatchBg: colors.searchMatchBg ?? colors.selectedBg,
		searchMatchText: colors.searchMatchText ?? colors.text,
	};
}

// ============================================================================
// Theme 类
// ============================================================================

/** 主题对象：把颜色令牌预编译为 ANSI 转义序列，并提供着色辅助方法。 */
export class Theme {
	/** 主题名称（可选）。 */
	readonly name?: string;
	/** 主题来源文件路径（可选）。 */
	readonly sourcePath?: string;
	/** 主题来源信息（用于调试/展示）。 */
	sourceInfo?: SourceInfo;
	/** 前景色令牌 -> ANSI 序列 的映射表。 */
	private fgColors: Map<ThemeColor, string>;
	/** 背景色令牌 -> ANSI 序列 的映射表。 */
	private bgColors: Map<ThemeBg, string>;
	/** 当前颜色输出模式。 */
	private mode: ColorMode;

	/**
	 * 构造主题实例，把颜色值按模式预编译为 ANSI 序列。
	 * @param fgColors - 前景色令牌表
	 * @param bgColors - 背景色令牌表（scrollbarThumb 可选）
	 * @param mode - 颜色模式（truecolor 或 256color）
	 * @param options - 名称、来源路径与来源信息等元数据
	 */
	constructor(
		fgColors: Record<Exclude<ThemeColor, OptionalThemeColor>, string | number> &
			Partial<Record<OptionalThemeColor, string | number>>,
		bgColors: Record<Exclude<ThemeBg, OptionalThemeBg>, string | number> &
			Partial<Record<OptionalThemeBg, string | number>>,
		mode: ColorMode,
		options: { name?: string; sourcePath?: string; sourceInfo?: SourceInfo } = {},
	) {
		this.name = options.name;
		this.sourcePath = options.sourcePath;
		this.sourceInfo = options.sourceInfo;
		this.mode = mode;
		this.fgColors = new Map();
		const colors = {
			...fgColors,
			thinkingMax: fgColors.thinkingMax ?? fgColors.thinkingXhigh,
			searchMatchText: fgColors.searchMatchText ?? fgColors.text,
		};
		for (const [key, value] of Object.entries(colors) as [ThemeColor, string | number][]) {
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		this.bgColors = new Map();
		const backgrounds = {
			...bgColors,
			scrollbarThumb: bgColors.scrollbarThumb ?? bgColors.selectedBg,
			searchMatchBg: bgColors.searchMatchBg ?? bgColors.selectedBg,
		};
		for (const [key, value] of Object.entries(backgrounds) as [ThemeBg, string | number][]) {
			this.bgColors.set(key, bgAnsi(value, mode));
		}
	}

	/** 用指定的前景色令牌给文本着色。 */
	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // 只重置前景色
	}

	/** 用指定的背景色令牌给文本着色。 */
	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // 只重置背景色
	}

	/** 加粗文本。 */
	bold(text: string): string {
		return chalk.bold(text);
	}

	/** 斜体文本。 */
	italic(text: string): string {
		return chalk.italic(text);
	}

	/** 下划线文本。 */
	underline(text: string): string {
		return chalk.underline(text);
	}

	/** 反色（反转）文本。 */
	inverse(text: string): string {
		return chalk.inverse(text);
	}

	/** 删除线文本。 */
	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	/** 获取前景色令牌对应的 ANSI 序列。 */
	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	/** 获取背景色令牌对应的 ANSI 序列。 */
	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	/** 获取当前颜色输出模式。 */
	getColorMode(): ColorMode {
		return this.mode;
	}

	/** 根据思考级别返回对应的边框着色函数。 */
	getThinkingBorderColor(level: ThinkingLevel): (str: string) => string {
		// 把思考级别映射到专门的边框颜色
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			case "max":
				return (str: string) => this.fg("thinkingMax", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	/** 返回 Bash 模式边框的着色函数。 */
	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}
}

// ============================================================================
// 主题加载
// ============================================================================

/** 内置主题的缓存（dark / light）。 */
let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

/** 读取并缓存内置主题（dark.json 与 light.json）。 */
function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const themesDir = getThemesDir();
		const darkPath = path.join(themesDir, "dark.json");
		const lightPath = path.join(themesDir, "light.json");
		BUILTIN_THEMES = {
			dark: JSON.parse(stripBom(fs.readFileSync(darkPath, "utf-8"))) as ThemeJson,
			light: JSON.parse(stripBom(fs.readFileSync(lightPath, "utf-8"))) as ThemeJson,
		};
	}
	return BUILTIN_THEMES;
}

/** 获取所有可用主题的名称列表。 */
export function getAvailableThemes(): string[] {
	return getAvailableThemesWithPaths().map(({ name }) => name);
}

/** 主题信息：名称与来源路径。 */
export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

/** 获取所有可用主题的名称与路径（内置 + 自定义 + 已注册），按名称排序。 */
export function getAvailableThemesWithPaths(): ThemeInfo[] {
	const themesDir = getThemesDir();
	const result: ThemeInfo[] = [];
	const seen = new Set<string>();
	const addTheme = (themeInfo: ThemeInfo) => {
		if (seen.has(themeInfo.name)) {
			return;
		}
		seen.add(themeInfo.name);
		result.push(themeInfo);
	};

	// 内置主题
	for (const name of Object.keys(getBuiltinThemes())) {
		addTheme({ name, path: path.join(themesDir, `${name}.json`) });
	}

	// 自定义主题
	for (const themeInfo of getCustomThemeInfos()) {
		addTheme(themeInfo);
	}

	for (const [name, theme] of registeredThemes.entries()) {
		addTheme({ name, path: theme.sourcePath });
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** 扫描自定义主题目录，返回可加载的 JSON 主题信息。 */
function getCustomThemeInfos(): ThemeInfo[] {
	const customThemesDir = getCustomThemesDir();
	const result: ThemeInfo[] = [];
	if (!fs.existsSync(customThemesDir)) {
		return result;
	}

	for (const file of fs.readdirSync(customThemesDir)) {
		if (!file.endsWith(".json")) {
			continue;
		}
		const themePath = path.join(customThemesDir, file);
		try {
			const customTheme = loadThemeFromPath(themePath);
			if (customTheme.name) {
				result.push({ name: customTheme.name, path: themePath });
			}
		} catch {
			// 无效主题在此忽略；资源加载器会在正常启动/重载时报错
		}
	}
	return result;
}

/** 校验主题名：不允许包含 "/"，因为该字符保留给自动亮/暗主题设置使用。 */
function assertThemeNameIsValid(name: string): void {
	if (name.includes("/")) {
		throw new Error(
			`Invalid theme name "${name}": theme names cannot contain "/" because it is reserved for automatic light/dark theme settings.`,
		);
	}
}

/** 校验并解析主题 JSON 对象；失败时给出友好的缺失颜色令牌与其它错误提示。 */
function parseThemeJson(label: string, json: unknown): ThemeJson {
	if (!validateThemeJson.Check(json)) {
		const errors = Array.from(validateThemeJson.Errors(json));
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.size > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	const themeJson = json as ThemeJson;
	assertThemeNameIsValid(themeJson.name);
	return themeJson;
}

/** 解析主题 JSON 字符串内容。 */
function parseThemeJsonContent(label: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(stripBom(content));
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	return parseThemeJson(label, json);
}

/** 按名称加载主题 JSON：优先内置主题，其次是已注册主题，最后是自定义目录。 */
function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme?.sourcePath) {
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	return parseThemeJsonContent(name, content);
}

/** 根据主题 JSON 创建一个 Theme 实例，把颜色按前景/背景分组。 */
function createTheme(themeJson: ThemeJson, mode?: ColorMode, sourcePath?: string): Theme {
	const colorMode = mode ?? (getCapabilities().trueColor ? "truecolor" : "256color");
	const resolvedColors = resolveThemeColors(withThemeColorFallbacks(themeJson.colors), themeJson.vars);
	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	const bgColorKeys: Set<string> = new Set([
		"selectedBg",
		"scrollbarThumb",
		"searchMatchBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return new Theme(fgColors, bgColors, colorMode, {
		name: themeJson.name,
		sourcePath,
	});
}

/** 从文件路径加载主题。 */
export function loadThemeFromPath(themePath: string, mode?: ColorMode): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	const themeJson = parseThemeJsonContent(themePath, content);
	return createTheme(themeJson, mode, themePath);
}

/** 按名称加载主题；已注册的主题直接复用实例。 */
function loadTheme(name: string, mode?: ColorMode): Theme {
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme) {
		return registeredTheme;
	}
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

/** 按名称获取主题；未找到时返回 undefined。 */
export function getThemeByName(name: string): Theme | undefined {
	try {
		return loadTheme(name);
	} catch {
		return undefined;
	}
}

/** 终端的明暗主题。 */
export type TerminalTheme = "dark" | "light";

/** 解析自动主题设置（格式 "lightTheme/darkTheme"）；格式非法时返回 undefined。 */
export function parseAutoThemeSetting(
	themeSetting: string | undefined,
): { lightTheme: string; darkTheme: string } | undefined {
	if (!themeSetting) return undefined;
	const slashIndex = themeSetting.indexOf("/");
	if (slashIndex === -1 || themeSetting.indexOf("/", slashIndex + 1) !== -1) {
		return undefined;
	}

	const lightTheme = themeSetting.slice(0, slashIndex).trim();
	const darkTheme = themeSetting.slice(slashIndex + 1).trim();
	if (!lightTheme || !darkTheme) {
		return undefined;
	}
	return { lightTheme, darkTheme };
}

/** 根据终端明暗主题解析最终要使用的主题名。 */
export function resolveThemeSetting(
	themeSetting: string | undefined,
	terminalTheme: TerminalTheme,
): string | undefined {
	const autoTheme = parseAutoThemeSetting(themeSetting);
	if (autoTheme) {
		return terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme;
	}
	if (themeSetting?.includes("/")) return undefined;
	if (typeof themeSetting === "string") return themeSetting;
	return undefined;
}

/** 终端明暗主题的检测结果：包含来源与置信度。 */
export interface TerminalThemeDetection {
	theme: TerminalTheme;
	source: "terminal background" | "COLORFGBG" | "fallback";
	detail: string;
	confidence: "high" | "low";
}

/** 终端主题检测选项（可注入环境变量用于测试）。 */
export interface TerminalThemeDetectionOptions {
	env?: NodeJS.ProcessEnv;
}

/** 能查询终端背景色的 UI 接口。 */
export interface TerminalBackgroundThemeDetector {
	queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined>;
}

/** 支持查询终端配色方案的 UI 接口（额外支持 DSR 配色方案上报）。 */
export interface TerminalAutoThemeDetector extends TerminalBackgroundThemeDetector {
	queryTerminalColorScheme?({ timeoutMs }: { timeoutMs: number }): Promise<TerminalTheme | undefined>;
}

/** 背景色主题检测的完整选项。 */
export interface TerminalBackgroundThemeDetectionOptions extends TerminalThemeDetectionOptions {
	ui: TerminalBackgroundThemeDetector;
	timeoutMs: number;
}

/** 自动主题检测的完整选项。 */
export interface TerminalAutoThemeDetectionOptions extends TerminalThemeDetectionOptions {
	ui: TerminalAutoThemeDetector;
	timeoutMs: number;
}

/** 从 COLORFGBG 环境变量中提取背景色索引（从后往前找合法的 0-255 数值）。 */
function getColorFgBgBackgroundIndex(colorfgbg: string): number | undefined {
	const parts = colorfgbg.split(";");
	for (let i = parts.length - 1; i >= 0; i--) {
		const bg = parseInt(parts[i].trim(), 10);
		if (Number.isInteger(bg) && bg >= 0 && bg <= 255) {
			return bg;
		}
	}
	return undefined;
}

/** 计算 RGB 颜色的相对亮度（sRGB 线性化后的加权和）。 */
function getRgbColorLuminance({ r, g, b }: RgbColor): number {
	const toLinear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** 计算 256 色索引颜色的相对亮度。 */
function getAnsiColorLuminance(index: number): number {
	return getRgbColorLuminance(hexToRgb(ansi256ToHex(index)));
}

/** 根据 RGB 颜色亮度判断终端明暗主题（亮度 >= 0.5 视为浅色）。 */
export function getThemeForRgbColor(rgb: RgbColor): TerminalTheme {
	return getRgbColorLuminance(rgb) >= 0.5 ? "light" : "dark";
}

/** 仅从环境变量（COLORFGBG）检测终端明暗主题；无提示时回退为 dark。 */
export function detectTerminalBackgroundFromEnv(options: TerminalThemeDetectionOptions = {}): TerminalThemeDetection {
	const env = options.env ?? process.env;
	const colorfgbg = env.COLORFGBG || "";
	const bg = getColorFgBgBackgroundIndex(colorfgbg);
	if (bg !== undefined) {
		return {
			theme: getAnsiColorLuminance(bg) >= 0.5 ? "light" : "dark",
			source: "COLORFGBG",
			detail: `background color index ${bg}`,
			confidence: "high",
		};
	}

	return {
		theme: "dark",
		source: "fallback",
		detail: "no terminal background hint found",
		confidence: "low",
	};
}

/** 通过 OSC 11 查询终端背景色来检测明暗主题；失败时回退到环境变量检测。 */
export async function detectTerminalBackgroundTheme({
	ui,
	timeoutMs,
	env,
}: TerminalBackgroundThemeDetectionOptions): Promise<TerminalThemeDetection> {
	try {
		const rgb = await ui.queryTerminalBackgroundColor({ timeoutMs });
		if (rgb) {
			return {
				theme: getThemeForRgbColor(rgb),
				source: "terminal background",
				detail: `OSC 11 background rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
				confidence: "high",
			};
		}
	} catch {
		// 终端查询失败时回退到基于环境变量的检测
	}

	return detectTerminalBackgroundFromEnv({ env });
}

/** 为自动主题检测明暗主题：优先用 DSR 配色方案上报，否则回退到背景色检测。 */
export async function detectTerminalThemeForAuto({
	ui,
	timeoutMs,
	env,
}: TerminalAutoThemeDetectionOptions): Promise<TerminalTheme> {
	let colorSchemePromise: Promise<TerminalTheme | undefined> | undefined;
	try {
		colorSchemePromise = ui.queryTerminalColorScheme?.({ timeoutMs });
	} catch {
		// Fall back to OSC 11 / COLORFGBG detection when starting the color-scheme query fails.
	}
	const backgroundThemePromise = detectTerminalBackgroundTheme({ ui, timeoutMs, env });

	try {
		const colorScheme = await colorSchemePromise;
		if (colorScheme) return colorScheme;
	} catch {
		// Fall back to the concurrently queried OSC 11 / COLORFGBG detection.
	}
	return (await backgroundThemePromise).theme;
}

/** 获取默认主题名（根据环境变量检测的终端明暗主题）。 */
export function getDefaultTheme(): string {
	return detectTerminalBackgroundFromEnv().theme;
}

// ============================================================================
// 全局主题实例
// ============================================================================

// 使用 globalThis 在模块加载器之间共享主题（开发模式下 tsx 与 jiti 各自加载模块）
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

// 把主题导出为从 globalThis 读取的 getter，
// 确保所有模块实例（tsx、jiti）看到同一个主题
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

/** 把主题实例写入 globalThis（新旧两个 key 都写，兼容旧引用）。 */
function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
	(globalThis as Record<symbol, Theme>)[THEME_KEY_OLD] = t;
}

/** 当前激活的主题名。 */
let currentThemeName: string | undefined;
/** 主题文件监视器（仅对自定义主题生效）。 */
let themeWatcher: fs.FSWatcher | undefined;
/** 主题重载的防抖定时器。 */
let themeReloadTimer: NodeJS.Timeout | undefined;
/** 主题变化时的回调（用于让 UI 失效重绘）。 */
let onThemeChangeCallback: (() => void) | undefined;
/** 已注册的主题表：名称 -> 主题实例。 */
const registeredThemes = new Map<string, Theme>();

/** 批量注册主题实例，清空旧注册表。 */
export function setRegisteredThemes(themes: Theme[]): void {
	registeredThemes.clear();
	for (const theme of themes) {
		if (theme.name) {
			assertThemeNameIsValid(theme.name);
			registeredThemes.set(theme.name, theme);
		}
	}
}

/** 初始化主题：按名称加载并设为全局主题；加载失败时静默回退到 dark。 */
export function initTheme(themeName?: string, enableWatcher: boolean = false): void {
	const name = themeName ?? getDefaultTheme();
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
	} catch (_error) {
		// 主题无效——静默回退到 dark 主题
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// 回退主题不启动监视器
	}
}

/** 切换主题：成功返回 { success: true }，失败回退到 dark 并返回错误信息。 */
export function setTheme(name: string, enableWatcher: boolean = false): { success: boolean; error?: string } {
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		// 主题无效——回退到 dark 主题
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// 回退主题不启动监视器
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** 直接设置一个主题实例为全局主题（内存中的实例，不参与文件监视）。 */
export function setThemeInstance(themeInstance: Theme): void {
	setGlobalTheme(themeInstance);
	currentThemeName = "<in-memory>";
	stopThemeWatcher(); // 无法监视一个直接传入的实例
	if (onThemeChangeCallback) {
		onThemeChangeCallback();
	}
}

/** 注册主题变化回调。 */
export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

/** 启动对当前自定义主题文件的监视，文件变更后防抖重载。 */
function startThemeWatcher(): void {
	stopThemeWatcher();

	// 仅监视自定义主题（内置主题不监视）
	if (!currentThemeName || currentThemeName === "dark" || currentThemeName === "light") {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// 仅当文件存在时才监视
	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// 切换主题或停止监视后忽略过期的定时器
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// 若文件暂时缺失，保留最后成功加载的主题
			if (!fs.existsSync(themeFile)) {
				return;
			}

			try {
				// 从磁盘重新加载主题并刷新注册表缓存
				const reloadedTheme = loadThemeFromPath(themeFile);
				registeredThemes.set(watchedThemeName, reloadedTheme);
				setGlobalTheme(reloadedTheme);
				// 通知回调（使 UI 失效）
				if (onThemeChangeCallback) {
					onThemeChangeCallback();
				}
			} catch (_error) {
				// 忽略错误（文件可能正处于编辑中的无效状态）
			}
		}, 100);
	};

	themeWatcher =
		watchWithErrorHandler(
			customThemesDir,
			(_eventType, filename) => {
				if (currentThemeName !== watchedThemeName) {
					return;
				}
				if (!filename) {
					scheduleReload();
					return;
				}
				if (filename !== watchedFileName) {
					return;
				}
				scheduleReload();
			},
			() => {
				closeWatcher(themeWatcher);
				themeWatcher = undefined;
			},
		) ?? undefined;
}

/** 停止主题文件监视并清理重载定时器。 */
export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	closeWatcher(themeWatcher);
	themeWatcher = undefined;
}

// ============================================================================
// HTML 导出辅助
// ============================================================================

/**
 * 把 256 色索引转换为十六进制字符串。
 * 索引 0-15：基础色（近似值）
 * 索引 16-231：6x6x6 颜色立方体
 * 索引 232-255：灰度渐变
 */
function ansi256ToHex(index: number): string {
	// 基础色（0-15）——近似常见终端取值
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// 颜色立方体（16-231）：6x6x6 = 216 色
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// 灰度（232-255）：24 级灰度
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * 获取解析后的主题颜色，作为 CSS 兼容的十六进制字符串。
 * 供 HTML 导出生成 CSS 自定义属性使用。
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	const isLight = name === "light";
	const themeJson = loadThemeJson(name);
	const resolved = resolveThemeColors(withThemeColorFallbacks(themeJson.colors), themeJson.vars);

	// 空值时的默认文本色（终端使用默认前景色）
	const defaultText = isLight ? "#000000" : "#e5e5e7";

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// 空表示默认终端颜色——为 HTML 使用合理的回退值
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * 判断主题是否为浅色主题（用于需要明暗变体的 CSS）。
 */
export function isLightTheme(themeName?: string): boolean {
	// 目前仅检查名称——将来可扩展为分析颜色
	return themeName === "light";
}

/**
 * 获取主题 JSON 中显式声明的导出颜色（若指定）。
 * 未显式设置的每个颜色返回 undefined。
 */
export function getThemeExportColors(themeName?: string): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	try {
		const themeJson = loadThemeJson(name);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		const resolve = (value: ColorValue | undefined): string | undefined => {
			if (value === undefined) return undefined;
			const resolved = resolveVarRefs(value, vars);
			if (typeof resolved === "number") return ansi256ToHex(resolved);
			if (resolved === "") return undefined;
			return resolved;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}

// ============================================================================
// TUI 辅助
// ============================================================================

/** cli-highlight 的主题映射类型：语法 token 名 -> 着色函数。 */
type CliHighlightTheme = Record<string, (s: string) => string>;

/** 缓存的高亮主题对应的 Theme 实例。 */
let cachedHighlightThemeFor: Theme | undefined;
/** 缓存的 cli-highlight 主题。 */
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

/** 根据 Theme 构建 cli-highlight 使用的语法着色主题映射。 */
function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		regexp: (s: string) => t.fg("syntaxString", s),
		string: (s: string) => t.fg("syntaxString", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		doctag: (s: string) => t.fg("syntaxComment", s),
		meta: (s: string) => t.fg("muted", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		tag: (s: string) => t.fg("syntaxPunctuation", s),
		name: (s: string) => t.fg("syntaxKeyword", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
		emphasis: (s: string) => t.italic(s),
		strong: (s: string) => t.bold(s),
		link: (s: string) => t.underline(s),
		addition: (s: string) => t.fg("toolDiffAdded", s),
		deletion: (s: string) => t.fg("toolDiffRemoved", s),
	};
}

/** 获取缓存的 cli-highlight 主题（按 Theme 实例缓存）。 */
function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/**
 * 根据文件扩展名或语言做语法高亮。
 * 返回高亮后的行数组。
 */
export function highlightCode(code: string, lang?: string): string[] {
	// 高亮前先校验语言，避免 cli-highlight 向 stderr 打印噪音
	const validLang = lang && supportsLanguage(lang) ? lang : undefined;
	// 未指定有效语言时跳过高亮。cli-highlight 的自动检测不可靠，
	// 可能把普通文字误判为 AppleScript、LiveCodeServer 等，随机给英文单词上色。
	if (!validLang) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	};
	try {
		return highlight(code, opts).split("\n");
	} catch {
		return code.split("\n");
	}
}

/**
 * 根据文件路径扩展名获取语言标识符。
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

/** 构建 Markdown 渲染所用的主题回调集合。 */
export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => {
			// 高亮前先校验语言，避免 cli-highlight 向 stderr 打印噪音
			const validLang = lang && supportsLanguage(lang) ? lang : undefined;
			// 未指定有效语言时跳过高亮。cli-highlight 的自动检测不可靠，
			// 可能把普通文字误判为 AppleScript、LiveCodeServer 等，随机给英文单词上色。
			if (!validLang) {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
			const opts = {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(theme),
			};
			try {
				return highlight(code, opts).split("\n");
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

/** 构建选择列表（SelectList）所用的主题回调集合。 */
export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

/** 构建编辑器（Editor）所用的主题回调集合。 */
export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

/** 构建设置列表（SettingsList）所用的主题回调集合。 */
export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}

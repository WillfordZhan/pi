/**
 * 最小化 TUI 实现，采用差分渲染（只重绘发生变化的部分）。
 */

import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { isKeyRelease, matchesKey } from "./keys.ts";
import type { Terminal } from "./terminal.ts";
import {
	isOsc11BackgroundColorResponse,
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
} from "./terminal-colors.ts";
import { getCapabilities, isImageLine, setCellDimensions } from "./terminal-image.ts";
import { extractSegments, normalizeTerminalOutput, sliceByColumn, sliceWithWidth, visibleWidth } from "./utils.ts";

/**
 * 组件接口：所有可渲染到 TUI 的组件都必须实现该接口。
 */
export interface Component {
	/**
	 * 将组件渲染为指定视口宽度下的文本行。
	 * @param width - 当前视口宽度
	 * @returns 字符串数组，每个字符串代表一行
	 */
	render(width: number): string[];

	/**
	 * 可选：当组件获得焦点时处理键盘输入的回调。
	 */
	handleInput?(data: string): void;

	/**
	 * 若为 true，组件会接收按键释放事件（Kitty 协议）。
	 * 默认为 false——释放事件会被过滤掉。
	 */
	wantsKeyRelease?: boolean;

	/**
	 * 使缓存的渲染状态失效。
	 * 当主题变化或组件需要从头重新渲染时调用。
	 */
	invalidate(): void;
}

/**
 * 输入监听器的返回结果：`consume` 表示是否消费（拦截）该输入，`data` 为可选的重写数据。
 */
export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
/** 输入监听器：接收原始输入数据，可决定是否消费并返回重写后的数据。 */
export type TuiInputListener = (data: string) => TuiInputListenerResult;
/** 待处理的 OSC 11 背景色查询：记录是否已结算、完成回调和超时定时器。 */
type PendingOsc11BackgroundQuery = {
	settled: boolean;
	resolve: ((rgb: RgbColor | undefined) => void) | undefined;
	timer: NodeJS.Timeout | undefined;
};

/**
 * 可接收焦点并显示硬件光标的组件接口。
 * 组件获得焦点时，应在渲染输出的光标位置发射 CURSOR_MARKER；
 * TUI 会找到该标记并将硬件光标定位到此处，以便 IME 候选窗口正确放置。
 */
export interface Focusable {
	/** 由 TUI 在焦点变化时设置。为 true 时组件应发射 CURSOR_MARKER。 */
	focused: boolean;
}

/** 类型守卫：判断组件是否实现了 {@link Focusable} 接口。 */
export function isFocusable(component: Component | null): component is Component & Focusable {
	return component !== null && "focused" in component;
}

/**
 * 光标位置标记——APC（应用程序命令）序列。
 * 这是一个终端会忽略的零宽度转义序列。
 * 组件在获得焦点时于光标位置发射它；
 * TUI 找到并剥离该标记后，将硬件光标定位到此处。
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export { visibleWidth };

/**
 * Overlay（悬浮层）的锚点定位位置。
 */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/**
 * Overlay 的边距配置。
 */
export interface OverlayMargin {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

/** 尺寸值：可以是绝对数值，也可以是百分比字符串（如 "50%"）。 */
export type SizeValue = number | `${number}%`;

/** 根据参考尺寸把 {@link SizeValue} 解析为绝对值；无法解析时返回 undefined。 */
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	// 解析形如 "50%" 的百分比字符串
	const match = value.match(/^(\d+(?:\.\d+)?)%$/);
	if (match) {
		return Math.floor((referenceSize * parseFloat(match[1])) / 100);
	}
	return undefined;
}

/**
 * Overlay 的定位与尺寸选项。
 * 值可以是绝对数值，也可以是百分比字符串（如 "50%"）。
 */
export interface OverlayOptions {
	// === 尺寸 ===
	/** 宽度（列数），或占终端宽度的百分比（如 "50%"） */
	width?: SizeValue;
	/** 最小宽度（列数） */
	minWidth?: number;
	/** 最大高度（行数），或占终端高度的百分比（如 "50%"） */
	maxHeight?: SizeValue;

	// === 定位 —— 基于锚点 ===
	/** 定位锚点（默认：'center'） */
	anchor?: OverlayAnchor;
	/** 相对锚点的水平偏移（正数 = 向右） */
	offsetX?: number;
	/** 相对锚点的垂直偏移（正数 = 向下） */
	offsetY?: number;

	// === 定位 —— 百分比或绝对值 ===
	/** 行位置：绝对数值，或百分比（如 "25%" = 距顶部 25%） */
	row?: SizeValue;
	/** 列位置：绝对数值，或百分比（如 "50%" = 水平居中） */
	col?: SizeValue;

	// === 距终端边缘的边距 ===
	/** 距终端边缘的边距。单个数字应用于所有方向。 */
	margin?: OverlayMargin | number;

	// === 可见性 ===
	/**
	 * 根据终端尺寸控制 Overlay 的可见性。
	 * 若提供，仅当该函数返回 true 时 Overlay 才会被渲染。
	 * 每个渲染周期都会以当前终端尺寸调用它。
	 */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/** 若为 true，显示时不抢占键盘焦点 */
	nonCapturing?: boolean;
}

/** {@link OverlayHandle.unfocus} 的选项。 */
export interface OverlayUnfocusOptions {
	/** 释放该 Overlay 后要显式聚焦的目标组件。 */
	target: Component | null;
}

/**
 * 由 showOverlay 返回的 Overlay 控制句柄。
 */
export interface OverlayHandle {
	/** 永久移除该 Overlay（之后无法再显示） */
	hide(): void;
	/** 临时隐藏或显示该 Overlay */
	setHidden(hidden: boolean): void;
	/** 检查 Overlay 是否被临时隐藏 */
	isHidden(): boolean;
	/** 聚焦该 Overlay 并将其置于视觉最上层 */
	focus(): void;
	/** 释放焦点：交给下一个可见的捕获焦点 Overlay、之前的焦点目标，或在提供时交给显式目标 */
	unfocus(options?: OverlayUnfocusOptions): void;
	/** 检查该 Overlay 当前是否持有焦点 */
	isFocused(): boolean;
}

/** Overlay 栈中的一条记录：包含组件、选项、显示焦点前的目标、隐藏状态和焦点顺序。 */
type OverlayStackEntry = {
	component: Component;
	options?: OverlayOptions;
	preFocus: Component | null;
	hidden: boolean;
	focusOrder: number;
};

/** 当 Overlay 焦点被阻塞时的恢复策略：恢复该 Overlay，或聚焦指定目标。 */
type OverlayBlockedFocusResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
/** 可恢复的 Overlay 焦点状态：记录对应的 Overlay。 */
type EligibleOverlayFocusRestoreState = { status: "eligible"; overlay: OverlayStackEntry };
/** 被阻塞的 Overlay 焦点状态：记录阻塞方与恢复策略。 */
type BlockedOverlayFocusRestoreState = {
	status: "blocked";
	overlay: OverlayStackEntry;
	blockedBy: Component;
	resume: OverlayBlockedFocusResume;
};
type ActiveOverlayFocusRestoreState = EligibleOverlayFocusRestoreState | BlockedOverlayFocusRestoreState;
/** Overlay 焦点恢复状态机：inactive 表示没有待恢复的 Overlay。 */
type OverlayFocusRestoreState = { status: "inactive" } | ActiveOverlayFocusRestoreState;
/** Overlay 焦点恢复策略：clear 表示清除，preserve 表示保留待恢复状态。 */
type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * 容器：一个包含其他组件的组件，负责把子组件的渲染结果按顺序拼接。
 */
export class Container implements Component {
	/** 子组件列表。 */
	children: Component[] = [];

	/** 添加一个子组件。 */
	addChild(component: Component): void {
		this.children.push(component);
	}

	/** 移除一个子组件。 */
	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	/** 清空所有子组件。 */
	clear(): void {
		this.children = [];
	}

	/** 让所有子组件的缓存渲染状态失效。 */
	invalidate(): void {
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	/** 按宽度渲染每个子组件，并顺序拼接所有行。 */
	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}
}

/**
 * TUI - 管理终端 UI 并进行差分渲染的主类。
 */
const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** 将 Overlay 内容合成到终端行中的固定列位置。 */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

/** TUI 主接口：定义终端 UI 的渲染、焦点、Overlay 与输入处理等能力。 */
export interface TUI extends Component {
	children: Component[];
	terminal: Terminal;
	onDebug?: () => void;
	readonly fullRedraws: number;
	addChild(component: Component): void;
	removeChild(component: Component): void;
	clear(): void;
	getShowHardwareCursor(): boolean;
	setShowHardwareCursor(enabled: boolean): void;
	getClearOnShrink(): boolean;
	setClearOnShrink(enabled: boolean): void;
	setFocus(component: Component | null): void;
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
	hideOverlay(): void;
	hasOverlay(): boolean;
	start(): void;
	stop(): void;
	requestRender(force?: boolean): void;
	addInputListener(listener: TuiInputListener): () => void;
	removeInputListener(listener: TuiInputListener): void;
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void;
	setTerminalColorSchemeNotifications(enabled: boolean): void;
	queryTerminalBackgroundColor(options: { timeoutMs: number }): Promise<RgbColor | undefined>;
	queryTerminalColorScheme(options: { timeoutMs: number }): Promise<TerminalColorScheme | undefined>;
}

/** 用于标识“视口型 TUI”的全局 Symbol。 */
export const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

/** 视口型 TUI：支持设置布局根组件的特殊 TUI。 */
export interface ViewportTUI extends TUI {
	readonly [VIEWPORT_TUI]: true;
	setLayoutRoot(component: Component | undefined): void;
}

/** 类型守卫：判断一个 TUI 是否为 {@link ViewportTUI}。 */
export function isViewportTUI(tui: TUI): tui is ViewportTUI {
	return (tui as Partial<ViewportTUI>)[VIEWPORT_TUI] === true;
}

/**
 * TUI 抽象基类：实现焦点管理、Overlay 栈、输入分发、渲染调度等公共逻辑。
 */
export abstract class TuiBase extends Container implements TUI {
	public terminal: Terminal;
	/** 当前持有焦点的组件。 */
	private focusedComponent: Component | null = null;
	/** 全局输入监听器集合。 */
	private inputListeners = new Set<TuiInputListener>();

	/** 调试键（Shift+Ctrl+D）的全局回调，在输入转发到焦点组件之前调用。 */
	public onDebug?: () => void;
	/** 是否已请求渲染（用于合并同一帧内的多次请求）。 */
	private renderRequested = false;
	/** 渲染定时器句柄。 */
	private renderTimer: NodeJS.Timeout | undefined;
	/** 上次渲染的时间戳（毫秒）。 */
	private lastRenderAt = 0;
	/** 两次渲染之间的最小间隔（毫秒），用于节流。 */
	private static readonly MIN_RENDER_INTERVAL_MS = 16;
	/** 是否显示硬件光标（可用环境变量 PI_HARDWARE_CURSOR 覆盖）。 */
	private showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1";
	/** 内容缩小时是否清空多余行（可用环境变量 PI_CLEAR_ON_SHRINK 覆盖）。 */
	private clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1";
	/** 全量重绘的次数计数。 */
	protected fullRedrawCount = 0;
	/** 是否已停止（停止后不再调度渲染）。 */
	protected stopped = false;
	/** 等待中的 OSC 11 背景色查询回复数。 */
	private pendingOsc11BackgroundReplies = 0;
	/** 待处理的 OSC 11 背景色查询队列。 */
	private pendingOsc11BackgroundQueries: PendingOsc11BackgroundQuery[] = [];
	/** 终端配色方案变化的监听器集合。 */
	private terminalColorSchemeListeners = new Set<(scheme: TerminalColorScheme) => void>();
	/** 是否已启用终端配色方案通知（OSC 2031 协议）。 */
	private terminalColorSchemeNotificationsEnabled = false;
	/** 日志目录路径。 */
	protected readonly logDirectory: string;

	// Overlay 栈：用于渲染在基础内容之上的模态组件
	private focusOrderCounter = 0;
	private overlayStack: OverlayStackEntry[] = [];

	/** 是否已有 Overlay 入栈。 */
	protected get hasOverlayEntries(): boolean {
		return this.overlayStack.length > 0;
	}
	/** 当前的 Overlay 焦点恢复状态。 */
	private overlayFocusRestore: OverlayFocusRestoreState = { status: "inactive" };

	/**
	 * 构造 TUI 实例。
	 * @param terminal - 底层终端对象，负责原始读写
	 * @param showHardwareCursor - 是否显示硬件光标（可选，覆盖环境变量）
	 * @param logDirectory - 日志目录（可选，默认取 PI_CODING_AGENT_DIR 或 ~/.pi/agent）
	 */
	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string) {
		super();
		this.terminal = terminal;
		this.logDirectory = logDirectory ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
		if (showHardwareCursor !== undefined) {
			this.showHardwareCursor = showHardwareCursor;
		}
	}

	/** 执行实际渲染：由子类实现具体屏幕输出。 */
	protected abstract doRender(): void;

	/** 重置渲染状态：强制渲染前调用，子类可覆盖以清除缓存。 */
	protected resetRenderState(): void {}

	/** 终端启动前的钩子。 */
	protected beforeTerminalStart(): void {}

	/** 终端启动后的钩子。 */
	protected afterTerminalStart(): void {}

	/** 终端停止前的钩子。 */
	protected beforeTerminalStop(): void {}

	/** 终端停止后的钩子。 */
	protected afterTerminalStop(): void {}

	/** 全量重绘次数。 */
	get fullRedraws(): number {
		return this.fullRedrawCount;
	}

	/** 当前是否显示硬件光标。 */
	getShowHardwareCursor(): boolean {
		return this.showHardwareCursor;
	}

	/** 设置是否显示硬件光标；关闭时立即隐藏光标并触发重绘。 */
	setShowHardwareCursor(enabled: boolean): void {
		if (this.showHardwareCursor === enabled) return;
		this.showHardwareCursor = enabled;
		if (!enabled) {
			this.terminal.hideCursor();
		}
		this.requestRender();
	}

	/** 内容缩小时是否清空多余行。 */
	getClearOnShrink(): boolean {
		return this.clearOnShrink;
	}

	/**
	 * 设置内容缩小时是否触发全量重绘。
	 * 为 true（默认）时，内容缩小的空行会被清空；
	 * 为 false 时空行保留（减少慢终端上的重绘次数）。
	 */
	setClearOnShrink(enabled: boolean): void {
		this.clearOnShrink = enabled;
	}

	/** 设置当前焦点组件，并清除 Overlay 焦点恢复状态。 */
	setFocus(component: Component | null): void {
		this.setFocusInternal({ component, overlayFocusRestore: "clear" });
	}

	/**
	 * 焦点切换的核心逻辑：处理 Overlay 之间的焦点转移与恢复策略。
	 * 会更新旧焦点/新焦点的 `focused` 标志，并维护 overlayFocusRestore 状态。
	 */
	private setFocusInternal({
		component,
		overlayFocusRestore,
	}: {
		component: Component | null;
		overlayFocusRestore: OverlayFocusRestorePolicy;
	}): void {
		const previousFocus = this.focusedComponent;
		let nextFocus = component;
		const previousFocusedOverlay = previousFocus
			? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry))
			: undefined;
		const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
		const restoreState = this.getVisibleOverlayFocusRestore();
		if (nextFocus && !nextFocusIsOverlay) {
			// 焦点离开被阻塞的 Overlay 时，按其恢复策略转移或保留阻塞状态
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
					nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
				} else {
					this.overlayFocusRestore = {
						status: "blocked",
						overlay: restoreState.overlay,
						blockedBy: nextFocus,
						resume: restoreState.resume,
					};
				}
			} else if (
				previousFocusedOverlay &&
				restoreState.status !== "inactive" &&
				restoreState.overlay === previousFocusedOverlay &&
				!this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)
			) {
				// 从 Overlay 切到其外部的组件时，记录为阻塞并稍后可恢复
				this.overlayFocusRestore = {
					status: "blocked",
					overlay: previousFocusedOverlay,
					blockedBy: nextFocus,
					resume: { status: "restore-overlay" },
				};
			}
		} else if (nextFocus === null) {
			if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
				nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
			} else if (overlayFocusRestore === "clear") {
				this.clearOverlayFocusRestore();
			}
		}

		if (isFocusable(this.focusedComponent)) {
			this.focusedComponent.focused = false;
		}

		this.focusedComponent = nextFocus;

		if (isFocusable(nextFocus)) {
			nextFocus.focused = true;
		}

		const focusedOverlay = nextFocus
			? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry))
			: undefined;
		if (focusedOverlay) {
			this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
		}
	}

	/** 清除 Overlay 焦点恢复状态。 */
	private clearOverlayFocusRestore(): void {
		this.overlayFocusRestore = { status: "inactive" };
	}

	/** 若恢复状态关联的是指定 Overlay，则清除该恢复状态。 */
	private clearOverlayFocusRestoreFor(overlay: OverlayStackEntry): void {
		if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
			this.clearOverlayFocusRestore();
		}
	}

	/** 解析被阻塞的 Overlay 焦点恢复：恢复 Overlay 或返回显式目标。 */
	private resolveBlockedOverlayFocusResume(restoreState: BlockedOverlayFocusRestoreState): Component | null {
		if (restoreState.resume.status === "restore-overlay") return restoreState.overlay.component;
		this.clearOverlayFocusRestore();
		return restoreState.resume.target;
	}

	/** 获取当前有效的 Overlay 焦点恢复状态；若关联 Overlay 已不可见则视为 inactive。 */
	private getVisibleOverlayFocusRestore(): OverlayFocusRestoreState {
		const restoreState = this.overlayFocusRestore;
		if (restoreState.status === "inactive") return restoreState;
		if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
			return { status: "inactive" };
		}
		return restoreState;
	}

	/** 判断 `component` 是否位于 Overlay 的焦点祖先链中。 */
	private isOverlayFocusAncestor(entry: OverlayStackEntry, component: Component): boolean {
		const visited = new Set<Component>();
		let current = entry.preFocus;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current === component) return true;
			current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
		}
		return false;
	}

	/** 当某个 Overlay 被移除时，把其它 Overlay 的 preFocus 指向它的 preFocus。 */
	private retargetOverlayPreFocus(removed: OverlayStackEntry): void {
		for (const overlay of this.overlayStack) {
			if (overlay !== removed && overlay.preFocus === removed.component) {
				overlay.preFocus = removed.preFocus;
			}
		}
	}

	/** 获取已挂载的根组件列表（子类可覆盖以自定义挂载根）。 */
	protected getMountedRoots(): readonly Component[] {
		return this.children;
	}

	/** 判断组件是否已挂载到组件树中。 */
	private isComponentMounted(component: Component): boolean {
		return this.getMountedRoots().some((child) => this.containsComponent(child, component));
	}

	/** 递归判断 `root` 组件树中是否包含 `target`。 */
	private containsComponent(root: Component, target: Component): boolean {
		if (root === target) return true;
		if (!(root instanceof Container)) return false;
		return root.children.some((child) => this.containsComponent(child, target));
	}

	/**
	 * 显示一个 Overlay 组件，支持可配置的定位与尺寸。
	 * 返回用于控制该 Overlay 可见性的句柄。
	 */
	showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		const entry: OverlayStackEntry = {
			component,
			...(options === undefined ? {} : { options }),
			preFocus: this.focusedComponent,
			hidden: false,
			focusOrder: ++this.focusOrderCounter,
		};
		this.overlayStack.push(entry);
		// 仅在 Overlay 实际可见时才聚焦它
		if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
			this.setFocus(component);
		}
		this.terminal.hideCursor();
		this.requestRender();

		// 返回用于控制该 Overlay 的句柄
		return {
			hide: () => {
				const index = this.overlayStack.indexOf(entry);
				if (index !== -1) {
					this.clearOverlayFocusRestoreFor(entry);
					this.retargetOverlayPreFocus(entry);
					this.overlayStack.splice(index, 1);
					// 若该 Overlay 持有焦点，则恢复焦点
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
					if (this.overlayStack.length === 0) this.terminal.hideCursor();
					this.requestRender();
				}
			},
			setHidden: (hidden: boolean) => {
				if (entry.hidden === hidden) return;
				entry.hidden = hidden;
				// 隐藏/显示时更新焦点
				if (hidden) {
					this.clearOverlayFocusRestoreFor(entry);
					// 若该 Overlay 持有焦点，把焦点交给下一个可见 Overlay 或 preFocus
					if (this.focusedComponent === component) {
						const topVisible = this.getTopmostVisibleOverlay();
						this.setFocus(topVisible?.component ?? entry.preFocus);
					}
				} else {
					// 显示时若确实可见，则恢复该 Overlay 的焦点
					if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
						entry.focusOrder = ++this.focusOrderCounter;
						this.setFocus(component);
					}
				}
				this.requestRender();
			},
			isHidden: () => entry.hidden,
			focus: () => {
				if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry)) return;
				entry.focusOrder = ++this.focusOrderCounter;
				this.setFocus(component);
				this.requestRender();
			},
			unfocus: (unfocusOptions) => {
				const isFocused = this.focusedComponent === component;
				const restoreState = this.overlayFocusRestore;
				const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
				if (!isFocused && !hasPendingRestore) return;
				if (
					restoreState.status === "blocked" &&
					restoreState.overlay === entry &&
					this.focusedComponent === restoreState.blockedBy
				) {
					if (unfocusOptions) {
						this.overlayFocusRestore = {
							status: "blocked",
							overlay: entry,
							blockedBy: restoreState.blockedBy,
							resume: { status: "focus-target", target: unfocusOptions.target },
						};
					} else {
						this.clearOverlayFocusRestore();
					}
					this.requestRender();
					return;
				}
				this.clearOverlayFocusRestoreFor(entry);
				if (isFocused || unfocusOptions) {
					const topVisible = this.getTopmostVisibleOverlay();
					const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
					this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
				}
				this.requestRender();
			},
			isFocused: () => this.focusedComponent === component,
		};
	}

	/** 隐藏最顶层的 Overlay 并恢复之前的焦点。 */
	hideOverlay(): void {
		const overlay = this.overlayStack[this.overlayStack.length - 1];
		if (!overlay) return;
		this.clearOverlayFocusRestoreFor(overlay);
		this.retargetOverlayPreFocus(overlay);
		this.overlayStack.pop();
		if (this.focusedComponent === overlay.component) {
			// 查找最顶层的可见 Overlay，否则回退到 preFocus
			const topVisible = this.getTopmostVisibleOverlay();
			this.setFocus(topVisible?.component ?? overlay.preFocus);
		}
		if (this.overlayStack.length === 0) this.terminal.hideCursor();
		this.requestRender();
	}

	/** 检查是否存在任何可见的 Overlay。 */
	hasOverlay(): boolean {
		return this.overlayStack.some((o) => this.isOverlayVisible(o));
	}

	/** 检查某个 Overlay 记录当前是否可见。 */
	private isOverlayVisible(entry: OverlayStackEntry): boolean {
		if (entry.hidden) return false;
		if (entry.options?.visible) {
			return entry.options.visible(this.terminal.columns, this.terminal.rows);
		}
		return true;
	}

	/** 查找视觉上最靠前且可捕获焦点的可见 Overlay（若存在）。 */
	private getTopmostVisibleOverlay(): OverlayStackEntry | undefined {
		let topmost: OverlayStackEntry | undefined;
		for (const overlay of this.overlayStack) {
			if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay)) continue;
			if (!topmost || overlay.focusOrder > topmost.focusOrder) {
				topmost = overlay;
			}
		}
		return topmost;
	}

	/** 使所有子组件及 Overlay 的渲染状态失效。 */
	override invalidate(): void {
		super.invalidate();
		for (const overlay of this.overlayStack) overlay.component.invalidate?.();
	}

	/** 启动 TUI：启动终端、注册输入回调、查询终端能力并触发首次渲染。 */
	start(): void {
		this.stopped = false;
		this.beforeTerminalStart();
		this.terminal.start(
			(data) => this.handleTerminalInput(data),
			() => this.requestRender(),
		);
		this.afterTerminalStart();
		this.terminal.hideCursor();
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031h");
		}
		this.queryCellSize();
		this.requestRender();
	}

	/** 添加一个全局输入监听器，返回取消订阅函数。 */
	addInputListener(listener: TuiInputListener): () => void {
		this.inputListeners.add(listener);
		return () => {
			this.inputListeners.delete(listener);
		};
	}

	/** 移除一个全局输入监听器。 */
	removeInputListener(listener: TuiInputListener): void {
		this.inputListeners.delete(listener);
	}

	/** 订阅终端配色方案变化事件，返回取消订阅函数。 */
	onTerminalColorSchemeChange(listener: (scheme: TerminalColorScheme) => void): () => void {
		this.terminalColorSchemeListeners.add(listener);
		return () => {
			this.terminalColorSchemeListeners.delete(listener);
		};
	}

	/** 启用/禁用终端配色方案通知（OSC 2031 协议）。 */
	setTerminalColorSchemeNotifications(enabled: boolean): void {
		if (this.terminalColorSchemeNotificationsEnabled === enabled) {
			return;
		}
		this.terminalColorSchemeNotificationsEnabled = enabled;
		if (!this.stopped) {
			this.terminal.write(enabled ? "\x1b[?2031h" : "\x1b[?2031l");
		}
	}

	/** 查询终端的单元格像素尺寸（仅用于图片渲染，不支持图片时跳过）。 */
	private queryCellSize(): void {
		// 仅在终端支持图片时查询（单元格尺寸只用于图片渲染）
		if (!getCapabilities().images) {
			return;
		}
		// 通过 CSI 16 t 查询终端单元格像素尺寸
		// 响应格式：CSI 6 ; height ; width t
		this.terminal.write("\x1b[16t");
	}

	/** 停止 TUI：清理渲染定时器、恢复光标并关闭终端。 */
	stop(): void {
		this.stopped = true;
		if (this.renderTimer) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		if (this.terminalColorSchemeNotificationsEnabled) {
			this.terminal.write("\x1b[?2031l");
		}
		this.beforeTerminalStop();
		this.terminal.showCursor();
		this.terminal.stop();
		this.afterTerminalStop();
	}

	/**
	 * 请求一次渲染。默认合并到渲染调度中做节流；
	 * `force` 为 true 时跳过节流、清除渲染状态并尽快全量重绘。
	 */
	requestRender(force = false): void {
		if (force) {
			this.resetRenderState();
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			this.renderRequested = true;
			process.nextTick(() => {
				if (this.stopped || !this.renderRequested) {
					return;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				this.doRender();
			});
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	/** 按最小渲染间隔节流调度实际渲染，并在渲染期间有新请求时继续调度。 */
	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}

	/** 处理来自终端的原始输入：先消费协议响应，再交给监听器与焦点组件。 */
	private handleTerminalInput(data: string): void {
		if (this.consumeOsc11BackgroundResponse(data)) {
			return;
		}
		if (this.consumeTerminalColorSchemeReport(data)) {
			return;
		}

		if (this.inputListeners.size > 0) {
			let current = data;
			for (const listener of this.inputListeners) {
				const result = listener(current);
				if (result?.consume) {
					return;
				}
				if (result?.data !== undefined) {
					current = result.data;
				}
			}
			if (current.length === 0) {
				return;
			}
			data = current;
		}

		// 消费终端单元格尺寸响应，但不阻塞无关输入
		if (this.consumeCellSizeResponse(data)) {
			return;
		}

		// 全局调试键处理（Shift+Ctrl+D）
		if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
			this.onDebug();
			return;
		}

		// 若焦点组件是 Overlay，检查它是否仍然可见
		// （可见性可能因终端尺寸变化或 visible() 回调而改变）
		const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
		if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
			// 焦点 Overlay 已不可见，改指到最顶层的可见 Overlay
			const topVisible = this.getTopmostVisibleOverlay();
			if (topVisible) {
				this.setFocus(topVisible.component);
			} else {
				this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
			}
		}

		const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);
		if (!focusIsOverlay) {
			const restoreState = this.getVisibleOverlayFocusRestore();
			if (restoreState.status === "eligible") {
				this.setFocus(restoreState.overlay.component);
			} else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
				if (restoreState.resume.status === "restore-overlay") {
					this.setFocus(restoreState.overlay.component);
				} else {
					this.clearOverlayFocusRestore();
					this.setFocus(restoreState.resume.target);
				}
			}
		}

		// 把输入交给焦点组件（包括 Ctrl+C）
		// 焦点组件可以自行决定如何处理 Ctrl+C
		if (this.focusedComponent?.handleInput) {
			// 过滤按键释放事件，除非组件主动选择接收
			if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
				return;
			}
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}

	/** 消费并解析 OSC 11 背景色查询响应，兑现对应的 Promise。 */
	private consumeOsc11BackgroundResponse(data: string): boolean {
		if (this.pendingOsc11BackgroundReplies <= 0) {
			return false;
		}

		if (!isOsc11BackgroundColorResponse(data)) {
			return false;
		}

		const rgb = parseOsc11BackgroundColor(data);
		this.pendingOsc11BackgroundReplies -= 1;
		const query = this.pendingOsc11BackgroundQueries.shift();
		if (query && !query.settled) {
			query.settled = true;
			if (query.timer) {
				clearTimeout(query.timer);
				query.timer = undefined;
			}
			query.resolve?.(rgb);
			query.resolve = undefined;
		}
		return true;
	}

	/** 消费并解析终端配色方案上报（DSR），并通知所有监听器。 */
	private consumeTerminalColorSchemeReport(data: string): boolean {
		const scheme = parseTerminalColorSchemeReport(data);
		if (!scheme) {
			return false;
		}

		for (const listener of this.terminalColorSchemeListeners) {
			listener(scheme);
		}
		return true;
	}

	/** 消费终端单元格像素尺寸响应（CSI 6;height;width t），并据此使图片重新渲染。 */
	private consumeCellSizeResponse(data: string): boolean {
		// 响应格式：ESC [ 6 ; height ; width t
		const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
		if (!match) {
			return false;
		}

		const heightPx = parseInt(match[1], 10);
		const widthPx = parseInt(match[2], 10);
		if (heightPx <= 0 || widthPx <= 0) {
			return true;
		}

		setCellDimensions({ widthPx, heightPx });
		// 使所有组件失效，以便图片按正确尺寸重新渲染
		this.invalidate();
		this.requestRender();
		return true;
	}

	/**
	 * 根据选项解析 Overlay 的布局。
	 * 返回 { width, row, col, maxHeight } 供渲染使用。
	 */
	private resolveOverlayLayout(
		options: OverlayOptions | undefined,
		overlayHeight: number,
		termWidth: number,
		termHeight: number,
	): { width: number; row: number; col: number; maxHeight: number | undefined } {
		const opt = options ?? {};

		// 解析边距（钳制为非负值）
		const margin =
			typeof opt.margin === "number"
				? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
				: (opt.margin ?? {});
		const marginTop = Math.max(0, margin.top ?? 0);
		const marginRight = Math.max(0, margin.right ?? 0);
		const marginBottom = Math.max(0, margin.bottom ?? 0);
		const marginLeft = Math.max(0, margin.left ?? 0);

		// 扣除边距后的可用空间
		const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
		const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

		// === 解析宽度 ===
		let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
		// 应用最小宽度
		if (opt.minWidth !== undefined) {
			width = Math.max(width, opt.minWidth);
		}
		// 钳制到可用空间内
		width = Math.max(1, Math.min(width, availWidth));

		// === 解析最大高度 ===
		let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
		// 钳制到可用空间内
		if (maxHeight !== undefined) {
			maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
		}

		// 实际生效的 Overlay 高度（可能被 maxHeight 截断）
		const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

		// === 解析位置 ===
		let row: number;
		let col: number;

		if (opt.row !== undefined) {
			if (typeof opt.row === "string") {
				// 百分比：0% = 顶部，100% = 底部（Overlay 保持在边界内）
				const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxRow = Math.max(0, availHeight - effectiveHeight);
					const percent = parseFloat(match[1]) / 100;
					row = marginTop + Math.floor(maxRow * percent);
				} else {
					// 格式非法，回退到居中
					row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
				}
			} else {
				// 绝对行位置
				row = opt.row;
			}
		} else {
			// 基于锚点定位（默认：居中）
			const anchor = opt.anchor ?? "center";
			row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
		}

		if (opt.col !== undefined) {
			if (typeof opt.col === "string") {
				// 百分比：0% = 左侧，100% = 右侧（Overlay 保持在边界内）
				const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
				if (match) {
					const maxCol = Math.max(0, availWidth - width);
					const percent = parseFloat(match[1]) / 100;
					col = marginLeft + Math.floor(maxCol * percent);
				} else {
					// 格式非法，回退到居中
					col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
				}
			} else {
				// 绝对列位置
				col = opt.col;
			}
		} else {
			// 基于锚点定位（默认：居中）
			const anchor = opt.anchor ?? "center";
			col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
		}

		// 应用偏移量
		if (opt.offsetY !== undefined) row += opt.offsetY;
		if (opt.offsetX !== undefined) col += opt.offsetX;

		// 钳制到终端边界内（并尊重边距）
		row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
		col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));

		return { width, row, col, maxHeight };
	}

	/** 根据锚点解析 Overlay 的行位置。 */
	private resolveAnchorRow(anchor: OverlayAnchor, height: number, availHeight: number, marginTop: number): number {
		switch (anchor) {
			case "top-left":
			case "top-center":
			case "top-right":
				return marginTop;
			case "bottom-left":
			case "bottom-center":
			case "bottom-right":
				return marginTop + availHeight - height;
			case "left-center":
			case "center":
			case "right-center":
				return marginTop + Math.floor((availHeight - height) / 2);
		}
	}

	/** 根据锚点解析 Overlay 的列位置。 */
	private resolveAnchorCol(anchor: OverlayAnchor, width: number, availWidth: number, marginLeft: number): number {
		switch (anchor) {
			case "top-left":
			case "left-center":
			case "bottom-left":
				return marginLeft;
			case "top-right":
			case "right-center":
			case "bottom-right":
				return marginLeft + availWidth - width;
			case "top-center":
			case "center":
			case "bottom-center":
				return marginLeft + Math.floor((availWidth - width) / 2);
		}
	}

	/** 把所有 Overlay 合成到内容行中（按 focusOrder 排序，值越大越靠上）。 */
	protected compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
		if (this.overlayStack.length === 0) return lines;
		const result = [...lines];

		// 预渲染所有可见 Overlay 并计算位置
		const rendered: { overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// 先用高度 0 求布局以确定宽度和 maxHeight
			// （宽度和 maxHeight 不依赖于 Overlay 高度）
			const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);

			// 按计算出的宽度渲染组件
			let overlayLines = component.render(width);

			// 若指定了 maxHeight 则截断
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// 用实际 Overlay 高度求出最终的行/列
			const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);

			rendered.push({ overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}

		// 至少填充到终端高度，使 Overlay 具有屏幕相对位置。
		// 不使用 maxLinesRendered：历史高水位线会造成自我强化的膨胀，
		// 在终端变宽时把内容推入滚动缓冲区。
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// 若内容行数不足以放置 Overlay 或达到工作区高度，则补充空行
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// 逐个合成 Overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// 防御性处理：合成前把 Overlay 行截断到声明宽度
					// （组件本应遵守宽度，但这里确保万无一失）
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}

	/** 为每一行追加段重置序列，确保上一行的样式/超链接不会泄漏到下一行。 */
	protected applyLineResets(lines: string[]): string[] {
		const reset = SEGMENT_RESET;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isImageLine(line)) {
				lines[i] = normalizeTerminalOutput(line) + reset;
			}
		}
		return lines;
	}

	/** 在指定列位置把 Overlay 行合成到基础行上。 */
	private compositeLineAt(
		baseLine: string,
		overlayLine: string,
		startCol: number,
		overlayWidth: number,
		totalWidth: number,
	): string {
		return compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
	}

	/**
	 * 从渲染行中查找并提取光标位置。
	 * 搜索 CURSOR_MARKER，计算其位置，然后从输出中剥离该标记。
	 * 仅扫描底部终端高度的行（可见视口）。
	 * @param lines - 要搜索的渲染行
	 * @param height - 终端高度（可见视口大小）
	 * @returns 光标位置 { row, col }，若未找到标记则返回 null
	 */
	protected extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
		// 只扫描底部 `height` 行（可见视口）
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const line = lines[row];
			const markerIndex = line.indexOf(CURSOR_MARKER);
			if (markerIndex !== -1) {
				// 计算视觉列（标记前文本的宽度）
				const beforeMarker = line.slice(0, markerIndex);
				const col = visibleWidth(beforeMarker);

				// 从该行中剥离标记
				lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

				return { row, col };
			}
		}
		return null;
	}

	/**
	 * 通过 OSC 11（`ESC ] 11 ; ? BEL`）查询终端的默认背景色。
	 * @param timeoutMs 查询超时时间（毫秒）
	 * @returns Promise，解析为解析出的 RGB 颜色；超时或解析失败时为 undefined
	 */
	queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined> {
		return new Promise((resolve) => {
			const query: PendingOsc11BackgroundQuery = {
				settled: false,
				resolve,
				timer: undefined,
			};

			query.timer = setTimeout(() => {
				if (query.settled) {
					return;
				}
				query.settled = true;
				query.timer = undefined;
				query.resolve?.(undefined);
				query.resolve = undefined;
			}, timeoutMs);
			this.pendingOsc11BackgroundQueries.push(query);
			this.pendingOsc11BackgroundReplies += 1;
			this.terminal.write("\x1b]11;?\x07");
		});
	}

	/**
	 * 通过 DSR（`CSI ? 996 n`）查询终端的配色方案偏好。
	 * 支持调色板通知协议的终端会以
	 * `CSI ? 997 ; 1 n`（深色）或 `CSI ? 997 ; 2 n`（浅色）回复。
	 */
	queryTerminalColorScheme({ timeoutMs }: { timeoutMs: number }): Promise<TerminalColorScheme | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			let unsubscribe: () => void = () => {};
			const settle = (scheme: TerminalColorScheme | undefined) => {
				if (settled) return;
				settled = true;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				unsubscribe();
				resolve(scheme);
			};

			unsubscribe = this.onTerminalColorSchemeChange(settle);
			timer = setTimeout(() => settle(undefined), timeoutMs);
			this.terminal.write("\x1b[?996n");
		});
	}
}

import { AltScreenFlashContainer } from "./components/alt-screen-flash.ts";
import { ScrollView } from "./components/scroll-view.ts";
import { getKeybindings } from "./keybindings.ts";
import { isKeyRelease } from "./keys.ts";
import {
	getScrollbarGeometry,
	getScrollViewBox,
	getScrollViewsAt,
	type LayoutFrame,
	renderLayoutFrame,
	type ScrollbarGeometry,
} from "./layout.ts";
import type { Terminal } from "./terminal.ts";
import {
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	deleteKittyImage,
	getCapabilities,
	getKittyImagePlacement,
	type ImageProtocol,
	isImageLine,
	setCapabilities,
	type TerminalCapabilities,
} from "./terminal-image.ts";
import { type Component, CURSOR_MARKER, compositeTuiLine, TuiBase, VIEWPORT_TUI, type ViewportTUI } from "./tui.ts";
import {
	extractAnsiCode,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "./utils.ts";

/** 进入备用屏幕（alternate screen）的转义序列。 */
const ENTER_ALT_SCREEN = "\x1b[?1049h";
/** 退出备用屏幕的转义序列。 */
const EXIT_ALT_SCREEN = "\x1b[?1049l";
/** 关闭自动换行。 */
const DISABLE_AUTOWRAP = "\x1b[?7l";
/** 开启自动换行。 */
const ENABLE_AUTOWRAP = "\x1b[?7h";
/** 启用鼠标事件（按下、拖动、移动、聚焦及 SGR 坐标模式）。 */
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
/** 禁用全部鼠标事件模式。 */
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
/** 终端聚焦进入事件。 */
const FOCUS_IN = "\x1b[I";
/** 终端聚焦离开事件。 */
const FOCUS_OUT = "\x1b[O";
/** 开始同步输出（减少屏幕闪烁）。 */
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
/** 结束同步输出。 */
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
/** 匹配 OSC 133 提示符区域的前缀（在渲染时会被剥离）。 */
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
/** 匹配 OSC 133 提示符起始标记（A 标记），用于提示符间滚动。 */
const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
/** 翻页时与视口边缘重叠的行数，用于保留上下文。 */
const PAGE_SCROLL_OVERLAP = 4;

/** 文本选择锚点/焦点：记录行列位置及所属的滚动视图。 */
interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: ScrollView;
}

/** 解析后的 SGR 鼠标事件：按钮编码、坐标和是否释放。 */
interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

/** 滚轮事件：滚动方向与坐标。 */
interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
}

/** 滚动条拖动状态：目标滚动视图与抓取位置偏移。 */
interface ScrollbarDrag {
	scrollView: ScrollView;
	grabOffset: number;
}

/** 命中滚动条的目标：滚动视图及其几何信息。 */
interface ScrollbarTarget {
	scrollView: ScrollView;
	geometry: ScrollbarGeometry;
}

/** 备用屏幕 TUI 的选项。 */
export interface TuiAltScreenOptions {
	/** 每次滚轮事件滚动的逻辑行数。 */
	wheelScrollLines?: number;
	/** 捕获鼠标事件，用于视口滚动和应用自有的文本选择。 */
	mouse?: boolean;
	/** 单击时打开 OSC 8 超链接。 */
	openUrl?: (url: string) => void;
}

/** 备用屏幕 TUI：拥有可滚动、由应用自有的视口。 */
export class TuiAltScreen extends TuiBase implements ViewportTUI {
	/** 标记该实例为视口型 TUI。 */
	readonly [VIEWPORT_TUI] = true as const;
	/** 上次渲染的屏幕内容（用于差分比较）。 */
	private previousScreen: string[] = [];
	/** 退出备用屏幕前保留的最后文档内容（用于恢复主屏幕）。 */
	private lastDocument: string[] = [];
	/** 上次渲染时的终端宽度。 */
	private previousScreenWidth = 0;
	/** 上次渲染时的终端高度。 */
	private previousScreenHeight = 0;
	/** 布局根组件；未设置时回退到隐式文档。 */
	private layoutRoot: Component | undefined;
	/** 当前布局帧（由 layout.ts 计算得到）。 */
	private currentLayout: LayoutFrame | undefined;
	/** 隐式文档组件：直接渲染 TUI 的子组件。 */
	private readonly implicitDocument: Component;
	/** 包住隐式文档的滚动视图（未设置布局根时使用）。 */
	private readonly implicitScrollView: ScrollView;
	/** 临时闪现消息容器。 */
	private readonly flashes: AltScreenFlashContainer;
	/** 备用屏幕是否已激活。 */
	private altScreenActive = false;
	/** 当前使用的图片协议（null 表示不支持图片）。 */
	private imageProtocol: ImageProtocol = null;
	/** 进入备用屏幕前保存的终端能力（iTerm2 图片需要临时禁用）。 */
	private savedCapabilities?: TerminalCapabilities;
	/** 已上传的 Kitty 图片：imageId -> 传输代数。 */
	private readonly uploadedKittyImages = new Map<number, number>();
	/** 文本选择的锚点。 */
	private selectionAnchor?: SelectionPoint;
	/** 文本选择的焦点端。 */
	private selectionFocus?: SelectionPoint;
	/** 拖动选择时的指针位置。 */
	private selectionDragPointer?: { x: number; y: number };
	/** 选择拖动的自动滚动方向：-1 上、1 下、0 无。 */
	private selectionAutoScrollDirection: -1 | 0 | 1 = 0;
	/** 自动滚动的定时器。 */
	private selectionAutoScrollTimer?: NodeJS.Timeout;
	/** 是否处于按下选中状态（拖拽选择过程中）。 */
	private selectionPressActive = false;
	/** 滚动条拖动状态。 */
	private scrollbarDrag?: ScrollbarDrag;
	/** 当前悬停的滚动条所在滚动视图。 */
	private scrollbarHover?: ScrollView;
	/** 按下时检测到的 URL（点击释放时判断是否触发打开）。 */
	private pressedUrl?: string;
	/** 选择是否已发生拖动（用于区分点击与拖选）。 */
	private selectionDragged = false;
	/** 每次滚轮滚动的行数。 */
	private readonly wheelScrollLines: number;
	/** 是否启用鼠标事件捕获。 */
	private readonly mouseEnabled: boolean;
	/** 打开 URL 的回调（可选）。 */
	private readonly openUrl?: (url: string) => void;

	/**
	 * 构造备用屏幕 TUI。
	 * @param terminal - 底层终端对象
	 * @param showHardwareCursor - 是否显示硬件光标（可选）
	 * @param logDirectory - 日志目录（可选）
	 * @param options - 备用屏幕选项（滚轮行数、鼠标捕获、URL 打开等）
	 */
	constructor(
		terminal: Terminal,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options: TuiAltScreenOptions = {},
	) {
		super(terminal, showHardwareCursor, logDirectory);
		this.implicitDocument = {
			render: (width) => super.render(width),
			invalidate: () => {
				for (const child of this.children) child.invalidate();
			},
		};
		this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
		this.flashes = new AltScreenFlashContainer(() => this.requestRender());
		this.wheelScrollLines = Math.max(1, Math.floor(options.wheelScrollLines ?? 1));
		this.mouseEnabled = options.mouse ?? true;
		this.openUrl = options.openUrl;
		this.addInputListener((data) => this.handleViewportInput(data));
	}

	/** 当前主滚动视图的滚动顶部位置。 */
	get viewportTop(): number {
		return this.getPrimaryScrollView().scrollTop;
	}

	/** 当前是否跟随输出（滚动到底部）。 */
	get isFollowingOutput(): boolean {
		return this.getPrimaryScrollView().isFollowingEnd;
	}

	/** 设置布局根组件；设为 undefined 时回退到隐式文档。 */
	setLayoutRoot(component: Component | undefined): void {
		if (this.layoutRoot === component) return;
		this.layoutRoot = component;
		this.currentLayout = undefined;
		this.requestRender();
	}

	/** 渲染布局根组件，未设置时回退到隐式文档渲染。 */
	override render(width: number): string[] {
		return this.layoutRoot?.render(width) ?? super.render(width);
	}

	/** 使布局根组件与所有子组件失效。 */
	override invalidate(): void {
		super.invalidate();
		this.layoutRoot?.invalidate();
	}

	/** 获取挂载根：优先返回布局根，否则返回子组件列表。 */
	protected override getMountedRoots(): readonly Component[] {
		return this.layoutRoot ? [this.layoutRoot] : this.children;
	}

	/** 获取主滚动视图（当前布局的主滚动视图，否则用隐式滚动视图）。 */
	private getPrimaryScrollView(): ScrollView {
		return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
	}

	/** 终端启动前：进入备用屏幕、清空状态、启用鼠标捕获并发送初始化序列。 */
	protected override beforeTerminalStart(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.flashes.dispose();
		this.altScreenActive = true;
		const capabilities = getCapabilities();
		this.imageProtocol = capabilities.images;
		this.uploadedKittyImages.clear();
		if (capabilities.images === "iterm2") {
			// iTerm2 图片会干扰备用屏幕差分渲染，先临时禁用以回到纯文本模式
			this.savedCapabilities = capabilities;
			setCapabilities({ ...capabilities, images: null });
			this.invalidate();
		}
		this.lastDocument = [];
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.resetRenderState();
		this.terminal.write(
			`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? ENABLE_MOUSE : ""}\x1b[2J\x1b[H\x1b[?25l`,
		);
	}

	/** 终端停止前：清理状态、禁用鼠标并删除已上传的 Kitty 图片。 */
	protected override beforeTerminalStop(): void {
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.stopScrollbarHover();
		this.stopScrollbarDrag();
		this.flashes.dispose();
		if (!this.altScreenActive) return;
		this.terminal.write(
			`${BEGIN_SYNCHRONIZED_OUTPUT}${this.deleteKittyImages()}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`,
		);
		this.uploadedKittyImages.clear();
	}

	/** 终端停止后：退出备用屏幕，并把最后的文档内容写回主屏幕。 */
	protected override afterTerminalStop(): void {
		if (!this.altScreenActive) return;
		this.altScreenActive = false;
		const width = Math.max(1, this.terminal.columns);
		const documentLines = this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
		this.lastDocument = this.applyLineResets(documentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map(
			(line) => (isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true)),
		);
		let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
		for (let row = 0; row < this.lastDocument.length; row++) {
			if (row > 0) buffer += "\r\n";
			buffer += `\r\x1b[2K${this.lastDocument[row] ?? ""}`;
		}
		buffer += `\x1b[0m${ENABLE_AUTOWRAP}\r\n\x1b[?25h${END_SYNCHRONIZED_OUTPUT}`;
		this.terminal.write(buffer);
		if (this.savedCapabilities) {
			setCapabilities(this.savedCapabilities);
			this.savedCapabilities = undefined;
		}
	}

	/** 生成删除全部 Kitty 图片的转义序列（非 Kitty 协议时为空）。 */
	private deleteKittyImages(): string {
		return this.imageProtocol === "kitty" ? deleteAllKittyImages() : "";
	}

	/**
	 * 为 Kitty 图片屏幕做准备：
	 * 对已上传且未变化的图片替换为占位行，同时生成删除失效图片的序列。
	 */
	private prepareKittyScreen(screen: string[]): { lines: string[]; staleImageDeletion: string } {
		const visibleImageIds = new Set<number>();
		const lines = screen.map((line) => {
			const placement = getKittyImagePlacement(line);
			if (!placement) return line;
			visibleImageIds.add(placement.imageId);
			if (this.uploadedKittyImages.get(placement.imageId) === placement.transmissionGeneration) {
				return placement.replacementLine;
			}
			this.uploadedKittyImages.set(placement.imageId, placement.transmissionGeneration);
			return line;
		});

		let staleImageDeletion = "";
		for (const imageId of this.uploadedKittyImages.keys()) {
			if (visibleImageIds.has(imageId)) continue;
			staleImageDeletion += deleteKittyImage(imageId);
			this.uploadedKittyImages.delete(imageId);
		}
		return { lines, staleImageDeletion };
	}

	/** 重置渲染状态：清空差分缓存，强制下次全量重绘。 */
	protected override resetRenderState(): void {
		this.previousScreen = [];
		this.previousScreenWidth = 0;
		this.previousScreenHeight = 0;
		this.currentLayout = undefined;
	}

	/** 按指定行数滚动主视口（负数向上）。 */
	scrollBy(lines: number): void {
		this.getPrimaryScrollView().scrollBy(lines);
		this.requestRender();
	}

	/** 滚动到顶部。 */
	scrollToTop(): void {
		this.getPrimaryScrollView().scrollToStart();
		this.requestRender();
	}

	/** 滚动到底部。 */
	scrollToBottom(): void {
		this.getPrimaryScrollView().scrollToEnd();
		this.requestRender();
	}

	/** 滚动到上一个（-1）或下一个（1）OSC 133 提示符起始处。 */
	private scrollToPrompt(direction: -1 | 1): void {
		if (!this.currentLayout) return;
		const scrollView = this.getPrimaryScrollView();
		const lines = getScrollViewBox(this.currentLayout, scrollView)?.scrollContentLines;
		if (!lines) return;

		for (let row = scrollView.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
			if (!OSC133_PROMPT_START.test(lines[row] ?? "")) continue;
			scrollView.scrollTo(row);
			this.requestRender();
			return;
		}
	}

	/** 在备用屏幕闪现栈中显示一条临时消息。 */
	flash(message: string, durationMs?: number): void {
		this.flashes.flash(message, durationMs);
	}

	/**
	 * 处理视口相关的输入：焦点事件、滚轮、鼠标及滚动快捷键。
	 * 返回 `{ consume: true }` 表示该输入已被消费，不再向下传递。
	 */
	private handleViewportInput(data: string): { consume?: boolean } | undefined {
		if (data === FOCUS_OUT) {
			// 终端失去焦点：取消激活中的选择与滚动条交互
			const hadActiveSelection = this.selectionPressActive;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			this.stopScrollbarHover();
			this.stopScrollbarDrag();
			this.pressedUrl = undefined;
			this.selectionDragged = false;
			if (hadActiveSelection) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
			}
			this.requestRender();
			return { consume: true };
		}
		if (data === FOCUS_IN) return { consume: true };

		const wheelEvent = this.parseWheelEvent(data);
		if (wheelEvent) {
			this.routeWheel(wheelEvent);
			return { consume: true };
		}
		const mouseEvent = this.parseSgrMouseEvent(data);
		if (mouseEvent) {
			const handled = this.handleScrollbarMouseEvent(mouseEvent);
			if (!this.scrollbarDrag) this.updateScrollbarHover(mouseEvent.x, mouseEvent.y);
			if (!handled) this.handleSelectionMouseEvent(mouseEvent);
			return { consume: true };
		}
		if (this.isMouseSequence(data)) return { consume: true };

		const keybindings = getKeybindings();
		const isRelease = isKeyRelease(data);
		if (keybindings.matches(data, "tui.altScreen.pageUp")) {
			if (!isRelease) {
				this.scrollBy(-Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.pageDown")) {
			if (!isRelease) {
				this.scrollBy(Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
			}
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.previousPrompt")) {
			if (!isRelease) this.scrollToPrompt(-1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.nextPrompt")) {
			if (!isRelease) this.scrollToPrompt(1);
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.top")) {
			if (!isRelease) this.scrollToTop();
			return { consume: true };
		}
		if (keybindings.matches(data, "tui.altScreen.bottom")) {
			if (!isRelease) this.scrollToBottom();
			return { consume: true };
		}
		return undefined;
	}

	/** 解析滚轮事件：支持 SGR 与 X10 两种鼠标编码格式。 */
	private parseWheelEvent(data: string): WheelEvent | undefined {
		const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
		if (sgr) {
			const button = Number.parseInt(sgr[1], 10);
			// 第 6 位表示滚轮事件，低位 2 位表示方向
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: Number.parseInt(sgr[2], 10) - 1,
				y: Number.parseInt(sgr[3], 10) - 1,
			};
		}
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const button = data.charCodeAt(3) - 32;
			if ((button & 64) === 0) return undefined;
			const direction = button & 3;
			if (direction !== 0 && direction !== 1) return undefined;
			return {
				direction: direction === 0 ? -1 : 1,
				x: data.charCodeAt(4) - 33,
				y: data.charCodeAt(5) - 33,
			};
		}
		return undefined;
	}

	/**
	 * 分发滚轮事件：优先滚动指针下的滚动视图，
	 * 剩余滚动量再交给主滚动视图处理。
	 */
	private routeWheel(event: WheelEvent): void {
		let remaining = event.direction * this.wheelScrollLines;
		const seen = new Set<ScrollView>();
		for (const scrollView of this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y) : []) {
			seen.add(scrollView);
			remaining = scrollView.scrollBy(remaining);
			if (remaining === 0 || scrollView.overscroll === "contain") break;
		}
		const primary = this.getPrimaryScrollView();
		if (remaining !== 0 && !seen.has(primary)) primary.scrollBy(remaining);
		this.updateScrollbarHover(event.x, event.y);
		this.requestRender();
	}

	/** 解析 SGR 鼠标事件（`CSI < button ; x ; y M/m`）。 */
	private parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
		const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
		if (!match) return undefined;
		return {
			button: Number.parseInt(match[1], 10),
			x: Number.parseInt(match[2], 10) - 1,
			y: Number.parseInt(match[3], 10) - 1,
			release: match[4] === "m",
		};
	}

	/** 查找给定坐标处命中的滚动条（滚动条滑块区域）。 */
	private getScrollbarTargetAt(x: number, y: number): ScrollbarTarget | undefined {
		if (this.hasOverlay() || !this.currentLayout) return undefined;
		for (const scrollView of getScrollViewsAt(this.currentLayout, x, y)) {
			const box = getScrollViewBox(this.currentLayout, scrollView);
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			if (
				geometry &&
				x === geometry.column &&
				y >= geometry.thumbTop &&
				y < geometry.thumbTop + geometry.thumbHeight
			) {
				return { scrollView, geometry };
			}
		}
		return undefined;
	}

	/** 更新滚动条悬停状态：旧的取消激活，新的激活。 */
	private setScrollbarHover(scrollView: ScrollView | undefined): void {
		if (scrollView === this.scrollbarHover) return;
		this.scrollbarHover?.setScrollbarActive(false);
		this.scrollbarHover = scrollView;
		this.scrollbarHover?.setScrollbarActive(true);
	}

	/** 根据鼠标坐标更新滚动条悬停目标。 */
	private updateScrollbarHover(x: number, y: number): void {
		this.setScrollbarHover(this.getScrollbarTargetAt(x, y)?.scrollView);
	}

	/** 停止滚动条悬停（取消激活）。 */
	private stopScrollbarHover(): void {
		this.setScrollbarHover(undefined);
	}

	/**
	 * 处理滚动条相关鼠标事件：拖动滑块时更新滚动位置；
	 * 返回 true 表示事件已被滚动条消费。
	 */
	private handleScrollbarMouseEvent(event: SgrMouseEvent): boolean {
		if (this.scrollbarDrag) {
			if (event.release) {
				this.stopScrollbarDrag();
				return true;
			}
			const box = this.currentLayout
				? getScrollViewBox(this.currentLayout, this.scrollbarDrag.scrollView)
				: undefined;
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			if (geometry) {
				const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
				const thumbOffset = Math.max(
					0,
					Math.min(maxThumbOffset, event.y - geometry.trackTop - this.scrollbarDrag.grabOffset),
				);
				const scrollTop =
					maxThumbOffset === 0 ? 0 : Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
				this.scrollbarDrag.scrollView.scrollTo(scrollTop);
			}
			return true;
		}

		// 忽略释放、拖动（bit 5）与其它按键（bit 0-1 非左键）事件
		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		const target = this.getScrollbarTargetAt(event.x, event.y);
		if (!target) return false;
		this.stopSelectionAutoScroll();
		this.selectionPressActive = false;
		this.selectionAnchor = undefined;
		this.selectionFocus = undefined;
		this.pressedUrl = undefined;
		this.selectionDragged = false;
		this.setScrollbarHover(target.scrollView);
		this.scrollbarDrag = {
			scrollView: target.scrollView,
			grabOffset: event.y - target.geometry.thumbTop,
		};
		return true;
	}

	/** 停止滚动条拖动。 */
	private stopScrollbarDrag(): void {
		this.scrollbarDrag = undefined;
	}

	/** 把屏幕坐标转换为滚动视图内容坐标系中的选择点（考虑滚动偏移）。 */
	private getScrollSelectionPoint(scrollView: ScrollView, x: number, y: number): SelectionPoint | undefined {
		if (!this.currentLayout) return undefined;
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) return undefined;
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		if (visibleBottom < visibleTop) return undefined;
		const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y));
		const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
		return {
			row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
			col: Math.max(0, Math.min(box.rect.width - 1, x - box.rect.x)),
			scrollView,
		};
	}

	/** 获取鼠标事件对应的选择点；若命中滚动视图则用其内容坐标，否则用屏幕坐标。 */
	private getSelectionPoint(event: SgrMouseEvent, scrollView?: ScrollView): SelectionPoint {
		if (scrollView) {
			const point = this.getScrollSelectionPoint(scrollView, event.x, event.y);
			if (point) return point;
		}
		return {
			row: Math.max(0, Math.min(this.terminal.rows - 1, event.y)),
			col: Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
		};
	}

	/** 根据指针位置更新选择拖动的自动滚动方向，必要时启动定时滚动。 */
	private updateSelectionAutoScroll(event: SgrMouseEvent): void {
		const scrollView = this.selectionAnchor?.scrollView;
		if (!scrollView || !this.currentLayout) {
			this.stopSelectionAutoScroll();
			return;
		}
		const box = getScrollViewBox(this.currentLayout, scrollView);
		if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const visibleTop = Math.max(0, box.rect.y, box.clip.y);
		const visibleBottom = Math.min(
			this.terminal.rows - 1,
			box.rect.y + box.rect.height - 1,
			box.clip.y + box.clip.height - 1,
		);
		this.selectionDragPointer = { x: event.x, y: event.y };
		this.selectionAutoScrollDirection = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
		if (this.selectionAutoScrollDirection === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		if (this.selectionAutoScrollTimer) return;
		this.selectionAutoScrollTimer = setInterval(() => this.autoScrollSelection(), 50);
		this.selectionAutoScrollTimer.unref();
	}

	/** 自动滚动一步，并更新选择的焦点端。 */
	private autoScrollSelection(): void {
		const scrollView = this.selectionAnchor?.scrollView;
		const pointer = this.selectionDragPointer;
		const direction = this.selectionAutoScrollDirection;
		if (!scrollView || !pointer || direction === 0) {
			this.stopSelectionAutoScroll();
			return;
		}
		const remaining = scrollView.scrollBy(direction);
		if (remaining === direction) {
			this.stopSelectionAutoScroll();
			return;
		}
		const point = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y);
		if (point) this.selectionFocus = point;
		this.requestRender();
	}

	/** 停止选择的自动滚动。 */
	private stopSelectionAutoScroll(): void {
		if (this.selectionAutoScrollTimer) {
			clearInterval(this.selectionAutoScrollTimer);
			this.selectionAutoScrollTimer = undefined;
		}
		this.selectionAutoScrollDirection = 0;
		this.selectionDragPointer = undefined;
	}

	/**
	 * 处理文本选择与 URL 点击相关的鼠标事件。
	 * 支持：按下设定锚点、拖动扩展选择、释放时复制到剪贴板或打开 URL。
	 */
	private handleSelectionMouseEvent(event: SgrMouseEvent): void {
		if ((event.button & 3) !== 0) return;
		const anchorScrollView = this.selectionAnchor?.scrollView;
		const point = this.getSelectionPoint(event, anchorScrollView);
		if (event.release) {
			if (!this.selectionPressActive) return;
			this.selectionPressActive = false;
			this.stopSelectionAutoScroll();
			if (!this.selectionAnchor) return;
			this.selectionFocus = point;
			const clickedUrl =
				!this.selectionDragged &&
				this.selectionAnchor.scrollView === point.scrollView &&
				this.selectionAnchor.row === point.row &&
				this.selectionAnchor.col === point.col
					? this.pressedUrl
					: undefined;
			this.pressedUrl = undefined;
			if (clickedUrl && this.openUrl) {
				this.selectionAnchor = undefined;
				this.selectionFocus = undefined;
				try {
					this.openUrl(clickedUrl);
				} catch {
					// 打开 URL 是尽力而为的操作，失败可忽略
				}
				this.requestRender();
				return;
			}
			this.copySelectionToClipboard();
			this.requestRender();
			return;
		}
		if ((event.button & 32) !== 0) {
			// 拖动事件：扩展选择焦点并触发自动滚动
			if (!this.selectionPressActive || !this.selectionAnchor) return;
			this.selectionDragged = true;
			this.pressedUrl = undefined;
			this.selectionFocus = point;
			this.updateSelectionAutoScroll(event);
			this.requestRender();
			return;
		}
		// 按下事件：开始新选择并记录按下位置的 URL
		this.stopSelectionAutoScroll();
		this.selectionPressActive = true;
		const scrollView =
			!this.hasOverlay() && this.currentLayout
				? getScrollViewsAt(this.currentLayout, event.x, event.y)[0]
				: undefined;
		const anchor = this.getSelectionPoint(event, scrollView);
		this.selectionAnchor = anchor;
		this.selectionFocus = anchor;
		this.selectionDragged = false;
		this.pressedUrl = getOsc8LinkAtColumn(
			this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? "",
			Math.max(0, Math.min(this.terminal.columns - 1, event.x)),
		);
		this.requestRender();
	}

	/** 计算选择的边界（起点在前、终点在后）；无有效选择或跨滚动视图时返回 undefined。 */
	private getSelectionBounds(): { start: SelectionPoint; end: SelectionPoint } | undefined {
		if (!this.selectionAnchor || !this.selectionFocus) return undefined;
		if (this.selectionAnchor.scrollView !== this.selectionFocus.scrollView) return undefined;
		const anchorBeforeFocus =
			this.selectionAnchor.row < this.selectionFocus.row ||
			(this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col < this.selectionFocus.col);
		if (
			this.selectionAnchor.row === this.selectionFocus.row &&
			this.selectionAnchor.col === this.selectionFocus.col
		) {
			return undefined;
		}
		return anchorBeforeFocus
			? { start: this.selectionAnchor, end: this.selectionFocus }
			: { start: this.selectionFocus, end: this.selectionAnchor };
	}

	/** 计算某一行的选择列范围：起始行取开始列，结束行取结束列，并夹紧到行宽。 */
	private getSelectionColumns(
		line: string,
		row: number,
		selection: { start: SelectionPoint; end: SelectionPoint },
		minColumn = 0,
		maxColumn = visibleWidth(line),
	): { start: number; end: number } {
		const lineWidth = visibleWidth(line);
		let start = Math.max(0, minColumn);
		let end = Math.min(lineWidth, maxColumn);
		if (row === selection.start.row) {
			start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
		}
		if (row === selection.end.row) {
			end = getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth);
		}
		return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
	}

	/** 把当前选择复制到系统剪贴板（通过 OSC 52 序列）。 */
	private copySelectionToClipboard(): void {
		const selection = this.getSelectionBounds();
		if (!selection) return;
		let sourceLines: readonly string[] = this.previousScreen;
		if (selection.start.scrollView) {
			if (!this.currentLayout) return;
			const box = getScrollViewBox(this.currentLayout, selection.start.scrollView);
			if (!box?.scrollContentLines) return;
			sourceLines = box.scrollContentLines;
		}
		const lines: string[] = [];
		for (let row = selection.start.row; row <= selection.end.row; row++) {
			const line = sourceLines[row] ?? "";
			const columns = this.getSelectionColumns(line, row, selection);
			lines.push(
				stripTerminalSequences(
					sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
				).trimEnd(),
			);
		}
		const text = lines.join("\n");
		if (text.length === 0) return;
		this.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		this.flash("Copied!");
	}

	/** 为选中的文本应用反色高亮（保留原有的 ANSI 颜色序列）。 */
	private applySelectionHighlight(text: string): string {
		let result = "\x1b[7m";
		let index = 0;
		while (index < text.length) {
			const ansi = extractAnsiCode(text, index);
			if (!ansi) {
				result += text[index];
				index += 1;
				continue;
			}
			result += ansi.code;
			if (ansi.code.endsWith("m")) result += "\x1b[7m";
			index += ansi.length;
		}
		return `${result}\x1b[27m`;
	}

	/** 把当前选择高亮应用到渲染出的屏幕行上（支持滚动视图坐标换算）。 */
	private applySelection(screen: string[], layout = this.currentLayout): string[] {
		const selection = this.getSelectionBounds();
		if (!selection) return screen;
		let screenSelection = selection;
		let minRow = 0;
		let maxRow = screen.length - 1;
		let minColumn = 0;
		let maxColumn = this.terminal.columns;
		if (selection.start.scrollView) {
			if (!layout) return screen;
			const box = getScrollViewBox(layout, selection.start.scrollView);
			if (!box) return screen;
			minRow = Math.max(0, box.rect.y, box.clip.y);
			maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
			minColumn = Math.max(0, box.rect.x, box.clip.x);
			maxColumn = Math.min(this.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width);
			screenSelection = {
				start: {
					row: box.rect.y + selection.start.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.start.col,
					scrollView: selection.start.scrollView,
				},
				end: {
					row: box.rect.y + selection.end.row - selection.start.scrollView.scrollTop,
					col: box.rect.x + selection.end.col,
					scrollView: selection.start.scrollView,
				},
			};
		}
		return screen.map((line, row) => {
			if (
				row < minRow ||
				row > maxRow ||
				row < screenSelection.start.row ||
				row > screenSelection.end.row ||
				isImageLine(line)
			) {
				return line;
			}
			const lineWidth = visibleWidth(line);
			const columns = this.getSelectionColumns(line, row, screenSelection, minColumn, maxColumn);
			if (columns.end <= columns.start) return line;
			const before = sliceByColumn(line, 0, columns.start, true);
			const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
			const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
			return `${before}${this.applySelectionHighlight(selected)}${after}`;
		});
	}

	/** 判断输入是否为一个鼠标事件序列（SGR 或 X10 格式）。 */
	private isMouseSequence(data: string): boolean {
		return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
	}

	/** 把闪现消息合成到屏幕的右上角区域。 */
	private compositeFlashes(screen: string[], width: number, height: number): string[] {
		const flashLines = this.flashes.render(width).slice(-height);
		if (flashLines.length === 0) return screen;
		const result = [...screen];
		while (result.length < height) result.push("");
		for (let row = 0; row < flashLines.length; row++) {
			const line = flashLines[row]!;
			const flashWidth = visibleWidth(line);
			if (flashWidth === 0) continue;
			result[row] = compositeTuiLine(result[row] ?? "", line, width - flashWidth, flashWidth, width);
		}
		return result;
	}

	/**
	 * 执行实际渲染：计算布局、合成 Overlay/选择/闪现，
	 * 与上次屏幕做差分后写出到终端，并维护状态。
	 */
	protected override doRender(): void {
		if (this.stopped || !this.altScreenActive) return;
		const width = Math.max(1, this.terminal.columns);
		const height = Math.max(1, this.terminal.rows);
		const root = this.layoutRoot ?? this.implicitScrollView;
		const nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
		let screen = nextLayout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX, ""));
		screen = this.compositeOverlays(screen, width, height);
		if (screen.length > height) screen = screen.slice(screen.length - height);
		screen = this.applySelection(screen, nextLayout);
		screen = this.compositeFlashes(screen, width, height);

		const cursorPos = this.extractCursorPosition(screen, height);
		screen = this.applyLineResets(screen).map((line) => {
			if (isImageLine(line) || visibleWidth(line) <= width) return line;
			return sliceByColumn(line, 0, width, true);
		});

		// 判定是否需要全量重绘或图片重绘
		const fullRedraw =
			this.previousScreen.length === 0 || this.previousScreenWidth !== width || this.previousScreenHeight !== height;
		const imagesNeedRedraw = screen.some(
			(line, row) =>
				line !== this.previousScreen[row] && (isImageLine(line) || isImageLine(this.previousScreen[row] ?? "")),
		);
		const redrawImages = fullRedraw || imagesNeedRedraw;
		const hadUploadedKittyImages = this.uploadedKittyImages.size > 0;
		const preparedKittyScreen =
			redrawImages && this.imageProtocol === "kitty"
				? this.prepareKittyScreen(screen)
				: { lines: screen, staleImageDeletion: "" };

		let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
		if (fullRedraw) {
			this.fullRedrawCount += 1;
			const clearImages =
				this.imageProtocol === "kitty" && hadUploadedKittyImages
					? deleteAllKittyPlacements()
					: this.deleteKittyImages();
			buffer += `${clearImages}\x1b[2J`;
		} else if (imagesNeedRedraw) {
			if (this.imageProtocol === "iterm2") buffer += "\x1b[2J";
			else if (this.imageProtocol === "kitty") buffer += deleteAllKittyPlacements();
		}
		buffer += preparedKittyScreen.staleImageDeletion;

		// 逐行差分：仅重写发生变化的行
		for (let row = 0; row < height; row++) {
			if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row]) continue;
			buffer += `\x1b[${row + 1};1H\x1b[2K${preparedKittyScreen.lines[row] ?? ""}`;
		}

		// 定位硬件光标（若存在标记）或隐藏光标
		if (cursorPos) {
			buffer += `\x1b[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
			buffer += this.getShowHardwareCursor() ? "\x1b[?25h" : "\x1b[?25l";
		} else {
			buffer += "\x1b[?25l";
		}
		buffer += END_SYNCHRONIZED_OUTPUT;
		this.terminal.write(buffer);

		// 更新差分比较用的快照
		this.previousScreen = screen;
		this.previousScreenWidth = width;
		this.previousScreenHeight = height;
		this.currentLayout = nextLayout;
	}
}

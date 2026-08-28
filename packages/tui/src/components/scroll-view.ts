import { LAYOUT_NODE, type ScrollLayoutNode } from "../layout-node.ts";
import { type Component, Container } from "../tui.ts";

/** 滚动条显示策略：隐藏 / 按需显示 / 始终显示。 */
export type ScrollViewScrollbar = "hidden" | "auto" | "always";

/** {@link ScrollView} 的配置选项。 */
export interface ScrollViewOptions {
	/** 滚动轴，目前仅支持垂直。 */
	axis?: "vertical";
	/** 是否跟随内容末尾（默认不跟随）。 */
	follow?: "none" | "end";
	/** 是否作为主滚动视图（用于备用屏幕整体滚动）。 */
	primary?: boolean;
	/** 滚动到边界后的行为：链式传递给父级 / 就地停下。 */
	overscroll?: "chain" | "contain";
	/** 滚动条显示策略。 */
	scrollbar?: ScrollViewScrollbar;
	/** 滚动条单元格的样式函数（默认灰底反色）。 */
	scrollbarStyle?: (text: string) => string;
	/** 滚动条自动隐藏的延迟毫秒数。 */
	scrollbarHideDelayMs?: number;
}

export interface ScrollViewScrollToOptions {
	/** Keep follow-end disabled even when the target is the current content end. */
	disableFollow?: boolean;
}

export class ScrollView extends Container {
	private readonly child: Component;
	private readonly followEnd: boolean;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly scrollbarStyle: (text: string) => string;
	private currentScrollbar: ScrollViewScrollbar;
	private readonly scrollbarHideDelayMs: number;
	/** 当前滚动偏移（顶部行号）。 */
	private currentScrollTop = 0;
	/** 子内容的总高度。 */
	private contentHeight = 0;
	/** 可视视口高度。 */
	private currentViewportHeight = 0;
	/** 当前是否跟随内容末尾。 */
	private followingEnd: boolean;
	private followSuppressedAtEnd = false;
	private requestRenderCallback: (() => void) | undefined;
	private transientScrollbarVisible = false;
	private scrollbarActive = false;
	private scrollbarHideTimer: NodeJS.Timeout | undefined;

	/**
	 * @param component 唯一的子组件。
	 * @param options 滚动视图配置。
	 */
	constructor(component: Component, options: ScrollViewOptions = {}) {
		super();
		if (options.axis !== undefined && options.axis !== "vertical") {
			throw new Error(`Unsupported ScrollView axis: ${options.axis}`);
		}
		this.child = component;
		this.children.push(component);
		this.followEnd = (options.follow ?? "none") === "end";
		this.followingEnd = this.followEnd;
		this.primary = options.primary ?? false;
		this.overscroll = options.overscroll ?? "chain";
		this.currentScrollbar = options.scrollbar ?? "hidden";
		this.scrollbarStyle = options.scrollbarStyle ?? ((text) => `\x1b[100m${text}\x1b[49m`);
		this.scrollbarHideDelayMs = Math.max(0, Math.floor(options.scrollbarHideDelayMs ?? 1000));
	}

	/** 当前滚动偏移。 */
	get scrollTop(): number {
		return this.currentScrollTop;
	}

	/** 当前是否跟随内容末尾。 */
	get isFollowingEnd(): boolean {
		return this.followingEnd;
	}

	/** 可视视口高度。 */
	get viewportHeight(): number {
		return this.currentViewportHeight;
	}

	/** 当前滚动条策略。 */
	get scrollbar(): ScrollViewScrollbar {
		return this.currentScrollbar;
	}

	/** 滚动条当前是否可见（auto 策略下仅在有溢出且近期有滚动时可见）。 */
	get isScrollbarVisible(): boolean {
		if (this.scrollbar === "always") return this.currentViewportHeight > 0;
		return (
			this.scrollbar === "auto" && this.contentHeight > this.currentViewportHeight && this.transientScrollbarVisible
		);
	}

	/** 更新滚动条策略，并同步自动隐藏状态。 */
	setScrollbar(scrollbar: ScrollViewScrollbar): void {
		if (scrollbar === this.currentScrollbar) return;
		this.currentScrollbar = scrollbar;
		if (scrollbar !== "auto") this.hideTransientScrollbar();
		else if (this.scrollbarActive) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	/** 计算子内容实际可用宽度（始终显示滚动条时让出一列）。 */
	getContentWidth(width: number): number {
		return this.scrollbar === "always" && width > 1 ? width - 1 : width;
	}

	/** 记录一次滚动活动：显示临时滚动条并重置隐藏计时器。 */
	private markScrollbarActivity(): void {
		if (this.scrollbar !== "auto" || this.contentHeight <= this.currentViewportHeight) return;
		this.transientScrollbarVisible = true;
		if (this.scrollbarHideTimer) {
			clearTimeout(this.scrollbarHideTimer);
			this.scrollbarHideTimer = undefined;
		}
		if (this.scrollbarActive) return;
		this.scrollbarHideTimer = setTimeout(() => {
			this.scrollbarHideTimer = undefined;
			this.transientScrollbarVisible = false;
			this.requestRenderCallback?.();
		}, this.scrollbarHideDelayMs);
		this.scrollbarHideTimer.unref();
	}

	/** 隐藏临时滚动条并取消隐藏计时器。 */
	private hideTransientScrollbar(): void {
		this.transientScrollbarVisible = false;
		if (!this.scrollbarHideTimer) return;
		clearTimeout(this.scrollbarHideTimer);
		this.scrollbarHideTimer = undefined;
	}

	/** 设置滚动条激活状态（如鼠标悬停时），并触发一次滚动活动。 */
	setScrollbarActive(active: boolean): void {
		if (active === this.scrollbarActive) return;
		this.scrollbarActive = active;
		this.markScrollbarActivity();
	}

	scrollTo(scrollTop: number, options: ScrollViewScrollToOptions = {}): void {
		const requested = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : this.currentScrollTop;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const next = Math.max(0, Math.min(maxScrollTop, requested));
		const nextFollowSuppressedAtEnd = options.disableFollow === true && next === maxScrollTop;
		const nextFollowingEnd = !nextFollowSuppressedAtEnd && this.followEnd && next === maxScrollTop;
		if (
			next === this.currentScrollTop &&
			nextFollowingEnd === this.followingEnd &&
			nextFollowSuppressedAtEnd === this.followSuppressedAtEnd
		) {
			return;
		}
		const moved = next !== this.currentScrollTop;
		this.currentScrollTop = next;
		this.followingEnd = nextFollowingEnd;
		this.followSuppressedAtEnd = nextFollowSuppressedAtEnd;
		if (moved) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	/** 相对滚动；返回未被消耗的滚动量（供链式 overscroll 使用）。 */
	scrollBy(lines: number): number {
		const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
		if (requested === 0) return 0;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const start = this.followingEnd ? maxScrollTop : this.currentScrollTop;
		const next = Math.max(0, Math.min(maxScrollTop, start + requested));
		const moved = next - start;
		const wasFollowingEnd = this.followingEnd;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd && next === maxScrollTop;
		this.followSuppressedAtEnd = false;
		if (moved !== 0) this.markScrollbarActivity();
		if (moved !== 0 || this.followingEnd !== wasFollowingEnd) this.requestRenderCallback?.();
		return requested - moved;
	}

	/** 滚动到顶部。 */
	scrollToStart(): void {
		const changed =
			this.currentScrollTop !== 0 ||
			this.followingEnd !== (this.followEnd && this.contentHeight <= this.currentViewportHeight);
		this.currentScrollTop = 0;
		this.followingEnd = this.followEnd && this.contentHeight <= this.currentViewportHeight;
		this.followSuppressedAtEnd = false;
		if (changed) {
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
	}

	/** 滚动到底部。 */
	scrollToEnd(): void {
		const next = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const changed = this.currentScrollTop !== next || this.followingEnd !== this.followEnd;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd;
		this.followSuppressedAtEnd = false;
		if (changed) {
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
	}

	/** 由布局系统在每次渲染时调用，更新内容/视口尺寸并校正滚动位置。 */
	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		this.contentHeight = Math.max(0, Math.floor(contentHeight));
		this.currentViewportHeight = Math.max(0, Math.floor(viewportHeight));
		this.requestRenderCallback = requestRender;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		if (this.followingEnd) this.currentScrollTop = maxScrollTop;
		else this.currentScrollTop = Math.max(0, Math.min(this.currentScrollTop, maxScrollTop));
		if (this.currentScrollTop < maxScrollTop) this.followSuppressedAtEnd = false;
		if (this.followEnd && this.currentScrollTop === maxScrollTop && !this.followSuppressedAtEnd) {
			this.followingEnd = true;
		}
		if (this.contentHeight <= this.currentViewportHeight) this.hideTransientScrollbar();
	}

	/** 禁止添加多个子组件：滚动视图只能有一个子组件。 */
	override addChild(_component: Component): void {
		throw new Error("ScrollView has exactly one child");
	}

	/** 禁止移除子组件。 */
	override removeChild(_component: Component): void {
		throw new Error("ScrollView child cannot be removed");
	}

	/** 禁止清空子组件。 */
	override clear(): void {
		throw new Error("ScrollView child cannot be cleared");
	}

	/** 渲染子内容；始终显示滚动条时补齐一列占位。 */
	override render(width: number): string[] {
		const contentWidth = this.getContentWidth(width);
		const lines = this.child.render(contentWidth);
		return contentWidth === width ? lines : lines.map((line) => `${line} `);
	}

	/** 向布局系统暴露滚动节点描述。 */
	[LAYOUT_NODE](): ScrollLayoutNode {
		return { type: "scroll", component: this.child, state: this };
	}
}

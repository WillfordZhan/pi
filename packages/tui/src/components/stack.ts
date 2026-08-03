import { LAYOUT_NODE, type LayoutViewport, type StackLayoutEntry, type StackLayoutNode } from "../layout-node.ts";
import { type Component, Container } from "../tui.ts";

/** 单个栈条目的布局选项。 */
export interface StackEntryOptions {
	/** 初始尺寸：数字表示固定大小，`"auto"` 表示按内容自适应。 */
	basis?: number | "auto";
	/** 空间富余时的增长权重。 */
	grow?: number;
	/** 空间不足时的收缩权重。 */
	shrink?: number;
	/** 最小尺寸。 */
	minSize?: number;
	/** 最大尺寸。 */
	maxSize?: number;
	/** 可见性回调：返回 false 时该条目不参与布局与渲染。 */
	visible?: (viewport: LayoutViewport) => boolean;
}

/** 栈条目：组件加上其布局选项。 */
export interface StackEntry extends StackEntryOptions {
	component: Component;
}

/** 栈的子元素：可以是裸组件，也可以是带布局选项的条目。 */
export type StackChild = Component | StackEntry;

/** 栈布局的配置选项。 */
export interface StackOptions {
	/** 相邻条目之间的间隙。 */
	gap?: number;
	/** 交叉轴对齐方式。 */
	align?: "stretch" | "start" | "center" | "end";
}

/** 判断子元素是否为带布局选项的条目（不是裸组件）。 */
function isStackEntry(child: StackChild): child is StackEntry {
	return !("render" in child);
}

/** 规范化尺寸：非法或未定义时回退到 `fallback`，并取整为非负值。 */
function normalizeSize(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

/** 抽象栈容器：管理子条目及其布局选项，具体渲染由 VStack/HStack 子类实现。 */
export abstract class Stack extends Container {
	protected readonly entries: StackLayoutEntry[] = [];
	protected readonly gap: number;
	protected readonly align: "stretch" | "start" | "center" | "end";
	protected abstract readonly layoutType: "vstack" | "hstack";

	/**
	 * @param children 初始子元素。
	 * @param options 栈选项（间隙、对齐）。
	 */
	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super();
		this.gap = normalizeSize(options.gap, 0);
		this.align = options.align ?? "stretch";
		for (const child of children) {
			if (isStackEntry(child)) this.addChild(child.component, child);
			else this.addChild(child);
		}
	}

	/** 添加子组件并登记其布局选项。 */
	override addChild(component: Component, options: StackEntryOptions = {}): void {
		super.addChild(component);
		this.entries.push({
			component,
			...(options.basis === undefined ? {} : { basis: options.basis }),
			...(options.grow === undefined ? {} : { grow: normalizeSize(options.grow, 0) }),
			...(options.shrink === undefined ? {} : { shrink: normalizeSize(options.shrink, 1) }),
			...(options.minSize === undefined ? {} : { minSize: normalizeSize(options.minSize, 0) }),
			...(options.maxSize === undefined ? {} : { maxSize: normalizeSize(options.maxSize, Number.MAX_SAFE_INTEGER) }),
			...(options.visible === undefined ? {} : { visible: options.visible }),
		});
	}

	/** 移除子组件并同步删除其布局条目。 */
	override removeChild(component: Component): void {
		super.removeChild(component);
		const index = this.entries.findIndex((entry) => entry.component === component);
		if (index !== -1) this.entries.splice(index, 1);
	}

	/** 清空所有子组件与布局条目。 */
	override clear(): void {
		super.clear();
		this.entries.length = 0;
	}

	/** 向布局系统暴露栈节点描述。 */
	[LAYOUT_NODE](): StackLayoutNode {
		return {
			type: this.layoutType,
			entries: this.entries,
			gap: this.gap,
			align: this.align,
		};
	}
}

/** 过滤出在给定视口下可见的栈条目。 */
export function visibleStackEntries(
	entries: readonly StackLayoutEntry[],
	viewport: LayoutViewport,
): StackLayoutEntry[] {
	return entries.filter((entry) => entry.visible?.(viewport) ?? true);
}

/** 把尺寸夹取到条目的 [minSize, maxSize] 区间。 */
function clampSize(size: number, entry: StackLayoutEntry): number {
	const min = Math.max(0, Math.floor(entry.minSize ?? 0));
	const max = Math.max(min, Math.floor(entry.maxSize ?? Number.MAX_SAFE_INTEGER));
	return Math.max(min, Math.min(max, Math.max(0, Math.floor(size))));
}

/** 按权重把剩余空间分配给可增长的条目，或从可收缩的条目中扣除。 */
function distribute(
	sizes: number[],
	entries: readonly StackLayoutEntry[],
	amount: number,
	mode: "grow" | "shrink",
): void {
	let remaining = amount;
	while (remaining > 0) {
		const candidates = entries
			.map((entry, index) => ({ entry, index }))
			.filter(({ entry, index }) => {
				if (mode === "grow") {
					return (entry.grow ?? 0) > 0 && sizes[index]! < (entry.maxSize ?? Number.MAX_SAFE_INTEGER);
				}
				return (entry.shrink ?? 1) > 0 && sizes[index]! > (entry.minSize ?? 0);
			});
		if (candidates.length === 0) return;

		const totalWeight = candidates.reduce((sum, { entry, index }) => {
			return sum + (mode === "grow" ? (entry.grow ?? 0) : (entry.shrink ?? 1) * Math.max(1, sizes[index]!));
		}, 0);
		let distributed = 0;
		for (const { entry, index } of candidates) {
			if (remaining <= 0) break;
			const weight = mode === "grow" ? (entry.grow ?? 0) : (entry.shrink ?? 1) * Math.max(1, sizes[index]!);
			const proposed = Math.max(1, Math.floor((remaining * weight) / totalWeight));
			const capacity =
				mode === "grow"
					? (entry.maxSize ?? Number.MAX_SAFE_INTEGER) - sizes[index]!
					: sizes[index]! - (entry.minSize ?? 0);
			const delta = Math.min(remaining, proposed, capacity);
			if (delta <= 0) continue;
			sizes[index] = sizes[index]! + (mode === "grow" ? delta : -delta);
			remaining -= delta;
			distributed += delta;
		}
		if (distributed === 0) return;
	}
}

/** 计算各栈条目的最终尺寸：先按 basis/自适应初始大小，再根据可用空间统一增长或收缩。 */
export function allocateStackSizes(
	entries: readonly StackLayoutEntry[],
	intrinsicSizes: readonly number[],
	availableSize: number | undefined,
	gap: number,
): number[] {
	const sizes = entries.map((entry, index) =>
		clampSize(
			entry.basis === undefined || entry.basis === "auto" ? (intrinsicSizes[index] ?? 0) : entry.basis,
			entry,
		),
	);
	if (availableSize === undefined) return sizes;

	const contentSize = Math.max(0, Math.floor(availableSize) - Math.max(0, entries.length - 1) * gap);
	const total = sizes.reduce((sum, size) => sum + size, 0);
	if (total < contentSize) distribute(sizes, entries, contentSize - total, "grow");
	else if (total > contentSize) distribute(sizes, entries, total - contentSize, "shrink");
	return sizes;
}

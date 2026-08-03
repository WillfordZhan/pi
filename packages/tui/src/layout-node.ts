import type { Component } from "./tui.ts";

/** 组件向布局系统暴露布局描述的符号键。 */
export const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

/** 布局视口的宽高。 */
export interface LayoutViewport {
	width: number;
	height: number;
}

/** 栈布局中的单个条目及其布局选项。 */
export interface StackLayoutEntry {
	component: Component;
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}

/** 栈布局节点的描述。 */
export interface StackLayoutNode {
	type: "vstack" | "hstack";
	entries: readonly StackLayoutEntry[];
	gap: number;
	align: "stretch" | "start" | "center" | "end";
}

/** 滚动视图向布局系统暴露的状态与回调接口。 */
export interface ScrollLayoutState {
	readonly scrollTop: number;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly viewportHeight: number;
	/** 计算子内容可用宽度。 */
	getContentWidth(width: number): number;
	/** 布局阶段更新内容/视口尺寸。 */
	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
}

/** 滚动布局节点的描述。 */
export interface ScrollLayoutNode {
	type: "scroll";
	component: Component;
	state: ScrollLayoutState;
}

/** 布局节点的联合类型：栈或滚动视图。 */
export type LayoutNode = StackLayoutNode | ScrollLayoutNode;

/** 实现了布局节点协议的组件。 */
export interface LayoutComponent extends Component {
	[LAYOUT_NODE](): LayoutNode;
}

/** 获取组件的布局节点描述；未实现该协议时返回 undefined。 */
export function getLayoutNode(component: Component): LayoutNode | undefined {
	const candidate = component as Partial<LayoutComponent>;
	return typeof candidate[LAYOUT_NODE] === "function" ? candidate[LAYOUT_NODE]() : undefined;
}

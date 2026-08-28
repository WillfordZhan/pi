import { allocateStackSizes, Stack, type StackChild, type StackOptions, visibleStackEntries } from "./stack.ts";

/** 垂直栈布局：子组件自上而下垂直排列，条目之间用空行填充间隙。 */
export class VStack extends Stack {
	protected readonly layoutType = "vstack" as const;

	/**
	 * @param children 初始子组件或栈条目。
	 * @param options 栈选项（间隙、对齐）。
	 */
	constructor(children: StackChild[] = [], options: StackOptions = {}) {
		super(children, options);
	}

	/** 按给定宽度渲染：逐个渲染可见子项，并在相邻子项之间插入空行作为间隙。 */
	override render(width: number): string[] {
		const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
		const entries = visibleStackEntries(this.entries, viewport);
		const rendered = entries.map((entry) => entry.component.render(viewport.width));
		const sizes = allocateStackSizes(
			entries,
			rendered.map((lines) => lines.length),
			undefined,
			this.gap,
		);
		const lines: string[] = [];
		for (let index = 0; index < entries.length; index++) {
			if (index > 0) {
				for (let gap = 0; gap < this.gap; gap++) lines.push("");
			}
			const childLines = rendered[index]!.slice(0, sizes[index]);
			lines.push(...childLines);
			for (let padding = childLines.length; padding < sizes[index]!; padding++) lines.push("");
		}
		return lines;
	}
}

export type { StackChild, StackEntry, StackEntryOptions, StackOptions } from "./stack.ts";

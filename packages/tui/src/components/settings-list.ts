import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { Input } from "./input.ts";

/** 一条设置项的定义。 */
export interface SettingItem {
	/** 该设置的唯一标识 */
	id: string;
	/** 显示标签（左侧） */
	label: string;
	/** 选中时显示的说明文字（可选） */
	description?: string;
	/** 当前值，显示在右侧 */
	currentValue: string;
	/** 若提供，按 Enter/Space 会在这些值之间循环切换 */
	values?: string[];
	/** 若提供，按 Enter 会打开该子菜单。接收当前值和完成回调。 */
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

/** 设置列表的主题样式函数集合。 */
export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
}

/** 设置列表的配置选项。 */
export interface SettingsListOptions {
	/** 是否启用搜索过滤。 */
	enableSearch?: boolean;
}

/** 设置列表组件：展示键值对设置，支持键盘导航、循环取值、搜索过滤与子菜单。 */
export class SettingsList implements Component {
	private items: SettingItem[];
	private filteredItems: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	private maxVisible: number;
	private onChange: (id: string, newValue: string) => void;
	private onCancel: () => void;
	private searchInput?: Input;
	private searchEnabled: boolean;

	// 子菜单状态
	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;

	/**
	 * @param items 设置项列表。
	 * @param maxVisible 一屏最多可见的条目数。
	 * @param theme 主题样式。
	 * @param onChange 值变化时的回调。
	 * @param onCancel 取消/退出时的回调。
	 * @param options 配置选项。
	 */
	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
	}

	/** 更新某个设置项的当前显示值。 */
	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	/** 使子菜单或自身失效。 */
	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	/** 渲染：若子菜单处于活动状态则渲染子菜单，否则渲染主列表。 */
	render(width: number): string[] {
		// 子菜单激活时优先渲染子菜单
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	/** 渲染主列表（含搜索框、条目、滚动指示器、描述与提示行）。 */
	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (displayItems.length === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		// 计算带滚动的可见范围：让选中项保持在中间附近
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, displayItems.length);

		// 计算最大标签宽度以便对齐右侧的值
		const maxLabelWidth = Math.min(30, Math.max(...this.items.map((item) => visibleWidth(item.label))));

		// 渲染可见条目
		for (let i = startIndex; i < endIndex; i++) {
			const item = displayItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			// 用空格补齐标签，使各条目的值对齐
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.theme.label(labelPadded, isSelected);

			// 计算留给值的宽度
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = width - usedWidth - 2;

			const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);

			lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
		}

		// 内容超出可视区时添加滚动指示器
		if (startIndex > 0 || endIndex < displayItems.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		// 为选中项追加说明文字
		const selectedItem = displayItems[this.selectedIndex];
		if (selectedItem?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
			for (const line of wrappedDesc) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		// 追加操作提示行
		this.addHintLine(lines, width);

		return lines;
	}

	/** 处理键盘输入：子菜单激活时委托给子菜单，否则处理主列表导航。 */
	handleInput(data: string): void {
		// 子菜单激活时，把所有输入委托给它。
		// 子菜单的 onCancel（由 Esc 触发）会调用 done() 来关闭子菜单。
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		// 主列表输入处理
		const kb = getKeybindings();
		const displayItems = this.searchEnabled ? this.filteredItems : this.items;
		if (kb.matches(data, "tui.select.up")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			if (displayItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (
			kb.matches(data, "tui.select.confirm") ||
			(data === " " && (!this.searchEnabled || this.searchInput?.getValue().length === 0))
		) {
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			this.searchInput.handleInput(data);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	/** 激活当前条目：有子菜单则打开子菜单，有 values 则循环切换值。 */
	private activateItem(): void {
		const item = this.searchEnabled ? this.filteredItems[this.selectedIndex] : this.items[this.selectedIndex];
		if (!item) return;

		if (item.submenu) {
			// 打开子菜单，传入当前值以便子菜单正确预选
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.onChange(item.id, selectedValue);
				}
				this.closeSubmenu();
			});
		} else if (item.values && item.values.length > 0) {
			// 循环切换值
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		}
	}

	/** 关闭子菜单，并把选中项恢复到打开子菜单前的条目。 */
	private closeSubmenu(): void {
		this.submenuComponent = null;
		// 恢复选中到打开子菜单的条目
		if (this.submenuItemIndex !== null) {
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
	}

	/** 按查询对条目做模糊过滤并重置选中项。 */
	private applyFilter(query: string): void {
		this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
		this.selectedIndex = 0;
	}

	/** 追加操作提示行（搜索模式提示不同）。 */
	private addHintLine(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? "  Type to search · Enter/Space to change · Esc to cancel"
						: "  Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
}

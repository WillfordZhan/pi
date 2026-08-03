import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

/** 闪屏消息的默认展示时长（毫秒）。 */
const DEFAULT_DURATION_MS = 1000;

/** 一条待展示的闪屏消息及其定时器。 */
interface FlashEntry {
	id: number;
	message: string;
	timer: NodeJS.Timeout;
}

/** 备用屏幕渲染器合成的临时提示消息容器，用于在界面上短暂显示“Copied!”之类的提示。 */
export class AltScreenFlashContainer implements Component {
	private readonly entries: FlashEntry[] = [];
	private nextId = 0;
	private readonly requestRender: () => void;

	/**
	 * @param requestRender 消息变化时触发的重绘回调。
	 */
	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	/** 显示一条临时消息，达到 `durationMs` 后自动消失并触发重绘。 */
	flash(message: string, durationMs = DEFAULT_DURATION_MS): void {
		const id = this.nextId++;
		const timer = setTimeout(
			() => {
				const index = this.entries.findIndex((entry) => entry.id === id);
				if (index === -1) return;
				this.entries.splice(index, 1);
				this.requestRender();
			},
			Math.max(0, durationMs),
		);
		timer.unref();
		this.entries.push({ id, message, timer });
		this.requestRender();
	}

	/** 清理所有未过期的定时器并清空消息列表。 */
	dispose(): void {
		for (const entry of this.entries) clearTimeout(entry.timer);
		this.entries.length = 0;
	}

	invalidate(): void {}

	/** 把所有闪屏消息渲染为反色文本行。 */
	render(width: number): string[] {
		return this.entries.map((entry) => {
			const message = truncateToWidth(` ${entry.message} `, width, "");
			return `\x1b[7m${message}\x1b[27m`;
		});
	}
}

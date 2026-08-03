import type { CommandResult, ServerEvent, ServerSnapshot, SessionSnapshot } from "@earendil-works/pi-protocol";
import { toError } from "./errors.ts";
import type { ListenerErrorHandler, Unsubscribe } from "./types.ts";

/** 维护客户端的会话快照、附加状态与订阅者列表，并负责派发快照/事件更新。 */
export class ClientState {
	/** 已见过的会话快照（按会话 ID 索引）。 */
	readonly #sessionSnapshots = new Map<string, SessionSnapshot>();
	/** 当前处于附加（attached）状态的会话 ID 集合。 */
	readonly #attachedSessionIds = new Set<string>();
	/** 全局快照订阅者。 */
	readonly #snapshotListeners = new Set<(snapshot: ServerSnapshot) => void>();
	/** 全局事件订阅者。 */
	readonly #eventListeners = new Set<(event: ServerEvent) => void>();
	/** 按会话 ID 索引的会话快照订阅者。 */
	readonly #sessionSnapshotListeners = new Map<string, Set<(snapshot: SessionSnapshot) => void>>();
	/** 按会话 ID 索引的会话事件订阅者。 */
	readonly #sessionEventListeners = new Map<string, Set<(event: ServerEvent) => void>>();
	/** 可选的监听器异常处理回调。 */
	readonly #onListenerError: ListenerErrorHandler | undefined;
	/** 最近一次的服务端全局快照。 */
	#snapshot: ServerSnapshot | undefined;

	/** @param onListenerError 监听器抛错时的处理回调，可缺省。 */
	constructor(onListenerError?: ListenerErrorHandler) {
		this.#onListenerError = onListenerError;
	}

	/** 最近一次的服务端全局快照。 */
	get snapshot(): ServerSnapshot | undefined {
		return this.#snapshot;
	}

	/** 清空全部快照与附加状态，用于连接断开后重置。 */
	reset(): void {
		this.#snapshot = undefined;
		this.#sessionSnapshots.clear();
		this.#attachedSessionIds.clear();
	}

	/** 仅清空附加状态（保留快照），用于连接切换时。 */
	clearAttachments(): void {
		this.#attachedSessionIds.clear();
	}

	/** 释放全部状态与订阅者，供客户端销毁时调用。 */
	dispose(): void {
		this.reset();
		this.#snapshotListeners.clear();
		this.#eventListeners.clear();
		this.#sessionSnapshotListeners.clear();
		this.#sessionEventListeners.clear();
	}

	/** 获取指定会话的快照。 */
	getSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
		return this.#sessionSnapshots.get(sessionId);
	}

	/** 判断指定会话是否处于附加状态。 */
	isSessionAttached(sessionId: string): boolean {
		return this.#attachedSessionIds.has(sessionId);
	}

	/** 移除并返回指定会话的快照（用于附加失败时回滚）。 */
	forgetSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
		const previous = this.#sessionSnapshots.get(sessionId);
		this.#sessionSnapshots.delete(sessionId);
		return previous;
	}

	/** 恢复指定会话的快照（仅在快照不存在时写入）。 */
	restoreSessionSnapshot(snapshot: SessionSnapshot): void {
		if (!this.#sessionSnapshots.has(snapshot.id)) this.#sessionSnapshots.set(snapshot.id, snapshot);
	}

	/** 订阅全局快照更新，返回取消订阅函数。 */
	subscribe(listener: (snapshot: ServerSnapshot) => void): Unsubscribe {
		this.#snapshotListeners.add(listener);
		return () => this.#snapshotListeners.delete(listener);
	}

	/** 订阅全局事件，返回取消订阅函数。 */
	onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	/** 订阅指定会话的快照更新，返回取消订阅函数。 */
	subscribeSession(sessionId: string, listener: (snapshot: SessionSnapshot) => void): Unsubscribe {
		return addMappedListener(this.#sessionSnapshotListeners, sessionId, listener);
	}

	/** 订阅指定会话的事件，返回取消订阅函数。 */
	onSessionEvent(sessionId: string, listener: (event: ServerEvent) => void): Unsubscribe {
		return addMappedListener(this.#sessionEventListeners, sessionId, listener);
	}

	/** 应用一条命令结果：更新对应会话的快照或附加状态。 */
	applyResult(result: CommandResult): void {
		if (result.command === "list") return;
		if (result.command === "detach") {
			this.#attachedSessionIds.delete(result.sessionId);
			const snapshot = this.#sessionSnapshots.get(result.sessionId);
			if (snapshot) this.#applySessionSnapshot({ ...snapshot, attached: false }, true);
			return;
		}
		this.#applySessionSnapshot(result.session);
	}

	/** 应用一个服务器事件：更新快照/会话，并通知相应订阅者。 */
	applyEvent(event: ServerEvent): void {
		if (event.type === "server_snapshot") this.applyServerSnapshot(event.snapshot);
		if (event.type === "session_snapshot") this.#applySessionSnapshot(event.snapshot);
		if (event.type === "session_removed") {
			this.#sessionSnapshots.delete(event.sessionId);
			this.#attachedSessionIds.delete(event.sessionId);
		}
		this.#notify(this.#eventListeners, event);
		const sessionId = getEventSessionId(event);
		if (sessionId) this.#notify(this.#sessionEventListeners.get(sessionId), event);
	}

	/** 应用服务端全局快照：按修订号去重，并据此重建附加状态集合。 */
	applyServerSnapshot(snapshot: ServerSnapshot): void {
		if (this.#snapshot && snapshot.revision < this.#snapshot.revision) return;
		this.#snapshot = snapshot;
		this.#attachedSessionIds.clear();
		for (const session of snapshot.sessions) if (session.attached) this.#attachedSessionIds.add(session.id);
		this.#notify(this.#snapshotListeners, snapshot);
	}

	/** 应用单个会话快照：按修订号去重，更新附加状态并通知订阅者。 */
	#applySessionSnapshot(snapshot: SessionSnapshot, force = false): void {
		const current = this.#sessionSnapshots.get(snapshot.id);
		if (!force && current && snapshot.revision < current.revision) return;
		this.#sessionSnapshots.set(snapshot.id, snapshot);
		if (snapshot.attached) this.#attachedSessionIds.add(snapshot.id);
		else this.#attachedSessionIds.delete(snapshot.id);
		this.#notify(this.#sessionSnapshotListeners.get(snapshot.id), snapshot);
	}

	/** 通知一组监听器；单个监听器抛错不影响其余监听器。 */
	#notify<T>(listeners: Iterable<(value: T) => void> | undefined, value: T): void {
		for (const listener of listeners ?? []) {
			try {
				listener(value);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	/** 上报监听器异常；诊断逻辑不应影响客户端状态。 */
	#reportListenerError(error: unknown): void {
		if (!this.#onListenerError) return;
		try {
			this.#onListenerError(toError(error));
		} catch {
			// 诊断逻辑不能影响客户端状态。
		}
	}
}

/** 向以 ID 为键的监听器集合中添加监听器并返回移除函数；空集合会自动删除。 */
function addMappedListener<T>(
	listenersById: Map<string, Set<(value: T) => void>>,
	id: string,
	listener: (value: T) => void,
): Unsubscribe {
	let listeners = listenersById.get(id);
	if (!listeners) {
		listeners = new Set();
		listenersById.set(id, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) listenersById.delete(id);
	};
}

/** 从事件中提取其所属的会话 ID；与任何会话无关的事件返回 undefined。 */
function getEventSessionId(event: ServerEvent): string | undefined {
	if (event.type === "session_snapshot") return event.snapshot.id;
	if (event.type === "session_progress" || event.type === "session_removed") return event.sessionId;
	return undefined;
}

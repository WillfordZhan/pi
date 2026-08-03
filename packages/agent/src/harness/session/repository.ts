import { uuidv7 } from "@earendil-works/pi-ai";
import {
	type FileError,
	type Result,
	type SessionCreateOptions,
	SessionError,
	type SessionForkOptions,
	type SessionForkSelection,
	type SessionMetadata,
	type SessionTreeEntry,
} from "../types.ts";
import type { Session } from "./session.ts";

/** 生成一个新的会话 id（基于 uuidv7）。 */
export function createSessionId(): string {
	return uuidv7();
}

/** 生成当前时间的 ISO 字符串，用作条目/会话的时间戳。 */
export function createTimestamp(): string {
	return new Date().toISOString();
}

/**
 * 会话仓库接口：内置（JSONL/内存）仓库的统一门面，负责创建、打开、
 * 列出、删除与派生（fork）会话，并管理会话的完整生命周期。
 */
export interface SessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> extends AsyncDisposable {
	/** 创建一个新会话。 */
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	/** 按元数据打开一个已有会话。 */
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	/** 列出会话元数据。 */
	list(options?: TListOptions): Promise<TMetadata[]>;
	/** 删除一个会话。 */
	delete(metadata: TMetadata): Promise<void>;
	/** 从源会话按选项派生一个新会话。 */
	fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}

/** 将文件系统操作的结果解包：失败时抛出对应的 SessionError。 */
export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}

/** `T` 或 `Promise<T>` 的缩写，用于允许同步或异步的实现。 */
type MaybePromise<T> = T | Promise<T>;

/** fork 派生时读取源会话条目所需的接口子集。 */
interface SessionForkEntrySource {
	readEntry(id: string): MaybePromise<SessionTreeEntry | undefined>;
	readEntries(): MaybePromise<readonly SessionTreeEntry[]>;
	readPathToRootOrCompaction(leafId: string | null): MaybePromise<readonly SessionTreeEntry[]>;
}

/** @internal 内置仓库共享的 fork 选择策略转换：把 fork 选项映射为具体的选择方案。 */
export function createSessionForkSelection(options: SessionForkOptions): SessionForkSelection {
	if (!options.entryId) return { kind: "all" };
	return (options.position ?? "before") === "at"
		? { kind: "through_entry", entryId: options.entryId }
		: { kind: "before_user_message", entryId: options.entryId };
}

/** @internal 内置仓库共享的 fork 条目读取：按选择方案从源会话取出派生所需的条目。 */
export async function readSessionEntriesForFork(
	source: SessionForkEntrySource,
	selection: SessionForkSelection,
): Promise<readonly SessionTreeEntry[]> {
	if (selection.kind === "all") return source.readEntries();
	const target = await source.readEntry(selection.entryId);
	if (!target) throw new SessionError("invalid_fork_target", `Entry ${selection.entryId} not found`);
	if (selection.kind === "through_entry") return source.readPathToRootOrCompaction(target.id);
	if (target.type !== "message" || target.message.role !== "user") {
		throw new SessionError("invalid_fork_target", `Entry ${selection.entryId} is not a user message`);
	}
	return source.readPathToRootOrCompaction(target.parentId);
}

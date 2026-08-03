import type {
	FileSystem,
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	SessionForkOptions,
	SessionForkSelection,
	SessionStorage,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError, toError } from "../types.ts";
import { ArraySessionIndex } from "./array-session-index.ts";
import { KeyedOperationQueue } from "./keyed-operation-queue.ts";
import {
	createSessionForkSelection,
	createSessionId,
	createTimestamp,
	getFileSystemResultOrThrow,
	readSessionEntriesForFork,
	type SessionRepository,
} from "./repository.ts";
import { createSession, type Session, type SessionContextBuildOptions } from "./session.ts";

/** JSONL 会话后端的构造选项。 */
export interface JsonlSessionBackendOptions {
	/** 底层文件系统接口。 */
	fs: JsonlSessionRepositoryFileSystem;
	/** 会话文件根目录。 */
	sessionsRoot: string;
	/** 跨会话 key 的最大并发操作数，默认为 4。 */
	maxConcurrentOperations?: number;
}
/** JSONL 仓库所需的最小文件系统接口子集。 */
export type JsonlSessionRepositoryFileSystem = Pick<
	FileSystem,
	| "absolutePath"
	| "joinPath"
	| "readTextFile"
	| "readTextLines"
	| "writeFile"
	| "appendFile"
	| "listDir"
	| "exists"
	| "createDir"
	| "remove"
>;

/** 后端内部读写会话文件所需的最小文件系统接口子集。 */
type JsonlSessionFileSystem = Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile">;

/** 默认的最大并发操作数。 */
const DEFAULT_MAX_CONCURRENT_OPERATIONS = 4;

/** JSONL 会话文件首行的头部结构。 */
interface SessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	metadata?: Record<string, unknown>;
}

/** 新建会话文档时推导出的描述信息，用于确定文件名与操作队列 key。 */
interface SessionDocumentDescriptor {
	id: string;
	timestamp: string;
	fileName: string;
	operationKey: string;
}

/** 从 JSONL 文件加载出的完整会话文档（元数据 + 条目）。 */
interface JsonlSessionDocument {
	metadata: JsonlSessionMetadata;
	entries: SessionTreeEntry[];
}

/** 构造表示会话文件无效的 SessionError。 */
function invalidSession(path: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid JSONL session file ${path}: ${message}`, cause);
}

/** 构造表示会话文件某行条目无效的 SessionError。 */
function invalidEntry(path: string, line: number, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_entry", `Invalid JSONL session file ${path}: line ${line} ${message}`, cause);
}

/** 解析并校验 JSONL 文件的首行头部。 */
function parseHeader(line: string, path: string): SessionHeader {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw invalidSession(path, "first line is not a valid session header", toError(error));
	}
	if (typeof value !== "object" || value === null)
		throw invalidSession(path, "first line is not a valid session header");
	const header = value as Partial<SessionHeader>;
	if (header.type !== "session" || header.version !== 3) {
		throw invalidSession(
			path,
			header.type === "session" ? "unsupported session version" : "first line is not a valid session header",
		);
	}
	if (typeof header.id !== "string" || !header.id) throw invalidSession(path, "session header is missing id");
	if (typeof header.timestamp !== "string" || !header.timestamp)
		throw invalidSession(path, "session header is missing timestamp");
	if (typeof header.cwd !== "string" || !header.cwd) throw invalidSession(path, "session header is missing cwd");
	if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
		throw invalidSession(path, "session header parentSession must be a string");
	}
	if (
		header.metadata !== undefined &&
		(typeof header.metadata !== "object" || header.metadata === null || Array.isArray(header.metadata))
	) {
		throw invalidSession(path, "session header metadata must be an object");
	}
	return {
		type: "session",
		version: 3,
		id: header.id,
		timestamp: header.timestamp,
		cwd: header.cwd,
		parentSession: header.parentSession,
		metadata: header.metadata,
	};
}

/** 解析并校验 JSONL 文件中的一行会话条目。 */
function parseEntry(line: string, path: string, lineNumber: number): SessionTreeEntry {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw invalidEntry(path, lineNumber, "is not valid JSON", toError(error));
	}
	if (typeof value !== "object" || value === null)
		throw invalidEntry(path, lineNumber, "is not a valid session entry");
	const entry = value as {
		type?: unknown;
		id?: unknown;
		parentId?: unknown;
		timestamp?: unknown;
		targetId?: unknown;
	};
	if (typeof entry.type !== "string") throw invalidEntry(path, lineNumber, "is missing entry type");
	if (typeof entry.id !== "string" || !entry.id) throw invalidEntry(path, lineNumber, "is missing entry id");
	if (entry.parentId !== null && typeof entry.parentId !== "string")
		throw invalidEntry(path, lineNumber, "has invalid parentId");
	if (typeof entry.timestamp !== "string" || !entry.timestamp)
		throw invalidEntry(path, lineNumber, "is missing timestamp");
	if (entry.type === "leaf" && entry.targetId !== null && typeof entry.targetId !== "string") {
		throw invalidEntry(path, lineNumber, "has invalid targetId");
	}
	return entry as SessionTreeEntry;
}

/** 由头部解析结果构造会话元数据。 */
function metadataFromHeader(header: SessionHeader, path: string): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.timestamp,
		cwd: header.cwd,
		path,
		parentSessionPath: header.parentSession,
		metadata: header.metadata,
	};
}

/** 只读取 JSONL 文件的头部行，返回轻量的会话元数据，用于列表场景。 */
export async function loadJsonlSessionMetadata(
	fs: JsonlSessionFileSystem,
	path: string,
): Promise<JsonlSessionMetadata> {
	const lines = getFileSystemResultOrThrow(
		await fs.readTextLines(path, { maxLines: 1 }),
		`Failed to read session header ${path}`,
	);
	if (!lines[0]?.trim()) throw invalidSession(path, "missing session header");
	return metadataFromHeader(parseHeader(lines[0], path), path);
}

/** 读取并解析整个 JSONL 会话文件，校验条目 id 唯一性。 */
async function loadJsonlSession(fs: JsonlSessionFileSystem, path: string): Promise<JsonlSessionDocument> {
	const content = getFileSystemResultOrThrow(await fs.readTextFile(path), `Failed to read session ${path}`);
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) throw invalidSession(path, "missing session header");
	const header = parseHeader(lines[0]!, path);
	const entries = lines.slice(1).map((line, index) => parseEntry(line, path, index + 2));
	const entryIds = new Set<string>();
	for (const entry of entries) {
		if (entryIds.has(entry.id)) throw invalidSession(path, `duplicate entry id ${entry.id}`);
		entryIds.add(entry.id);
	}
	return {
		metadata: metadataFromHeader(header, path),
		entries,
	};
}

/** 将工作目录编码为合法的目录名片段（用于按 cwd 分组存放会话文件）。 */
function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** 根据创建选项推导会话文档描述信息（id、文件名、操作队列 key）。 */
function createDocumentDescriptor(options: JsonlSessionCreateOptions): SessionDocumentDescriptor {
	const id = options.id ?? createSessionId();
	if (!id) throw new SessionError("invalid_session", "Session id cannot be empty");
	let encodedId: string;
	try {
		encodedId = encodeURIComponent(id);
	} catch (error) {
		throw new SessionError("invalid_session", `Invalid session id ${JSON.stringify(id)}`, toError(error));
	}
	const timestamp = createTimestamp();
	const fileName = `${timestamp.replace(/[:.]/g, "-")}_${encodedId}.jsonl`;
	return {
		id,
		timestamp,
		fileName,
		operationKey: `document:${JSON.stringify([encodeCwd(options.cwd), fileName])}`,
	};
}

/**
 * JSONL 会话后端：把每个会话存为一个 `.jsonl` 文件，并提供基于
 * 内存索引（ArraySessionIndex）的读写；所有跨会话操作通过键控队列串行化。
 */
export class JsonlSessionBackend {
	/** 底层文件系统接口。 */
	private readonly fs: JsonlSessionRepositoryFileSystem;
	/** 构造时传入的会话根目录（可能是相对路径）。 */
	private readonly sessionsRootInput: string;
	/** 解析后的绝对会话根目录，惰性求值。 */
	private sessionsRoot: string | undefined;
	/** 按会话文件路径缓存的内存条目索引。 */
	private readonly entryIndexesByPath = new Map<string, ArraySessionIndex>();
	/** 按会话文件路径缓存的操作队列 key。 */
	private readonly operationKeysByPath = new Map<string, string>();
	/** 跨会话的操作队列，同一 key（同一会话文件）的操作串行执行。 */
	private readonly operations: KeyedOperationQueue<string>;
	/** 是否已释放（dispose）。 */
	private disposed = false;
	/** 释放流程的 Promise。 */
	private disposePromise: Promise<void> | undefined;

	/**
	 * 构造 JSONL 会话后端。
	 * @param options - 后端选项，包含文件系统、会话根目录与并发上限。
	 */
	constructor(options: JsonlSessionBackendOptions) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
		this.operations = new KeyedOperationQueue({
			maxConcurrentOperations: options.maxConcurrentOperations ?? DEFAULT_MAX_CONCURRENT_OPERATIONS,
		});
	}

	/** 创建并打开一个新会话，返回其存储句柄。 */
	create(options: JsonlSessionCreateOptions): Promise<SessionStorage<JsonlSessionMetadata>> {
		this.assertOpen();
		const descriptor = createDocumentDescriptor(options);
		return this.operations.enqueue(descriptor.operationKey, async () =>
			this.storage(await this.createDocument(descriptor, options, options.parentSessionPath, options.metadata, [])),
		);
	}

	/** 按元数据打开一个已有会话，返回其存储句柄。 */
	open(metadata: JsonlSessionMetadata): Promise<SessionStorage<JsonlSessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () =>
			this.storage(await this.loadDocument(metadata)),
		);
	}

	/** 加载会话文件到内存索引（若已有缓存则替换），返回元数据。 */
	private async loadDocument(metadata: JsonlSessionMetadata): Promise<JsonlSessionMetadata> {
		if (
			!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.path}`);
		}
		const document = await loadJsonlSession(this.fs, metadata.path);
		const entries = this.entryIndexesByPath.get(metadata.path);
		if (entries) entries.replace(document.entries);
		else this.entryIndexesByPath.set(metadata.path, new ArraySessionIndex(document.entries));
		return document.metadata;
	}

	/** 列出会话元数据；传 cwd 时只列该目录下的会话。 */
	list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		this.assertOpen();
		return this.operations.enqueueBarrier(() => this.listSessions(options));
	}

	/** 实际扫描会话目录并读取各文件头部元数据，按创建时间倒序排列。 */
	private async listSessions(options: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
		const dirs = options.cwd ? [await this.getSessionDir(options.cwd)] : await this.listSessionDirs();
		const sessions: JsonlSessionMetadata[] = [];
		for (const dir of dirs) {
			if (!getFileSystemResultOrThrow(await this.fs.exists(dir), `Failed to check session directory ${dir}`))
				continue;
			const files = getFileSystemResultOrThrow(
				await this.fs.listDir(dir),
				`Failed to list sessions in ${dir}`,
			).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
			for (const file of files) sessions.push(await loadJsonlSessionMetadata(this.fs, file.path));
		}
		return sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	}

	/** 向会话文件追加一条条目，并同步更新内存索引。 */
	private appendEntry(metadata: JsonlSessionMetadata, entry: SessionTreeEntry): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () => {
			if (
				!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
			) {
				throw new SessionError("not_found", `Session not found: ${metadata.path}`);
			}
			let entries = this.entryIndexesByPath.get(metadata.path);
			if (!entries) {
				await this.loadDocument(metadata);
				entries = this.entryIndexesByPath.get(metadata.path)!;
			}
			if (entries.has(entry.id)) throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
			getFileSystemResultOrThrow(
				await this.fs.appendFile(metadata.path, `${JSON.stringify(entry)}\n`),
				`Failed to append session entry ${entry.id}`,
			);
			entries.append(entry);
		});
	}

	/** 删除一个会话文件，并清除相关的内存缓存。 */
	delete(metadata: JsonlSessionMetadata): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), async () => {
			getFileSystemResultOrThrow(
				await this.fs.remove(metadata.path, { force: true }),
				`Failed to delete session ${metadata.path}`,
			);
			this.entryIndexesByPath.delete(metadata.path);
			this.operationKeysByPath.delete(metadata.path);
		});
	}

	/** 从源会话按选择策略派生一个新会话，返回其存储句柄。 */
	fork(
		source: JsonlSessionMetadata,
		options: JsonlSessionCreateOptions,
		selection: SessionForkSelection,
	): Promise<SessionStorage<JsonlSessionMetadata>> {
		this.assertOpen();
		const descriptor = createDocumentDescriptor(options);
		const sourceEntries = this.operations.enqueue(this.operationKey(source), async () => {
			if (!getFileSystemResultOrThrow(await this.fs.exists(source.path), `Failed to check session ${source.path}`)) {
				throw new SessionError("not_found", `Session not found: ${source.path}`);
			}
			const document = await loadJsonlSession(this.fs, source.path);
			const entries = this.entryIndexesByPath.get(source.path);
			if (entries) entries.replace(document.entries);
			else this.entryIndexesByPath.set(source.path, new ArraySessionIndex(document.entries));
			return readSessionEntriesForFork(this.entryIndexesByPath.get(source.path)!, selection);
		});
		return this.operations.enqueue(descriptor.operationKey, async () =>
			this.storage(
				await this.createDocument(
					descriptor,
					options,
					options.parentSessionPath ?? source.path,
					options.metadata ?? source.metadata,
					await sourceEntries,
				),
			),
		);
	}

	/** 释放后端：标记为已释放并等待所有排队操作结束。 */
	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.disposePromise) {
			this.disposed = true;
			this.disposePromise = this.operations.drain();
		}
		await this.disposePromise;
	}

	/** 若后端已释放则抛出错误。 */
	private assertOpen(): void {
		if (this.disposed) throw new SessionError("storage", "JSONL session repository is disposed");
	}

	/** 获取会话文件对应的操作队列 key（优先用创建时生成的 key）。 */
	private operationKey(metadata: JsonlSessionMetadata): string {
		return this.operationKeysByPath.get(metadata.path) ?? metadata.path;
	}

	/** 在磁盘上创建会话文件（写入头部与初始条目），并建立内存索引。 */
	private async createDocument(
		descriptor: SessionDocumentDescriptor,
		options: JsonlSessionCreateOptions,
		parentSessionPath: string | undefined,
		metadata: Record<string, unknown> | undefined,
		entries: readonly SessionTreeEntry[],
	): Promise<JsonlSessionMetadata> {
		const dir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(dir, { recursive: true }),
			`Failed to create session directory ${dir}`,
		);
		const path = getFileSystemResultOrThrow(
			await this.fs.joinPath([dir, descriptor.fileName]),
			`Failed to resolve session file path for ${descriptor.id}`,
		);
		if (getFileSystemResultOrThrow(await this.fs.exists(path), `Failed to check session ${path}`)) {
			throw new SessionError("invalid_session", `Session already exists: ${path}`);
		}
		const header: SessionHeader = {
			type: "session",
			version: 3,
			id: descriptor.id,
			timestamp: descriptor.timestamp,
			cwd: options.cwd,
			parentSession: parentSessionPath,
			metadata,
		};
		const content = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry)), ""].join("\n");
		getFileSystemResultOrThrow(await this.fs.writeFile(path, content), `Failed to create session ${path}`);
		this.entryIndexesByPath.set(path, new ArraySessionIndex(entries));
		this.operationKeysByPath.set(path, descriptor.operationKey);
		return metadataFromHeader(header, path);
	}

	/** 在会话的操作队列中执行一次对内存索引的读操作。 */
	private readIndex<T>(metadata: JsonlSessionMetadata, read: (entries: ArraySessionIndex) => T): Promise<T> {
		this.assertOpen();
		return this.operations.enqueue(this.operationKey(metadata), () => read(this.entryIndex(metadata.path)));
	}

	/** 基于后端方法组装一个 SessionStorage 存储句柄。 */
	private storage(metadata: JsonlSessionMetadata): SessionStorage<JsonlSessionMetadata> {
		return {
			metadata,
			readHead: () => this.readIndex(metadata, (entries) => entries.readHead()),
			readEntry: (id) => this.readIndex(metadata, (entries) => entries.readEntry(id)),
			readEntries: (options) => this.readIndex(metadata, (entries) => entries.readEntries(options)),
			appendEntry: (entry) => this.appendEntry(metadata, entry),
			findEntriesOnBranch: (query) => this.readIndex(metadata, (entries) => entries.findEntriesOnBranch(query)),
			readPathToRootOrCompaction: (leafId) =>
				this.readIndex(metadata, (entries) => entries.readPathToRootOrCompaction(leafId)),
			getLabel: (id) => this.readIndex(metadata, (entries) => entries.getLabel(id)),
			getName: () => this.readIndex(metadata, (entries) => entries.getName()),
			getStats: () => this.readIndex(metadata, (entries) => entries.getStats()),
		};
	}

	/** 获取指定路径会话的内存索引，未加载则报错。 */
	private entryIndex(path: string): ArraySessionIndex {
		const entries = this.entryIndexesByPath.get(path);
		if (!entries) throw new SessionError("not_found", `Session not found: ${path}`);
		return entries;
	}

	/** 惰性解析并缓存会话根目录的绝对路径。 */
	private async getSessionsRoot(): Promise<string> {
		this.sessionsRoot ??= getFileSystemResultOrThrow(
			await this.fs.absolutePath(this.sessionsRootInput),
			`Failed to resolve sessions root ${this.sessionsRootInput}`,
		);
		return this.sessionsRoot;
	}

	/** 计算指定 cwd 对应的会话目录路径（用编码后的 cwd 命名子目录）。 */
	private async getSessionDir(cwd: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
			`Failed to resolve session directory for ${cwd}`,
		);
	}

	/** 列出会话根目录下的所有子目录（每个目录对应一个 cwd）。 */
	private async listSessionDirs(): Promise<string[]> {
		const root = await this.getSessionsRoot();
		if (!getFileSystemResultOrThrow(await this.fs.exists(root), `Failed to check sessions root ${root}`)) return [];
		return getFileSystemResultOrThrow(await this.fs.listDir(root), `Failed to list sessions root ${root}`)
			.filter((entry) => entry.kind === "directory")
			.map((entry) => entry.path);
	}
}

/** JsonlSessionRepository 的构造选项。 */
export interface JsonlSessionRepositoryOptions extends JsonlSessionBackendOptions {
	/** 默认的上下文构建选项。 */
	contextBuildOptions?: SessionContextBuildOptions;
}

/**
 * JSONL 会话仓库：面向外部提供的门面，负责把后端存储句柄包装为 {@link Session}。
 * 底层数据以 `.jsonl` 文件形式持久化在磁盘上。
 */
export class JsonlSessionRepository
	implements SessionRepository<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>
{
	/** 底层的 JSONL 后端。 */
	private readonly backend: JsonlSessionBackend;
	/** 创建 Session 时使用的默认上下文构建选项。 */
	private readonly contextBuildOptions: SessionContextBuildOptions;

	/**
	 * 构造 JSONL 会话仓库。
	 * @param options - 后端选项与上下文构建选项。
	 */
	constructor(options: JsonlSessionRepositoryOptions) {
		const { contextBuildOptions, ...backendOptions } = options;
		this.backend = new JsonlSessionBackend(backendOptions);
		this.contextBuildOptions = contextBuildOptions ?? {};
	}

	/** 创建并打开一个新会话。 */
	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		return createSession(await this.backend.create(options), this.contextBuildOptions);
	}

	/** 按元数据打开一个已有会话。 */
	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		return createSession(await this.backend.open(metadata), this.contextBuildOptions);
	}

	/** 列出会话元数据。 */
	async list(options?: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
		return await this.backend.list(options);
	}

	/** 删除一个会话。 */
	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		await this.backend.delete(metadata);
	}

	/** 从源会话按选择策略派生一个新会话。 */
	async fork(
		source: JsonlSessionMetadata,
		options: SessionForkOptions & JsonlSessionCreateOptions,
	): Promise<Session<JsonlSessionMetadata>> {
		const { entryId: _entryId, position: _position, ...createOptions } = options;
		return createSession(
			await this.backend.fork(source, createOptions, createSessionForkSelection(options)),
			this.contextBuildOptions,
		);
	}

	/** 释放底层后端。 */
	async [Symbol.asyncDispose](): Promise<void> {
		await this.backend[Symbol.asyncDispose]();
	}
}

/**
 * 基于 auth.json 文件的凭据存储（CredentialStore）实现。
 * 提供方的认证编排属于 ModelRuntime 与 pi-ai Models 的职责。
 */

import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

/** 存储文件的数据结构：按 provider ID 索引的凭据映射。 */
type AuthStorageData = Record<string, Credential>;

/** 一次锁内读写操作的结果：返回值，以及（可选）要写回文件的下一份内容。 */
type LockResult<T> = {
	result: T;
	next?: string;
};

/** 写 auth.json 时使用的文件选项：UTF-8 编码，权限 0600。 */
const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

/** 读取文件后的内存状态：数据、文件修订号，以及进行中的重新加载 Promise。 */
type AuthFileReadState = {
	data: AuthStorageData;
	revision?: string;
	reload?: Promise<AuthStorageData>;
};

/** 跨实例共享的读取状态，使同一 authPath 的多个 AuthStorage 能复用内存快照。 */
let sharedAuthFileReadState: { authPath: string; readState: AuthFileReadState } | undefined;

/** 计算文件修订号（基于设备、inode、大小与 mtime/ctime），用于检测文件变化。 */
function getFileRevision(path: string): string | undefined {
	try {
		const stats = statSync(path, { bigint: true });
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	} catch {
		return undefined;
	}
}

/** 存储后端抽象：在互斥锁内读写当前内容，同步与异步两种形式。 */
export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

/** 基于文件（auth.json）的存储后端：用 proper-lockfile 保证并发安全。 */
export class FileAuthStorageBackend implements AuthStorageBackend {
	/** auth.json 的完整路径。 */
	private authPath: string;

	/** @param authPath 认证文件路径，默认位于 agent 目录下。 */
	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	/** 确保文件所在目录存在（权限 0700）。 */
	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	/** 确保文件存在；不存在时以空对象 `{}` 初始化。 */
	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
			chmodSync(this.authPath, 0o600);
		}
	}

	/** 同步获取文件锁，遇 `ELOCKED` 时短时重试。 */
	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// 同步忙等，避免把调用方改成异步。
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	/** 同步持锁执行读取-修改-写入流程。 */
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	/** 异步持锁执行读取-修改-写入流程，并在锁被破坏时抛错。 */
	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// 锁已被破坏时忽略解锁错误。
				}
			}
		}
	}
}

/** 纯内存的存储后端：无文件 I/O，用于测试与内存会话。 */
export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	/** 内存中的文件内容。 */
	private value: string | undefined;

	/** 同步持锁读写内存内容。 */
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	/** 异步持锁读写内存内容。 */
	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * 凭据存储：由 JSON 文件（或任意后端）支撑，实现 CredentialStore 接口。
 */
export class AuthStorage implements CredentialStore {
	/** 底层存储后端。 */
	private storage: AuthStorageBackend;
	/** auth.json 路径（内存后端时为 undefined）。 */
	private authPath: string | undefined;
	/** 当前的文件读取状态（数据快照 + 修订号）。 */
	private readState: AuthFileReadState;

	/** 私有构造函数：请通过静态工厂方法创建实例。 */
	private constructor(storage: AuthStorageBackend, authPath?: string) {
		this.storage = storage;
		this.authPath = authPath;
		this.readState =
			authPath && sharedAuthFileReadState?.authPath === authPath ? sharedAuthFileReadState.readState : { data: {} };
		if (authPath) {
			sharedAuthFileReadState = { authPath, readState: this.readState };
			const revision = getFileRevision(authPath);
			if (revision !== undefined && revision === this.readState.revision) return;
		}
		this.reload();
	}

	/** 创建基于文件存储的 AuthStorage。 @param authPath 认证文件路径。 */
	static create(authPath: string = join(getAgentDir(), "auth.json")): AuthStorage {
		const normalizedAuthPath = normalizePath(authPath);
		return new AuthStorage(new FileAuthStorageBackend(normalizedAuthPath), normalizedAuthPath);
	}

	/** 从任意存储后端创建 AuthStorage。 */
	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	/** 创建预置初始数据的纯内存 AuthStorage。 */
	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/** 解析文件内容为凭据数据；空内容视为空对象。 */
	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	/** 更新内存中的读取状态（数据与修订号）。 */
	private updateReadState(data: AuthStorageData, revision?: string): void {
		this.readState.data = data;
		this.readState.revision = revision;
	}

	/** 从存储中重新加载凭据。 */
	reload(): void {
		let content: string | undefined;
		let revision: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: undefined };
			});
			this.updateReadState(this.parseStorageData(content), revision);
		} catch {
			// 保留最后一个有效的内存快照。
		}
	}

	/** 异步从存储重新加载并返回最新数据。 */
	private async reloadFromStorageAsync(): Promise<AuthStorageData> {
		return this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const revision = this.authPath ? getFileRevision(this.authPath) : undefined;
			this.updateReadState(currentData, revision);
			return { result: currentData };
		});
	}

	/** 读取最新数据：文件未变则用内存快照，否则触发异步重新加载。 */
	private async readLatestData(): Promise<AuthStorageData> {
		if (this.authPath) {
			const revision = getFileRevision(this.authPath);
			if (revision !== undefined && revision === this.readState.revision) return this.readState.data;
		}
		if (!this.readState.reload) {
			this.readState.reload = this.reloadFromStorageAsync().catch(() => this.readState.data);
		}
		try {
			return await this.readState.reload;
		} finally {
			this.readState.reload = undefined;
		}
	}

	/** 读取指定 provider 的凭据；对 api_key 会解析其中可能的环境变量占位。 */
	async read(provider: string): Promise<Credential | undefined> {
		const credential = (await this.readLatestData())[provider];
		if (credential?.type !== "api_key") return credential;
		if (credential.key === undefined) return credential;
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	/** 在锁内修改指定 provider 的凭据：返回 undefined 表示删除，否则写回新值。 */
	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		let latestData = this.readState.data;
		let revision: string | undefined;
		const result = await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const next = await fn(currentData[provider]);
			if (next === undefined) {
				latestData = currentData;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: currentData[provider] };
			}

			const merged: AuthStorageData = { ...currentData, [provider]: next };
			latestData = merged;
			return { result: next, next: JSON.stringify(merged, null, 2) };
		});
		this.updateReadState(latestData, revision);
		return result;
	}

	/** 删除指定 provider 的凭据并写回存储。 */
	async delete(provider: string): Promise<void> {
		let latestData = this.readState.data;
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			delete currentData[provider];
			latestData = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		});
		this.updateReadState(latestData);
	}

	/** 列出所有凭据的元信息（provider ID 与类型），不解析配置的 key 值。 */
	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(await this.readLatestData()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}
}

/**
 * 一次性同步读取 auth.json 中存储的凭据，
 * 不实例化存储对象，也不解析配置的 key 值。
 */
export function readStoredCredential(
	providerId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
): Credential | undefined {
	try {
		const data = JSON.parse(readFileSync(normalizePath(authPath), "utf-8")) as AuthStorageData;
		return data[providerId];
	} catch {
		return undefined;
	}
}

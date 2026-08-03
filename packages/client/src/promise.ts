/** Promise 的三个组成部分：Promise 本体以及可在外部触发的 resolve / reject 回调。 */
export interface PromiseResolvers<T> {
	/** 待结算的 Promise 本体。 */
	promise: Promise<T>;
	/** 用成功值结算该 Promise。 */
	resolve(value: T | PromiseLike<T>): void;
	/** 用失败原因结算该 Promise。 */
	reject(reason?: unknown): void;
}

/** 当仓库的 TypeScript lib 基线升级到 ES2024 后，可用 `Promise.withResolvers()` 替代本函数。 */
export function createPromiseResolvers<T>(): PromiseResolvers<T> {
	let resolve!: PromiseResolvers<T>["resolve"];
	let reject!: PromiseResolvers<T>["reject"];
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

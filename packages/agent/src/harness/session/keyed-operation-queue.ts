/**
 * 键控操作队列：按 key 串行执行操作（同一 key 的操作排队逐个运行），
 * 不同 key 之间可并行；还支持全局并发上限与屏障（barrier）操作。
 */
export class KeyedOperationQueue<TKey> {
	/** 每个 key 对应的队列尾部 Promise，用于链式串行。 */
	private readonly tails = new Map<TKey, Promise<void>>();
	/** 全局最大并发操作数；undefined 表示不限制。 */
	private readonly maxConcurrentOperations: number | undefined;
	/** 等待并发名额的解析函数队列。 */
	private readonly permitWaiters: Array<() => void> = [];
	/** 当前活跃的操作数。 */
	private activeOperations = 0;
	/** 屏障 Promise：所有屏障操作按提交顺序全局串行。 */
	private barrier: Promise<void> = Promise.resolve();

	/**
	 * 构造键控操作队列。
	 * @param options - 可选的全局并发上限。
	 */
	constructor(options: { maxConcurrentOperations?: number } = {}) {
		if (
			options.maxConcurrentOperations !== undefined &&
			(!Number.isInteger(options.maxConcurrentOperations) || options.maxConcurrentOperations < 1)
		) {
			throw new RangeError("maxConcurrentOperations must be a positive integer");
		}
		this.maxConcurrentOperations = options.maxConcurrentOperations;
	}

	/** 将操作按 key 排队：同一 key 的操作串行执行，返回操作结果。 */
	enqueue<T>(key: TKey, operation: () => Promise<T> | T): Promise<T> {
		const previous = this.tails.get(key) ?? Promise.resolve();
		const result = Promise.all([this.barrier, previous]).then(() => this.runOperation(operation));
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return result;
	}

	/** 以屏障方式排队：等待所有已排队的操作（含其他 key 的）完成后执行。 */
	enqueueBarrier<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = Promise.all([this.barrier, ...this.tails.values()]).then(() => this.runOperation(operation));
		this.barrier = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** 等待当前所有排队与进行中的操作全部结束。 */
	async drain(): Promise<void> {
		await Promise.all([this.barrier, ...this.tails.values()]);
	}

	/** 获取并发名额后执行操作，最终释放名额。 */
	private async runOperation<T>(operation: () => Promise<T> | T): Promise<T> {
		await this.acquirePermit();
		try {
			return await operation();
		} finally {
			this.releasePermit();
		}
	}

	/** 申请一个并发名额；若已达上限则等待空闲名额。 */
	private async acquirePermit(): Promise<void> {
		if (this.maxConcurrentOperations === undefined) return;
		if (this.activeOperations < this.maxConcurrentOperations) {
			this.activeOperations += 1;
			return;
		}
		await new Promise<void>((resolve) => this.permitWaiters.push(resolve));
	}

	/** 释放一个并发名额：优先唤醒等待者，否则递减活跃计数。 */
	private releasePermit(): void {
		if (this.maxConcurrentOperations === undefined) return;
		const next = this.permitWaiters.shift();
		if (next) next();
		else this.activeOperations -= 1;
	}
}

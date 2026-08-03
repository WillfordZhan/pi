import { dirname, join } from "node:path";
import {
	type Api,
	type ApiStreamOptions,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createModels,
	lazyStream,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	ModelsError,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type ModelsStreamTransforms,
	type MutableModels,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "../config.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { ModelConfig } from "./model-config.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { withRemoteCatalog } from "./remote-catalog-provider.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";

/** 模型运行时的一次性快照：全部模型、可用模型、已配置/已存储的 provider 与认证检查。 */
interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

/** 创建 ModelRuntime 时的选项。 */
export interface CreateModelRuntimeOptions {
	/** 凭据存储；默认使用 authPath 对应的文件存储。 */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	/** 是否允许 create() 通过网络刷新模型目录；默认为 false。 */
	allowModelNetwork?: boolean;
	/** 创建期网络刷新模型目录的超时时间。 */
	modelRefreshTimeoutMs?: number;
	catalogBaseUrl?: string;
}

/** 覆盖认证解析的选项。 */
export interface ModelRuntimeAuthOverrides {
	apiKey?: string;
	env?: Record<string, string>;
	/** 要求 OAuth token 至少剩余多少有效时间；默认五分钟。 */
	minOAuthValidityMs?: number;
}

/** 合并两套请求头：覆盖值按名称（大小写不敏感）替换基础值。 */
function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/** 供 coding-agent 与 SDK 使用者使用的 pi-ai Models 集合实现。 */
export class ModelRuntime implements Models {
	/** 底层的可变模型集合。 */
	private readonly models: MutableModels;
	/** 运行时凭据（含运行期 API key 覆盖）。 */
	private readonly credentials: RuntimeCredentials;
	/** 内置 provider 的原始快照。 */
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	/** 当前生效的内置 provider。 */
	private readonly builtins = new Map<string, Provider>();
	/** 以原生 Provider 实例注册的扩展 provider。 */
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	/** 以配置形式注册的扩展 provider。 */
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	/** provider 组合失败的错误信息，按 provider ID 索引。 */
	private readonly compositionErrors = new Map<string, string>();
	/** models.json 路径（无文件时为 undefined）。 */
	private readonly modelsPath: string | undefined;
	/** 是否允许启动期联网刷新模型目录。 */
	private readonly modelNetworkEnabled: boolean;
	/** 模型配置（models.json 解析结果）。 */
	private config: ModelConfig;
	/** 当前对外可见的快照。 */
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	/** 进行中的可用性刷新 Promise（用于合并并发读取）。 */
	private availabilityRefresh: Promise<void> | undefined;
	/** 可用性刷新序号，用于丢弃过期结果。 */
	private availabilityRefreshSeq = 0;
	/** 最近一次可用性刷新的错误信息。 */
	private availabilityError: string | undefined;

	/** 私有构造函数：请使用静态工厂方法 `create`。 */
	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		modelNetworkEnabled: boolean,
	) {
		this.credentials = credentials;
		this.config = config;
		this.modelsPath = modelsPath;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		this.models = createModels({ credentials, modelsStore });
		this.rebuildProviders();
	}

	/** 创建 ModelRuntime：加载配置、组装 provider、并按需做一次网络刷新。 */
	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
		const providers = builtinProviderCatalog
			.builtinProviders()
			.map((provider) =>
				provider.id === "radius"
					? provider
					: withRemoteCatalog(provider, options.catalogBaseUrl, builtinModelDataGeneratedAt),
			);
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			process.env.PI_OFFLINE === undefined,
		);
		runtime.configureRadiusProviders();
		runtime.rebuildProviders();
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		const controller = refreshFromNetwork ? new AbortController() : undefined;
		const timeout = controller
			? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs ?? 15_000)
			: undefined;
		try {
			await runtime.refresh({ allowNetwork: refreshFromNetwork, signal: controller?.signal });
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return runtime;
	}

	/** 根据配置为使用 radius OAuth 的 provider 注入内置的 radius provider 实现。 */
	private configureRadiusProviders(): void {
		this.builtins.clear();
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		for (const providerId of this.config.getProviderIds()) {
			const config = this.config.getProvider(providerId);
			if (config?.oauth !== "radius" || !config.baseUrl) continue;
			this.builtins.set(
				providerId,
				builtinProviderCatalog.radiusProvider({
					id: providerId,
					name: config.name ?? providerId,
					gateway: config.baseUrl.replace(/\/v1\/?$/u, ""),
				}),
			);
		}
	}

	/** 汇总所有 provider ID：内置 + 原生扩展 + 配置 + 配置化扩展。 */
	private providerIds(): Set<string> {
		return new Set([
			...this.builtins.keys(),
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
			...this.extensionProviders.keys(),
		]);
	}

	/** 重新组合单个 provider：合并配置与扩展覆盖，失败时回退到基础实现并记录错误。 */
	private recomposeProvider(providerId: string): void {
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!base && !this.config.getProvider(providerId) && !extension) {
			this.models.deleteProvider(providerId);
			this.compositionErrors.delete(providerId);
			return;
		}
		if (base && !this.config.getProvider(providerId) && !extension) {
			// 无覆盖：原样使用内置 provider，以保持其 auth/login/stream 行为完全一致。
			this.models.setProvider(base);
			this.compositionErrors.delete(providerId);
			return;
		}
		try {
			this.models.setProvider(composeModelProvider(providerId, base, this.config, extension));
			this.compositionErrors.delete(providerId);
		} catch (error) {
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			if (base) this.models.setProvider(base);
			else this.models.deleteProvider(providerId);
		}
	}

	/** 清空并重建所有 provider，随后更新模型快照。 */
	private rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}

	/** 更新快照中的全部模型，并按已配置 provider 过滤可用模型。 */
	private updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	/** 执行一次可用性刷新（可用模型 + 认证检查 + 凭据列表），并用序号防止过期结果覆盖快照。 */
	private async runAvailabilityRefresh(seq: number): Promise<void> {
		const providers = this.models.getProviders();
		const [available, checks, credentials] = await Promise.all([
			this.models.getAvailable(),
			Promise.all(
				providers.map(
					async (provider): Promise<[string, AuthCheck | undefined]> => [
						provider.id,
						await this.models.checkAuth(provider.id),
					],
				),
			),
			this.credentials.list(),
		]);
		// 刷新期间可能有更新的重建请求；丢弃本次结果，
		// 避免一个缓慢且已被取代的刷新用过期数据覆盖快照。
		if (seq !== this.availabilityRefreshSeq) return;
		const auth = new Map(checks);
		const configuredProviders = new Set(
			checks
				.filter((entry): entry is [string, AuthCheck] => entry[1] !== undefined)
				.map(([providerId]) => providerId),
		);
		this.snapshot = {
			all: [...this.models.getModels()],
			available: [...available],
			configuredProviders,
			storedProviders: new Set(credentials.map((entry) => entry.providerId)),
			auth,
		};
		this.availabilityError = undefined;
	}

	/** 排队启动一次可用性刷新；只有最新一次刷新的错误会写入状态。 */
	private queueAvailabilityRefresh(): Promise<void> {
		const seq = ++this.availabilityRefreshSeq;
		const refresh = this.runAvailabilityRefresh(seq);
		const recorded = refresh.catch((error) => {
			// 只有最新请求的重建拥有错误状态的所有权。
			if (seq === this.availabilityRefreshSeq) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		});
		const tracked = recorded.finally(() => {
			if (this.availabilityRefresh === tracked) this.availabilityRefresh = undefined;
		});
		this.availabilityRefresh = tracked;
		return tracked;
	}

	/** 把并发读取合并到同一次进行中的刷新上。 */
	private refreshAvailability(): Promise<void> {
		return this.availabilityRefresh ?? this.queueAvailabilityRefresh();
	}

	/**
	 * 变更必须观察到其状态变化之后开始的刷新，且卡住的进行中刷新不应阻塞它们。
	 * 因此启动一次全新的独立刷新，而不是挂到待处理的刷新上。
	 * runAvailabilityRefresh 中的序号保护保证被取代的刷新不会覆盖其结果。
	 */
	private forceRefreshAvailability(): Promise<void> {
		return this.queueAvailabilityRefresh();
	}

	/** 返回全部 provider。 */
	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	/** 按 ID 获取 provider。 */
	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	/** 获取全部（或指定 provider 的）模型。 */
	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	/** 按 provider 与模型 ID 获取模型。 */
	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	/** 检查指定 provider 的认证状态。 */
	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId);
	}

	/** 获取可用模型；指定 provider 时仅返回该 provider 的结果。 */
	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		if (providerId) {
			if (this.availabilityRefresh) {
				await this.availabilityRefresh;
				return this.snapshot.available.filter((model) => model.provider === providerId);
			}
			try {
				return await this.models.getAvailable(providerId);
			} catch (error) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
				throw error;
			}
		}
		await this.refreshAvailability();
		return this.snapshot.available;
	}

	/** 返回最近一次可用性刷新的快照结果。 */
	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	/** 汇总配置、provider 组合与可用性刷新的全部错误信息。 */
	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	/** 获取按配置注册的 provider 配置。 */
	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	/** 获取所有注册过的 provider ID（配置化 + 原生扩展）。 */
	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	/** 获取按原生 Provider 实例注册的 provider。 */
	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}

	/** @internal 当 provider 认证未配置时，供 ModelRegistry 使用的兼容性回退。 */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
		);
	}

	/** 判断 provider 是否使用 OAuth 认证。 */
	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	/** 判断 provider 是否已配置认证。 */
	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	/** 获取认证结果：按 provider 或按模型解析，并合并配置化的请求头。 */
	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		const resolution = await this.models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		const configuredHeaders = resolveConfiguredModelHeaders(
			providerOrModel,
			this.config.getProvider(providerOrModel.provider),
			this.extensionProviders.get(providerOrModel.provider),
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		return {
			...resolution,
			auth: {
				...resolution.auth,
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	/** 设置运行期 API key（不持久化），并立即刷新可用模型。 */
	async setRuntimeApiKey(
		providerId: string,
		apiKey: string,
		refreshOptions: ModelsRefreshOptions = {},
	): Promise<void> {
		this.credentials.setRuntimeApiKey(providerId, apiKey);
		const auth = new Map(this.snapshot.auth).set(providerId, { type: "api_key", source: "runtime API key" });
		const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
		const storedProviders = new Set(this.snapshot.storedProviders).add(providerId);
		this.snapshot = {
			...this.snapshot,
			auth,
			configuredProviders,
			storedProviders,
			available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
		};
		await this.refresh(refreshOptions);
	}

	/** 移除运行期 API key 并刷新可用模型。 */
	async removeRuntimeApiKey(providerId: string): Promise<void> {
		this.credentials.removeRuntimeApiKey(providerId);
		await this.refresh({ allowNetwork: this.modelNetworkEnabled });
	}

	/** 列出全部存储的凭据信息。 */
	listCredentials(): Promise<readonly CredentialInfo[]> {
		return this.credentials.list();
	}

	/** 汇总 provider 的认证状态来源（运行时 / 存储 / 配置 / 环境）。 */
	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		const configured = configuredRequestAuthStatus(
			this.config.getProvider(providerId),
			this.extensionProviders.get(providerId),
		);
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	/** 准备一次模型请求：解析 provider、合并认证与头信息，返回可调用的参数。 */
	private async prepareRequest(
		model: Model<Api>,
		options: (StreamOptions & ModelsStreamTransforms) | undefined,
	): Promise<{ provider: Provider; model: Model<Api>; options: StreamOptions }> {
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, { apiKey: options?.apiKey, env: options?.env });
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		const { transformHeaders, ...providerOptions } = options ?? {};
		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		return {
			provider,
			model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model,
			options: {
				...providerOptions,
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				env,
			},
		};
	}

	/** 以流式方式调用模型，返回事件流。 */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(
				model,
				options as (StreamOptions & ModelsStreamTransforms) | undefined,
			);
			return prepared.provider.stream(
				prepared.model as Model<TApi>,
				context,
				prepared.options as ApiStreamOptions<TApi>,
			);
		});
	}

	/** 同步完成模型调用，返回完整回复。 */
	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	/** 以简化选项流式调用模型（用于简易 API 场景）。 */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(model, options);
			return prepared.provider.streamSimple(prepared.model, context, prepared.options as SimpleStreamOptions);
		});
	}

	/** 以简化选项同步完成模型调用。 */
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	/** 发起登录流程，成功后刷新可用模型。 */
	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const credential = await this.models.login(providerId, type, interaction);
		await this.refresh({ allowNetwork: this.modelNetworkEnabled });
		return credential;
	}

	/** 退出登录并刷新模型；在刷新跳过未配置 provider 前先重置其兼容性投影。 */
	async logout(providerId: string): Promise<void> {
		await this.models.logout(providerId);
		// 在刷新跳过未配置 provider 之前，重置依赖凭据的兼容性投影。
		this.recomposeProvider(providerId);
		await this.refresh({ allowNetwork: this.modelNetworkEnabled });
	}

	/** 刷新模型：重新加载配置、重建 provider，并触发可用性刷新。 */
	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		this.config = await ModelConfig.load(this.modelsPath);
		this.configureRadiusProviders();
		this.rebuildProviders();
		const refreshOptions = {
			...options,
			allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
		};
		// 已发布的 pi-ai 构建在 ModelsStore 返回 void 且接受 provider ID 之前。
		// 该回退让源码模式的 CLI 测试无需重建 workspace 依赖也能工作。
		const result = ((await this.models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
			aborted: refreshOptions.signal?.aborted ?? false,
			errors: new Map(),
		};
		this.updateModelSnapshot();
		try {
			await this.forceRefreshAvailability();
		} catch {
			// 可用性错误由 forceRefreshAvailability 记录；刷新后的模型仍然可用。
		}
		return result;
	}

	/** 以原生 Provider 实例注册扩展 provider。 */
	registerNativeProvider(provider: Provider): void {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}

	/** 以配置形式注册扩展 provider；重复注册时合并已定义字段并保留 undefined。 */
	registerProvider(providerId: string, config: ProviderConfigInput): void {
		// 像旧注册表一样独立校验本次注册：损坏的重复注册必须抛错，且不触碰已存配置。
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		this.nativeExtensionProviders.delete(providerId);
		// 重复注册会合并已定义的值到上一次注册之上，并保留 undefined，
		// 以匹配旧 ModelRegistry 的契约。
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		if (
			this.snapshot.storedProviders.has(providerId) ||
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective)?.configured
		) {
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			const auth = new Map(this.snapshot.auth);
			// 异步刷新落地前的临时条目；绝不覆盖真实的检查结果。
			if (!auth.get(providerId)) {
				auth.set(providerId, {
					type: effective.oauth && !effective.apiKey ? "oauth" : "api_key",
					source: "configured provider",
				});
			}
			this.snapshot = {
				...this.snapshot,
				auth,
				configuredProviders,
				available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
			};
		}
		void this.refresh({ allowNetwork: false });
	}

	/** 注销 provider（配置化与原生扩展两种形式都移除）。 */
	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}
}

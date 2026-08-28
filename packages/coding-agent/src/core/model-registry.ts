import type {
	Api,
	AssistantMessage,
	AuthResult,
	Context,
	Model,
	ModelsApiStreamOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	Provider,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./model-runtime.ts";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer.ts";

export type { ProviderConfigInput } from "./provider-composer.ts";
/** 解析后的请求认证结果：成功携带 apiKey/headers/env，失败携带错误信息。 */
export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: ProviderHeaders;
			baseUrl?: string;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };
export { clearApiKeyCache } from "./provider-composer.ts";

/**
 * 面向扩展暴露的同步兼容门面（facade）。
 * coding-agent 内部直接使用 ModelRuntime，此注册表仅供扩展使用。
 */
export class ModelRegistry {
	/** 底层模型运行时。 */
	private readonly runtime: ModelRuntime;

	/** @param runtime 底层的 ModelRuntime 实例。 */
	constructor(runtime: ModelRuntime) {
		this.runtime = runtime;
	}

	/** Reload models.json asynchronously. Await before making synchronous registry reads. */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		return this.runtime.refresh(options);
	}

	/** 获取当前模型的错误信息（配置错误、组合错误等）。 */
	getError(): string | undefined {
		return this.runtime.getError();
	}

	/** 返回全部已注册模型。 */
	getAll(): Model<Api>[] {
		return [...this.runtime.getModels()];
	}

	/** 返回当前可用的模型（已配置认证的）。 */
	getAvailable(): Model<Api>[] {
		return [...this.runtime.getAvailableSnapshot()];
	}

	/** 按 provider 与模型 ID 查找模型。 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.runtime.getModel(provider, modelId);
	}

	/** 判断该模型所属的 provider 是否已配置认证。 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.runtime.hasConfiguredAuth(model.provider);
	}

	/** 解析模型的 API key 与请求头；失败时给出可读的错误信息。 */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const resolution = await this.runtime.getAuth(model);
			if (!resolution) {
				const compatibility = this.runtime.getCompatibilityRequestConfig(model);
				if (compatibility.authHeader) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				return { ok: true, headers: compatibility.headers };
			}
			return {
				ok: true,
				apiKey: resolution.auth.apiKey,
				headers: resolution.auth.headers,
				...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
				env: resolution.env,
			};
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			const message =
				cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				error:
					message === "authHeader requires a resolved API key"
						? `No API key found for "${model.provider}"`
						: message,
			};
		}
	}

	/** 获取 provider 的认证状态（未配置 / 环境 / 存储 / 运行时）。 */
	getProviderAuthStatus(provider: string): AuthStatus {
		return this.runtime.getProviderAuthStatus(provider);
	}

	/** 按 ID 获取 provider。 */
	getProvider(provider: string): Provider | undefined {
		return this.runtime.getProvider(provider);
	}

	/** 同步完成一次模型调用并返回完整回复。 */
	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.runtime.complete(model, context, options);
	}

	/** 获取 provider 的显示名称，缺失时回退为 provider ID。 */
	getProviderDisplayName(provider: string): string {
		return this.runtime.getProvider(provider)?.name ?? provider;
	}

	/** 获取 provider 的认证结果（可能携带 API key / 头信息）。 */
	getProviderAuth(provider: string): Promise<AuthResult | undefined> {
		return this.runtime.getAuth(provider);
	}

	/** 获取 provider 的 API key；解析失败时返回 undefined。 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		try {
			return (await this.runtime.getAuth(provider))?.auth.apiKey;
		} catch {
			return undefined;
		}
	}

	/** 判断该模型所属 provider 是否使用 OAuth 认证。 */
	isUsingOAuth(model: Model<Api>): boolean {
		return this.runtime.isUsingOAuth(model.provider);
	}

	/** 注册 provider：可直接传 Provider 实例，也可按名称 + 配置注册。 */
	registerProvider(provider: Provider): void;
	registerProvider(providerName: string, config: ProviderConfigInput): void;
	registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
		if (typeof providerOrName === "string") {
			if (!config) throw new Error("Provider config is required when registering by name");
			this.runtime.registerProvider(providerOrName, config);
			return;
		}
		this.runtime.registerNativeProvider(providerOrName);
	}

	/** 注销一个按名称注册的 provider。 */
	unregisterProvider(providerName: string): void {
		this.runtime.unregisterProvider(providerName);
	}

	/** 获取按名称注册的 provider 配置。 */
	getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
		return this.runtime.getRegisteredProviderConfig(providerName);
	}

	/** 获取按原生 Provider 实例注册的 provider。 */
	getRegisteredNativeProvider(providerName: string): Provider | undefined {
		return this.runtime.getRegisteredNativeProvider(providerName);
	}

	/** 获取所有注册过的 provider ID。 */
	getRegisteredProviderIds(): readonly string[] {
		return this.runtime.getRegisteredProviderIds();
	}
}

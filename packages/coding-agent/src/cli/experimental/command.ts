/** 具名命令调用的基础结构：所有被解析的命令都携带命令名。 */
export interface NamedCommandInvocation {
	readonly command: string;
}

/** 命令解析结果：成功返回命令调用，失败返回错误信息列表。 */
export type CommandParseResult<TInvocation extends NamedCommandInvocation = NamedCommandInvocation> =
	| { readonly ok: true; readonly command: TInvocation }
	| { readonly ok: false; readonly errors: readonly string[] };

/** 命令执行结果：成功返回已执行的命令调用，失败返回错误信息列表。 */
export type CommandExecutionResult<TInvocation extends NamedCommandInvocation = NamedCommandInvocation> =
	| { readonly ok: true; readonly command: TInvocation }
	| { readonly ok: false; readonly errors: readonly string[] };

/** 单个选项值的解析结果：成功返回值，失败返回错误信息。 */
export type CommandOptionParseResult<TValue> =
	| { readonly ok: true; readonly value: TValue }
	| { readonly ok: false; readonly error: string };

/** 命令行选项定义：指定选项名（形如 `--xxx`）以及字符串值的解析方式。 */
export interface CommandOption<TValue> {
	readonly name: `--${string}`;
	parse(value: string): CommandOptionParseResult<TValue>;
}

/** 创建一个带自定义解析函数的选项。 */
export function valueOption<TValue>(
	name: `--${string}`,
	parse: (value: string) => CommandOptionParseResult<TValue>,
): CommandOption<TValue> {
	return { name, parse };
}

/** 创建一个直接透传字符串值的选项（不做额外校验）。 */
export function stringOption(name: `--${string}`): CommandOption<string> {
	return valueOption(name, (value) => ({ ok: true, value }));
}

/** 解析后的命令输入：提供按选项读取单个/多个值，以及剩余的未识别参数。 */
export interface ParsedCommandInput {
	readonly remainingArgs: readonly string[];
	value<TValue>(option: CommandOption<TValue>): TValue | undefined;
	values<TValue>(option: CommandOption<TValue>): readonly TValue[];
}

/** 命令构建（builder）结果：成功返回命令调用，失败返回错误信息列表。 */
export type CommandBuildResult<TInvocation extends NamedCommandInvocation> =
	| { readonly ok: true; readonly command: TInvocation }
	| { readonly ok: false; readonly errors: readonly string[] };

/** 内部使用的可变解析结果：解析过程中逐步累积选项值、剩余参数与错误。 */
interface MutableParsedCommandInput {
	readonly values: Map<string, unknown[]>;
	readonly remainingArgs: string[];
	readonly errors: string[];
}

/** 命令构建函数：根据解析后的输入生成最终的命令调用。 */
type CommandBuilder<TInvocation extends NamedCommandInvocation> = (
	input: ParsedCommandInput,
) => CommandBuildResult<TInvocation>;

/** 命令动作函数：执行命令调用，可访问调用自身的上下文。 */
type CommandAction<TInvocation extends NamedCommandInvocation, TContext> = (
	command: TInvocation,
	context: TContext,
) => void | Promise<void>;

/** 已注册的子命令：统一暴露解析与执行接口，供父命令调度。 */
interface RegisteredCommand {
	parse(argv: readonly string[]): CommandParseResult;
	execute(argv: readonly string[], context: unknown): Promise<CommandExecutionResult>;
}

/**
 * 可组合的命令解析器：支持注册选项、子命令、构建函数与动作。
 * 通过 `.option()` / `.build()` / `.action()` / `.command()` 链式配置。
 */
export class Command<
	TOwnInvocation extends NamedCommandInvocation,
	TContext,
	TInvocation extends NamedCommandInvocation = TOwnInvocation,
> {
	/** 命令名称。 */
	readonly name: string;
	/** 已注册的选项，按选项名索引。 */
	private readonly options = new Map<string, CommandOption<unknown>>();
	/** 已注册的子命令，按命令名索引。 */
	private readonly subcommands = new Map<string, RegisteredCommand>();
	/** 构建函数：把解析后的输入组装成命令调用。 */
	private builder?: CommandBuilder<TOwnInvocation>;
	/** 命令动作：执行构建出的命令调用。 */
	private commandAction?: CommandAction<TOwnInvocation, TContext>;

	/** 构造一个具名命令。 @param name 命令名称。 */
	constructor(name: string) {
		this.name = name;
	}

	/** 注册一个命令行选项；同名选项重复注册会抛出错误。 */
	option<TValue>(option: CommandOption<TValue>): this {
		if (this.options.has(option.name)) {
			throw new Error(`Option ${option.name} is already registered for ${this.name}`);
		}
		this.options.set(option.name, option);
		return this;
	}

	/** 设置构建函数，用于把解析出的选项组装成命令调用。 */
	build(builder: CommandBuilder<TOwnInvocation>): this {
		this.builder = builder;
		return this;
	}

	/** 设置命令动作，在命令被解析并执行时调用。 */
	action(action: CommandAction<TOwnInvocation, TContext>): this {
		this.commandAction = action;
		return this;
	}

	/**
	 * 注册一个子命令；执行时若首参匹配子命令名则交给子命令处理。
	 * 返回合并了子命令上下文的命令，便于链式继续注册。
	 */
	command<
		TSubcommandOwnInvocation extends NamedCommandInvocation,
		TSubcommandContext,
		TSubcommandInvocation extends NamedCommandInvocation,
	>(
		command: Command<TSubcommandOwnInvocation, TSubcommandContext, TSubcommandInvocation>,
	): Command<TOwnInvocation, TContext & TSubcommandContext, TInvocation | TSubcommandInvocation> {
		if (this.subcommands.has(command.name)) throw new Error(`Command ${command.name} is already registered`);
		this.subcommands.set(command.name, {
			parse: (argv) => command.parse(argv),
			execute: (argv, context) => command.execute(argv, context as TSubcommandContext),
		});
		return this as unknown as Command<
			TOwnInvocation,
			TContext & TSubcommandContext,
			TInvocation | TSubcommandInvocation
		>;
	}

	/** 解析命令行参数：若首参命中子命令则交由子命令解析，否则解析自身。 */
	parse(argv: readonly string[]): CommandParseResult<TInvocation> {
		const selected = this.select(argv);
		if (selected) return selected.command.parse(selected.argv) as CommandParseResult<TInvocation>;
		return this.parseOwn(argv) as CommandParseResult<TInvocation>;
	}

	/** 解析并执行命令：命中子命令则调度子命令，否则执行自身动作。 */
	async execute(argv: readonly string[], context: TContext): Promise<CommandExecutionResult<TInvocation>> {
		const selected = this.select(argv);
		if (selected) {
			return selected.command.execute(selected.argv, context) as Promise<CommandExecutionResult<TInvocation>>;
		}

		const parsed = this.parseOwn(argv);
		if (!parsed.ok) return parsed;
		if (!this.commandAction) throw new Error(`Command ${this.name} does not define an action`);
		await this.commandAction(parsed.command, context);
		return { ok: true, command: parsed.command as unknown as TInvocation };
	}

	/** 根据首个参数匹配已注册的子命令；未命中返回 undefined。 */
	private select(argv: readonly string[]): { command: RegisteredCommand; argv: readonly string[] } | undefined {
		const candidate = argv[0];
		if (candidate === undefined) return undefined;
		const command = this.subcommands.get(candidate);
		return command ? { command, argv: argv.slice(1) } : undefined;
	}

	/** 解析本命令自身的选项，并通过构建函数生成命令调用。 */
	private parseOwn(argv: readonly string[]): CommandParseResult<TOwnInvocation> {
		if (!this.builder) throw new Error(`Command ${this.name} does not define a builder`);
		const parsed = this.parseOptions(argv);
		const input: ParsedCommandInput = {
			remainingArgs: parsed.remainingArgs,
			value: <TValue>(option: CommandOption<TValue>) => parsed.values.get(option.name)?.[0] as TValue | undefined,
			values: <TValue>(option: CommandOption<TValue>) => (parsed.values.get(option.name) ?? []) as readonly TValue[],
		};
		const built = this.builder(input);
		const errors = [...parsed.errors, ...(built.ok ? [] : built.errors)];
		if (errors.length > 0) return { ok: false, errors };
		if (!built.ok) throw new Error(`Command ${this.name} failed without an error`);
		return { ok: true, command: built.command };
	}

	/** 逐项解析参数：识别 `--name`、`--name=value` 以及 `--` 结束标记。 */
	private parseOptions(argv: readonly string[]): MutableParsedCommandInput {
		const parsed: MutableParsedCommandInput = {
			values: new Map(),
			remainingArgs: [],
			errors: [],
		};
		for (let index = 0; index < argv.length; index++) {
			const argument = argv[index]!;
			if (argument === "--") {
				parsed.remainingArgs.push(...argv.slice(index));
				break;
			}

			const equals = argument.indexOf("=");
			const name = equals === -1 ? argument : argument.slice(0, equals);
			const option = this.options.get(name);
			if (!option) {
				parsed.remainingArgs.push(...argv.slice(index));
				break;
			}

			let value = equals === -1 ? undefined : argument.slice(equals + 1);
			if (value === undefined) {
				const next = argv[index + 1];
				if (next !== undefined && !next.startsWith("-")) {
					value = next;
					index++;
				}
			}
			if (value === undefined || value === "") {
				parsed.errors.push(`${name} requires a value`);
				continue;
			}

			const values = parsed.values.get(name) ?? [];
			if (values.length > 0) {
				parsed.errors.push(`${name} may only be specified once`);
				continue;
			}
			const result = option.parse(value);
			if (!result.ok) {
				parsed.errors.push(result.error);
				continue;
			}
			values.push(result.value);
			parsed.values.set(name, values);
		}
		return parsed;
	}
}

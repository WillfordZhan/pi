import type { JsonValue, ProtocolError, ProtocolErrorCode } from "@earendil-works/pi-protocol";

/** 服务器返回协议错误时抛出的异常：携带错误码与可选详情。 */
export class PiServerError extends Error {
	/** 协议错误码，用于区分错误类别。 */
	readonly code: ProtocolErrorCode;
	/** 附加的错误详情（JSON 值），可为 undefined。 */
	readonly details: JsonValue | undefined;

	/** @param error 协议层产生的 `ProtocolError`。 */
	constructor(error: ProtocolError) {
		super(error.message);
		this.name = "PiServerError";
		this.code = error.code;
		this.details = error.details;
	}
}

/** 连接未建立或已断开时尝试操作而抛出的异常。 */
export class PiDisconnectedError extends Error {
	/** @param message 错误消息，默认 "Pi client is disconnected"。 */
	constructor(message = "Pi client is disconnected") {
		super(message);
		this.name = "PiDisconnectedError";
	}
}

/** 客户端已被释放（dispose）后仍尝试使用时抛出的异常。 */
export class PiClientDisposedError extends Error {
	constructor() {
		super("Pi client is disposed");
		this.name = "PiClientDisposedError";
	}
}

/** 会话租约所有权冲突时抛出的异常（例如对已被独占的会话再次申请独占）。 */
export class PiSessionOwnershipError extends Error {
	/** 发生冲突的会话 ID。 */
	readonly sessionId: string;

	/** @param sessionId 发生冲突的会话 ID；@param message 错误消息。 */
	constructor(sessionId: string, message: string) {
		super(message);
		this.name = "PiSessionOwnershipError";
		this.sessionId = sessionId;
	}
}

/** 会话已脱离（detach）但仍尝试调用会话方法时抛出的异常。 */
export class PiSessionDetachedError extends Error {
	/** 已脱离的会话 ID。 */
	readonly sessionId: string;

	/** @param sessionId 已脱离的会话 ID。 */
	constructor(sessionId: string) {
		super(`Session ${sessionId} is not attached`);
		this.name = "PiSessionDetachedError";
		this.sessionId = sessionId;
	}
}

/** 将任意未知值规整为 `Error` 对象，便于统一处理异常。 */
export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** 将任意异常规整为 `PiDisconnectedError`；本身已是该类型则原样返回。 */
export function toDisconnectedError(error: unknown): PiDisconnectedError {
	const cause = toError(error);
	return cause instanceof PiDisconnectedError ? cause : new PiDisconnectedError(cause.message);
}

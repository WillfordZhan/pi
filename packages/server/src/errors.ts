import type { JsonValue, ProtocolErrorCode } from "@earendil-works/pi-protocol";

/** PiServer 允许跨协议边界传输的操作错误码（从协议错误码中收窄而来）。 */
export type PiServerOperationErrorCode = Extract<
	ProtocolErrorCode,
	"busy" | "session_locked" | "not_found" | "invalid_request" | "not_implemented"
>;

export const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error";
export const NOT_IMPLEMENTED_MESSAGE = "Operation is not implemented";

/** A service/runtime error that can safely cross the protocol boundary. */
export class PiServerError extends Error {
	/** 对应的协议错误码。 */
	readonly code: PiServerOperationErrorCode;
	/** 附加的详细数据（JSON 兼容值），可选。 */
	readonly details: JsonValue | undefined;

	/**
	 * @param code    协议错误码。
	 * @param message 人类可读的错误信息。
	 * @param details 可选的附加详情，随错误一起传给客户端。
	 */
	constructor(code: PiServerOperationErrorCode, message: string, details?: JsonValue) {
		super(message);
		this.name = "PiServerError";
		this.code = code;
		this.details = details;
	}
}

/** 会话正忙（例如已有 prompt 在运行）时抛出的错误。 */
export class SessionBusyError extends PiServerError {
	constructor(message = "Session is busy", details?: JsonValue) {
		super("busy", message, details);
		this.name = "SessionBusyError";
	}
}

/** 会话被锁定（例如正在终止或已被其他连接独占）时抛出的错误。 */
export class SessionLockedError extends PiServerError {
	constructor(message = "Session is locked", details?: JsonValue) {
		super("session_locked", message, details);
		this.name = "SessionLockedError";
	}
}

/** 找不到目标会话时抛出的错误。 */
export class SessionNotFoundError extends PiServerError {
	constructor(message = "Session was not found", details?: JsonValue) {
		super("not_found", message, details);
		this.name = "SessionNotFoundError";
	}
}

export class NotImplementedError extends PiServerError {
	constructor() {
		super("not_implemented", NOT_IMPLEMENTED_MESSAGE);
		this.name = "NotImplementedError";
	}
}

/** An unsafe failure whose cause is retained for reporting but never serialized. */
export class InternalServerError extends Error {
	constructor(cause: unknown) {
		super(INTERNAL_SERVER_ERROR_MESSAGE, { cause });
		this.name = "InternalServerError";
	}
}

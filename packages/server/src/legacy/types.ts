/** 实例的生命周期状态。 */
export type InstanceStatus = "starting" | "online" | "stopping" | "stopped" | "error";

/** 旧版机器注册记录：描述一台已知机器及其最近在线时间。 */
export interface MachineRecord {
	/** 机器唯一 ID。 */
	id: string;
	/** 首次注册时间。 */
	createdAt: string;
	/** 最近一次心跳/在线时间。 */
	lastSeenAt?: string;
	/** 可选的人类可读标签。 */
	label?: string;
}

/** 旧版 Radius 注册策略：约定心跳间隔与注册过期时间。 */
export interface RadiusRegistration {
	/** 心跳间隔（毫秒）。 */
	heartbeatIntervalMs: number;
	/** 注册有效时长（毫秒），超时视为离线。 */
	expiresInMs: number;
}

/** 旧版实例记录：描述一个运行中的实例及其绑定的会话信息。 */
export interface InstanceRecord {
	/** 实例唯一 ID。 */
	id: string;
	/** 当前生命周期状态。 */
	status: InstanceStatus;
	/** 实例的工作目录。 */
	cwd: string;
	/** 创建时间。 */
	createdAt: string;
	/** 最近一次在线时间。 */
	lastSeenAt?: string;
	/** 可选的人类可读标签。 */
	label?: string;
	/** 绑定的会话 ID。 */
	sessionId?: string;
	/** 会话数据文件路径。 */
	sessionFile?: string;
	/** 关联的 Radius Pi ID。 */
	radiusPiId?: string;
}

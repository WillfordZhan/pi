import {
	type EventEnvelope,
	type ModelMetadata,
	PROTOCOL_VERSION,
	type ServerSnapshot,
	type SessionMetadata,
} from "@earendil-works/pi-protocol";
import type { ConnectionState } from "./connection.ts";
import type { PiServerService } from "./types.ts";

/** 快照发布器依赖的外部协作接口（由 PiServer 注入）。 */
interface ServerSnapshotPublisherOptions {
	/** 服务器实例 ID。 */
	serverId: string;
	service: PiServerService;
	connections: Set<ConnectionState>;
	/** 查询服务器是否正在关闭。 */
	isClosing: () => boolean;
	listSessions: () => Promise<SessionMetadata[]>;
	sendMessage: (connection: ConnectionState, message: EventEnvelope) => Promise<boolean>;
	/** 上报非致命错误。 */
	reportError: (error: unknown) => void;
}

/** 服务器快照发布器：为所有就绪连接构建并广播包含版本号的服务器快照。 */
export class ServerSnapshotPublisher {
	/** 外部协作接口。 */
	private readonly options: ServerSnapshotPublisherOptions;
	/** 当前快照修订号（每次广播递增）。 */
	private revision = 0;
	/** 广播队列链，保证广播按顺序串行执行。 */
	private broadcastQueue: Promise<void> = Promise.resolve();

	/** @param options 外部协作接口（连接集合、发送消息等）。 */
	constructor(options: ServerSnapshotPublisherOptions) {
		this.options = options;
	}

	/** 当前快照修订号。 */
	get currentRevision(): number {
		return this.revision;
	}

	async get(models?: ModelMetadata[]): Promise<ServerSnapshot> {
		return {
			serverId: this.options.serverId,
			protocolVersion: PROTOCOL_VERSION,
			revision: this.revision,
			sessions: await this.options.listSessions(),
			models: models ?? (await this.options.service.listModels()),
		};
	}

	/** 发起一次广播（排队串行执行），返回本次广播完成的 Promise。 */
	broadcast(): Promise<void> {
		const broadcast = this.broadcastQueue.then(() => this.performBroadcast());
		this.broadcastQueue = broadcast.catch((error: unknown) => this.options.reportError(error));
		return broadcast;
	}

	/** 实际执行广播：向所有就绪连接发送带新修订号的服务器快照。 */
	private async performBroadcast(): Promise<void> {
		const readyConnections = [...this.options.connections].filter(
			(connection) => connection.stage === "ready" && !connection.disconnected,
		);
		if (readyConnections.length === 0 || this.options.isClosing()) return;
		const revision = ++this.revision;
		const models = await this.options.service.listModels();
		const current = await this.get(models);
		const snapshot: ServerSnapshot = { ...current, revision };
		const envelope: EventEnvelope = { type: "event", event: { type: "server_snapshot", snapshot } };
		for (const connection of readyConnections) await this.options.sendMessage(connection, envelope);
	}
}

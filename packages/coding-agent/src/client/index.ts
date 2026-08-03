// 远程会话客户端公共导出：RemoteSession 封装远程会话操作，transcript 提供转录状态管理。
export {
	type CreateRemoteSessionOptions,
	RemoteSession,
	type RemoteSessionLifecycle,
	type RemoteSessionOperation,
	type RemoteSessionOptions,
	type RemoteSessionState,
} from "./remote-session.ts";
export {
	applyTranscriptProgress,
	applyTranscriptSnapshot,
	createTranscriptState,
	selectTranscript,
	type TranscriptState,
} from "./transcript.ts";

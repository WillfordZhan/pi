// 模块说明：管理台前端共享类型，统一在线调试与会话回放两套视图的数据契约。

export type ManageUser = {
  userId?: string;
  username?: string;
  nickName?: string;
  deptId?: string;
  deptName?: string;
  rolePermission?: string[];
  debugPrivilege?: number;
};

export type DeptOption = {
  deptId: string;
  deptName: string;
  current?: boolean;
};

export type SessionPayload = {
  user: ManageUser;
  depts: DeptOption[];
  current_dept?: DeptOption | null;
};

export type UserListItem = {
  userId: string;
  username?: string;
  nickname?: string;
  mobileNo?: string;
  deptId?: string;
  deptName?: string;
  conversationCount?: number;
  lastConversationAt?: string;
};

export type UserSearchResponse = {
  total: number;
  pageNum: number;
  pageSize: number;
  items: UserListItem[];
};

export type ConversationItem = {
  conversationId: string;
  deptId?: string;
  userId?: string;
  username?: string;
  nickname?: string;
  mobileNo?: string;
  title?: string;
  initialQuery?: string;
  previewText?: string;
  latestEventType?: string;
  latestEventId?: number;
  turnCount?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type ConversationSearchResponse = {
  total: number;
  pageNum: number;
  pageSize: number;
  items: ConversationItem[];
};

export type TimelineMessage = {
  message_id: number;
  turn_index: number;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  status: string;
  anchor_event_id?: number;
};

export type TimelineResponse = {
  conversation: Record<string, unknown>;
  messages: TimelineMessage[];
};

export type EventItem = {
  id: number;
  event_type: string;
  created_at: string;
  summary: string;
  raw_json: string;
  data: Record<string, unknown>;
  visible_in_messages: boolean;
  include_in_context: boolean;
};

export type ReplayTurn = {
  turn_index: number;
  anchor_event_id: number;
  query?: string | null;
  status: string;
  event_count: number;
  assistant_message_event_id?: number | null;
  assistant_preview?: string | null;
  events: EventItem[];
};

export type TurnEventsResponse = {
  conversation_id: string;
  turn: ReplayTurn;
};

export type EventDetailResponse = {
  conversation_id: string;
  event: EventItem;
};

export type DatePreset = "all" | "today" | "3d" | "7d" | "custom";

export type LiveMessage = {
  id: number;
  conversation_id: string;
  message_type: string;
  role: string;
  content: string;
  data: Record<string, unknown>;
  created_at: string;
};

export type LiveMessagesResponse = {
  conversation_id: string;
  messages: LiveMessage[];
};

export type SseConversationEventName =
  | "conversation_started"
  | "answer_delta"
  | "final"
  | "clarification_needed"
  | "conversation_failed"
  | "conversation_interrupted";

export type SseConversationEvent = {
  id?: string;
  event: SseConversationEventName | string;
  data: Record<string, unknown> | null;
  rawData: string;
};

export type ConversationInterruptResponse = {
  conversation_id: string;
  accepted: boolean;
  interrupted: boolean;
  anchor_event_id?: number | null;
};

export type ToolDescriptorItem = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
};

export type ToolProvider = {
  provider_type: "mcp" | "internal";
  provider_key: string;
  name: string;
  description?: string;
  url?: string;
  status?: string;
  detail?: string;
  tools: ToolDescriptorItem[];
};

export type ToolCatalogResponse = {
  providers: ToolProvider[];
  summary: {
    tool_count: number;
    provider_count: number;
  };
};

// 模块说明：管理台主工作台，统一承接在线调试与历史会话回放两套视图的状态、数据加载与交互编排。

import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  ConfigProvider,
  DatePicker,
  Drawer,
  Empty,
  Form,
  Input,
  Layout,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  theme as antdTheme,
} from "antd";
import {
  AppstoreOutlined,
  BulbOutlined,
  LoginOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RadarChartOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useState } from "react";
import {
  apiFetch,
  AUTH_STORAGE_KEY,
  getUserFacingErrorMessage,
  login,
} from "./api";
import { SchemaInspector } from "./components/SchemaInspector";
import { MarkdownMessage } from "./components/MarkdownMessage";
import { TurnEventInspector, eventTypeColor } from "./components/TurnEventInspector";
import type {
  ConversationItem,
  ConversationSearchResponse,
  DatePreset,
  DeptOption,
  EventDetailResponse,
  EventItem,
  EffectiveOutputMode,
  RequestOutputMode,
  ReplayTurn,
  SessionPayload,
  TimelineMessage,
  TimelineResponse,
  ToolCatalogResponse,
  ToolDescriptorItem,
  ToolProvider,
  TurnEventsResponse,
  UserListItem,
  UserSearchResponse,
} from "./types";
import { useLiveDebugTransport } from "./useLiveDebugTransport";

const { Header, Sider, Content } = Layout;
const { Title, Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

type ActiveView = "live-debug" | "conversation-manage";
type ToolFilter = "all" | "mcp" | "internal";
type ThemeMode = "dark" | "light";
type ToolModalPayload = {
  provider: ToolProvider;
  tool: ToolDescriptorItem;
};

const VIEW_META: Record<ActiveView, { label: string }> = {
  "live-debug": { label: "在线调试" },
  "conversation-manage": { label: "历史会话回放" },
};
const THEME_STORAGE_KEY = "ai-manage.theme-mode";

export default function App() {
  const { message } = AntApp.useApp();
  const [loginForm] = Form.useForm<{ mobileNo: string; password: string }>();
  const [authLoading, setAuthLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => loadThemeMode());
  const [navCollapsed, setNavCollapsed] = useState(true);
  const [activeView, setActiveView] = useState<ActiveView>("live-debug");
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [deptId, setDeptId] = useState<string>("");

  const [userKeyword, setUserKeyword] = useState("");
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");

  const [conversationKeyword, setConversationKeyword] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [dateRange, setDateRange] = useState<[any, any] | null>(null);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [conversationTotal, setConversationTotal] = useState(0);
  const [selectedConversationId, setSelectedConversationId] = useState("");

  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [selectedTurn, setSelectedTurn] = useState<ReplayTurn | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);

  const [toolCatalog, setToolCatalog] = useState<ToolCatalogResponse | null>(null);
  const [toolCatalogLoading, setToolCatalogLoading] = useState(false);
  const [toolFilter, setToolFilter] = useState<ToolFilter>("all");
  const [toolSearch, setToolSearch] = useState("");
  const [selectedTool, setSelectedTool] = useState<ToolModalPayload | null>(null);
  const [liveConversations, setLiveConversations] = useState<ConversationItem[]>([]);
  const [liveConversationLoading, setLiveConversationLoading] = useState(false);
  const [liveConversationKeyword, setLiveConversationKeyword] = useState("");
  const [liveConversationDatePreset, setLiveConversationDatePreset] = useState<DatePreset>("7d");
  const [liveConversationDateRange, setLiveConversationDateRange] = useState<[any, any] | null>(null);
  const [liveTimeline, setLiveTimeline] = useState<TimelineResponse | null>(null);
  const [liveSelectedTurn, setLiveSelectedTurn] = useState<ReplayTurn | null>(null);
  const [liveSelectedEvent, setLiveSelectedEvent] = useState<EventItem | null>(null);
  const isAuthed = !!window.sessionStorage.getItem(AUTH_STORAGE_KEY);
  const activeViewLabel = VIEW_META[activeView].label;
  const filteredLiveConversations = useMemo(() => {
    const normalizedKeyword = liveConversationKeyword.trim().toLowerCase();
    return liveConversations.filter((item) => {
      return (
        !normalizedKeyword ||
        [item.title, item.previewText, item.initialQuery, item.username, item.nickname, item.conversationId]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalizedKeyword))
      );
    });
  }, [liveConversationKeyword, liveConversations]);

  useEffect(() => {
    void loadSession(true);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (!session || !deptId) {
      return;
    }
    void loadToolCatalog();
  }, [session, deptId]);

  useEffect(() => {
    if (!session || !deptId || activeView !== "live-debug") {
      return;
    }
    void loadLiveConversations();
  }, [session, deptId, activeView, liveConversationDatePreset, liveConversationDateRange]);

  async function loadSession(silent = false) {
    if (!window.sessionStorage.getItem(AUTH_STORAGE_KEY)) {
      setSession(null);
      return;
    }
    setAuthLoading(true);
    try {
      const payload = await apiFetch<SessionPayload>("/ai/management/session/me");
      setSession(payload);
      // 当前工厂是后端独立状态，不能再从候选列表第一个元素反推。
      // 这样才能和小程序保持一致：没有切换记录时，页面停留在“全部工厂/未选择”态。
      const nextDeptId = payload.current_dept?.deptId || "";
      setDeptId(nextDeptId);
      if (nextDeptId) {
        await loadUsers(nextDeptId, userKeyword, String(payload.user?.userId || ""));
      } else {
        setUsers([]);
        setSelectedUserId("");
        resetConversationPane();
        resetLivePane();
      }
    } catch (error) {
      setSession(null);
      window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
      if (!silent) {
        message.error(getUserFacingErrorMessage(error, "会话校验失败，请重新登录。"));
      }
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleLogin(values: { mobileNo: string; password: string }) {
    setLoginError("");
    setAuthLoading(true);
    try {
      await login(values.mobileNo, values.password);
      await loadSession();
      loginForm.resetFields();
      setLoginError("");
      setLoginOpen(false);
      message.success("登录成功");
    } catch (error) {
      const errorMessage = getUserFacingErrorMessage(error, "登录失败，请稍后重试。");
      setLoginError(errorMessage);
      message.error(`登录失败：${errorMessage}`);
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleRefresh() {
    await loadSession();
    if (session && deptId) {
      await loadToolCatalog();
    }
    if (activeView === "conversation-manage" && selectedConversationId) {
      await loadTimeline(selectedConversationId);
    }
    if (activeView === "live-debug" && liveConversationId) {
      await refreshLiveTimeline(liveConversationId, true);
    }
  }

  async function loadUsers(
    nextDeptId = deptId,
    nextKeyword = userKeyword,
    preferredUserId = String(session?.user?.userId || "")
  ) {
    if (!nextDeptId) {
      return;
    }
    setLoading(true);
    try {
      const payload = await apiFetch<UserSearchResponse>("/ai/management/users/search", {
        method: "POST",
        body: JSON.stringify({
          dept_id: nextDeptId,
          keyword: nextKeyword || undefined,
          page_num: 1,
          page_size: 20,
        }),
      });
      const nextItems = payload.items || [];
      setUsers(nextItems);
      const nextUserId =
        nextItems.find((item) => item.userId === preferredUserId)?.userId || nextItems[0]?.userId || "";
      setSelectedUserId(nextUserId);
      if (nextUserId) {
        await loadConversations(nextDeptId, nextUserId);
      } else {
        resetConversationPane();
      }
    } catch (error) {
      message.error(getUserFacingErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function handleSwitchDept(nextDeptId: string) {
    setAuthLoading(true);
    try {
      await apiFetch<{ current_dept: DeptOption | null; items: DeptOption[] }>("/ai/management/depts/switch", {
        method: "POST",
        body: JSON.stringify({ dept_id: nextDeptId }),
      });
      setSelectedUserId("");
      setConversationKeyword("");
      resetConversationPane();
      resetLivePane();
      // 切厂后的权威状态在后端：
      // - current_dept 来自 getBeforeDept
      // - depts 来自 groupByDept
      // 因此这里直接重新拉 session，而不是在前端本地猜测如何拼装最新状态。
      await loadSession();
      message.success("工厂已切换");
    } catch (error) {
      message.error(getUserFacingErrorMessage(error));
    } finally {
      setAuthLoading(false);
    }
  }

  async function loadConversations(nextDeptId = deptId, nextUserId = selectedUserId) {
    if (!nextDeptId || !nextUserId) {
      resetConversationPane();
      return;
    }
    setLoading(true);
    try {
      const payload = await searchConversationItems({
        page_num: 1,
        page_size: 50,
        dept_id: nextDeptId,
        user_id: nextUserId,
        keyword: conversationKeyword || undefined,
        created_from: buildDateQuery().created_from,
        created_to: buildDateQuery().created_to,
      });
      setConversations(payload.items || []);
      setConversationTotal(payload.total || 0);
      const nextConversationId = payload.items?.[0]?.conversationId || "";
      if (nextConversationId) {
        await loadTimeline(nextConversationId);
      } else {
        resetConversationPane();
      }
    } catch (error) {
      message.error(getUserFacingErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadTimeline(conversationId: string) {
    setSelectedConversationId(conversationId);
    setLoading(true);
    try {
      const payload = await apiFetch<TimelineResponse>(`/ai/management/conversations/${conversationId}/timeline`);
      setTimeline(payload);
      const latestAssistant = [...(payload.messages || [])]
        .reverse()
        .find((item) => item.role === "assistant" && item.turn_index);
      if (latestAssistant?.turn_index) {
        await loadTurnEvents(conversationId, latestAssistant.turn_index);
      } else {
        setSelectedTurn(null);
        setSelectedEvent(null);
      }
    } catch (error) {
      message.error(getUserFacingErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadTurnEvents(conversationId: string, turnIndex: number) {
    setLoading(true);
    try {
      const payload = await apiFetch<TurnEventsResponse>(
        `/ai/management/conversations/${conversationId}/turns/${turnIndex}/events`
      );
      setSelectedTurn(payload.turn);
      const firstEvent = payload.turn.events?.[0] || null;
      setSelectedEvent(firstEvent);
      if (firstEvent?.id) {
        await loadEventDetail(conversationId, firstEvent.id);
      }
    } catch (error) {
      message.error(getUserFacingErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function loadEventDetail(conversationId: string, eventId: number) {
    try {
      const payload = await apiFetch<EventDetailResponse>(
        `/ai/management/conversations/${conversationId}/events/${eventId}`
      );
      setSelectedEvent(payload.event);
    } catch (error) {
      message.error(getUserFacingErrorMessage(error));
    }
  }

  async function loadLiveTurnEvents(conversationId: string, turnIndex: number) {
    try {
      const payload = await apiFetch<TurnEventsResponse>(
        `/ai/management/conversations/${conversationId}/turns/${turnIndex}/events`
      );
      setLiveSelectedTurn(payload.turn);
      const firstEvent = payload.turn.events?.[0] || null;
      setLiveSelectedEvent(firstEvent);
      if (firstEvent?.id) {
        await loadLiveEventDetail(conversationId, firstEvent.id);
      }
    } catch (error) {
      message.error(getUserFacingErrorMessage(error));
    }
  }

  async function loadLiveEventDetail(conversationId: string, eventId: number) {
    try {
      const payload = await apiFetch<EventDetailResponse>(
        `/ai/management/conversations/${conversationId}/events/${eventId}`
      );
      setLiveSelectedEvent(payload.event);
    } catch (error) {
      message.error(getUserFacingErrorMessage(error));
    }
  }

  async function loadToolCatalog(nextDeptId = deptId) {
    if (!session || !nextDeptId) {
      return;
    }
    setToolCatalogLoading(true);
    try {
      const payload = await apiFetch<ToolCatalogResponse>("/ai/management/tools/catalog");
      setToolCatalog(payload);
    } catch (error) {
      message.error(getUserFacingErrorMessage(error));
    } finally {
      setToolCatalogLoading(false);
    }
  }

  async function loadLiveConversations(
    nextDeptId = deptId,
    preferredConversationId = liveConversationId
  ) {
    const currentUserId = String(session?.user?.userId || "");
    if (!nextDeptId || !currentUserId) {
      setLiveConversations([]);
      return;
    }
    setLiveConversationLoading(true);
    try {
      // 在线调试页左栏只展示“当前登录用户最近在这个工厂下产生的会话”。
      // 这里默认限制到最近 7 日，避免列表过长拖慢渲染，也让工作台更像“近期调试入口”。
      const payload = await searchConversationItems({
        page_num: 1,
        page_size: 30,
        dept_id: nextDeptId,
        user_id: currentUserId,
        ...buildLiveConversationDateQuery(),
      });
      const nextItems = payload.items || [];
      setLiveConversations(nextItems);
      if (preferredConversationId && nextItems.some((item) => item.conversationId === preferredConversationId)) {
        return;
      }
      if (!preferredConversationId) {
        return;
      }
      if (!nextItems.length) {
        setLiveSelectedTurn(null);
        setLiveSelectedEvent(null);
        setLiveTimeline(null);
      }
    } catch (error) {
      message.error(`在线会话列表加载失败: ${getUserFacingErrorMessage(error)}`);
    } finally {
      setLiveConversationLoading(false);
    }
  }

  async function searchConversationItems(
    payload: {
      page_num: number;
      page_size: number;
      dept_id?: string;
      user_id?: string;
      keyword?: string;
      created_from?: string;
      created_to?: string;
    }
  ) {
    // 管理台存在“回放台列表”和“在线调试列表”两条入口，
    // 这里把查询契约统一到一个 helper，避免两边各自拼 JSON 时字段再度漂移。
    const responsePayload = await apiFetch<ConversationSearchResponse | Record<string, unknown>>(
      "/ai/management/conversations/search",
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );
    return normalizeConversationSearchResponse(responsePayload);
  }

  async function refreshLiveTimeline(conversationId: string, autoSelectLatest = false) {
    // 在线调试的终态事件可能先于 timeline 投影短暂到达。
    // 这里在“需要切到最新 assistant turn”时做有限次重试，避免页面停留在旧 turn。
    await refreshLiveTimelineWithRetry(conversationId, {
      autoSelectLatest,
      previousTurnIndex: liveSelectedTurn?.turn_index ?? null,
    });
  }

  async function refreshLiveTimelineWithRetry(
    conversationId: string,
    options: {
      autoSelectLatest: boolean;
      previousTurnIndex: number | null;
      attempt?: number;
    }
  ) {
    const { autoSelectLatest, previousTurnIndex, attempt = 0 } = options;
    try {
      const payload = await apiFetch<TimelineResponse>(`/ai/management/conversations/${conversationId}/timeline`);
      setLiveTimeline(payload);
      const latestAssistant = [...(payload.messages || [])]
        .reverse()
        .find((item) => item.role === "assistant" && item.turn_index);
      const latestAssistantTurnIndex = latestAssistant?.turn_index ?? null;
      if (
        autoSelectLatest &&
        shouldRetryLatestTurnProjection({
          latestAssistantTurnIndex,
          previousTurnIndex,
          attempt,
        })
      ) {
        await waitForLiveTimelineProjection();
        await refreshLiveTimelineWithRetry(conversationId, {
          autoSelectLatest,
          previousTurnIndex,
          attempt: attempt + 1,
        });
        return;
      }
      const nextTurnIndex =
        autoSelectLatest || !liveSelectedTurn
          ? latestAssistantTurnIndex ?? undefined
          : liveSelectedTurn.turn_index;
      if (nextTurnIndex) {
        await loadLiveTurnEvents(conversationId, nextTurnIndex);
      }
    } catch (error) {
      // 在线调试里 timeline 刷新只是增强能力，不应该因为回放接口偶发失败中断主轮询。
      message.warning(`在线时间线刷新失败: ${getUserFacingErrorMessage(error)}`);
    }
  }

  const {
    liveConversationId,
    liveInput,
    liveActionLoading,
    liveAwaitingTerminal,
    livePollStatus,
    liveOutputMode,
    liveActiveOutputMode,
    setLiveInput,
    setLiveOutputMode,
    openLiveConversation,
    resetLiveTransport,
    handleLivePrimaryAction,
    buildPreviewMessages,
  } = useLiveDebugTransport({
    message,
    refreshLiveTimeline,
  });

  useEffect(() => {
    if (!session || !deptId || activeView !== "live-debug") {
      return;
    }
    void loadLiveConversations(deptId, liveConversationId);
  }, [liveConversationId]);

  function resetConversationPane() {
    setConversations([]);
    setConversationTotal(0);
    setSelectedConversationId("");
    setTimeline(null);
    setSelectedTurn(null);
    setSelectedEvent(null);
  }

  function resetLivePane() {
    setLiveTimeline(null);
    setLiveSelectedTurn(null);
    setLiveSelectedEvent(null);
    resetLiveTransport();
  }

  function buildDateQuery(): { created_from?: string; created_to?: string } {
    const now = new Date();
    if (datePreset === "all") {
      return {};
    }
    if (datePreset === "custom" && dateRange?.[0] && dateRange?.[1]) {
      return {
        created_from: dateRange[0].toDate().toISOString(),
        created_to: dateRange[1].toDate().toISOString(),
      };
    }
    const start = new Date(now);
    if (datePreset === "today") {
      start.setHours(0, 0, 0, 0);
    } else if (datePreset === "3d") {
      start.setDate(start.getDate() - 3);
    } else {
      start.setDate(start.getDate() - 7);
    }
    return {
      created_from: start.toISOString(),
      created_to: now.toISOString(),
    };
  }

  function buildRecentDateQuery(days: number): { created_from: string; created_to: string } {
    // 在线调试列表不需要暴露完整筛选面板，直接提供一个稳定的“近期窗口”即可。
    // 这样既能控制列表体量，也能避免和回放台那套复杂筛选状态耦合。
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - Math.max(days, 0));
    return {
      created_from: start.toISOString(),
      created_to: now.toISOString(),
    };
  }

  function buildLiveConversationDateQuery(): { created_from?: string; created_to?: string } {
    if (liveConversationDatePreset === "all") {
      return {};
    }
    if (liveConversationDatePreset === "custom" && liveConversationDateRange?.[0] && liveConversationDateRange?.[1]) {
      return {
        created_from: liveConversationDateRange[0].toDate().toISOString(),
        created_to: liveConversationDateRange[1].toDate().toISOString(),
      };
    }
    if (liveConversationDatePreset === "today") {
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return {
        created_from: start.toISOString(),
        created_to: now.toISOString(),
      };
    }
    if (liveConversationDatePreset === "3d") {
      return buildRecentDateQuery(3);
    }
    return buildRecentDateQuery(7);
  }

  function normalizeConversationSearchResponse(
    payload: ConversationSearchResponse | Record<string, unknown>
  ): ConversationSearchResponse {
    const source =
      typeof payload === "object" && payload && Array.isArray((payload as Record<string, unknown>).items)
        ? (payload as Record<string, unknown>)
        : typeof payload === "object" &&
            payload &&
            typeof (payload as Record<string, unknown>).data === "object" &&
            (payload as Record<string, unknown>).data
          ? ((payload as Record<string, unknown>).data as Record<string, unknown>)
          : {};
    const rawItems = Array.isArray(source.items)
      ? source.items
      : Array.isArray(source.records)
        ? source.records
        : Array.isArray(source.list)
          ? source.list
          : [];
    return {
      total: Number(source.total ?? source.count ?? rawItems.length ?? 0),
      pageNum: Number(source.pageNum ?? source.page_num ?? 1),
      pageSize: Number(source.pageSize ?? source.page_size ?? rawItems.length ?? 0),
      items: rawItems.map((item) => normalizeConversationItem(item)).filter(Boolean) as ConversationItem[],
    };
  }

  function normalizeConversationItem(rawItem: unknown): ConversationItem | null {
    if (!rawItem || typeof rawItem !== "object") {
      return null;
    }
    const item = rawItem as Record<string, unknown>;
    return {
      conversationId: pickString(item, "conversationId", "conversation_id", "id"),
      deptId: pickString(item, "deptId", "dept_id"),
      userId: pickString(item, "userId", "user_id"),
      username: pickString(item, "username", "userName"),
      nickname: pickString(item, "nickname", "nickName"),
      mobileNo: pickString(item, "mobileNo", "mobile_no"),
      title: pickString(item, "title", "conversationTitle", "name"),
      initialQuery: pickString(item, "initialQuery", "initial_query", "query"),
      previewText: pickString(item, "previewText", "preview_text", "summary"),
      latestEventType: normalizeEventType(pickString(item, "latestEventType", "latest_event_type", "eventType")),
      latestEventId: pickNumber(item, "latestEventId", "latest_event_id"),
      turnCount: pickNumber(item, "turnCount", "turn_count"),
      createdAt: pickString(item, "createdAt", "created_at"),
      updatedAt: pickString(item, "updatedAt", "updated_at"),
    };
  }

  function pickString(source: Record<string, unknown>, ...keys: string[]) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
    }
    return "";
  }

  function pickNumber(source: Record<string, unknown>, ...keys: string[]) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return undefined;
  }

  function normalizeEventType(value?: string) {
    return value ? value.trim().toLowerCase() : "";
  }

  const deptOptions = useMemo(
    () => (session?.depts || []).map((item) => ({ label: item.deptName, value: item.deptId })),
    [session]
  );
  const currentDeptDisplayName = session?.current_dept?.deptName || "全部工厂";

  const toolProviders = useMemo(() => {
    const providers = toolCatalog?.providers || [];
    const keyword = toolSearch.trim().toLowerCase();
    return providers
      .filter((provider) => toolFilter === "all" || provider.provider_type === toolFilter)
      .map((provider) => ({
        ...provider,
        tools: provider.tools.filter((tool) => {
          if (!keyword) {
            return true;
          }
          const haystack = [
            tool.name,
            tool.description,
            JSON.stringify(tool.input_schema || {}),
            JSON.stringify(tool.output_schema || {}),
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(keyword);
        }),
      }))
      .filter((provider) => provider.tools.length > 0);
  }, [toolCatalog, toolFilter, toolSearch]);

  return (
    <ConfigProvider
      theme={{
        algorithm: themeMode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: "#f4a261",
          colorInfo: "#f4a261",
          fontFamily: "'IBM Plex Sans', 'PingFang SC', sans-serif",
          borderRadius: 14,
        },
      }}
    >
      <Layout className="console-shell">
        <Sider
          width={220}
          collapsedWidth={68}
          collapsed={navCollapsed}
          trigger={null}
          className="nav-sider"
        >
          <div className="nav-header">
            <Button
              type="text"
              className="nav-toggle"
              icon={navCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setNavCollapsed((current) => !current)}
            />
          </div>
          <div className="nav-menu">
            <button
              type="button"
              className={`nav-item ${activeView === "live-debug" ? "nav-item-active" : ""}`}
              onClick={() => setActiveView("live-debug")}
            >
              <RadarChartOutlined />
              {!navCollapsed ? <span>{VIEW_META["live-debug"].label}</span> : null}
            </button>
            <button
              type="button"
              className={`nav-item ${activeView === "conversation-manage" ? "nav-item-active" : ""}`}
              onClick={() => setActiveView("conversation-manage")}
            >
              <AppstoreOutlined />
              {!navCollapsed ? <span>{VIEW_META["conversation-manage"].label}</span> : null}
            </button>
          </div>
        </Sider>
        <Layout className="console-main">
          <Header className="console-header compact-header">
            <div>
              <Title level={4} className="console-title">
                {activeViewLabel}
              </Title>
            </div>
            <Space wrap size="middle">
              <Select
                value={deptId || undefined}
                options={deptOptions}
                showSearch
                optionFilterProp="label"
                filterOption={(input, option) =>
                  String(option?.label || "")
                    .toLowerCase()
                    .includes(input.trim().toLowerCase())
                }
                placeholder={session ? "搜索或选择工厂" : "选择工厂"}
                style={{ width: "clamp(11rem, 16vw, 14rem)" }}
                disabled={!session || authLoading}
                onChange={(value) => void handleSwitchDept(String(value))}
              />
              {session ? (
                <Badge
                  status="processing"
                  text={`${session.user.username || "-"} / ${currentDeptDisplayName}`}
                />
              ) : (
                <Badge status={isAuthed ? "warning" : "default"} text={isAuthed ? "校验中" : "未登录"} />
              )}
              <Button icon={<BulbOutlined />} onClick={() => setThemeMode((current) => (current === "dark" ? "light" : "dark"))}>
                {themeMode === "dark" ? "浅色" : "深色"}
              </Button>
              <Button icon={<ReloadOutlined />} onClick={() => void handleRefresh()}>
                刷新
              </Button>
              {session ? (
                <Button
                  icon={<LogoutOutlined />}
                  onClick={() => {
                    window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
                    setSession(null);
                    setDeptId("");
                    setUsers([]);
                    setSelectedUserId("");
                    resetConversationPane();
                    resetLivePane();
                  }}
                >
                  退出
                </Button>
              ) : (
                <Button type="primary" icon={<LoginOutlined />} onClick={() => setLoginOpen(true)}>
                  登录
                </Button>
              )}
            </Space>
          </Header>
          <Layout className="console-body">
            <Content className="console-content">
              <Spin spinning={loading || authLoading}>
                {!session ? (
                  <Alert
                    type="info"
                    showIcon
                    message="先登录管理员账号"
                    description="当前管理台要求管理员账号已登录，并具备 admin 角色或 debugPrivilege。"
                  />
                ) : activeView === "live-debug" ? (
                  <LiveDebugView
                    session={session}
                    liveConversationId={liveConversationId}
                    liveTimeline={liveTimeline}
                    liveSelectedTurn={liveSelectedTurn}
                    liveSelectedEvent={liveSelectedEvent}
                    liveInput={liveInput}
                    liveActionLoading={liveActionLoading}
                    liveAwaitingTerminal={liveAwaitingTerminal}
                    livePollStatus={livePollStatus}
                    liveOutputMode={liveOutputMode}
                    liveActiveOutputMode={liveActiveOutputMode}
                    liveConversationLoading={liveConversationLoading}
                    liveConversations={liveConversations}
                    filteredLiveConversations={filteredLiveConversations}
                    liveConversationKeyword={liveConversationKeyword}
                    liveConversationDatePreset={liveConversationDatePreset}
                    liveConversationDateRange={liveConversationDateRange}
                    buildPreviewMessages={buildPreviewMessages}
                    toolCatalogLoading={toolCatalogLoading}
                    toolProviders={toolProviders}
                    toolFilter={toolFilter}
                    toolSearch={toolSearch}
                    onLiveOutputModeChange={setLiveOutputMode}
                    onLiveConversationKeywordChange={setLiveConversationKeyword}
                    onLiveConversationDatePresetChange={setLiveConversationDatePreset}
                    onLiveConversationDateRangeChange={setLiveConversationDateRange}
                    onOpenLiveConversation={(conversationId) => {
                      openLiveConversation(conversationId);
                      void refreshLiveTimeline(conversationId, true);
                    }}
                    onReloadLiveConversations={() => void loadLiveConversations()}
                    onRefreshCurrentConversation={() => {
                      if (liveConversationId) {
                        void refreshLiveTimeline(liveConversationId, true);
                      }
                    }}
                    onToolFilterChange={setToolFilter}
                    onToolSearchChange={setToolSearch}
                    onRefreshTools={() => void loadToolCatalog()}
                    onNewConversation={resetLivePane}
                    onInputChange={setLiveInput}
                    onPrimaryAction={() => void handleLivePrimaryAction()}
                    onSelectAssistantMessage={(item) => {
                      if (liveConversationId && item.turn_index) {
                        void loadLiveTurnEvents(liveConversationId, item.turn_index);
                      }
                    }}
                    onSelectLiveEvent={(item) => {
                      setLiveSelectedEvent(item);
                      if (liveConversationId) {
                        void loadLiveEventDetail(liveConversationId, item.id);
                      }
                    }}
                    onToolSelect={(provider, tool) => setSelectedTool({ provider, tool })}
                  />
                ) : (
                  <ManagementView
                    userKeyword={userKeyword}
                    users={users}
                    selectedUserId={selectedUserId}
                    conversationKeyword={conversationKeyword}
                    datePreset={datePreset}
                    dateRange={dateRange}
                    conversations={conversations}
                    conversationTotal={conversationTotal}
                    selectedConversationId={selectedConversationId}
                    timeline={timeline}
                    selectedTurn={selectedTurn}
                    selectedEvent={selectedEvent}
                    onUserKeywordChange={setUserKeyword}
                    onSearchUsers={() => void loadUsers()}
                    onSelectUser={(userId) => {
                      setSelectedUserId(userId);
                      void loadConversations(deptId, userId);
                    }}
                    onConversationKeywordChange={setConversationKeyword}
                    onSearchConversations={() => void loadConversations()}
                    onDatePresetChange={setDatePreset}
                    onDateRangeChange={setDateRange}
                    onSelectConversation={(conversationId) => void loadTimeline(conversationId)}
                    onSelectAssistantMessage={(item) => {
                      if (selectedConversationId && item.turn_index) {
                        void loadTurnEvents(selectedConversationId, item.turn_index);
                      }
                    }}
                    onSelectEvent={(item) => {
                      setSelectedEvent(item);
                      if (selectedConversationId) {
                        void loadEventDetail(selectedConversationId, item.id);
                      }
                    }}
                  />
                )}
              </Spin>
            </Content>
          </Layout>
        </Layout>
        <Drawer
          title="管理员登录"
          open={loginOpen}
          onClose={() => {
            setLoginError("");
            setLoginOpen(false);
          }}
          width={420}
          destroyOnClose
        >
          <Form
            form={loginForm}
            layout="vertical"
            onValuesChange={() => {
              if (loginError) {
                setLoginError("");
              }
            }}
            onFinish={(values) => void handleLogin(values)}
          >
            {loginError ? (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                message="登录失败"
                description={loginError}
              />
            ) : null}
            <Form.Item name="mobileNo" label="手机号 / 用户名" rules={[{ required: true }]}>
              <Input placeholder="输入手机号" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true }]}>
              <Input.Password placeholder="输入密码" />
            </Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={authLoading}>
                登录
              </Button>
              <Button
                onClick={() => {
                  window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
                  setSession(null);
                  setLoginError("");
                  setLoginOpen(false);
                }}
              >
                清除 Token
              </Button>
            </Space>
          </Form>
        </Drawer>

        <ToolDetailModal payload={selectedTool} onClose={() => setSelectedTool(null)} />
      </Layout>
    </ConfigProvider>
  );
}

function loadThemeMode(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" ? "light" : "dark";
}

function LiveDebugView({
  session,
  liveConversationId,
  liveTimeline,
  liveSelectedTurn,
  liveSelectedEvent,
  liveInput,
  liveActionLoading,
  liveAwaitingTerminal,
  livePollStatus,
  liveOutputMode,
  liveActiveOutputMode,
  liveConversationLoading,
  liveConversations,
  filteredLiveConversations,
  liveConversationKeyword,
  liveConversationDatePreset,
  liveConversationDateRange,
  buildPreviewMessages,
  toolCatalogLoading,
  toolProviders,
  toolFilter,
  toolSearch,
  onLiveOutputModeChange,
  onLiveConversationKeywordChange,
  onLiveConversationDatePresetChange,
  onLiveConversationDateRangeChange,
  onOpenLiveConversation,
  onReloadLiveConversations,
  onRefreshCurrentConversation,
  onToolFilterChange,
  onToolSearchChange,
  onRefreshTools,
  onNewConversation,
  onInputChange,
  onPrimaryAction,
  onSelectAssistantMessage,
  onSelectLiveEvent,
  onToolSelect,
}: {
  session: SessionPayload;
  liveConversationId: string;
  liveTimeline: TimelineResponse | null;
  liveSelectedTurn: ReplayTurn | null;
  liveSelectedEvent: EventItem | null;
  liveInput: string;
  liveActionLoading: boolean;
  liveAwaitingTerminal: boolean;
  livePollStatus: "idle" | "connecting" | "connected" | "error";
  liveOutputMode: RequestOutputMode;
  liveActiveOutputMode: EffectiveOutputMode;
  liveConversationLoading: boolean;
  liveConversations: ConversationItem[];
  filteredLiveConversations: ConversationItem[];
  liveConversationKeyword: string;
  liveConversationDatePreset: DatePreset;
  liveConversationDateRange: [any, any] | null;
  buildPreviewMessages: (messages: TimelineMessage[]) => TimelineMessage[];
  toolCatalogLoading: boolean;
  toolProviders: ToolProvider[];
  toolFilter: ToolFilter;
  toolSearch: string;
  onLiveOutputModeChange: (value: RequestOutputMode) => void;
  onLiveConversationKeywordChange: (value: string) => void;
  onLiveConversationDatePresetChange: (value: DatePreset) => void;
  onLiveConversationDateRangeChange: (value: [any, any] | null) => void;
  onOpenLiveConversation: (conversationId: string) => void;
  onReloadLiveConversations: () => void;
  onRefreshCurrentConversation: () => void;
  onToolFilterChange: (value: ToolFilter) => void;
  onToolSearchChange: (value: string) => void;
  onRefreshTools: () => void;
  onNewConversation: () => void;
  onInputChange: (value: string) => void;
  onPrimaryAction: () => void;
  onSelectAssistantMessage: (item: TimelineMessage) => void;
  onSelectLiveEvent: (item: EventItem) => void;
  onToolSelect: (provider: ToolProvider, tool: ToolDescriptorItem) => void;
}) {
  const liveMessages = liveTimeline?.messages || [];
  const previewMessages = buildPreviewMessages(liveMessages);
  const liveConversationEmptyText = !liveConversations.length ? "当前用户最近 7 日暂无会话" : "没有匹配到会话";

  return (
    <div className="main-grid live-main-grid">
      <div className="live-workspace-grid">
        <div className="live-left-stack">
          <Card
            className="panel-card live-side-card"
            bordered={false}
            title="会话列表"
            extra={
              <div className="turn-events-summary live-summary-metrics">
                <MetricPill label="工厂" value={session.current_dept?.deptName || "全部工厂"} />
                <MetricPill label="用户" value={session.user.username || "-"} />
                <MetricPill label="Auth" value="已继承" />
              </div>
            }
          >
            <div className="live-side-body">
              <div className="live-conversation-toolbar">
                <div className="compact-count">
                  共 {filteredLiveConversations.length} / {liveConversations.length} 条会话
                </div>
                <Space size="small">
                  <Button size="small" onClick={onReloadLiveConversations}>
                    刷新
                  </Button>
                  <Button size="small" type="primary" onClick={onNewConversation}>
                    新会话
                  </Button>
                </Space>
              </div>
              <Input
                value={liveConversationKeyword}
                placeholder="搜索标题 / 首句 / 会话 ID"
                onChange={(event) => onLiveConversationKeywordChange(event.target.value)}
                onPressEnter={() => onReloadLiveConversations()}
              />
              <Space wrap className="preset-row">
                <Tag.CheckableTag
                  checked={liveConversationDatePreset === "all"}
                  onChange={() => onLiveConversationDatePresetChange("all")}
                >
                  全部
                </Tag.CheckableTag>
                <Tag.CheckableTag
                  checked={liveConversationDatePreset === "today"}
                  onChange={() => onLiveConversationDatePresetChange("today")}
                >
                  今日
                </Tag.CheckableTag>
                <Tag.CheckableTag
                  checked={liveConversationDatePreset === "3d"}
                  onChange={() => onLiveConversationDatePresetChange("3d")}
                >
                  近 3 日
                </Tag.CheckableTag>
                <Tag.CheckableTag
                  checked={liveConversationDatePreset === "7d"}
                  onChange={() => onLiveConversationDatePresetChange("7d")}
                >
                  近 7 日
                </Tag.CheckableTag>
                <Tag.CheckableTag
                  checked={liveConversationDatePreset === "custom"}
                  onChange={() => onLiveConversationDatePresetChange("custom")}
                >
                  自定义
                </Tag.CheckableTag>
              </Space>
              <RangePicker
                style={{ width: "100%" }}
                disabled={liveConversationDatePreset !== "custom"}
                value={liveConversationDateRange as any}
                onChange={(value) => onLiveConversationDateRangeChange(value ? [value[0], value[1]] : null)}
              />
              <List
                className="scroll-panel conversation-list"
                dataSource={filteredLiveConversations}
                loading={liveConversationLoading}
                locale={{ emptyText: liveConversationEmptyText }}
                renderItem={(item) => (
                  <List.Item
                    className={`selectable-item ${liveConversationId === item.conversationId ? "is-selected" : ""}`}
                    onClick={() => onOpenLiveConversation(item.conversationId)}
                  >
                    <div className="list-main">
                      <div className="list-title">{item.title || "未命名会话"}</div>
                      <div className="list-subtitle">{item.previewText || item.initialQuery || "-"}</div>
                    </div>
                    <div className="list-meta">
                      <Tag color={eventTypeColor(item.latestEventType)}>{item.latestEventType || "unknown"}</Tag>
                      <Text type="secondary">{item.updatedAt || item.createdAt || "-"}</Text>
                    </div>
                  </List.Item>
                )}
              />
            </div>
          </Card>

          <Card className="panel-card live-side-card" bordered={false} title="Tool 集成">
            <div className="live-side-body">
              <div className="tool-summary-row">
                <Tag color="blue">
                  {toolCatalogLoading ? "刷新中" : `${toolProviders.reduce((sum, item) => sum + item.tools.length, 0)} Tools`}
                </Tag>
                <Tag color="purple">MCP + Internal</Tag>
                <Button size="small" onClick={onRefreshTools}>
                  刷新
                </Button>
              </div>
              <div className="tool-filter-row">
                <Tag.CheckableTag checked={toolFilter === "all"} onChange={() => onToolFilterChange("all")}>
                  全部
                </Tag.CheckableTag>
                <Tag.CheckableTag checked={toolFilter === "mcp"} onChange={() => onToolFilterChange("mcp")}>
                  MCP
                </Tag.CheckableTag>
                <Tag.CheckableTag checked={toolFilter === "internal"} onChange={() => onToolFilterChange("internal")}>
                  Internal
                </Tag.CheckableTag>
              </div>
              <Input
                value={toolSearch}
                placeholder="搜索 tool 名称 / schema / 描述"
                onChange={(event) => onToolSearchChange(event.target.value)}
              />
              <div className="tool-provider-list">
                {!toolProviders.length ? (
                  <Empty description="没有匹配到工具" />
                ) : (
                  toolProviders.map((provider) => (
                    <article key={provider.provider_key} className="tool-provider-card">
                      <div className="tool-provider-head">
                        <div>
                          <div className="tool-provider-name">{provider.name}</div>
                          <div className="tool-provider-desc">{provider.description || "-"}</div>
                        </div>
                        {provider.provider_type === "mcp" ? (
                          <Tooltip title={provider.url}>
                            <Tag color="geekblue">MCP</Tag>
                          </Tooltip>
                        ) : (
                          <Tag color="purple">Internal</Tag>
                        )}
                      </div>
                      {provider.provider_type === "mcp" ? (
                        <>
                          <div className="tool-provider-url">{provider.url || "-"}</div>
                          <div className="tool-provider-status-row">
                            <span className={`status-light ${statusClass(provider.status)}`} />
                            <span className="tool-provider-status-text">{provider.status || "unknown"}</span>
                            <Button size="small" onClick={onRefreshTools}>
                              刷新
                            </Button>
                          </div>
                        </>
                      ) : null}
                      <div className="tool-item-scroll">
                        {provider.tools.map((tool) => (
                          <div
                            key={`${provider.provider_key}-${tool.name}`}
                            className="tool-item-card"
                            onClick={() => onToolSelect(provider, tool)}
                          >
                            <div className="tool-item-name">{tool.name}</div>
                            <div className="tool-item-desc">{tool.description || "-"}</div>
                          </div>
                        ))}
                      </div>
                    </article>
                  ))
                )}
              </div>
            </div>
          </Card>
        </div>

        <Card
          className="panel-card chat-card live-chat-card"
          bordered={false}
          title="业务 AI 对话"
          extra={
            <Button
              size="small"
              icon={<ReloadOutlined />}
              disabled={!liveConversationId}
              onClick={onRefreshCurrentConversation}
            >
              刷新当前会话
            </Button>
          }
        >
          {!previewMessages.length ? (
            <div className="live-chat-empty">
              <Empty description="输入问题后将自动创建会话，并在收到 assistant 输出后支持下钻 turn 详情" />
            </div>
          ) : (
            <div className="scroll-panel chat-scroll">
              {previewMessages.map((item) => (
                <div key={`${item.role}-${item.message_id}`} className={`chat-row ${item.role === "assistant" ? "assistant" : "user"}`}>
                  <div
                    className={`chat-bubble ${item.role === "assistant" ? "assistant" : "user"} ${
                      liveSelectedTurn?.turn_index === item.turn_index && item.role === "assistant" ? "active" : ""
                    }`}
                    onClick={() => {
                      if (item.role === "assistant" && item.message_id > 0) {
                        onSelectAssistantMessage(item);
                      }
                    }}
                  >
                    <div className="chat-meta">
                      <Tag color={item.role === "assistant" ? "geekblue" : "gold"}>
                        {item.role === "assistant" ? "assistant" : "user"}
                      </Tag>
                      <Text type="secondary">
                        TURN {item.turn_index} / {item.created_at || "-"}
                      </Text>
                    </div>
                    {item.role === "assistant" ? (
                      <MarkdownMessage content={item.content} />
                    ) : (
                      <div className="plain-message-text">{item.content || "-"}</div>
                    )}
                    {item.role === "assistant" && item.message_id > 0 ? (
                      <div className="chat-chip-hint">点击查看本轮 turn 详情</div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="live-composer">
            <div className="live-composer-hint">
              当前上下文：{session.current_dept?.deptName || "全部工厂"} / {session.user.username || "-"} /{" "}
              {liveConversationId || "未创建"} / {pollStatusText(livePollStatus, liveActiveOutputMode)}
            </div>
            <Input.TextArea
              value={liveInput}
              autoSize={{ minRows: 3, maxRows: 5 }}
              placeholder="请输入问题，Enter 发送，Shift + Enter 换行"
              onChange={(event) => onInputChange(event.target.value)}
              onPressEnter={(event) => {
                if (event.shiftKey) {
                  return;
                }
                event.preventDefault();
                void onPrimaryAction();
              }}
            />
            <div className="live-composer-actions">
              <div className="live-composer-controls">
                <Select
                  className="live-output-select"
                  size="large"
                  value={liveOutputMode}
                  options={REQUEST_OUTPUT_MODE_OPTIONS}
                  onChange={(value) => onLiveOutputModeChange(value)}
                  disabled={liveActionLoading}
                />
              </div>
              <Button size="large" type="primary" loading={liveActionLoading} onClick={onPrimaryAction}>
                {liveAwaitingTerminal ? "中断执行" : "发送"}
              </Button>
            </div>
          </div>
        </Card>

        <TurnEventInspector
          turn={liveSelectedTurn}
          selectedEvent={liveSelectedEvent}
          onSelectEvent={onSelectLiveEvent}
          emptyDescription="点击 assistant 消息查看当前 turn 的 events"
          titlePrefix="Turn Events"
        />
      </div>
    </div>
  );
}

function ManagementView({
  userKeyword,
  users,
  selectedUserId,
  conversationKeyword,
  datePreset,
  dateRange,
  conversations,
  conversationTotal,
  selectedConversationId,
  timeline,
  selectedTurn,
  selectedEvent,
  onUserKeywordChange,
  onSearchUsers,
  onSelectUser,
  onConversationKeywordChange,
  onSearchConversations,
  onDatePresetChange,
  onDateRangeChange,
  onSelectConversation,
  onSelectAssistantMessage,
  onSelectEvent,
}: {
  userKeyword: string;
  users: UserListItem[];
  selectedUserId: string;
  conversationKeyword: string;
  datePreset: DatePreset;
  dateRange: [any, any] | null;
  conversations: ConversationItem[];
  conversationTotal: number;
  selectedConversationId: string;
  timeline: TimelineResponse | null;
  selectedTurn: ReplayTurn | null;
  selectedEvent: EventItem | null;
  onUserKeywordChange: (value: string) => void;
  onSearchUsers: () => void;
  onSelectUser: (userId: string) => void;
  onConversationKeywordChange: (value: string) => void;
  onSearchConversations: () => void;
  onDatePresetChange: (value: DatePreset) => void;
  onDateRangeChange: (value: [any, any] | null) => void;
  onSelectConversation: (conversationId: string) => void;
  onSelectAssistantMessage: (item: TimelineMessage) => void;
  onSelectEvent: (item: EventItem) => void;
}) {
  return (
    <Layout className="console-workspace">
      <Sider width={380} className="console-sider">
        <Card className="panel-card user-filter-card" bordered={false} title="用户筛选">
          <Space.Compact style={{ width: "100%" }}>
            <Input
              placeholder="名称 / 手机号"
              value={userKeyword}
              onChange={(event) => onUserKeywordChange(event.target.value)}
              onPressEnter={() => onSearchUsers()}
            />
            <Button type="primary" onClick={onSearchUsers}>
              搜索
            </Button>
          </Space.Compact>
          <div className="compact-count">共 {users.length} 个用户</div>
          <List
            className="scroll-panel user-list"
            dataSource={users}
            locale={{ emptyText: "暂无 AI 会话用户" }}
            renderItem={(item) => (
              <List.Item
                className={`selectable-item ${selectedUserId === item.userId ? "is-selected" : ""}`}
                onClick={() => onSelectUser(item.userId)}
              >
                <div className="list-main">
                  <div className="list-title">{item.nickname || item.username || item.userId}</div>
                  <div className="list-subtitle">{item.mobileNo || "-"}</div>
                </div>
                <Tag>{item.conversationCount || 0} 会话</Tag>
              </List.Item>
            )}
          />
        </Card>
        <Card className="panel-card conversation-filter-card" bordered={false} title="会话筛选">
          <Space.Compact style={{ width: "100%" }}>
            <Input
              placeholder="标题 / 会话内容"
              value={conversationKeyword}
              onChange={(event) => onConversationKeywordChange(event.target.value)}
              onPressEnter={() => onSearchConversations()}
            />
            <Button type="primary" onClick={onSearchConversations}>
              查询
            </Button>
          </Space.Compact>
          <Space wrap className="preset-row">
            <Tag.CheckableTag checked={datePreset === "all"} onChange={() => onDatePresetChange("all")}>
              全部
            </Tag.CheckableTag>
            <Tag.CheckableTag checked={datePreset === "today"} onChange={() => onDatePresetChange("today")}>
              今日
            </Tag.CheckableTag>
            <Tag.CheckableTag checked={datePreset === "3d"} onChange={() => onDatePresetChange("3d")}>
              近 3 日
            </Tag.CheckableTag>
            <Tag.CheckableTag checked={datePreset === "7d"} onChange={() => onDatePresetChange("7d")}>
              近 7 日
            </Tag.CheckableTag>
            <Tag.CheckableTag checked={datePreset === "custom"} onChange={() => onDatePresetChange("custom")}>
              自定义
            </Tag.CheckableTag>
          </Space>
          <RangePicker
            style={{ width: "100%" }}
            disabled={datePreset !== "custom"}
            value={dateRange as any}
            onChange={(value) => onDateRangeChange(value ? [value[0], value[1]] : null)}
          />
          <div className="compact-count">共 {conversationTotal} 条会话</div>
          <List
            className="scroll-panel conversation-list"
            dataSource={conversations}
            locale={{ emptyText: "请先选择用户" }}
            renderItem={(item) => (
              <List.Item
                className={`selectable-item ${selectedConversationId === item.conversationId ? "is-selected" : ""}`}
                onClick={() => onSelectConversation(item.conversationId)}
              >
                <div className="list-main">
                  <div className="list-title">{item.title || "未命名会话"}</div>
                  <div className="list-subtitle">{item.previewText || item.initialQuery || "-"}</div>
                </div>
                <div className="list-meta">
                  <Tag color={eventTypeColor(item.latestEventType)}>{item.latestEventType || "unknown"}</Tag>
                  <Text type="secondary">{item.updatedAt || item.createdAt || "-"}</Text>
                </div>
              </List.Item>
            )}
          />
        </Card>
      </Sider>
      <Content className="console-content">
        <div className="main-grid">
          <div className="workspace-grid enhanced-workspace-grid">
            <Card className="panel-card chat-card" bordered={false} title="对话历史">
              <div className="chat-context-strip">
                <div>
                  <div className="context-label">已选会话</div>
                  <div className="context-value">{selectedConversationId || "-"}</div>
                </div>
                <div>
                  <div className="context-label">消息数</div>
                  <div className="context-value">{timeline?.messages?.length || 0}</div>
                </div>
                <div>
                  <div className="context-label">当前 turn</div>
                  <div className="context-value">{selectedTurn?.turn_index || "-"}</div>
                </div>
              </div>
              {!timeline?.messages?.length ? (
                <Empty description="选择会话后查看聊天流" />
              ) : (
                <div className="scroll-panel chat-scroll">
                  {timeline.messages.map((item) => (
                    <div
                      key={`${item.role}-${item.message_id}`}
                      className={`chat-row ${item.role === "assistant" ? "assistant" : "user"}`}
                    >
                      <div
                        className={`chat-bubble ${item.role === "assistant" ? "assistant" : "user"} ${
                          selectedTurn?.turn_index === item.turn_index && item.role === "assistant" ? "active" : ""
                        }`}
                        onClick={() => {
                          if (item.role === "assistant") {
                            onSelectAssistantMessage(item);
                          }
                        }}
                      >
                        <div className="chat-meta">
                          <Tag color={item.role === "assistant" ? "geekblue" : "gold"}>
                            {item.role === "assistant" ? "assistant" : "user"}
                          </Tag>
                          <Text type="secondary">
                            TURN {item.turn_index} / {item.created_at || "-"}
                          </Text>
                        </div>
                        {item.role === "assistant" ? (
                          <MarkdownMessage content={item.content} />
                        ) : (
                          <div className="plain-message-text">{item.content || "-"}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <TurnEventInspector
              turn={selectedTurn}
              selectedEvent={selectedEvent}
              onSelectEvent={onSelectEvent}
              emptyDescription="点击 assistant 消息查看当前 turn 的 events"
              titlePrefix="Turn Events"
            />
          </div>
        </div>
      </Content>
    </Layout>
  );
}

function ToolDetailModal({
  payload,
  onClose,
}: {
  payload: ToolModalPayload | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={!!payload}
      title={payload?.tool.name || "Tool 详情"}
      onCancel={onClose}
      footer={null}
      width={860}
      destroyOnClose
    >
      {!payload ? null : (
        <div className="tool-modal-body">
          <Card className="panel-card tool-detail-card" bordered={false}>
            <Space wrap>
              <Tag color={payload.provider.provider_type === "mcp" ? "geekblue" : "purple"}>
                {payload.provider.provider_type === "mcp" ? "MCP" : "Internal"}
              </Tag>
              <Text>{payload.provider.name}</Text>
              {payload.provider.url ? <Text type="secondary">{payload.provider.url}</Text> : null}
            </Space>
            <Paragraph className="tool-modal-description">{payload.tool.description || "-"}</Paragraph>
          </Card>
          <Card className="panel-card tool-detail-card" bordered={false} title="输入参数 Schema">
            <SchemaInspector
              schema={payload.tool.input_schema || {}}
              emptyDescription="当前工具没有声明输入参数 Schema"
            />
          </Card>
          <Card className="panel-card tool-detail-card" bordered={false} title="输出结果 Schema">
            <SchemaInspector
              schema={payload.tool.output_schema || {}}
              emptyDescription="当前工具没有声明输出结果 Schema"
            />
          </Card>
        </div>
      )}
    </Modal>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="turn-summary-pill">
      <div className="turn-metric-label">{label}</div>
      <div className="turn-metric-value">{value}</div>
    </div>
  );
}

function pollStatusText(
  status: "idle" | "connecting" | "connected" | "error",
  outputMode: EffectiveOutputMode
) {
  const modeLabel = outputMode === "sse" ? "SSE" : "Block";
  switch (status) {
    case "connecting":
      return `${modeLabel} 连接中`;
    case "connected":
      return outputMode === "sse" ? "SSE 增量输出中" : "Block 轮询已拿到增量";
    case "error":
      return `${modeLabel} 请求异常`;
    default:
      return "空闲";
  }
}

function statusClass(status: string | undefined) {
  switch ((status || "").toLowerCase()) {
    case "connected":
      return "is-ok";
    case "degraded":
      return "is-warn";
    default:
      return "is-danger";
  }
}

function shouldRetryLatestTurnProjection(options: {
  latestAssistantTurnIndex: number | null;
  previousTurnIndex: number | null;
  attempt: number;
}): boolean {
  const { latestAssistantTurnIndex, previousTurnIndex, attempt } = options;
  if (attempt >= 4) {
    return false;
  }
  if (!latestAssistantTurnIndex) {
    return true;
  }
  if (previousTurnIndex === null) {
    return false;
  }
  return latestAssistantTurnIndex <= previousTurnIndex;
}

async function waitForLiveTimelineProjection(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 250));
}

const REQUEST_OUTPUT_MODE_OPTIONS: Array<{ label: string; value: RequestOutputMode }> = [
  { label: "SSE", value: "sse" },
  { label: "Block", value: "block" },
];

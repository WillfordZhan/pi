import { Card, Empty, Segmented, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";
import type { EventItem, ReplayTurn } from "../types";

const { Text, Paragraph } = Typography;

type EventFilter = "all" | "llm" | "tool" | "final" | "error";
type DetailTab = "structured" | "raw";

type Props = {
  turn: ReplayTurn | null;
  selectedEvent: EventItem | null;
  onSelectEvent: (event: EventItem) => void;
  emptyDescription: string;
  titlePrefix?: string;
};

export function TurnEventInspector({
  turn,
  selectedEvent,
  onSelectEvent,
  emptyDescription,
  titlePrefix = "Turn Events",
}: Props) {
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");
  const [detailTab, setDetailTab] = useState<DetailTab>("structured");

  const filteredEvents = useMemo(() => {
    if (!turn) {
      return [];
    }
    if (eventFilter === "all") {
      return turn.events;
    }
    if (eventFilter === "llm") {
      return turn.events.filter((item) =>
        ["llm_request", "llm_response", "assistant_message"].includes(item.event_type)
      );
    }
    if (eventFilter === "tool") {
      return turn.events.filter((item) => item.event_type === "tool_call" || item.event_type === "tool_result");
    }
    if (eventFilter === "final") {
      return turn.events.filter((item) =>
        ["final", "clarification_needed", "answer_delta", "assistant_message"].includes(item.event_type)
      );
    }
    return turn.events.filter((item) => item.event_type === "conversation_failed");
  }, [eventFilter, turn]);

  const effectiveEvent = useMemo(() => {
    if (!selectedEvent) {
      return filteredEvents[0] || null;
    }
    return filteredEvents.find((item) => item.id === selectedEvent.id) || filteredEvents[0] || null;
  }, [filteredEvents, selectedEvent]);

  return (
    <div className="right-stack">
      <Card
        className="panel-card event-list-card"
        bordered={false}
        title={null}
      >
        <div className="turn-events-head">
          <div className="turn-events-head-main">
            <div className="turn-events-title">{`${titlePrefix}${turn ? ` / TURN ${turn.turn_index}` : ""}`}</div>
            <Segmented<EventFilter>
              size="small"
              value={eventFilter}
              onChange={(value) => setEventFilter(value)}
              options={[
                { label: "全部", value: "all" },
                { label: "LLM", value: "llm" },
                { label: "Tool", value: "tool" },
                { label: "Final", value: "final" },
                { label: "Error", value: "error" },
              ]}
            />
          </div>
          {turn ? (
            <div className="turn-events-summary">
              <MetricItem label="Events" value={String(turn.event_count)} />
              <MetricItem label="Anchor" value={String(turn.anchor_event_id)} />
              <MetricItem label="Assistant" value={String(turn.assistant_message_event_id || "-")} />
            </div>
          ) : null}
        </div>
        {!turn ? (
          <Empty description={emptyDescription} />
        ) : filteredEvents.length === 0 ? (
          <Empty description="当前过滤条件下没有事件" />
        ) : (
          <div className="scroll-panel event-scroll enhanced-event-list">
            {filteredEvents.map((item) => (
              <div
                key={item.id}
                className={`selectable-item enhanced-event-item ${effectiveEvent?.id === item.id ? "is-selected" : ""}`}
                onClick={() => onSelectEvent(item)}
              >
                <div className="list-main">
                  <div className="list-title">
                    <Space size="small">
                      <span className="event-dot" style={{ background: eventTypeSwatch(item.event_type) }} />
                      <Tag color={eventTypeColor(item.event_type)}>{item.event_type}</Tag>
                    </Space>
                  </div>
                  <div className="list-subtitle">{item.summary}</div>
                </div>
                <Text type="secondary">{item.created_at}</Text>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        className="panel-card event-detail-card"
        bordered={false}
        title="Event Detail"
        extra={
          <Segmented<DetailTab>
            size="small"
            value={detailTab}
            onChange={(value) => setDetailTab(value)}
            options={[
              { label: "结构化视图", value: "structured" },
              { label: "Raw JSON", value: "raw" },
            ]}
          />
        }
      >
        {!effectiveEvent ? (
          <Empty description="选择一个 event 查看详情" />
        ) : (
          <div className="scroll-panel detail-scroll">
            <Space size="middle" wrap>
              <Tag color={eventTypeColor(effectiveEvent.event_type)}>{effectiveEvent.event_type}</Tag>
              <Text>{effectiveEvent.created_at}</Text>
              <Text type="secondary">
                visible={String(effectiveEvent.visible_in_messages)} / context=
                {String(effectiveEvent.include_in_context)}
              </Text>
            </Space>
            {detailTab === "structured" ? (
              <div className="detail-struct-box">
                <DetailRow label="Summary" value={effectiveEvent.summary} />
                <DetailRow label="Visible" value={String(effectiveEvent.visible_in_messages)} />
                <DetailRow label="Context" value={String(effectiveEvent.include_in_context)} />
                <DetailRow
                  label="Payload"
                  value={JSON.stringify(effectiveEvent.data || {}, null, 2)}
                  preserveWhitespace
                />
              </div>
            ) : (
              <Paragraph className="json-box">{effectiveEvent.raw_json}</Paragraph>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function MetricItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="turn-summary-pill">
      <div className="turn-metric-label">{label}</div>
      <div className="turn-metric-value">{value}</div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  preserveWhitespace = false,
}: {
  label: string;
  value: string;
  preserveWhitespace?: boolean;
}) {
  return (
    <div className="detail-row">
      <div className="detail-row-label">{label}</div>
      <div className={`detail-row-value ${preserveWhitespace ? "is-mono" : ""}`}>{value}</div>
    </div>
  );
}

export function eventTypeColor(eventType: string | undefined) {
  switch (eventType) {
    case "final":
      return "green";
    case "conversation_failed":
      return "red";
    case "clarification_needed":
      return "orange";
    case "tool_result":
      return "cyan";
    case "tool_call":
      return "purple";
    case "llm_request":
    case "llm_response":
    case "assistant_message":
      return "geekblue";
    case "user_message":
      return "gold";
    default:
      return "default";
  }
}

function eventTypeSwatch(eventType: string | undefined) {
  switch (eventType) {
    case "final":
      return "#71d7a1";
    case "conversation_failed":
      return "#ff9384";
    case "clarification_needed":
      return "#f2ca68";
    case "tool_result":
      return "#76dfff";
    case "tool_call":
      return "#b69bff";
    case "llm_request":
    case "llm_response":
    case "assistant_message":
      return "#7ed8ff";
    case "user_message":
      return "#f4a261";
    default:
      return "rgba(255,255,255,0.42)";
  }
}

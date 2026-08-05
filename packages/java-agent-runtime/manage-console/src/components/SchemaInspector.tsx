// 模块说明：把不同 JSON/schema 范式统一投影成可读结构视图，并保留 raw JSON 兜底，避免调试弹窗直接暴露大段原始协议。

import { CaretDownFilled, CaretRightFilled } from "@ant-design/icons";
import { Empty, Segmented, Space, Tag, Typography } from "antd";
import { useMemo, useState } from "react";

const { Paragraph } = Typography;

type DetailTab = "structured" | "raw";

type StructuredNodeKind =
  | "object"
  | "array"
  | "field"
  | "primitive"
  | "map"
  | "composition"
  | "unknown";

type StructuredSchemaNode = {
  id: string;
  kind: StructuredNodeKind;
  label: string;
  typeLabel?: string;
  description?: string;
  required?: boolean;
  defaultValue?: string;
  enumValues?: string[];
  examples?: string[];
  badges?: string[];
  children?: StructuredSchemaNode[];
};

type SchemaInspectorProps = {
  schema: Record<string, unknown>;
  emptyDescription: string;
};

type SchemaAdapter = {
  kind: string;
  match: (value: unknown) => boolean;
  adapt: (value: unknown) => StructuredSchemaNode | null;
};

export function SchemaInspector({ schema, emptyDescription }: SchemaInspectorProps) {
  const [detailTab, setDetailTab] = useState<DetailTab>("structured");

  const adapted = useMemo(() => adaptSchemaValue(schema), [schema]);
  const isEmptySchema = useMemo(() => isEmptyObject(schema), [schema]);

  if (isEmptySchema) {
    return <Empty description={emptyDescription} />;
  }

  return (
    <div className="schema-inspector">
      <div className="schema-inspector-toolbar">
        <Segmented<DetailTab>
          size="small"
          value={detailTab}
          onChange={(value) => setDetailTab(value)}
          options={[
            { label: "结构化视图", value: "structured" },
            { label: "Raw JSON", value: "raw" },
          ]}
        />
      </div>

      {detailTab === "structured" ? (
        adapted.node ? (
          <div className="schema-tree">
            <SchemaNodeCard node={adapted.node} depth={0} />
          </div>
        ) : (
          <Empty description="当前内容无法提炼出稳定结构，已保留 Raw JSON 供排查。" />
        )
      ) : (
        <Paragraph className="json-box">{JSON.stringify(schema, null, 2)}</Paragraph>
      )}
    </div>
  );
}

function SchemaNodeCard({ node, depth }: { node: StructuredSchemaNode; depth: number }) {
  // 节点默认策略偏“克制”：
  // - 根节点默认展开，保证用户一进来能看见整体结构；
  // - 第一层字段默认收起，避免 schema 一上来铺满整屏；
  // - 叶子节点没有展开态，直接显示摘要即可。
  const hasChildren = Boolean(node.children?.length);
  const hasDetails = Boolean(node.description || buildNodeMetaItems(node).length > 0 || hasChildren);
  const [expanded, setExpanded] = useState(depth === 0);
  const metaItems = buildNodeMetaItems(node);
  const summaryText = buildNodeSummary(node, metaItems);

  return (
    <div className={`schema-tree-node depth-${Math.min(depth, 4)}`}>
      <div className="schema-tree-row">
        {hasDetails ? (
          <button
            type="button"
            className="schema-tree-toggle"
            onClick={() => {
              setExpanded((current) => !current);
            }}
            aria-label={expanded ? `收起 ${node.label}` : `展开 ${node.label}`}
            aria-expanded={expanded}
          >
            {expanded ? <CaretDownFilled /> : <CaretRightFilled />}
          </button>
        ) : null}

        <div className="schema-tree-main">
          <div className="schema-node-title-row">
            <div className="schema-node-title">{node.label}</div>
            <Space size={[6, 6]} wrap>
              {node.typeLabel ? <Tag>{node.typeLabel}</Tag> : null}
              {(node.badges || []).map((badge) => (
                <Tag key={`${node.id}-${badge}`} color="geekblue">
                  {badge}
                </Tag>
              ))}
              {node.required ? <Tag color="orange">必填</Tag> : null}
            </Space>
          </div>
          {summaryText ? <div className="schema-node-summary">{summaryText}</div> : null}
        </div>
      </div>

      {hasDetails && expanded ? (
        <div className="schema-tree-branch">
          <div className="schema-tree-rail" />
          <div className="schema-tree-panel">
            {metaItems.length > 0 ? (
              <div className="schema-meta-grid">
                {metaItems.map((item) => (
                  <div key={`${node.id}-${item.label}`} className="schema-meta-item">
                    <div className="schema-meta-label">{item.label}</div>
                    <div className="schema-meta-value">{item.value}</div>
                  </div>
                ))}
              </div>
            ) : null}

            {node.children?.length ? (
              <div className="schema-children">
                {node.children.map((child) => (
                  <SchemaNodeCard key={child.id} node={child} depth={depth + 1} />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function buildNodeSummary(
  node: StructuredSchemaNode,
  metaItems: Array<{ label: string; value: string }>
): string {
  const parts: string[] = [];
  if (node.description) {
    parts.push(node.description);
  }
  if (metaItems.length > 0) {
    parts.push(metaItems.map((item) => `${item.label}：${item.value}`).join("；"));
  }
  if (node.children?.length) {
    parts.push(`包含 ${node.children.length} 个子项`);
  }
  return parts.join(" · ");
}

function buildNodeMetaItems(node: StructuredSchemaNode): Array<{ label: string; value: string }> {
  const items: Array<{ label: string; value: string }> = [];
  if (node.defaultValue) {
    items.push({ label: "默认值", value: node.defaultValue });
  }
  if (node.enumValues?.length) {
    items.push({ label: "枚举值", value: node.enumValues.join(" / ") });
  }
  if (node.examples?.length) {
    items.push({ label: node.examples.length > 1 ? "示例" : "示例值", value: node.examples.join("\n\n") });
  }
  return items;
}

function adaptSchemaValue(schema: unknown): {
  adapterKind: string;
  node: StructuredSchemaNode | null;
} {
  const adapter = SCHEMA_ADAPTERS.find((item) => item.match(schema)) || FALLBACK_ADAPTER;
  return {
    adapterKind: adapter.kind,
    node: adapter.adapt(schema),
  };
}

const SCHEMA_ADAPTERS: SchemaAdapter[] = [
  {
    kind: "json-schema",
    match: isLikelyJsonSchema,
    adapt: (value) => buildJsonSchemaNode(value, "root", "Root"),
  },
  {
    kind: "simple-map",
    match: isSimpleDescriptionMap,
    adapt: (value) => buildSimpleMapNode(value as Record<string, unknown>),
  },
];

const FALLBACK_ADAPTER: SchemaAdapter = {
  kind: "fallback-json",
  match: () => true,
  adapt: (value) => buildFallbackNode(value, "root", "Root"),
};

function isLikelyJsonSchema(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.type === "string") {
    return true;
  }
  if (isRecord(value.properties) || Array.isArray(value.required) || isRecord(value.items)) {
    return true;
  }
  if (Array.isArray(value.oneOf) || Array.isArray(value.anyOf) || Array.isArray(value.allOf)) {
    return true;
  }
  return false;
}

function isSimpleDescriptionMap(value: unknown): boolean {
  if (!isRecord(value) || isEmptyObject(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return false;
  }
  return entries.every(([, child]) => typeof child === "string");
}

function buildJsonSchemaNode(value: unknown, path: string, fallbackLabel: string): StructuredSchemaNode | null {
  if (!isRecord(value)) {
    return buildFallbackNode(value, path, fallbackLabel);
  }

  const requiredSet = new Set(asStringArray(value.required));
  const properties = isRecord(value.properties) ? value.properties : null;
  const title = asNonEmptyText(value.title) || fallbackLabel;
  const description = asNonEmptyText(value.description);
  const rawType = normalizeTypeLabel(value.type, properties ? "object" : undefined);
  const badges = collectSchemaBadges(value);
  const enumValues = asPrimitiveArray(value.enum);
  const examples = extractExamples(value);
  const defaultValue = formatValue(value.default);
  const children: StructuredSchemaNode[] = [];

  if (properties) {
    for (const [key, child] of Object.entries(properties)) {
      const childNode = buildJsonSchemaNode(child, `${path}.properties.${key}`, key);
      if (!childNode) {
        continue;
      }
      children.push({
        ...childNode,
        kind: "field",
        label: key,
        required: requiredSet.has(key),
      });
    }
  }

  const items = value.items;
  if (items !== undefined) {
    const arrayItemNode = buildJsonSchemaNode(items, `${path}.items`, "数组成员");
    if (arrayItemNode) {
      children.push(arrayItemNode);
    }
  }

  const compositionChildren = buildCompositionChildren(value, path);
  children.push(...compositionChildren);

  return {
    id: path,
    kind: properties ? "object" : rawType === "array" ? "array" : enumValues.length > 0 ? "primitive" : "unknown",
    label: title,
    typeLabel: rawType || "schema",
    description,
    defaultValue,
    enumValues,
    examples,
    badges,
    children,
  };
}

function buildCompositionChildren(value: Record<string, unknown>, path: string): StructuredSchemaNode[] {
  const entries: Array<[keyof Pick<Record<string, unknown>, "oneOf" | "anyOf" | "allOf">, string]> = [
    ["oneOf", "满足其一"],
    ["anyOf", "任意其一"],
    ["allOf", "组合合并"],
  ];
  const children: StructuredSchemaNode[] = [];

  for (const [key, label] of entries) {
    const list = Array.isArray(value[key]) ? value[key] : [];
    if (!list.length) {
      continue;
    }
    const optionChildren = list
      .map((item, index) => buildJsonSchemaNode(item, `${path}.${key}.${index}`, `选项 ${index + 1}`))
      .filter((item): item is StructuredSchemaNode => Boolean(item));
    children.push({
      id: `${path}.${key}`,
      kind: "composition",
      label,
      typeLabel: key,
      badges: [`${list.length} 个候选`],
      children: optionChildren,
    });
  }

  return children;
}

function collectSchemaBadges(value: Record<string, unknown>): string[] {
  const badges: string[] = [];
  if (value.additionalProperties === false) {
    badges.push("禁止额外字段");
  }
  if (typeof value.format === "string") {
    badges.push(`format: ${value.format}`);
  }
  return badges;
}

function buildSimpleMapNode(value: Record<string, unknown>): StructuredSchemaNode {
  return {
    id: "root",
    kind: "map",
    label: "字段说明",
    typeLabel: "map",
    description: "当前结构不是标准 JSON Schema，已按“字段 -> 说明”的轻量映射展示。",
    children: Object.entries(value).map(([key, child]) => ({
      id: `root.map.${key}`,
      kind: "field",
      label: key,
      typeLabel: "description",
      description: typeof child === "string" ? child : formatValue(child),
    })),
  };
}

function buildFallbackNode(value: unknown, path: string, label: string): StructuredSchemaNode | null {
  if (Array.isArray(value)) {
    return {
      id: path,
      kind: "array",
      label,
      typeLabel: "array",
      badges: value.length ? [`${value.length} 项`] : ["空数组"],
      children: value
        .slice(0, 12)
        .map((item, index) => buildFallbackNode(item, `${path}.${index}`, `成员 ${index + 1}`))
        .filter((item): item is StructuredSchemaNode => Boolean(item)),
    };
  }

  if (isRecord(value)) {
    return {
      id: path,
      kind: "object",
      label,
      typeLabel: "object",
      badges: Object.keys(value).length ? [`${Object.keys(value).length} 个字段`] : ["空对象"],
      children: Object.entries(value)
        .slice(0, 24)
        .map(([key, child]) => {
          const childNode = buildFallbackNode(child, `${path}.${key}`, key);
          if (childNode) {
            return { ...childNode, kind: "field", label: key };
          }
          return null;
        })
        .filter((item): item is StructuredSchemaNode => Boolean(item)),
    };
  }

  return {
    id: path,
    kind: "primitive",
    label,
    typeLabel: inferPrimitiveType(value),
    description: formatValue(value),
  };
}

function normalizeTypeLabel(typeValue: unknown, fallback?: string): string {
  if (typeof typeValue === "string" && Boolean(typeValue.trim())) {
    return typeValue;
  }
  if (Array.isArray(typeValue)) {
    const items = typeValue.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    if (items.length) {
      return items.join(" | ");
    }
  }
  return fallback || "unknown";
}

function extractExamples(value: Record<string, unknown>): string[] {
  const collected: string[] = [];
  if (value.example !== undefined) {
    collected.push(formatExampleValue(value.example));
  }
  if (Array.isArray(value.examples)) {
    collected.push(formatExampleCollection(value.examples));
  }
  return Array.from(new Set(collected.filter((item) => item.trim())));
}

function formatExampleValue(value: unknown): string {
  // Examples 的目标是让用户快速扫一眼典型值，而不是阅读一段格式化 JSON。
  // 因此数组示例统一压成单行，避免一个叶子节点因为示例值换行而显得过重。
  if (Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return formatValue(value);
}

function formatExampleCollection(values: unknown[]): string {
  // schema.examples 通常表达“这一字段的一组典型候选值”，
  // 对阅读者来说更像一个集合，而不是多条独立记录，因此统一压成单行展示。
  try {
    return JSON.stringify(values);
  } catch {
    return values.map((item) => String(item)).join(", ");
  }
}

function inferPrimitiveType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

function asPrimitiveArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item === null || ["string", "number", "boolean"].includes(typeof item))
    .map((item) => formatValue(item));
}

function asNonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEmptyObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

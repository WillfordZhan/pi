// 模块说明：统一承接 assistant 消息的 Markdown 渲染，避免对话视图各自直出文本导致展示能力分裂。

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  content?: string | null;
};

export function MarkdownMessage({ content }: Props) {
  // assistant 返回为空时统一兜底为短横线，避免不同页面各自处理空值显示。
  const normalizedContent = content?.trim() ? content : "-";

  return (
    <div className="markdown-message">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizedContent}</ReactMarkdown>
    </div>
  );
}

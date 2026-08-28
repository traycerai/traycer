import { cn } from "@/lib/utils";
import { StreamingMarkdown } from "@tailmark/react";
import { useMemo, type ComponentType } from "react";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";
import { CodeBlock, PreBlock } from "./components/code-block";
import { MarkdownAnchor } from "./components/markdown-anchor";
import { MermaidBlock } from "./components/mermaid-block";
import { TraycerChatReference } from "./components/traycer-chat-reference";
import { TraycerEpicReference } from "./components/traycer-epic-reference";
import { TraycerSpecReference } from "./components/traycer-spec-reference";
import { TraycerTicketReference } from "./components/traycer-ticket-reference";
import {
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrapper,
} from "./components/table-wrapper";
import {
  assistantMarkdownUrlTransform,
  markdownUrlTransform,
} from "./links/markdown-url-transform";
import {
  TRAYCER_CHAT_TAG,
  TRAYCER_EPIC_TAG,
  TRAYCER_MERMAID_TAG,
  TRAYCER_SPEC_TAG,
  TRAYCER_TICKET_TAG,
} from "./plugins/const";
import { rehypeCustomMermaid } from "./plugins/rehype-custom-mermaid";
import { rehypeTraycerChat } from "./plugins/rehype-traycer-chat";
import { rehypeTraycerEpic } from "./plugins/rehype-traycer-epic";
import { rehypeTraycerSpec } from "./plugins/rehype-traycer-spec";
import { rehypeTraycerTicket } from "./plugins/rehype-traycer-ticket";
import {
  extendAssistantImageSanitizeSchema,
  extendTraycerSanitizeSchema,
} from "./plugins/rehype-sanitize-schema";
import { getTraycerStreamingHighlighter } from "./traycer-streaming-highlighter";

const TRAYCER_STREAMING_HIGHLIGHTER = getTraycerStreamingHighlighter();

// Product rehype plugins only. Tailmark already runs rehype-raw, sanitize, and
// its marker policy; do not re-register GFM / disable-indented-code (built-in).
// Intentionally no Tailmark `repairs` for next-steps - custom repairs force the
// full-document repair path, and TextSegment peels next-steps before render.
const PRODUCT_REHYPE_PLUGINS: PluggableList = [
  rehypeCustomMermaid,
  rehypeTraycerChat,
  rehypeTraycerEpic,
  rehypeTraycerSpec,
  rehypeTraycerTicket,
];

// Product custom tags (mermaid + traycer references) are not on react-markdown's
// `Components` keyof surface; cast after building the map so StreamingMarkdown
// still receives a single stable components object.
const DEFAULT_COMPONENTS = {
  a: MarkdownAnchor as Components["a"],
  code: CodeBlock as Components["code"],
  pre: PreBlock as Components["pre"],
  table: TableWrapper as Components["table"],
  thead: TableHead as Components["thead"],
  th: TableHeader as Components["th"],
  td: TableCell as Components["td"],
  tr: TableRow as Components["tr"],
  [TRAYCER_MERMAID_TAG]: MermaidBlock as ComponentType<Record<string, unknown>>,
  [TRAYCER_SPEC_TAG]: TraycerSpecReference as ComponentType<
    Record<string, unknown>
  >,
  [TRAYCER_TICKET_TAG]: TraycerTicketReference as ComponentType<
    Record<string, unknown>
  >,
  [TRAYCER_CHAT_TAG]: TraycerChatReference as ComponentType<
    Record<string, unknown>
  >,
  [TRAYCER_EPIC_TAG]: TraycerEpicReference as ComponentType<
    Record<string, unknown>
  >,
} as Components;

export interface TraycerMarkdownProps {
  children: string;
  className: string | null;
  proseSize: "compact" | "normal";
  components: Record<string, ComponentType<Record<string, unknown>>> | null;
  /** Relaxed image sources are reserved for assistant-owned markdown. */
  imageRendering?: "assistant" | "standard";
  remarkPlugins: PluggableList | null;
  rehypePlugins: PluggableList | null;
  quotable: boolean;
  /**
   * Whether `children` is still growing (a streaming turn). Forwarded to
   * Tailmark's `StreamingMarkdown`, which drives open-tail memo and the
   * streaming code-highlight path via `useIsMarkdownStreaming`.
   */
  isStreaming: boolean;
}

export function TraycerMarkdown({
  children,
  className,
  proseSize,
  components,
  imageRendering = "standard",
  remarkPlugins,
  rehypePlugins,
  quotable,
  isStreaming,
}: TraycerMarkdownProps) {
  const mergedComponents = useMemo((): Components => {
    if (!components) return DEFAULT_COMPONENTS;
    return {
      ...DEFAULT_COMPONENTS,
      ...(components as Components),
    };
  }, [components]);

  // Only caller extras - Tailmark already ships GFM + disable-indented-code.
  const effectiveRemarkPlugins = useMemo<PluggableList | undefined>(
    () =>
      remarkPlugins && remarkPlugins.length > 0 ? remarkPlugins : undefined,
    [remarkPlugins],
  );

  const effectiveRehypePlugins = useMemo<PluggableList>(() => {
    if (!rehypePlugins || rehypePlugins.length === 0) {
      return PRODUCT_REHYPE_PLUGINS;
    }
    return [...PRODUCT_REHYPE_PLUGINS, ...rehypePlugins];
  }, [rehypePlugins]);

  return (
    <div
      data-quotable={quotable ? "true" : undefined}
      className={cn(
        "prose dark:prose-invert md-prose max-w-none",
        proseSize === "normal" ? "prose-base" : "prose-sm",
        className,
      )}
    >
      <StreamingMarkdown
        isStreaming={isStreaming}
        highlighter={TRAYCER_STREAMING_HIGHLIGHTER}
        sanitizeSchema={
          imageRendering === "assistant"
            ? extendAssistantImageSanitizeSchema
            : extendTraycerSanitizeSchema
        }
        urlTransform={
          imageRendering === "assistant"
            ? assistantMarkdownUrlTransform
            : markdownUrlTransform
        }
        remarkPlugins={effectiveRemarkPlugins}
        rehypePlugins={effectiveRehypePlugins}
        components={mergedComponents}
      >
        {String(children || "")}
      </StreamingMarkdown>
    </div>
  );
}

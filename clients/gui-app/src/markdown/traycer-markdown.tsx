import { cn } from "@/lib/utils";
import { useMemo, type ComponentType } from "react";
import type { PluggableList } from "unified";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
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
import { MarkdownBlock } from "./markdown-block";
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
import { remarkDisableIndentedCode } from "./plugins/remark-disable-indented-code";
import { TRAYCER_SANITIZE_SCHEMA } from "./plugins/rehype-sanitize-schema";
import { MarkdownStreamingContext } from "./shiki-streaming-context";
import { useMarkdownBlocks } from "./use-markdown-blocks";

const DEFAULT_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkDisableIndentedCode,
];

const DEFAULT_REHYPE_PLUGINS: PluggableList = [
  rehypeRaw,
  rehypeCustomMermaid,
  rehypeTraycerChat,
  rehypeTraycerEpic,
  rehypeTraycerSpec,
  rehypeTraycerTicket,
  [rehypeSanitize, TRAYCER_SANITIZE_SCHEMA],
];

const DEFAULT_COMPONENTS: Record<
  string,
  ComponentType<Record<string, unknown>>
> = {
  a: MarkdownAnchor as ComponentType<Record<string, unknown>>,
  code: CodeBlock as ComponentType<Record<string, unknown>>,
  pre: PreBlock as ComponentType<Record<string, unknown>>,
  table: TableWrapper as ComponentType<Record<string, unknown>>,
  thead: TableHead as ComponentType<Record<string, unknown>>,
  th: TableHeader as ComponentType<Record<string, unknown>>,
  td: TableCell as ComponentType<Record<string, unknown>>,
  tr: TableRow as ComponentType<Record<string, unknown>>,
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
};

export interface TraycerMarkdownProps {
  children: string;
  className: string | null;
  proseSize: "compact" | "normal";
  components: Record<string, ComponentType<Record<string, unknown>>> | null;
  remarkPlugins: PluggableList | null;
  rehypePlugins: PluggableList | null;
  quotable: boolean;
  /**
   * Whether `children` is still growing (a streaming turn). Drives the
   * streaming-aware code-block highlight path via `MarkdownStreamingContext`:
   * the open block throttles its re-highlights and skips cache writes until
   * it settles. Settled blocks are memoized and never re-read this value.
   */
  isStreaming: boolean;
}

export function TraycerMarkdown({
  children,
  className,
  proseSize,
  components,
  remarkPlugins,
  rehypePlugins,
  quotable,
  isStreaming,
}: TraycerMarkdownProps) {
  const mergedComponents = useMemo(
    () =>
      components
        ? { ...DEFAULT_COMPONENTS, ...components }
        : DEFAULT_COMPONENTS,
    [components],
  );

  const effectiveRemarkPlugins = useMemo<PluggableList>(
    () =>
      remarkPlugins
        ? [...DEFAULT_REMARK_PLUGINS, ...remarkPlugins]
        : DEFAULT_REMARK_PLUGINS,
    [remarkPlugins],
  );

  const effectiveRehypePlugins = useMemo<PluggableList>(() => {
    if (!rehypePlugins) return DEFAULT_REHYPE_PLUGINS;
    const sanitizeIndex = DEFAULT_REHYPE_PLUGINS.length - 1;
    return [
      ...DEFAULT_REHYPE_PLUGINS.slice(0, sanitizeIndex),
      ...rehypePlugins,
      DEFAULT_REHYPE_PLUGINS[sanitizeIndex],
    ];
  }, [rehypePlugins]);

  const { blocks, tailStartIndex } = useMarkdownBlocks(String(children || ""));

  return (
    <MarkdownStreamingContext.Provider value={isStreaming}>
      <div
        data-quotable={quotable ? "true" : undefined}
        className={cn(
          "prose dark:prose-invert md-prose max-w-none",
          proseSize === "normal" ? "prose-base" : "prose-sm",
          className,
        )}
      >
        {blocks.map((block) =>
          isStreaming && block.id >= tailStartIndex ? (
            <div key={block.id} data-md-unstable="" className="contents">
              <MarkdownBlock
                raw={block.raw}
                remarkPlugins={effectiveRemarkPlugins}
                rehypePlugins={effectiveRehypePlugins}
                components={mergedComponents}
              />
            </div>
          ) : (
            <MarkdownBlock
              key={block.id}
              raw={block.raw}
              remarkPlugins={effectiveRemarkPlugins}
              rehypePlugins={effectiveRehypePlugins}
              components={mergedComponents}
            />
          ),
        )}
      </div>
    </MarkdownStreamingContext.Provider>
  );
}

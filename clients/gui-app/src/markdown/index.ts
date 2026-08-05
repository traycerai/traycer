export { TraycerMarkdown } from "./traycer-markdown";
export type { TraycerMarkdownProps } from "./traycer-markdown";

export {
  getOrCreateHighlighter,
  highlightCode,
  useShikiHighlighter,
  resolveActiveShikiTheme,
  ensureActiveThemePair,
  MAX_HIGHLIGHT_CHARS,
} from "./shiki-highlighter";
export { getTraycerStreamingHighlighter } from "./traycer-streaming-highlighter";
// Throttle lives in Tailmark; re-export so product surfaces keep one import
// path for streaming code highlight.
export {
  useThrottledHighlight,
  STREAMING_HIGHLIGHT_THROTTLE_MS,
  STREAMING_HIGHLIGHT_SETTLE_MS,
} from "@tailmark/react";
// Streaming flag is owned by Tailmark's StreamingMarkdown.
export { useIsMarkdownStreaming } from "@tailmark/react";

export { CodeBlock, PreBlock } from "./components/code-block";
export {
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrapper,
} from "./components/table-wrapper";
export { MermaidBlock } from "./components/mermaid-block";

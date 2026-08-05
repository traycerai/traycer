export { TraycerMarkdown } from "./traycer-markdown";
export type { TraycerMarkdownProps } from "./traycer-markdown";

export {
  getOrCreateHighlighter,
  highlightCode,
  useShikiHighlighter,
} from "./shiki-highlighter";
export { useThrottledCodeHighlight } from "./use-throttled-code-highlight";
// Streaming flag is owned by Tailmark's StreamingMarkdown; re-export so
// product code (CodeBlock) and tests keep a stable import path.
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

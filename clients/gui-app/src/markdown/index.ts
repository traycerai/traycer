export { TraycerMarkdown } from "./traycer-markdown";
export type { TraycerMarkdownProps } from "./traycer-markdown";

export { MarkdownBlock } from "./markdown-block";
export { useMarkdownBlocks } from "./use-markdown-blocks";
export type {
  MarkdownBlock as MarkdownBlockToken,
  MarkdownBlocksResult,
} from "./use-markdown-blocks";
export { repairMarkdown } from "./markdown-repair";

export {
  getOrCreateHighlighter,
  highlightCode,
  useShikiHighlighter,
} from "./shiki-highlighter";
export { useThrottledCodeHighlight } from "./use-throttled-code-highlight";
// The raw context object stays module-private: external code opts into
// streaming via `TraycerMarkdown`'s `isStreaming` prop, never by mounting
// the provider directly.
export { useIsMarkdownStreaming } from "./shiki-streaming-context";

export { CodeBlock, PreBlock } from "./components/code-block";
export {
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableWrapper,
} from "./components/table-wrapper";
export { MermaidBlock } from "./components/mermaid-block";

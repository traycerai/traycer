import { memo } from "react";
import type { ComponentType } from "react";
import Markdown from "react-markdown";
import type { PluggableList } from "unified";
import { markdownUrlTransform } from "./links/markdown-url-transform";

interface MarkdownBlockProps {
  raw: string;
  remarkPlugins: PluggableList;
  rehypePlugins: PluggableList;
  components: Record<string, ComponentType<Record<string, unknown>>>;
}

export const MarkdownBlock = memo(
  function MarkdownBlock({
    raw,
    remarkPlugins,
    rehypePlugins,
    components,
  }: MarkdownBlockProps) {
    return (
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {raw}
      </Markdown>
    );
  },
  (prev, next) =>
    prev.raw === next.raw &&
    prev.components === next.components &&
    prev.remarkPlugins === next.remarkPlugins &&
    prev.rehypePlugins === next.rehypePlugins,
);

import type { ReactNode } from "react";

type Mark = { type: string; attrs?: Record<string, unknown> };

export function applyMarks(
  children: ReactNode,
  marks: Mark[],
  key: string,
): ReactNode {
  return marks.reduce<ReactNode>((node, mark) => {
    if (mark.type === "bold") return <strong key={key}>{node}</strong>;
    if (mark.type === "italic") return <em key={key}>{node}</em>;
    if (mark.type === "strike") return <s key={key}>{node}</s>;
    if (mark.type === "underline") return <u key={key}>{node}</u>;
    if (mark.type === "code") {
      return (
        <code
          key={key}
          className="rounded bg-muted/80 px-1 py-0.5 font-mono text-[0.85em]"
        >
          {node}
        </code>
      );
    }
    if (mark.type === "link") {
      const href = typeof mark.attrs?.href === "string" ? mark.attrs.href : "#";
      return (
        <a
          key={key}
          href={href}
          className="underline decoration-1 underline-offset-2"
          rel="noopener noreferrer"
        >
          {node}
        </a>
      );
    }
    return node;
  }, children);
}

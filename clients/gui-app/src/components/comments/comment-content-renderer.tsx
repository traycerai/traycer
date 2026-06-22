import { Fragment, type ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { cn } from "@/lib/utils";

/**
 * Read-only renderer for the Tiptap `JSONContent` payload returned by the
 * comment-thread RPC. We intentionally don't mount a second Tiptap editor
 * per comment - the sidebar can render dozens of threads, and an editor
 * instance per card would be wasteful. Instead we walk the doc shape and
 * emit a small set of React elements matching the composer's grammar:
 *
 *   block: paragraph, bulletList, orderedList, listItem
 *   inline: text (with bold / italic / code marks), mention, hardBreak
 *
 * Anything outside that vocabulary degrades to plain text from the node's
 * `text` field (or to a Fragment for unknown blocks). Cross-product safe:
 * Views authors stay within the same grammar.
 */
export interface CommentContentProps {
  readonly content: JsonContent;
  readonly className: string | undefined;
}

export function CommentContent({ content, className }: CommentContentProps) {
  return (
    <div
      data-slot="comment-content"
      className={cn(
        "tc-comment-content text-ui-sm leading-relaxed text-foreground",
        className,
      )}
    >
      <CommentNodeList nodes={content.content ?? []} />
    </div>
  );
}

function CommentNodeList(props: {
  readonly nodes: ReadonlyArray<JsonContent>;
}): ReactNode {
  // The JSONContent payload is immutable input, so positional keys are safe
  // (no reorder, no insertion). Use a path-style key that mixes the node
  // type with its position so siblings of the same type still differ.
  return (
    <>
      {props.nodes.map((node, position) => (
        <Fragment key={nodeKey(node, position)}>
          <CommentNode node={node} />
        </Fragment>
      ))}
    </>
  );
}

function nodeKey(node: JsonContent, position: number): string {
  const type = typeof node.type === "string" ? node.type : "unknown";
  return `${type}#${position.toString()}`;
}

function CommentNode(props: { readonly node: JsonContent }): ReactNode {
  const { node } = props;
  const block = renderBlock(node);
  if (block !== undefined) return block;
  if (node.type === "mention") return renderMention(node);
  if (node.type === "text") return renderText(node);
  // Unknown block - render its inline children as a fallback so a
  // future schema addition (e.g. blockquote) still surfaces text.
  if (node.content !== undefined)
    return <CommentNodeList nodes={node.content} />;
  return node.text ?? null;
}

function renderBlock(node: JsonContent): ReactNode {
  switch (node.type) {
    case "paragraph":
      return (
        <p className="my-1 first:mt-0 last:mb-0">
          <CommentNodeList nodes={node.content ?? []} />
        </p>
      );
    case "bulletList":
      return (
        <ul className="my-1 list-disc pl-5">
          <CommentNodeList nodes={node.content ?? []} />
        </ul>
      );
    case "orderedList":
      return (
        <ol className="my-1 list-decimal pl-5">
          <CommentNodeList nodes={node.content ?? []} />
        </ol>
      );
    case "listItem":
      return (
        <li>
          <CommentNodeList nodes={node.content ?? []} />
        </li>
      );
    case "hardBreak":
      return <br />;
    default:
      return undefined;
  }
}

function renderMention(node: JsonContent): ReactNode {
  const attrs = node.attrs ?? {};
  const label = typeof attrs.label === "string" ? attrs.label : null;
  const id = typeof attrs.id === "string" ? attrs.id : null;
  const display = label !== null && label.length > 0 ? label : (id ?? "");
  return <span className="comment-mention">@{display}</span>;
}

function renderText(node: JsonContent): ReactNode {
  const text = node.text ?? "";
  if (node.marks === undefined || node.marks.length === 0) return text;
  return node.marks.reduce<ReactNode>((acc, mark) => {
    switch (mark.type) {
      case "bold":
        return <strong>{acc}</strong>;
      case "italic":
        return <em>{acc}</em>;
      case "code":
        return (
          <code className="rounded bg-muted px-1 py-0.5 text-ui-xs">{acc}</code>
        );
      case "strike":
        return <s>{acc}</s>;
      default:
        return acc;
    }
  }, text);
}

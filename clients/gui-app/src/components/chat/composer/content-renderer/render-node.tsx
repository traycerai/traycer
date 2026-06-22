import { Fragment, type ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { SlashCommandChip } from "@/components/chat/composer/nodes/slash-command-chip";
import { ComposerMentionDecorator } from "@/components/chat/composer/nodes/composer-mention-decorator";
import {
  mentionAttachmentFromAttrs,
  mentionPlainTextFromAttrs,
  slashCommandPlainTextFromAttrs,
} from "@/lib/composer/tiptap-json-content";

import { applyMarks } from "./render-marks";

const SKIPPED_NODES = new Set(["imageAttachment", "attachmentGroup"]);

type NodeRenderer = (node: JsonContent, key: string) => ReactNode;

function ComposerNodeList(props: {
  readonly nodes: ReadonlyArray<JsonContent>;
  readonly keyPrefix: string;
}): ReactNode[] {
  return props.nodes.map((node, i) => {
    const nodeKey = `${props.keyPrefix}-${i}`;
    return <RenderedComposerNode key={nodeKey} node={node} nodeKey={nodeKey} />;
  });
}

function renderText(node: JsonContent, key: string): ReactNode {
  const text = node.text ?? "";
  const marks = (node.marks ?? []) as {
    type: string;
    attrs?: Record<string, unknown>;
  }[];
  return applyMarks(text, marks, key);
}

function renderMention(node: JsonContent, key: string): ReactNode {
  const mention = mentionAttachmentFromAttrs(node.attrs);
  if (mention === null) {
    return <span key={key}>{mentionPlainTextFromAttrs(node.attrs)}</span>;
  }
  return <ComposerMentionDecorator key={key} mention={mention} />;
}

function renderSlashCommand(node: JsonContent, key: string): ReactNode {
  return (
    <SlashCommandChip
      key={key}
      name={slashCommandPlainTextFromAttrs(node.attrs)}
    />
  );
}

function renderCodeBlock(node: JsonContent, key: string): ReactNode {
  const lang =
    typeof node.attrs?.language === "string" ? node.attrs.language : "";
  const text = (node.content ?? []).map((child) => child.text ?? "").join("");
  return (
    <pre
      key={key}
      data-language={lang || undefined}
      className="my-1 overflow-x-auto rounded bg-muted/80 px-3 py-2 font-mono text-[0.85em]"
    >
      <code>{text}</code>
    </pre>
  );
}

const RENDERERS: Partial<Record<string, NodeRenderer>> = {
  doc: (node, key) => (
    <ComposerNodeList nodes={node.content ?? []} keyPrefix={key} />
  ),
  paragraph: (node, key) => (
    <p key={key} className="m-0 p-0">
      <ComposerNodeList nodes={node.content ?? []} keyPrefix={key} />
    </p>
  ),
  text: renderText,
  hardBreak: (_node, key) => <br key={key} />,
  mention: renderMention,
  slashCommand: renderSlashCommand,
  bulletList: (node, key) => (
    <ul key={key} className="my-0.5 list-disc pl-5">
      <ComposerNodeList nodes={node.content ?? []} keyPrefix={key} />
    </ul>
  ),
  orderedList: (node, key) => (
    <ol key={key} className="my-0.5 list-decimal pl-5">
      <ComposerNodeList nodes={node.content ?? []} keyPrefix={key} />
    </ol>
  ),
  listItem: (node, key) => (
    <li key={key} className="m-0 p-0">
      <ComposerNodeList nodes={node.content ?? []} keyPrefix={key} />
    </li>
  ),
  codeBlock: renderCodeBlock,
  blockquote: (node, key) => (
    <blockquote
      key={key}
      className="my-0.5 border-l-2 border-border pl-3 text-muted-foreground"
    >
      <ComposerNodeList nodes={node.content ?? []} keyPrefix={key} />
    </blockquote>
  ),
};

export function RenderedComposerNode(props: {
  readonly node: JsonContent;
  readonly nodeKey: string;
}): ReactNode {
  const { node, nodeKey } = props;
  const type = node.type ?? "text";
  if (SKIPPED_NODES.has(type)) return null;

  const renderer = RENDERERS[type];
  if (renderer !== undefined) return renderer(node, nodeKey);

  const children = node.content;
  if (children !== undefined && children.length > 0) {
    return (
      <Fragment key={nodeKey}>
        <ComposerNodeList nodes={children} keyPrefix={nodeKey} />
      </Fragment>
    );
  }
  return null;
}

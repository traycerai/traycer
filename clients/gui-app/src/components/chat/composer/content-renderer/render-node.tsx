import { Fragment, type ReactNode } from "react";
import { ImageIcon } from "lucide-react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { SlashCommandChip } from "@/components/chat/composer/nodes/slash-command-chip";
import { ComposerMentionDecorator } from "@/components/chat/composer/nodes/composer-mention-decorator";
import {
  COMPOSER_INLINE_CHIP_CLASSNAME,
  COMPOSER_INLINE_CHIP_ICON_CLASSNAME,
  COMPOSER_INLINE_CHIP_TEXT_CLASSNAME,
} from "@/components/chat/composer/nodes/composer-inline-chip-classnames";
import {
  stringValue,
  mentionAttachmentFromAttrs,
  mentionPlainTextFromAttrs,
  slashCommandPlainTextFromAttrs,
} from "@/lib/composer/tiptap-json-content";
import { fallbackImageAttachmentDisplayLabel } from "@/lib/composer/image-attachment-labels";
import { cn } from "@/lib/utils";

import { applyMarks } from "./render-marks";
import type { ComposerContentRenderContext } from "./types";

const IMAGE_ATTACHMENT_ICON_CLASSNAME = `${COMPOSER_INLINE_CHIP_ICON_CLASSNAME} text-muted-foreground`;
const MINIMAP_INLINE_CHIP_CLASSNAME =
  "mx-[1px] inline-flex min-h-[1.35em] max-w-full items-center gap-[0.28em] rounded border border-border/50 bg-muted/50 px-[0.35em] py-0 align-middle text-[0.9em] font-medium leading-[1.1] whitespace-nowrap select-none";
const MINIMAP_INLINE_CHIP_ICON_CLASSNAME =
  "size-[0.9em] shrink-0 text-muted-foreground";
const MINIMAP_INLINE_CHIP_TEXT_CLASSNAME = "min-w-0 truncate";

const SKIPPED_NODES = new Set(["attachmentGroup"]);

type NodeRenderer = (
  node: JsonContent,
  key: string,
  context: ComposerContentRenderContext,
) => ReactNode;

function ComposerNodeList(props: {
  readonly nodes: ReadonlyArray<JsonContent>;
  readonly keyPrefix: string;
  readonly context: ComposerContentRenderContext;
}): ReactNode[] {
  return props.nodes.map((node, i) => {
    const nodeKey = `${props.keyPrefix}-${i}`;
    return (
      <RenderedComposerNode
        key={nodeKey}
        node={node}
        nodeKey={nodeKey}
        context={props.context}
      />
    );
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

function inlineChipClassName(context: ComposerContentRenderContext): string {
  return context.variant === "minimap"
    ? MINIMAP_INLINE_CHIP_CLASSNAME
    : COMPOSER_INLINE_CHIP_CLASSNAME;
}

function inlineChipIconClassName(
  context: ComposerContentRenderContext,
): string {
  return context.variant === "minimap"
    ? MINIMAP_INLINE_CHIP_ICON_CLASSNAME
    : IMAGE_ATTACHMENT_ICON_CLASSNAME;
}

function inlineChipTextClassName(
  context: ComposerContentRenderContext,
): string {
  return context.variant === "minimap"
    ? MINIMAP_INLINE_CHIP_TEXT_CLASSNAME
    : COMPOSER_INLINE_CHIP_TEXT_CLASSNAME;
}

function renderMention(
  node: JsonContent,
  key: string,
  context: ComposerContentRenderContext,
): ReactNode {
  const mention = mentionAttachmentFromAttrs(node.attrs);
  if (mention === null) {
    return <span key={key}>{mentionPlainTextFromAttrs(node.attrs)}</span>;
  }
  return (
    <ComposerMentionDecorator
      key={key}
      mention={mention}
      className={inlineChipClassName(context)}
      iconClassName={
        context.variant === "minimap"
          ? MINIMAP_INLINE_CHIP_ICON_CLASSNAME
          : COMPOSER_INLINE_CHIP_ICON_CLASSNAME
      }
      textClassName={inlineChipTextClassName(context)}
    />
  );
}

function renderSlashCommand(
  node: JsonContent,
  key: string,
  context: ComposerContentRenderContext,
): ReactNode {
  return (
    <SlashCommandChip
      key={key}
      name={slashCommandPlainTextFromAttrs(node.attrs)}
      className={cn(inlineChipClassName(context), "font-mono text-foreground")}
      textClassName={inlineChipTextClassName(context)}
    />
  );
}

function renderImageAttachment(
  node: JsonContent,
  key: string,
  context: ComposerContentRenderContext,
): ReactNode {
  const id = stringValue(node.attrs?.id);
  const fileName = stringValue(node.attrs?.fileName) ?? "Image";
  const label =
    (id === null ? undefined : context.imageLabelsById.get(id)) ??
    fallbackImageAttachmentDisplayLabel({
      id: id ?? key,
      fileName,
    });
  return (
    <span
      key={key}
      aria-label={`Attached ${label.ariaLabel}`}
      className={cn(inlineChipClassName(context), "text-foreground/90")}
      data-composer-image-id={id ?? undefined}
      data-composer-chip="image-attachment"
      title={label.title}
    >
      <ImageIcon className={inlineChipIconClassName(context)} aria-hidden />
      <span className={inlineChipTextClassName(context)}>
        {label.inlineLabel}
      </span>
    </span>
  );
}

function renderCodeBlock(
  node: JsonContent,
  key: string,
  context: ComposerContentRenderContext,
): ReactNode {
  const lang =
    typeof node.attrs?.language === "string" ? node.attrs.language : "";
  const text = (node.content ?? []).map((child) => child.text ?? "").join("");
  if (text.length === 0) return null;
  if (lang.length === 0 && text.trim().length === 0) return null;
  if (context.variant === "minimap") {
    return (
      <code
        key={key}
        className="rounded bg-muted/70 px-1 font-mono text-[0.9em]"
      >
        {text}
      </code>
    );
  }
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
  doc: (node, key, context) => (
    <ComposerNodeList
      nodes={node.content ?? []}
      keyPrefix={key}
      context={context}
    />
  ),
  paragraph: (node, key, context) =>
    context.variant === "minimap" ? (
      <span key={key} className="contents">
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      </span>
    ) : (
      <p key={key} className="m-0 p-0">
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      </p>
    ),
  text: renderText,
  hardBreak: (_node, key, context) =>
    context.variant === "minimap" ? <span key={key}> </span> : <br key={key} />,
  mention: renderMention,
  slashCommand: renderSlashCommand,
  imageAttachment: renderImageAttachment,
  bulletList: (node, key, context) =>
    context.variant === "minimap" ? (
      <span key={key} className="contents">
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      </span>
    ) : (
      <ul key={key} className="my-0.5 list-disc pl-5">
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      </ul>
    ),
  orderedList: (node, key, context) =>
    context.variant === "minimap" ? (
      <span key={key} className="contents">
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      </span>
    ) : (
      <ol key={key} className="my-0.5 list-decimal pl-5">
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      </ol>
    ),
  listItem: (node, key, context) =>
    context.variant === "minimap" ? (
      <span key={key} className="contents">
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      </span>
    ) : (
      <li key={key} className="m-0 p-0">
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      </li>
    ),
  codeBlock: renderCodeBlock,
  blockquote: (node, key, context) =>
    context.variant === "minimap" ? (
      <span key={key} className="contents">
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      </span>
    ) : (
      <blockquote
        key={key}
        className="my-0.5 border-l-2 border-border pl-3 text-muted-foreground"
      >
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      </blockquote>
    ),
};

export function RenderedComposerNode(props: {
  readonly node: JsonContent;
  readonly nodeKey: string;
  readonly context: ComposerContentRenderContext;
}): ReactNode {
  const { context, node, nodeKey } = props;
  const type = node.type ?? "text";
  if (SKIPPED_NODES.has(type)) return null;

  const renderer = RENDERERS[type];
  if (renderer !== undefined) return renderer(node, nodeKey, context);

  const children = node.content;
  if (children !== undefined && children.length > 0) {
    return (
      <Fragment key={nodeKey}>
        <ComposerNodeList
          nodes={children}
          keyPrefix={nodeKey}
          context={context}
        />
      </Fragment>
    );
  }
  return null;
}

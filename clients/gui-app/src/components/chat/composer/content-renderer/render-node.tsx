import { Fragment, type ReactNode } from "react";
import { ImageIcon } from "lucide-react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { SlashCommandChip } from "@/components/chat/composer/nodes/slash-command-chip";
import { ComposerMentionDecorator } from "@/components/chat/composer/nodes/composer-mention-decorator";
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
      density={context.profile.inlineChipDensity}
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
      density={context.profile.inlineChipDensity}
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
  const classNames = context.profile.inlineChipClassNames;
  return (
    <span
      key={key}
      aria-label={`Attached ${label.ariaLabel}`}
      className={cn(classNames.root, "text-foreground/90")}
      data-composer-image-id={id ?? undefined}
      data-composer-chip="image-attachment"
      title={label.title}
    >
      <ImageIcon className={classNames.mutedIcon} aria-hidden />
      <span className={classNames.text}>{label.inlineLabel}</span>
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
  return context.profile.renderCodeBlock({
    language: lang,
    nodeKey: key,
    text,
  });
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
    context.profile.renderParagraph({
      children: (
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      ),
      nodeKey: key,
    }),
  text: renderText,
  hardBreak: (_node, key, context) => context.profile.renderHardBreak(key),
  mention: renderMention,
  slashCommand: renderSlashCommand,
  imageAttachment: renderImageAttachment,
  bulletList: (node, key, context) =>
    context.profile.renderBulletList({
      children: (
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      ),
      nodeKey: key,
    }),
  orderedList: (node, key, context) =>
    context.profile.renderOrderedList({
      children: (
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      ),
      nodeKey: key,
    }),
  listItem: (node, key, context) =>
    context.profile.renderListItem({
      children: (
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      ),
      nodeKey: key,
    }),
  codeBlock: renderCodeBlock,
  blockquote: (node, key, context) =>
    context.profile.renderBlockquote({
      children: (
        <ComposerNodeList
          nodes={node.content ?? []}
          keyPrefix={key}
          context={context}
        />
      ),
      nodeKey: key,
    }),
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

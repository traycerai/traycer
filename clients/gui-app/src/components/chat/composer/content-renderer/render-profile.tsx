import { Fragment } from "react";

import {
  composerInlineChipClassNames,
  type ComposerInlineChipDensity,
} from "@/components/chat/composer/nodes/composer-inline-chip-classnames";
import { cn } from "@/lib/utils";

import type {
  ComposerContentBlockRenderArgs,
  ComposerContentCodeBlockRenderArgs,
  ComposerContentRenderProfile,
  ComposerContentRenderVariant,
  ComposerContentRootRenderArgs,
  ComposerContentTopLevelNodeRenderArgs,
} from "./types";

const REGULAR_CHIP_CLASS_NAMES = composerInlineChipClassNames("regular");
const COMPACT_CHIP_CLASS_NAMES = composerInlineChipClassNames("compact");

function renderBlockContents({
  children,
  nodeKey,
}: ComposerContentBlockRenderArgs) {
  return (
    <span key={nodeKey} className="contents">
      {children}
    </span>
  );
}

function renderDefaultTopLevelNode({
  child,
}: ComposerContentTopLevelNodeRenderArgs) {
  return child;
}

function renderInlineTopLevelNode({
  child,
  index,
  nodeKey,
}: ComposerContentTopLevelNodeRenderArgs) {
  return (
    <Fragment key={`minimap-${nodeKey}`}>
      {index > 0 ? " " : null}
      {child}
    </Fragment>
  );
}

function renderMessageRoot({
  children,
  className,
  testId,
}: ComposerContentRootRenderArgs) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 text-ui leading-7 text-foreground",
        className,
      )}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

function renderPreviewRoot({
  children,
  className,
  testId,
}: ComposerContentRootRenderArgs) {
  return (
    <div
      className={cn("min-w-0 max-w-full text-foreground", className)}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

function renderMinimapRoot({
  children,
  className,
  testId,
}: ComposerContentRootRenderArgs) {
  return (
    <span
      className={cn("min-w-0 text-inherit", className)}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

function renderParagraph({
  children,
  nodeKey,
}: ComposerContentBlockRenderArgs) {
  return (
    <p key={nodeKey} className="m-0 p-0">
      {children}
    </p>
  );
}

function renderLineBreak(nodeKey: string) {
  return <br key={nodeKey} />;
}

function renderInlineSpace(nodeKey: string) {
  return <span key={nodeKey}> </span>;
}

function renderBulletList({
  children,
  nodeKey,
}: ComposerContentBlockRenderArgs) {
  return (
    <ul key={nodeKey} className="my-0.5 list-disc pl-5">
      {children}
    </ul>
  );
}

function renderOrderedList({
  children,
  nodeKey,
}: ComposerContentBlockRenderArgs) {
  return (
    <ol key={nodeKey} className="my-0.5 list-decimal pl-5">
      {children}
    </ol>
  );
}

function renderListItem({ children, nodeKey }: ComposerContentBlockRenderArgs) {
  return (
    <li key={nodeKey} className="m-0 p-0">
      {children}
    </li>
  );
}

function renderBlockquote({
  children,
  nodeKey,
}: ComposerContentBlockRenderArgs) {
  return (
    <blockquote
      key={nodeKey}
      className="my-0.5 border-l-2 border-primary/60 pl-3 leading-snug text-muted-foreground"
    >
      {children}
    </blockquote>
  );
}

function renderMessageCodeBlock({
  language,
  nodeKey,
  text,
}: ComposerContentCodeBlockRenderArgs) {
  if (text.length === 0) return null;
  if (language.length === 0 && text.trim().length === 0) return null;
  return (
    <pre
      key={nodeKey}
      data-language={language || undefined}
      className="my-1 overflow-x-auto rounded bg-muted/80 px-3 py-2 font-mono text-[0.85em]"
    >
      <code>{text}</code>
    </pre>
  );
}

function renderMinimapCodeBlock({
  language,
  nodeKey,
  text,
}: ComposerContentCodeBlockRenderArgs) {
  if (text.length === 0) return null;
  if (language.length === 0 && text.trim().length === 0) return null;
  return (
    <code
      key={nodeKey}
      className="rounded bg-muted/70 px-1 font-mono text-[0.9em]"
    >
      {text}
    </code>
  );
}

interface RenderProfileOptions {
  readonly density: ComposerInlineChipDensity;
  readonly root: ComposerContentRenderProfile["renderRoot"];
  readonly topLevelNode: ComposerContentRenderProfile["renderTopLevelNode"];
  readonly hardBreak: ComposerContentRenderProfile["renderHardBreak"];
  readonly block: {
    readonly paragraph: ComposerContentRenderProfile["renderParagraph"];
    readonly bulletList: ComposerContentRenderProfile["renderBulletList"];
    readonly orderedList: ComposerContentRenderProfile["renderOrderedList"];
    readonly listItem: ComposerContentRenderProfile["renderListItem"];
    readonly blockquote: ComposerContentRenderProfile["renderBlockquote"];
    readonly codeBlock: ComposerContentRenderProfile["renderCodeBlock"];
  };
}

function renderProfile(
  options: RenderProfileOptions,
): ComposerContentRenderProfile {
  return {
    inlineChipClassNames:
      options.density === "compact"
        ? COMPACT_CHIP_CLASS_NAMES
        : REGULAR_CHIP_CLASS_NAMES,
    inlineChipDensity: options.density,
    renderRoot: options.root,
    renderTopLevelNode: options.topLevelNode,
    renderParagraph: options.block.paragraph,
    renderHardBreak: options.hardBreak,
    renderBulletList: options.block.bulletList,
    renderOrderedList: options.block.orderedList,
    renderListItem: options.block.listItem,
    renderBlockquote: options.block.blockquote,
    renderCodeBlock: options.block.codeBlock,
  };
}

const BLOCK_RENDERERS = {
  paragraph: renderParagraph,
  bulletList: renderBulletList,
  orderedList: renderOrderedList,
  listItem: renderListItem,
  blockquote: renderBlockquote,
  codeBlock: renderMessageCodeBlock,
};

const INLINE_BLOCK_RENDERERS = {
  paragraph: renderBlockContents,
  bulletList: renderBlockContents,
  orderedList: renderBlockContents,
  listItem: renderBlockContents,
  blockquote: renderBlockContents,
  codeBlock: renderMinimapCodeBlock,
};

const RENDER_PROFILES: Record<
  ComposerContentRenderVariant,
  ComposerContentRenderProfile
> = {
  message: renderProfile({
    density: "regular",
    root: renderMessageRoot,
    topLevelNode: renderDefaultTopLevelNode,
    hardBreak: renderLineBreak,
    block: BLOCK_RENDERERS,
  }),
  minimap: renderProfile({
    density: "compact",
    root: renderMinimapRoot,
    topLevelNode: renderInlineTopLevelNode,
    hardBreak: renderInlineSpace,
    block: INLINE_BLOCK_RENDERERS,
  }),
  preview: renderProfile({
    density: "regular",
    root: renderPreviewRoot,
    topLevelNode: renderDefaultTopLevelNode,
    hardBreak: renderLineBreak,
    block: BLOCK_RENDERERS,
  }),
};

export function composerContentRenderProfile(
  variant: ComposerContentRenderVariant,
): ComposerContentRenderProfile {
  return RENDER_PROFILES[variant];
}

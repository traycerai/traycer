import type { ReactNode } from "react";

import type { ImageAttachmentDisplayLabel } from "@/lib/composer/image-attachment-labels";
import type {
  ComposerInlineChipClassNames,
  ComposerInlineChipDensity,
} from "@/components/chat/composer/nodes/composer-inline-chip-classnames";

export type ComposerContentRenderVariant = "message" | "minimap" | "preview";

export interface ComposerContentRootRenderArgs {
  readonly children: ReactNode;
  readonly className: string | undefined;
  readonly testId: string | undefined;
}

export interface ComposerContentTopLevelNodeRenderArgs {
  readonly child: ReactNode;
  readonly index: number;
  readonly nodeKey: string;
}

export interface ComposerContentBlockRenderArgs {
  readonly children: ReactNode;
  readonly nodeKey: string;
}

export interface ComposerContentCodeBlockRenderArgs {
  readonly language: string;
  readonly nodeKey: string;
  readonly text: string;
}

export interface ComposerContentRenderProfile {
  readonly inlineChipClassNames: ComposerInlineChipClassNames;
  readonly inlineChipDensity: ComposerInlineChipDensity;
  readonly renderRoot: (args: ComposerContentRootRenderArgs) => ReactNode;
  readonly renderTopLevelNode: (
    args: ComposerContentTopLevelNodeRenderArgs,
  ) => ReactNode;
  readonly renderParagraph: (args: ComposerContentBlockRenderArgs) => ReactNode;
  readonly renderHardBreak: (nodeKey: string) => ReactNode;
  readonly renderBulletList: (
    args: ComposerContentBlockRenderArgs,
  ) => ReactNode;
  readonly renderOrderedList: (
    args: ComposerContentBlockRenderArgs,
  ) => ReactNode;
  readonly renderListItem: (args: ComposerContentBlockRenderArgs) => ReactNode;
  readonly renderBlockquote: (
    args: ComposerContentBlockRenderArgs,
  ) => ReactNode;
  readonly renderCodeBlock: (
    args: ComposerContentCodeBlockRenderArgs,
  ) => ReactNode;
}

export interface ComposerContentRenderContext {
  readonly imageLabelsById: ReadonlyMap<string, ImageAttachmentDisplayLabel>;
  readonly profile: ComposerContentRenderProfile;
}

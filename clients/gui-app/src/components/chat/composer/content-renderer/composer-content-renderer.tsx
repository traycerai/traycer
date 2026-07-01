import { memo, useMemo, type ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { RenderedComposerNode } from "./render-node";
import type { ComposerContentRenderVariant } from "./types";
import { composerContentRenderProfile } from "./render-profile";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { buildImageAttachmentDisplayLabels } from "@/lib/composer/image-attachment-labels";

interface ComposerContentRendererProps {
  readonly content: JsonContent;
  readonly variant: ComposerContentRenderVariant | undefined;
  readonly className: string | undefined;
  readonly testId: string | undefined;
}

function ComposerContentRendererBase(
  props: ComposerContentRendererProps,
): ReactNode {
  const { className, content, testId } = props;
  const variant = props.variant ?? "message";
  const profile = composerContentRenderProfile(variant);
  const topNodes = content.content ?? [];
  const imageAtoms = useMemo(() => collectImageAtoms(content), [content]);
  const context = useMemo(
    () => ({
      imageLabelsById: buildImageAttachmentDisplayLabels(imageAtoms),
      profile,
    }),
    [imageAtoms, profile],
  );

  const children = topNodes.map((node, i) => {
    const nodeKey = `n${i}`;
    const child = (
      <RenderedComposerNode
        key={nodeKey}
        node={node}
        nodeKey={nodeKey}
        context={context}
      />
    );
    return profile.renderTopLevelNode({
      child,
      index: i,
      nodeKey,
    });
  });

  return profile.renderRoot({ children, className, testId });
}

export const ComposerContentRenderer = memo(ComposerContentRendererBase);

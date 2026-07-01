import { Fragment, memo, useMemo, type ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { RenderedComposerNode } from "./render-node";
import type { ComposerContentRenderVariant } from "./types";
import { collectImageAtoms } from "@/lib/composer/image-atoms";
import { buildImageAttachmentDisplayLabels } from "@/lib/composer/image-attachment-labels";
import { cn } from "@/lib/utils";

interface ComposerContentRendererProps {
  readonly content: JsonContent;
  readonly variant?: ComposerContentRenderVariant;
  readonly className?: string;
  readonly testId?: string;
}

function ComposerContentRendererBase(
  props: ComposerContentRendererProps,
): ReactNode {
  const { className, content, testId } = props;
  const variant = props.variant ?? "message";
  const topNodes = content.content ?? [];
  const imageAtoms = useMemo(() => collectImageAtoms(content), [content]);
  const context = useMemo(
    () => ({
      imageLabelsById: buildImageAttachmentDisplayLabels(imageAtoms),
      variant,
    }),
    [imageAtoms, variant],
  );
  if (variant === "minimap") {
    const minimapChildren = topNodes.map((node, i) => {
      const nodeKey = `n${i}`;
      return (
        <Fragment key={`minimap-${nodeKey}`}>
          {i > 0 ? " " : null}
          <RenderedComposerNode
            node={node}
            nodeKey={nodeKey}
            context={context}
          />
        </Fragment>
      );
    });
    return (
      <span
        className={cn("min-w-0 text-inherit", className)}
        data-testid={testId}
      >
        {minimapChildren}
      </span>
    );
  }

  const children = topNodes.map((node, i) => {
    const nodeKey = `n${i}`;
    return (
      <RenderedComposerNode
        key={nodeKey}
        node={node}
        nodeKey={nodeKey}
        context={context}
      />
    );
  });

  return (
    <div
      className={cn(
        variant === "message"
          ? "flex flex-col gap-1 text-ui leading-7 text-foreground"
          : "min-w-0 max-w-full text-foreground",
        className,
      )}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export const ComposerContentRenderer = memo(ComposerContentRendererBase);

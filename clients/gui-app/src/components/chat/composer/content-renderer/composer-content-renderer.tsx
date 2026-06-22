import { memo, type ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { RenderedComposerNode } from "./render-node";

interface ComposerContentRendererProps {
  readonly content: JsonContent;
}

function ComposerContentRendererBase({
  content,
}: ComposerContentRendererProps): ReactNode {
  const topNodes = content.content ?? [];
  return (
    <div className="flex flex-col gap-1 text-ui leading-7 text-foreground">
      {topNodes.map((node, i) => {
        const nodeKey = `n${i}`;
        return (
          <RenderedComposerNode key={nodeKey} node={node} nodeKey={nodeKey} />
        );
      })}
    </div>
  );
}

export const ComposerContentRenderer = memo(ComposerContentRendererBase);

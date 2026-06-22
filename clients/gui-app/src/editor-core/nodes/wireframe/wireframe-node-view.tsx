import { useCallback, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BlockErrorBoundary } from "../shared/block-error-boundary";
import { WireframeBlockToolbar } from "./wireframe-block-toolbar";
import { WireframeFullscreenDialog } from "./wireframe-fullscreen-dialog";
import { WireframeIframe } from "./wireframe-iframe";

/**
 * NodeView for an embedded UI preview. Two surfaces:
 *
 *  1. Inline: auto-sizing iframe with a floating toolbar.
 *  2. Fullscreen: modal dialog with a larger iframe + Copy HTML.
 *
 * The `htmlContent` attr is the full document body. Anything less than
 * a complete HTML fragment still renders - the browser fills in `<html>`
 * + `<head>` implicitly - but the auto-height measurement is less
 * accurate because `<body>` might not exist yet.
 */
export function WireframeNodeView(props: NodeViewProps) {
  const { node, selected } = props;
  const htmlContent =
    (node.attrs as { htmlContent?: string }).htmlContent ?? "";
  const title = (node.attrs as { title?: string }).title ?? "UI Preview";

  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined") return;
    void navigator.clipboard.writeText(htmlContent).then(() => {
      toast.success("HTML copied to clipboard");
    });
  }, [htmlContent]);

  const empty = htmlContent.trim().length === 0;

  return (
    <NodeViewWrapper
      className={cn("tc-node-wireframe", selected && "is-selected")}
    >
      <BlockErrorBoundary title="Wireframe block crashed" onCopy={handleCopy}>
        <WireframeBlockToolbar
          onOpenFullscreen={() => setFullscreenOpen(true)}
          onCopyHtml={handleCopy}
        />

        <div className="tc-node-wireframe__preview">
          {empty ? (
            <div className="tc-node-block__skeleton" aria-hidden="true">
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            </div>
          ) : (
            <WireframeIframe
              htmlContent={htmlContent}
              title={title}
              className=""
              mode="auto"
            />
          )}
        </div>

        <WireframeFullscreenDialog
          open={fullscreenOpen}
          onOpenChange={setFullscreenOpen}
          htmlContent={htmlContent}
          title={title}
        />
      </BlockErrorBoundary>
    </NodeViewWrapper>
  );
}

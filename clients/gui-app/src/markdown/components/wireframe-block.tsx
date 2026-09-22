import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BlockErrorBoundary } from "@/editor-core/nodes/shared/block-error-boundary";
import { WireframeBlockToolbar } from "@/editor-core/nodes/wireframe/wireframe-block-toolbar";
import { WireframeFullscreenDialog } from "@/editor-core/nodes/wireframe/wireframe-fullscreen-dialog";
import { WireframeIframe } from "@/editor-core/nodes/wireframe/wireframe-iframe";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { useCallback, useState } from "react";
import { toast } from "sonner";

// A streamed fence grows a few characters per delta; loading each partial
// document into the iframe would flash a half-built page over and over. Wait
// for the same quiet window the chat mermaid block uses before rendering.
const RENDER_DEBOUNCE_MS = 500;
const WIREFRAME_TITLE = "UI Preview";

interface WireframeBlockProps {
  "data-code"?: string;
  [key: string]: unknown;
}

function decodeWireframeCode(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

/**
 * Chat-side rendering of a ```wireframe fence: the same sandboxed, auto-sized
 * iframe the artifact editor mounts for its wireframe node, with the same
 * toolbar and fullscreen dialog, so a mockup reads identically whether an
 * agent put it in a spec or in a reply.
 */
export function WireframeBlock(props: WireframeBlockProps) {
  const code = decodeWireframeCode(props["data-code"] ?? "");
  const htmlContent = useDebouncedValue(code, RENDER_DEBOUNCE_MS);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined") return;
    void navigator.clipboard.writeText(code).then(() => {
      toast.success("HTML copied to clipboard");
    });
  }, [code]);

  if (code.trim().length === 0) {
    return (
      <div className="tc-node-wireframe">
        <div className="tc-node-block__empty">Empty wireframe block</div>
      </div>
    );
  }

  return (
    // Excluded from quote selection like the mermaid block: the toolbar and
    // the iframe are non-prose UI inside quotable markdown.
    <div className="tc-node-wireframe" data-quote-exclude="">
      <BlockErrorBoundary title="Wireframe block crashed" onCopy={handleCopy}>
        <WireframeBlockToolbar
          onOpenFullscreen={() => setFullscreenOpen(true)}
          onCopyHtml={handleCopy}
        />
        <div className="tc-node-wireframe__preview">
          {htmlContent.trim().length === 0 ? (
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
              title={WIREFRAME_TITLE}
              className=""
              mode="auto"
            />
          )}
        </div>
        <WireframeFullscreenDialog
          open={fullscreenOpen}
          onOpenChange={setFullscreenOpen}
          htmlContent={htmlContent}
          title={WIREFRAME_TITLE}
        />
      </BlockErrorBoundary>
    </div>
  );
}

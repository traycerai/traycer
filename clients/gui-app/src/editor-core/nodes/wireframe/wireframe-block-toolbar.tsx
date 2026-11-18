import { Copy, Maximize2 } from "lucide-react";
import { ToolbarButton } from "../../toolbar/toolbar-button";
import { BlockFloatingToolbar } from "../shared/block-floating-toolbar";

export interface WireframeBlockToolbarProps {
  readonly onOpenFullscreen: () => void;
  readonly onCopyHtml: () => void;
}

/**
 * Action bar for an inline wireframe. Read-only and editable users see
 * the same actions - both are non-destructive.
 */
export function WireframeBlockToolbar(props: WireframeBlockToolbarProps) {
  const { onOpenFullscreen, onCopyHtml } = props;
  return (
    <BlockFloatingToolbar label="Wireframe block actions">
      <ToolbarButton
        icon={<Maximize2 className="size-4" aria-hidden="true" />}
        label="Fullscreen"
        active={false}
        onClick={onOpenFullscreen}
        className="tc-editor-toolbar-button"
      />
      <ToolbarButton
        icon={<Copy className="size-4" aria-hidden="true" />}
        label="Copy HTML"
        active={false}
        onClick={onCopyHtml}
        className="tc-editor-toolbar-button"
      />
    </BlockFloatingToolbar>
  );
}

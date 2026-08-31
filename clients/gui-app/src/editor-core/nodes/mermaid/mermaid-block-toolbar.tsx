import { Copy, Download, Pencil, Share2, X } from "lucide-react";
import { ToolbarButton } from "../../toolbar/toolbar-button";
import { BlockFloatingToolbar } from "../shared/block-floating-toolbar";

export interface MermaidBlockToolbarProps {
  readonly editing: boolean;
  readonly editable: boolean;
  readonly onToggleEdit: () => void;
  readonly onCopyCode: () => void;
  readonly onDownloadPng: () => void;
  /**
   * Hands the PNG to the OS share sheet, or `null` where the shell owns no
   * chooser and Download is already the only route out.
   */
  readonly onSharePng: (() => void) | null;
  readonly downloadDisabled: boolean;
}

/**
 * Floating action bar for a mermaid block. Layout mirrors the global
 * BubbleMenu (same chrome, same `ToolbarButton` primitive) so the two
 * surfaces read as variants of one toolbar system rather than ad-hoc
 * buttons. Edit is hidden for read-only viewers.
 */
export function MermaidBlockToolbar(props: MermaidBlockToolbarProps) {
  const {
    editing,
    editable,
    onToggleEdit,
    onCopyCode,
    onDownloadPng,
    onSharePng,
    downloadDisabled,
  } = props;

  return (
    <BlockFloatingToolbar label="Mermaid block actions">
      {editable ? (
        <ToolbarButton
          icon={
            editing ? (
              <X className="size-4" aria-hidden="true" />
            ) : (
              <Pencil className="size-4" aria-hidden="true" />
            )
          }
          label={editing ? "Close source" : "Edit source"}
          active={editing}
          onClick={onToggleEdit}
          className="tc-editor-toolbar-button"
        />
      ) : null}
      <ToolbarButton
        icon={<Copy className="size-4" aria-hidden="true" />}
        label="Copy code"
        active={false}
        onClick={onCopyCode}
        className="tc-editor-toolbar-button"
      />
      {onSharePng === null ? null : (
        <ToolbarButton
          icon={<Share2 className="size-4" aria-hidden="true" />}
          label="Share PNG"
          active={false}
          disabled={downloadDisabled}
          onClick={onSharePng}
          className="tc-editor-toolbar-button"
        />
      )}
      <ToolbarButton
        icon={<Download className="size-4" aria-hidden="true" />}
        label="Download PNG"
        active={false}
        disabled={downloadDisabled}
        onClick={onDownloadPng}
        className="tc-editor-toolbar-button"
      />
    </BlockFloatingToolbar>
  );
}

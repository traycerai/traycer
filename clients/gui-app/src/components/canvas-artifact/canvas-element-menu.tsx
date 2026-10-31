import type { ReactNode } from "react";
import { Copy, Ellipsis, Trash2, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";
import { CanvasClipboardMenuItems } from "./canvas-clipboard-controls";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import type { CanvasBoardDocument } from "./canvas-board-document";
import type { CanvasSelection } from "./canvas-selection-store";
import { useCanvasEditAction } from "./use-canvas-edit-action";
import { selectCanvasParentElement } from "./canvas-select-parent";

export function CanvasElementMenu({
  disabled,
  onEdit,
  onSelectParent,
  children,
}: {
  readonly children?: ReactNode;
  readonly disabled: boolean;
  readonly onEdit: (edit: ArtboardEdit) => void;
  readonly onSelectParent?: () => void;
}) {
  const triggerDisabled = disabled && onSelectParent === undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Element actions"
          disabled={triggerDisabled}
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {children}
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => onEdit({ kind: "duplicate-element" })}
        >
          <Copy />
          Duplicate element
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          variant="destructive"
          onSelect={() => onEdit({ kind: "delete-element" })}
        >
          <Trash2 />
          Delete element
        </DropdownMenuItem>
        {onSelectParent === undefined ? null : (
          <DropdownMenuItem onSelect={onSelectParent}>
            <ArrowUp />
            Select parent
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The element menu with the clipboard, duplicate, delete and select-parent
 * items. No surface mounts it right now: the selection bar dropped it until
 * these edits are reliable enough to show again. Shift+Enter still selects
 * the parent through `selectCanvasParentElement`.
 */
export function CanvasSelectionMenu(props: {
  readonly selection: CanvasSelection;
  readonly registry: CanvasFrameRegistry;
  readonly document: CanvasBoardDocument | null;
}) {
  const action = useCanvasEditAction(props.selection.artifactId);
  const selectParent = async (): Promise<void> => {
    const moved = await selectCanvasParentElement(
      props.selection,
      props.registry,
    );
    if (!moved) action.setMessage("The page changed. Select the element again.");
  };
  return (
    <div className="flex flex-col gap-1">
      <CanvasElementMenu
        disabled={props.selection.element.generated || action.pending}
        onEdit={(edit) => {
          void action.apply(props.selection, edit);
        }}
        onSelectParent={() => {
          void selectParent();
        }}
      >
        <CanvasClipboardMenuItems {...props} />
      </CanvasElementMenu>
      {action.message === null ? null : (
        <p role="status" className="max-w-sm p-2 text-ui-xs text-destructive">
          {action.message}
        </p>
      )}
    </div>
  );
}

import { useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NewTerminalPickerBody } from "@/components/epic-canvas/sidebar/new-terminal-picker-body";
import {
  buildTerminalTileRef,
  type TerminalLaunchTarget,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useTabSurfaceKey } from "@/hooks/host/use-surface-host-pin";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

interface MobileNewTerminalDialogProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Fired right after a terminal launches, before the dialog closes. The
   * switcher sheet uses it to close itself so the new terminal lands as the
   * visible tile.
   */
  readonly onLaunched: (() => void) | null;
}

/**
 * Dialog shell around the shared raw-terminal picker body (the same host +
 * folder picker the Terminals panel "+" popover uses). A dialog rather than the
 * desktop popover because the phone entry points - a bottom sheet row - have no
 * usable anchor for one. Mounted only while open, so picker state and its
 * bindings query reset per open.
 */
export function MobileNewTerminalDialog(props: MobileNewTerminalDialogProps) {
  const { epicId, tabId, open, onOpenChange, onLaunched } = props;
  // The same per-tab pin surface the sidebar "+" popover keys, so the phone
  // dialog and the desktop popover remember one host pick per tab.
  const surfaceKey = useTabSurfaceKey("new-terminal", tabId);
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  // Same launch wiring as the sidebar "+" popover (`NewTerminalPicker`): the
  // shared body only reports the picked target; opening the tile is the
  // shell's job.
  const handleLaunch = useCallback(
    (target: TerminalLaunchTarget) => {
      navigateNested(epicId, tabId, () =>
        prepareOpenTileInTabFocusTarget(tabId, buildTerminalTileRef(target)),
      );
      onOpenChange(false);
      if (onLaunched !== null) onLaunched();
    },
    [
      navigateNested,
      prepareOpenTileInTabFocusTarget,
      epicId,
      tabId,
      onOpenChange,
      onLaunched,
    ],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(92vw,28rem)] max-w-[min(92vw,28rem)] gap-0 p-0"
        data-testid="mobile-epic-new-terminal-dialog"
        // The picker's workspace search input auto-focuses itself; keep Radix
        // from grabbing focus for the first host row instead.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="border-b border-border/60 px-4 py-3">
          <DialogTitle>New terminal</DialogTitle>
          <DialogDescription className="sr-only">
            Pick a host and folder for the new terminal.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <NewTerminalPickerBody
            epicId={epicId}
            surfaceKey={surfaceKey}
            onLaunch={handleLaunch}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Palette-triggered "Create new terminal" dialog. The ⌘K opener's terminal
 * category used to offer folder rows scoped to the active host only, with no
 * way to pick a different host (audit G2). Rather than re-implementing a host
 * section inside the palette subpage, the palette row opens this dialog,
 * which reuses the exact host+folder picker the sidebar "+" popover uses
 * (`NewTerminalPickerBody`) and launches through the same
 * `openTileIntoTargetGroup` delegate the palette's other opener leaves use.
 *
 * Mounted per active epic tab (`epic-route-session-body.tsx`), mirroring
 * `NewConversationModalHost`: every creation trigger funnels one open request
 * through the store, and the per-tab cleanup effect clears a request left
 * open when the user switches tabs (this component only renders for the
 * ACTIVE session tab), so it can't silently re-pop when the user returns.
 */
import { useCallback, useEffect } from "react";
import { XIcon } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NewTerminalPickerBody } from "@/components/epic-canvas/sidebar/new-terminal-picker-body";
import {
  buildTerminalTileRef,
  type TerminalLaunchTarget,
} from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useNewTerminalModalOpenStore } from "@/stores/epics/new-terminal-modal-open-store";

export function NewTerminalDialogHost(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const request = useNewTerminalModalOpenStore((state) => state.request);
  const close = useNewTerminalModalOpenStore((state) => state.close);
  const navigateNestedFocus = useEpicNestedFocusNavigation();
  const isOpen =
    request !== null &&
    request.epicId === props.epicId &&
    request.tabId === props.tabId;

  // This host only mounts for the active tab. If it unmounts (the user
  // switches to another epic tab) while it still owns the open request,
  // clear it - otherwise the global request lingers with no live host to
  // dismiss it and the dialog re-pops when the user returns to this tab.
  useEffect(() => {
    return () => {
      const current = useNewTerminalModalOpenStore.getState().request;
      if (
        current !== null &&
        current.epicId === props.epicId &&
        current.tabId === props.tabId
      ) {
        useNewTerminalModalOpenStore.getState().close();
      }
    };
  }, [props.epicId, props.tabId]);

  const handleLaunch = useCallback(
    (target: TerminalLaunchTarget) => {
      if (request === null) return;
      openTileIntoTargetGroup({
        tabId: request.tabId,
        groupId: request.groupId,
        ref: buildTerminalTileRef(target),
        navigateNestedFocus,
      });
      close();
    },
    [close, navigateNestedFocus, request],
  );

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="w-[min(90vw,28rem)] max-w-[min(90vw,28rem)] gap-0 p-0"
        data-testid="new-terminal-dialog"
        showCloseButton={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            className="absolute right-0 top-0 z-10 size-6 -translate-y-1/2 translate-x-1/2 rounded-full border border-border/70 bg-popover text-muted-foreground opacity-70 shadow-sm transition-opacity hover:opacity-100 focus-visible:opacity-100"
          >
            <XIcon className="size-3.5" />
          </Button>
        </DialogClose>
        <DialogTitle className="sr-only">Create new terminal</DialogTitle>
        {isOpen ? (
          <NewTerminalPickerBody
            epicId={props.epicId}
            onLaunch={handleLaunch}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

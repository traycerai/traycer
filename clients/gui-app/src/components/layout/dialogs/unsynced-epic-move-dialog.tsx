import { useEffect, useRef } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  epicHasUnsyncedEdits,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import type { EpicNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";

export function UnsyncedEpicMoveDialog(props: {
  readonly flow: EpicNewWindowFlow;
}) {
  const waitForSyncRef = useRef<HTMLButtonElement | null>(null);
  const request = props.flow.pendingMove;
  const epicId = request?.epicId ?? null;

  useEffect(() => {
    if (epicId === null) return;
    const registry = getOpenEpicRegistry();
    const check = () => {
      if (!epicHasUnsyncedEdits(epicId)) {
        props.flow.waitForSync();
      }
    };
    const unsubscribe = registry.subscribe(check);
    check();
    return () => {
      unsubscribe();
    };
  }, [epicId, props.flow]);

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) props.flow.cancelMove();
      }}
    >
      <DialogContent
        data-testid="epic-move-unsynced-dialog"
        onOpenAutoFocus={(event) => {
          // Same shape, same reason as `unsynced-close-dialog`: Radix focuses
          // the first tabbable descendant and this footer's DOM order puts the
          // destructive "Discard and move" first, which is what puts the safe
          // action rightmost on `sm:`.
          //
          // Measured by `__tests__/unsynced-epic-move-dialog.test.tsx`, which
          // opens this dialog and reads `document.activeElement`: with this
          // handler's `preventDefault(); safe.focus()` removed, focus lands on
          // `epic-move-unsynced-discard`; with it, on the safe button. It
          // also asserts the DOM-order premise (destructive first), so it
          // cannot go stale silently. The tab-close sibling was first driven
          // in a real browser (`FOCUS_ON_OPEN = epic-tab-unsynced-discard`).
          const safe = waitForSyncRef.current;
          if (safe === null) return;
          event.preventDefault();
          safe.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>You have unsynced changes for this Epic.</DialogTitle>
          <DialogDescription>
            Wait for sync before moving it, or discard local edits and open it
            in a new window now.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            onClick={() => props.flow.discardAndMove()}
            data-testid="epic-move-unsynced-discard"
          >
            <ExternalLink />
            Discard and move
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => props.flow.waitForSync()}
            data-testid="epic-move-unsynced-wait"
            ref={waitForSyncRef}
          >
            Wait for sync
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

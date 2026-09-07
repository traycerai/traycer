import { useEffect, useRef } from "react";
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

interface UnsyncedCloseDialogProps {
  readonly open: boolean;
  readonly epicId: string | null;
  readonly onWait: () => void;
  readonly onDiscard: () => void;
}

export function UnsyncedCloseDialog(props: UnsyncedCloseDialogProps) {
  const keepOpenRef = useRef<HTMLButtonElement | null>(null);
  const { onDiscard, onWait, open, epicId } = props;

  useEffect(() => {
    if (epicId === null) return;
    const registry = getOpenEpicRegistry();
    const check = () => {
      if (!epicHasUnsyncedEdits(epicId)) {
        onWait();
      }
    };
    const unsubscribe = registry.subscribe(check);
    check();
    return () => {
      unsubscribe();
    };
  }, [epicId, onWait]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onWait();
      }}
    >
      <DialogContent
        data-testid="epic-tab-unsynced-dialog"
        onOpenAutoFocus={(event) => {
          // A destructive confirmation must not open focused on its destructive control.
          const safe = keepOpenRef.current;
          if (safe === null) return;
          event.preventDefault();
          safe.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>You have unsynced changes for this Epic.</DialogTitle>
          <DialogDescription>
            They'll be discarded if you close the tab now. Keep it open and
            they'll sync as soon as the connection returns.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            onClick={onDiscard}
            data-testid="epic-tab-unsynced-discard"
          >
            Close anyway
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={onWait}
            data-testid="epic-tab-unsynced-wait"
            ref={keepOpenRef}
          >
            Keep open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect } from "react";
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
      <DialogContent data-testid="epic-move-unsynced-dialog">
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
          >
            Wait for sync
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

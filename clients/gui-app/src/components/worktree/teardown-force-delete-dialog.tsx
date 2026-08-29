import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { TeardownDisclosure } from "@/components/worktree/teardown-disclosure";
import { useTeardownAgentNames } from "@/lib/worktree/teardown-agent-names";

/**
 * Force-delete confirm built on the shared `TeardownDisclosure`. Title and
 * the danger action are delete-flavored; the holder list is not forked.
 */
export function TeardownForceDeleteDialog(props: {
  readonly open: boolean;
  readonly worktreeLabel: string;
  readonly holders: readonly WorktreeBusyHolder[];
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}) {
  const agentNames = useTeardownAgentNames(props.holders);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onDismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,34rem)] gap-0 overflow-hidden p-0 sm:max-w-xl"
        data-testid="teardown-force-delete-dialog"
      >
        <div className="flex min-w-0 items-start gap-3 p-5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-4" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <DialogTitle className="text-ui font-semibold leading-snug wrap-anywhere">
              Delete worktree {props.worktreeLabel}?
            </DialogTitle>
            <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground wrap-anywhere">
              It&apos;s still held by the following. Deleting will stop them
              first.
            </DialogDescription>
          </div>
        </div>
        <div className="min-w-0 px-5 pb-4">
          <TeardownDisclosure holders={props.holders} agentNames={agentNames} />
        </div>
        <div
          className="flex min-w-0 flex-wrap justify-end gap-2 border-t border-border/60 bg-foreground/3 px-5 py-3"
          data-testid="teardown-force-delete-footer"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onDismiss}
            data-testid="teardown-force-delete-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={props.onConfirm}
            data-testid="teardown-force-delete-confirm"
          >
            Stop all & delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

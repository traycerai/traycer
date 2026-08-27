import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TeardownDisclosure } from "@/components/worktree/teardown-disclosure";

export type TeardownCommitChoice = "commit" | "submit" | "blocked";

/**
 * Gesture-time confirm for a worktree commit that would tear holders down.
 * `immediate` is "stop and switch now"; `defer` is "apply on next message";
 * `blocked` is the legacy-host WORKTREE_REBIND_BLOCKED pivot (defer only).
 */
export function TeardownCommitDialog(props: {
  readonly open: boolean;
  readonly choice: TeardownCommitChoice | null;
  readonly holders: readonly WorktreeBusyHolder[];
  readonly onImmediate: () => void;
  readonly onDefer: () => void;
  readonly onDismiss: () => void;
}) {
  const blocked = props.choice === "blocked";
  const submit = props.choice === "submit";
  const title = blocked
    ? "Apply this folder change on the next message?"
    : submit
      ? "Send in the new folder?"
      : "Switch workspace?";
  const description = blocked
    ? "This host will not switch folders while the agent is running. The draft stays local until the next message."
    : submit
      ? "Sending this message will switch folders and stop the processes below."
      : "These processes run in the current folder and will stop if you switch now.";
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onDismiss();
      }}
    >
      <DialogContent
        className="w-full min-w-0 gap-0 overflow-hidden p-0"
        style={{ maxWidth: "min(92vw, 34rem)" }}
        showCloseButton={false}
        data-testid="teardown-commit-dialog"
      >
        <DialogHeader className="space-y-1 px-6 pt-6 pb-2">
          <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="px-6 py-2">
          <TeardownDisclosure holders={props.holders} />
        </div>
        <DialogFooter className="mx-0 mb-0 mt-2 gap-2 rounded-b-xl border-t border-border/40 bg-foreground/2 px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onDismiss}
          >
            Cancel
          </Button>
          {submit || blocked ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onDefer}
              data-testid="teardown-commit-defer"
            >
              Apply on next message
            </Button>
          )}
          {blocked ? (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={props.onDefer}
              data-testid="teardown-commit-defer"
            >
              Apply on next message
            </Button>
          ) : (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={props.onImmediate}
              data-testid="teardown-commit-immediate"
            >
              {submit ? "Send and switch" : "Stop and switch now"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

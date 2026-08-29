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
import { useTeardownAgentNames } from "@/lib/worktree/teardown-agent-names";

export type TeardownCommitChoice = "commit" | "submit" | "blocked" | "remove";

/**
 * Gesture-time confirm for a worktree commit that would tear holders down.
 * `immediate` is "stop and switch now"; `defer` is "apply on next message";
 * `blocked` is the legacy-host WORKTREE_REBIND_BLOCKED pivot (defer only).
 */
export function TeardownCommitDialog(props: {
  readonly open: boolean;
  readonly choice: TeardownCommitChoice | null;
  readonly holders: readonly WorktreeBusyHolder[];
  readonly failures?: Readonly<Record<string, string>>;
  readonly immediateDisabled?: boolean;
  readonly immediatePending?: boolean;
  readonly refusalReason?: string;
  readonly deferContext?: "message" | "update";
  readonly onImmediate: () => void;
  readonly onDefer: () => void;
  readonly onDismiss: () => void;
}) {
  const blocked = props.choice === "blocked";
  const submit = props.choice === "submit";
  const removeOnly = props.choice === "remove";
  const pending = props.immediatePending === true;
  const deferContext = props.deferContext ?? "message";
  const title = dialogTitle(props.choice);
  const description = dialogDescription(props.choice, deferContext);
  const deferLabel = deferButtonLabel(props.choice, deferContext);
  const immediateLabel = immediateButtonLabel(props.choice);
  const agentNames = useTeardownAgentNames(props.holders);
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
          {props.refusalReason === undefined ||
          props.refusalReason.length === 0 ? null : (
            <p
              className="text-ui-sm text-destructive"
              data-testid="teardown-commit-refusal"
            >
              {props.refusalReason}
            </p>
          )}
        </DialogHeader>
        <div className="min-w-0 w-full overflow-hidden px-6 py-2">
          <TeardownDisclosure
            holders={props.holders}
            failures={props.failures}
            agentNames={agentNames}
          />
        </div>
        <DialogFooter className="mx-0 mb-0 mt-2 w-full min-w-0 flex-wrap gap-2 rounded-b-xl border-t border-border/40 bg-foreground/2 px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onDismiss}
            data-testid="teardown-commit-cancel"
          >
            Cancel
          </Button>
          {submit || blocked || removeOnly ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={props.onDefer}
              data-testid="teardown-commit-defer"
            >
              {deferLabel}
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
              {deferLabel}
            </Button>
          ) : (
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={props.immediateDisabled === true || pending}
              onClick={props.onImmediate}
              data-testid="teardown-commit-immediate"
            >
              {immediateLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function deferButtonLabel(
  choice: TeardownCommitChoice | null,
  deferContext: "message" | "update",
): string {
  if (deferContext === "update" || choice === "commit") {
    return "Apply on next Update";
  }
  return "Apply on next message";
}

function immediateButtonLabel(choice: TeardownCommitChoice | null): string {
  if (choice === "submit") return "Send and switch";
  if (choice === "remove") return "Stop and remove now";
  return "Stop and switch now";
}

function dialogTitle(choice: TeardownCommitChoice | null): string {
  if (choice === "blocked") {
    return "Apply this folder change on the next message?";
  }
  if (choice === "submit") return "Send in the new folder?";
  if (choice === "remove") return "Remove this folder?";
  return "Switch workspace?";
}

function dialogDescription(
  choice: TeardownCommitChoice | null,
  deferContext: "message" | "update",
): string {
  if (choice === "blocked") {
    return deferContext === "update"
      ? "This host will not switch folders while the agent is running. The draft stays local until you click Update."
      : "This host will not switch folders while the agent is running. The draft stays local until the next message.";
  }
  if (choice === "submit") {
    return "Sending this message will switch folders and stop the processes below.";
  }
  if (choice === "remove") {
    return "These processes run in this folder and will stop if you remove it.";
  }
  return "These processes run in the current folder and will stop if you switch now.";
}

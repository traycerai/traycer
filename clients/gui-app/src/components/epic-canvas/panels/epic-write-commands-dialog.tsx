import type { ReactNode } from "react";
import type { CommandRecord } from "@traycer-clients/shared/replica-runtime";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEpicStore } from "@/hooks/use-epic-store";
import { useEpicWriteCommands } from "@/lib/epic-selectors";
import {
  describeEpicWriteCommandIntent,
  presentEpicWriteCommand,
  type EpicWriteCommandStage,
} from "@/lib/epic-write-command-copy";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";
import { cn } from "@/lib/utils";

export interface EpicWriteCommandsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The outstanding write commands, and the two things a user can do about one.
 *
 * This surface exists because a terminal record STAYS in the queue until it is
 * acknowledged. Without a way to clear it, an epic that had one rejected write
 * could never legitimately show a green sync indicator again - and hiding it to
 * get the green back is precisely what the freshness contract forbids. Dismiss
 * is therefore not a convenience; it is the other end of the sync pill.
 *
 * Retry is OFFERED, never taken. The one state where that matters most is
 * `unknown-outcome`: the write may already have been applied, and the queue
 * deliberately does not auto-retry it, so the decision to re-issue is the
 * user's alone.
 */
export function EpicWriteCommandsDialog(props: EpicWriteCommandsDialogProps) {
  const commands = useEpicWriteCommands();
  const retryWriteCommand = useEpicStore((s) => s.retryWriteCommand);
  const discardWriteCommand = useEpicStore((s) => s.discardWriteCommand);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/*
       * `sm:` and no width of its own: `DialogContent` already supplies
       * `w-full` plus the safe-area cap, and its own note says an UNMODIFIED
       * `max-w-*` from a caller DISPLACES that cap. `max-w-lg` did exactly
       * that, which is what the `w-[min(92vw,…)]` beside it was compensating
       * for. A modified `sm:max-w-lg` overrides only the primitive's
       * `sm:max-w-sm` and leaves the cap standing.
       */}
      <DialogContent
        className="sm:max-w-lg"
        data-testid="epic-write-commands-dialog"
      >
        <DialogTitle className="text-ui font-semibold">
          Pending changes
        </DialogTitle>
        <DialogDescription className="text-ui-sm text-muted-foreground">
          Changes this window has issued that the host has not finished
          answering, and the ones it answered but nobody has acknowledged yet.
        </DialogDescription>
        {commands.length === 0 ? (
          <p
            className="text-ui-sm text-muted-foreground"
            data-testid="epic-write-commands-empty"
          >
            Nothing outstanding.
          </p>
        ) : (
          <ul className="flex w-full flex-col gap-2">
            {commands.map((command) => (
              <li key={command.commandId}>
                <WriteCommandRow
                  command={command}
                  onRetry={() => {
                    retryWriteCommand(command.commandId);
                  }}
                  onDiscard={() => {
                    discardWriteCommand(command.commandId);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Tone per stage. A raised surface, so fills are an alpha of the foreground
 * rather than `bg-muted`, which collapses into the dialog's own background in
 * every preset dark theme and most flat light ones.
 */
const STAGE_TONE: Record<EpicWriteCommandStage, string> = {
  queued: "text-muted-foreground",
  sending: "text-muted-foreground",
  "unknown-outcome": "text-amber-700 dark:text-amber-400",
  committed: "text-muted-foreground",
  rejected: "text-red-700 dark:text-red-400",
  "read-only": "text-red-700 dark:text-red-400",
  superseded: "text-amber-700 dark:text-amber-400",
};

function WriteCommandRow(props: {
  readonly command: CommandRecord<EpicWriteCommandIntent>;
  readonly onRetry: () => void;
  readonly onDiscard: () => void;
}): ReactNode {
  const { command } = props;
  const presentation = presentEpicWriteCommand(command);
  return (
    <div
      className="flex w-full flex-col gap-1.5 rounded-md bg-foreground/5 px-3 py-2"
      data-testid={`epic-write-command-${command.commandId}`}
      data-stage={presentation.stage}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 text-ui-sm font-medium wrap-anywhere">
          {describeEpicWriteCommandIntent(command.intent)}
        </span>
        <span
          className={cn(
            "shrink-0 text-ui-xs font-medium",
            STAGE_TONE[presentation.stage],
          )}
          data-testid="epic-write-command-status"
        >
          {presentation.statusLabel}
        </span>
      </div>
      <p className="text-ui-xs leading-relaxed text-muted-foreground wrap-anywhere">
        {presentation.detail}
      </p>
      {presentation.canRetry || presentation.canDiscard ? (
        <div className="flex justify-end gap-2">
          {presentation.canRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onRetry}
              data-testid="epic-write-command-retry"
            >
              Retry
            </Button>
          ) : null}
          {presentation.canDiscard ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={props.onDiscard}
              data-testid="epic-write-command-discard"
            >
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

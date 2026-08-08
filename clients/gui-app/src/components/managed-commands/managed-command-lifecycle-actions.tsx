import { useState, type ReactNode } from "react";
import { Play, Square, Trash2 } from "lucide-react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  useManagedCommandDelete,
  useManagedCommandStart,
  useManagedCommandStop,
  useManagedCommandStopAllIsPending,
} from "@/hooks/managed-command/use-managed-command-lifecycle-mutations";
import { managedCommandTitle } from "@/lib/managed-commands/managed-command-copy";
import { cn } from "@/lib/utils";

export interface ManagedCommandLifecycleActionsProps {
  readonly command: ManagedCommand;
  readonly epicId: string;
  readonly hostId: string;
  readonly className: string | undefined;
}

/**
 * Start / stop / delete for one managed command (`UI.md` §2) - the whole human
 * capability set, shared by the list row and the output window header.
 *
 * Start appears only where nothing is running (it is idempotent on the host
 * either way, but offering it against a live process would read as a restart
 * it is not). Delete confirms first, and the confirmation names the one thing
 * a viewer cannot get back: the command's entire output history.
 */
export function ManagedCommandLifecycleActions(
  props: ManagedCommandLifecycleActionsProps,
) {
  const { command, epicId, hostId } = props;
  const start = useManagedCommandStart();
  const stop = useManagedCommandStop();
  // The command's chat may be running a Stop all batch that already carries
  // this command - gating here, at the shared action, covers every surface
  // that renders a stop (menu row, output window, panel row) with one rule.
  const stopAllPending = useManagedCommandStopAllIsPending(command.chatId);
  const remove = useManagedCommandDelete();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const variables = { hostId, epicId, commandId: command.id };
  const isRunning = command.status.state === "running";

  return (
    <span className={cn("flex shrink-0 items-center gap-0.5", props.className)}>
      {isRunning ? (
        <ActionButton
          label="Stop"
          icon={<Square aria-hidden className="size-3.5" />}
          isPending={stop.isPending || stopAllPending}
          testId={`managed-command-stop-${command.id}`}
          onClick={() => {
            stop.mutate(variables);
          }}
        />
      ) : (
        <ActionButton
          label="Start"
          icon={<Play aria-hidden className="size-3.5" />}
          isPending={start.isPending}
          testId={`managed-command-start-${command.id}`}
          onClick={() => {
            start.mutate(variables);
          }}
        />
      )}
      <ActionButton
        label="Delete"
        icon={<Trash2 aria-hidden className="size-3.5" />}
        isPending={remove.isPending}
        testId={`managed-command-delete-${command.id}`}
        onClick={() => {
          setConfirmingDelete(true);
        }}
      />
      <ConfirmDestructiveDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete ${managedCommandTitle(command)}?`}
        description="This stops the shell and deletes its entire output history. There is nothing to restore afterwards."
        cascadeSummary={null}
        actionLabel="Delete"
        isPending={remove.isPending}
        onConfirm={() => {
          setConfirmingDelete(false);
          remove.mutate(variables);
        }}
      />
    </span>
  );
}

/**
 * Stop alone, for a surface where a managed command is transient "work running
 * right now" rather than a durable object - today the chat's background strip.
 * Delete destroys the command's entire output history, which is not something
 * to put in a row that exists only while the process does; it belongs to the
 * sidebar and the output window, where the command is the subject rather than a
 * passing status. Nothing else is offered either: Start would be dead code in a
 * list that only ever holds running commands.
 */
export function ManagedCommandStopAction(props: {
  readonly command: ManagedCommand;
  readonly epicId: string;
  readonly hostId: string;
  readonly className: string | undefined;
}) {
  const stop = useManagedCommandStop();
  // Same one rule as ManagedCommandLifecycleActions: a batch already carrying
  // this command must not race a row press.
  const stopAllPending = useManagedCommandStopAllIsPending(
    props.command.chatId,
  );
  if (props.command.status.state !== "running") return null;
  return (
    <span className={cn("flex shrink-0 items-center", props.className)}>
      <ActionButton
        label="Stop"
        icon={<Square aria-hidden className="size-3.5" />}
        isPending={stop.isPending || stopAllPending}
        testId={`managed-command-stop-${props.command.id}`}
        onClick={() => {
          stop.mutate({
            hostId: props.hostId,
            epicId: props.epicId,
            commandId: props.command.id,
          });
        }}
      />
    </span>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly isPending: boolean;
  readonly testId: string;
  readonly onClick: () => void;
}) {
  return (
    <TooltipWrapper
      label={props.label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 text-muted-foreground hover:text-foreground"
        aria-label={props.label}
        data-testid={props.testId}
        disabled={props.isPending}
        // The surrounding row opens the output window; a lifecycle press is a
        // separate act and must not also open it.
        onClick={(event) => {
          event.stopPropagation();
          props.onClick();
        }}
      >
        {props.isPending ? (
          <AgentSpinningDots
            className="size-3.5"
            testId={undefined}
            variant={undefined}
          />
        ) : (
          props.icon
        )}
      </Button>
    </TooltipWrapper>
  );
}

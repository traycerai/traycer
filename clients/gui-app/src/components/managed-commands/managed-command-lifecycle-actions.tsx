import { useState } from "react";
import { Play, Trash2 } from "lucide-react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  ManagedCommandActionButton,
  ManagedCommandStopButton,
} from "@/components/managed-commands/managed-command-action-buttons";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
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
        <ManagedCommandStopButton
          commandId={command.id}
          ariaLabel="Stop"
          isPending={stop.isPending || stopAllPending}
          className={undefined}
          onStop={() => {
            stop.mutate(variables);
          }}
        />
      ) : (
        <ManagedCommandActionButton
          label="Start"
          ariaLabel="Start"
          icon={<Play aria-hidden className="size-3.5" />}
          isPending={start.isPending}
          testId={`managed-command-start-${command.id}`}
          className={undefined}
          onClick={() => {
            start.mutate(variables);
          }}
        />
      )}
      <ManagedCommandActionButton
        label="Delete"
        ariaLabel="Delete"
        icon={<Trash2 aria-hidden className="size-3.5" />}
        isPending={remove.isPending}
        testId={`managed-command-delete-${command.id}`}
        className={undefined}
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
      <ManagedCommandStopButton
        commandId={props.command.id}
        ariaLabel="Stop"
        isPending={stop.isPending || stopAllPending}
        className={undefined}
        onStop={() => {
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

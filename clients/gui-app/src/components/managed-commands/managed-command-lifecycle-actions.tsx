import { useState } from "react";
import { Play, RotateCcw, Trash2 } from "lucide-react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  ManagedCommandActionButton,
  ManagedCommandStopButton,
} from "@/components/managed-commands/managed-command-action-buttons";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import {
  useManagedCommandConfigure,
  useManagedCommandDelete,
  useManagedCommandStart,
  useManagedCommandStop,
  useManagedCommandStopAllIsPending,
} from "@/hooks/managed-command/use-managed-command-lifecycle-mutations";
import {
  managedCommandTitle,
  relaunchOnHostRestartLabel,
} from "@/lib/managed-commands/managed-command-copy";
import { cn } from "@/lib/utils";

export interface ManagedCommandLifecycleActionsProps {
  readonly command: ManagedCommand;
  readonly epicId: string;
  readonly hostId: string;
  readonly className: string | undefined;
}

/**
 * Start / stop / delete for one managed command, plus the one setting a person
 * edits on it: whether a host restart brings it back. The whole human
 * capability set, shared by the list row and the output window header.
 *
 * Start appears only where nothing is running (it is idempotent on the host
 * either way, but offering it against a live process would read as a restart
 * it is not). Delete confirms first, and the confirmation names the one thing
 * a viewer cannot get back: the command's entire output history.
 *
 * The relaunch switch is a toggle button rather than a checkbox because it sits
 * in a row of icon buttons and reads as one of them; its pressed state and
 * label carry the value. It is the person's override of what the agent asked
 * for at run time - the case it exists for is a shell the host keeps
 * relaunching that nobody wants relaunched.
 *
 * The switch is offered only when the command's host advertised
 * `managedCommand.configure`: the method is off the released floor, so an
 * older host negotiates it away rather than failing the handshake, and a
 * switch against such a host could only fail. (Its commands still carry the
 * flag - `true`, the legacy behaviour - through the schema default.)
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
  const configure = useManagedCommandConfigure({
    hostId,
    commandId: command.id,
  });
  const supportsConfigure = useHostSupportsMethod(
    hostId,
    "managedCommand.configure",
  );
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
          pressed={undefined}
          onClick={() => {
            start.mutate(variables);
          }}
        />
      )}
      {supportsConfigure ? (
        <ManagedCommandActionButton
          label={relaunchOnHostRestartLabel(command.relaunchOnHostRestart)}
          ariaLabel={relaunchOnHostRestartLabel(command.relaunchOnHostRestart)}
          icon={
            <RotateCcw
              aria-hidden
              className={cn(
                "size-3.5",
                command.relaunchOnHostRestart
                  ? "text-foreground"
                  : "opacity-50",
              )}
            />
          }
          isPending={configure.isPending}
          testId={`managed-command-relaunch-${command.id}`}
          className={undefined}
          pressed={command.relaunchOnHostRestart}
          onClick={() => {
            configure.mutate({
              ...variables,
              relaunchOnHostRestart: !command.relaunchOnHostRestart,
            });
          }}
        />
      ) : null}
      <ManagedCommandActionButton
        label="Delete"
        ariaLabel="Delete"
        icon={<Trash2 aria-hidden className="size-3.5" />}
        isPending={remove.isPending}
        testId={`managed-command-delete-${command.id}`}
        className={undefined}
        pressed={undefined}
        onClick={() => {
          setConfirmingDelete(true);
        }}
      />
      <ConfirmDestructiveDialog
        blockedReason={null}
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

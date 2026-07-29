import { Activity } from "lucide-react";
import { ManagedCommandStatusDot } from "@/components/managed-commands/managed-command-status-dot";
import { managedCommandTitle } from "@/lib/managed-commands/managed-command-copy";
import { useManagedCommandDoor } from "@/lib/managed-commands/use-managed-command-door";
import { useRunningManagedCommandsForChat } from "@/stores/managed-commands/managed-command-list-registry";

/**
 * Running managed commands owned by this chat, as rows in its running-work
 * strip (`UI.md` §5). Fed by the host supervisor rather than the harness
 * session, so this is a client-side join: the epic's list stream already
 * carries the owning chat id, and the strip simply filters it. A command
 * leaves the strip the moment it reaches a terminal state.
 */
export function ManagedCommandStripRows(props: {
  readonly epicId: string;
  readonly chatId: string;
}) {
  const commands = useRunningManagedCommandsForChat(props.epicId, props.chatId);
  const openOutput = useManagedCommandDoor();

  if (commands.length === 0) return null;
  return (
    <ul className="space-y-0.5" aria-label="Running monitors and shells">
      {commands.map((command) => (
        <li key={command.id}>
          <button
            type="button"
            data-testid={`managed-command-strip-row-${command.id}`}
            disabled={openOutput === null}
            onClick={() => {
              openOutput?.(command.id);
            }}
            className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left enabled:hover:bg-muted/60"
          >
            <Activity
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground/70"
            />
            <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground/85">
              {managedCommandTitle(command)}
            </span>
            <ManagedCommandStatusDot
              status={command.status}
              className={undefined}
            />
          </button>
        </li>
      ))}
    </ul>
  );
}

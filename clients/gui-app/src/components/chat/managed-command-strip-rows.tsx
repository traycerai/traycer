import { LiveElapsed } from "@/components/chat/segments/segment-elapsed";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { ManagedCommandKindIcon } from "@/components/managed-commands/managed-command-kind-icon";
import { ManagedCommandStopAction } from "@/components/managed-commands/managed-command-lifecycle-actions";
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
 *
 * The row deliberately reads like a harness background row beside it - kind
 * glyph, title, live elapsed, hover action - because to a human these are the
 * same thing: work running behind the chat. What differs is who can stop it:
 * "Stop all" speaks to the harness alone, so a managed row carries its own
 * stop and the header says so in words.
 *
 * Stop and nothing else. This is a "running right now" surface, so a row here
 * is a passing status rather than a durable object; deleting a command - which
 * destroys its whole output history - belongs to the sidebar and the output
 * window, where the command itself is the subject.
 */
export function ManagedCommandStripRows(props: {
  readonly epicId: string;
  readonly chatId: string;
}) {
  const commands = useRunningManagedCommandsForChat(props.epicId, props.chatId);
  const openOutput = useManagedCommandDoor();
  const hostId = useTabHostId();

  if (commands.length === 0) return null;
  return (
    <ul className="space-y-0.5" aria-label="Running monitors and shells">
      {commands.map((command) => (
        <li
          key={command.id}
          className="group flex min-w-0 items-center gap-1 rounded-sm pr-1 hover:bg-muted/60"
        >
          <button
            type="button"
            data-testid={`managed-command-strip-row-${command.id}`}
            disabled={openOutput === null}
            onClick={() => {
              openOutput?.(command.id);
            }}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1 text-left"
          >
            <ManagedCommandKindIcon kind={command.kind} className={undefined} />
            <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground/85">
              {managedCommandTitle(command)}
            </span>
            {command.status.state === "running" ? (
              <LiveElapsed startedAt={command.status.startedAtMs} />
            ) : null}
            <ManagedCommandStatusDot
              status={command.status}
              className={undefined}
            />
          </button>
          <span className="inline-flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <ManagedCommandStopAction
              command={command}
              epicId={props.epicId}
              hostId={hostId}
              className={undefined}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

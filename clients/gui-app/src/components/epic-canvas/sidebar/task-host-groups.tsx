import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChatTreeSurface } from "@/components/epic-canvas/sidebar/chat-tree-surface";
import { useTaskHostGroups } from "@/hooks/epic/use-task-host-groups";
import { useTaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  TASK_HOST_UNREACHABLE_LINE,
  type TaskHostGroup,
  type TaskHostGroupRow,
} from "./task-host-groups-model";

/**
 * The task's hosts grouped by owner, at the foot of the Agents panel. Rows are
 * the task-authorized summary from `epic.listTaskHosts`; a host the person
 * cannot open shows its name, owner and reach, and nothing else. An older host
 * without the method shows no section.
 */
export function TaskHostGroupsSection(props: {
  readonly epicId: string;
  readonly tabId: string;
  /** Whether the person may start a chat here: an editor, connected. */
  readonly canMutate: boolean;
}): ReactNode {
  const view = useTaskHostsView(props.epicId);
  const groups = useTaskHostGroups(
    props.epicId,
    view.kind === "hosts" ? view.hosts : null,
  );
  if (view.kind === "error") {
    return (
      <div
        className="flex shrink-0 flex-col items-start gap-1 px-3 py-2"
        data-testid="task-host-groups-error"
      >
        <p className="text-ui-xs text-muted-foreground">
          Couldn&apos;t load this task&apos;s hosts.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="task-host-groups-retry"
          onClick={view.retry}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (groups.length === 0) return null;
  return (
    <TaskHostGroupsList
      groups={groups}
      epicId={props.epicId}
      tabId={props.tabId}
      canMutate={props.canMutate}
    />
  );
}

function TaskHostGroupsList(props: {
  readonly groups: readonly TaskHostGroup[];
  readonly epicId: string;
  readonly tabId: string;
  readonly canMutate: boolean;
}): ReactNode {
  const [open, setOpen] = useState(true);
  // The phone sheet has no New Conversation modal (it starts chats through
  // its own surface, which names no host), so it offers no New chat here.
  const surface = useChatTreeSurface();
  const offersNewChat = props.canMutate && surface === null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section
      className="flex shrink-0 flex-col gap-1 px-2 py-2"
      data-testid="task-host-groups"
    >
      <button
        type="button"
        className="flex items-center gap-1 px-1 text-ui-xs font-medium text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Chevron className="size-3.5" aria-hidden />
        Hosts
      </button>
      {open
        ? props.groups.map((group) => (
            <div
              key={group.key}
              className="flex flex-col gap-0.5"
              data-testid="task-host-group"
              data-group-key={group.key}
            >
              <p
                className="px-1 pt-1 text-ui-xs text-muted-foreground"
                data-testid="task-host-group-title"
              >
                {group.title}
              </p>
              {group.rows.map((row) => (
                <TaskHostRowView
                  key={row.hostId}
                  row={row}
                  epicId={props.epicId}
                  tabId={props.tabId}
                  offersNewChat={offersNewChat}
                />
              ))}
            </div>
          ))
        : null}
    </section>
  );
}

function TaskHostRowView(props: {
  readonly row: TaskHostGroupRow;
  readonly epicId: string;
  readonly tabId: string;
  readonly offersNewChat: boolean;
}): ReactNode {
  const openNewConversation = useNewConversationModalOpenStore((s) => s.open);
  const { row } = props;
  return (
    <div
      className="flex flex-col gap-0.5 rounded-md px-2 py-1"
      data-testid="task-host-row"
      data-host-id={row.hostId}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate text-ui-sm"
          data-testid="task-host-row-label"
        >
          {row.label}
        </span>
        {row.state === null ? null : (
          <span
            className="text-ui-xs text-muted-foreground"
            data-testid="task-host-row-state"
          >
            {row.state === "online" ? "Online" : "Offline"}
          </span>
        )}
      </div>
      {row.agentsLine === null ? null : (
        <span
          className="text-ui-xs text-muted-foreground"
          data-testid="task-host-row-agents"
        >
          {row.agentsLine}
        </span>
      )}
      {row.unreachable ? (
        <span
          className="text-ui-xs text-muted-foreground"
          data-testid="task-host-row-unreachable"
        >
          {TASK_HOST_UNREACHABLE_LINE}
        </span>
      ) : null}
      {row.openable && props.offersNewChat ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          data-testid="task-host-row-new-chat"
          onClick={() =>
            openNewConversation({
              epicId: props.epicId,
              tabId: props.tabId,
              placement: null,
              parentId: null,
              hostId: row.hostId,
            })
          }
        >
          New chat on this host
        </Button>
      ) : null}
    </div>
  );
}

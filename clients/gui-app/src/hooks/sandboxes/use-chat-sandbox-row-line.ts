import { createContext, use, useCallback, useSyncExternalStore } from "react";
import {
  readHostDirectoryEntry,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { taskSandboxHostOf } from "@/hooks/epic/use-task-sandbox-end";
import type { TaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import { unlistedHostState } from "@/hooks/sandboxes/use-chat-sandbox-state";
import {
  resolveChatSandbox,
  type ChatSandboxState,
  type ChatSandboxViewer,
} from "@/lib/sandboxes/chat-sandbox-state";

/**
 * The task's hosts, read once by the Agents panel for its rows, which mount
 * with no host runtime to read them, or the sandbox list, themselves.
 */
export const TaskHostsViewContext = createContext<TaskHostsView>({
  kind: "none",
});

const ROW_VIEWER: ChatSandboxViewer = {
  reachable: false,
  canEdit: false,
  ownedByViewer: false,
  environmentOwned: false,
};

/**
 * A locked chat row's line for its sandbox, or `null` for a person's host, no
 * host or a row that is not locked: the resolver's line, from what a row can
 * read - the task's end record and names, and the host's directory row - so a
 * row never calls a sandbox an offline machine.
 */
export function useChatSandboxRowLine(
  ownerHostId: string | null,
  locked: boolean,
): string | null {
  const hostId = locked ? ownerHostId : null;
  const taskHosts = use(TaskHostsViewContext);
  const subscribe = useCallback(
    (listener: () => void) =>
      hostId === null
        ? () => undefined
        : subscribeHostRowChanged(hostId, listener),
    [hostId],
  );
  const getSnapshot = useCallback((): string | null => {
    if (hostId === null) return null;
    const task = taskSandboxHostOf(taskHosts, hostId);
    const state: ChatSandboxState =
      task.kind === "ended"
        ? { kind: "destroyed", ended: task.ended }
        : unlistedHostState(task, readHostDirectoryEntry(hostId));
    return resolveChatSandbox(state, ROW_VIEWER).line?.text ?? null;
  }, [hostId, taskHosts]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

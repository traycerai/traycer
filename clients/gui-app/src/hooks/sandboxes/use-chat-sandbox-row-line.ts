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
import { chatSandboxEndOf } from "@/lib/sandboxes/task-sandbox-end";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEndedSandboxHost } from "@/stores/sandboxes/ended-sandbox-hosts-store";

/**
 * The task's hosts, read once by the Agents panel for its rows, which mount
 * with no host runtime to read them, or the sandbox list, themselves.
 */
export const TaskHostsViewContext = createContext<TaskHostsView>({
  kind: "none",
});

const ROW_VIEWER: Omit<ChatSandboxViewer, "staysReadable"> = {
  reachable: false,
  canEdit: false,
  ownedByViewer: false,
  environmentOwned: false,
};

/**
 * A locked chat row's line for its sandbox, or `null` for a host nothing
 * names as a sandbox, no host or a row that is not locked: the resolver's
 * line, from what a row can read - the task's end record and names, a destroy
 * this device saw, and the host's directory row - so a row never calls a
 * sandbox an offline machine. A row reads no chat, so only a published head
 * lets its line promise one.
 */
export function useChatSandboxRowLine(
  ownerHostId: string | null,
  locked: boolean,
  published: boolean,
): string | null {
  const hostId = locked ? ownerHostId : null;
  const taskHosts = use(TaskHostsViewContext);
  const seenEnd = useEndedSandboxHost(hostId);
  const viewerUserId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
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
    const ended = chatSandboxEndOf(task, seenEnd, viewerUserId);
    const state: ChatSandboxState =
      ended === null
        ? unlistedHostState(task, readHostDirectoryEntry(hostId))
        : { kind: "destroyed", ended };
    return (
      resolveChatSandbox(state, { ...ROW_VIEWER, staysReadable: published })
        .line?.text ?? null
    );
  }, [hostId, taskHosts, seenEnd, viewerUserId, published]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

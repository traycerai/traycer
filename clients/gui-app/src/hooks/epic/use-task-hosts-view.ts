import { use, useMemo } from "react";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import {
  useCloudChatHasCloudAuthorization,
  useCloudChatViewerId,
} from "@/hooks/chats/use-cloud-chat-queries";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { SharedTaskHostsContext } from "@/hooks/epic/task-shared-reads-context";
import { useTaskHosts } from "@/hooks/epic/use-task-hosts-query";

/** What the task's hosts read as: nothing, a retryable failure, or the hosts. */
export type TaskHostsView =
  | { readonly kind: "none" }
  | { readonly kind: "error"; readonly retry: () => void }
  | { readonly kind: "hosts"; readonly hosts: readonly TaskHostRow[] };

const NO_TASK_HOSTS: TaskHostsView = { kind: "none" };

/**
 * The task's hosts as the Agents panel's reach marks and the composer's mirror
 * line read them; the query is shared. Without cloud authorization the hosts are withheld, not
 * served from the cache: they are a cloud projection. A failed refetch keeps
 * the list already shown; an older host without the method shows nothing.
 * Under a surface that holds this task's view, the view is read from it.
 */
export function useTaskHostsView(epicId: string): TaskHostsView {
  const shared = use(SharedTaskHostsContext);
  const held = shared !== null && shared.epicId === epicId ? shared.view : null;
  const client = useEpicSessionHostClient();
  const cloudAuthorized = useCloudChatHasCloudAuthorization();
  const viewerUserId = useCloudChatViewerId();
  // With a held view this observer gets no client, so it never asks.
  const hosts = useTaskHosts(held === null ? client : null, epicId);
  // No viewer, no grouping (Personal is the viewer's): no hosts.
  const withheld = !cloudAuthorized || viewerUserId.length === 0;
  const { data, refetch } = hosts;
  const failed = hosts.isError && hosts.error.code !== "E_HOST_UNSUPPORTED";
  // The same state gives the same object, so a context carrying the view
  // re-renders its readers only when the view changes.
  const own = useMemo<TaskHostsView>(() => {
    if (withheld) return NO_TASK_HOSTS;
    if (data !== undefined) {
      return data.hosts.length === 0
        ? NO_TASK_HOSTS
        : { kind: "hosts", hosts: data.hosts };
    }
    if (failed) return { kind: "error", retry: () => void refetch() };
    return NO_TASK_HOSTS;
  }, [withheld, data, failed, refetch]);
  return held ?? own;
}

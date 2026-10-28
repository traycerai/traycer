import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import {
  useCloudChatHasCloudAuthorization,
  useCloudChatViewerId,
} from "@/hooks/chats/use-cloud-chat-queries";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useTaskHosts } from "@/hooks/epic/use-task-hosts-query";

/**
 * What the task's hosts read as: nothing, not answered yet, a retryable
 * failure, or the hosts.
 */
export type TaskHostsView =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly retry: () => void }
  | { readonly kind: "hosts"; readonly hosts: readonly TaskHostRow[] };

/**
 * The task's hosts as the Agents panel's reach marks and the composer's mirror
 * line read them; the query is shared. Without cloud authorization the hosts are withheld, not
 * served from the cache: they are a cloud projection. A failed refetch keeps
 * the list already shown; an older host without the method shows nothing.
 * `loading` is only ever an authorized read that has not answered yet.
 */
export function useTaskHostsView(epicId: string): TaskHostsView {
  const client = useEpicSessionHostClient();
  const cloudAuthorized = useCloudChatHasCloudAuthorization();
  const viewerUserId = useCloudChatViewerId();
  const hosts = useTaskHosts(client, epicId);
  // No viewer, no grouping (Personal is the viewer's): no hosts.
  if (!cloudAuthorized || viewerUserId.length === 0) return { kind: "none" };
  if (hosts.data !== undefined) {
    return hosts.data.hosts.length === 0
      ? { kind: "none" }
      : { kind: "hosts", hosts: hosts.data.hosts };
  }
  if (hosts.isError) {
    return hosts.error.code === "E_HOST_UNSUPPORTED"
      ? { kind: "none" }
      : { kind: "error", retry: () => void hosts.refetch() };
  }
  // Authorized and unanswered: the read is in flight, or waits for the
  // session's host client.
  return { kind: "loading" };
}

import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  ChatAutoArchiveGetResponse,
  ChatAutoArchiveSetRequest,
  ChatAutoArchiveSetResponse,
} from "@traycer/protocol/host/chat-auto-archive/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  chatAutoArchiveMutationKeys,
  chatAutoArchiveWriteScope,
  hostQueryKeys,
} from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

type SetChatAutoArchiveContext = {
  /** Captured at `onMutate` so a host switch mid-flight cannot redirect the write-through. */
  readonly hostId: string | null;
  /** The viewer the save was made BY, captured for the same reason. */
  readonly viewerUserId: string;
};

/**
 * Saves the account's chat auto-archive policy through the surface's host.
 *
 * Last-write-wins on the server, so ordering is the client's job:
 * `chatAutoArchiveWriteScope` holds a newer save until the older one settles.
 * Never add a "skip if one is in flight" guard; it would drop the newest
 * choice.
 *
 * The read cache is written from the response, not invalidated: `set` answers
 * the same `{ policy, bounds }` shape as `get`, carrying the server-stamped
 * record, so the row re-renders from what the host now holds with no second
 * round trip. Written to the VIEWER's entry only - a write on the method scope
 * is a prefix match and would reach every viewer's partition under this host
 * (see `useAutoPolicySetMutation`).
 */
export function useChatAutoArchiveSetMutation(): UseMutationResult<
  ChatAutoArchiveSetResponse,
  HostRpcError,
  ChatAutoArchiveSetRequest,
  SetChatAutoArchiveContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  const viewerUserId = useCloudChatViewerId();
  return useHostMutation<
    HostRpcRegistry,
    "chatAutoArchive.set",
    SetChatAutoArchiveContext
  >({
    client,
    method: "chatAutoArchive.set",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: chatAutoArchiveMutationKeys.set(),
      scope: chatAutoArchiveWriteScope(),
      onMutate: () => ({
        hostId: client.getActiveHostId() ?? null,
        viewerUserId,
      }),
      onSuccess: async (data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        // `""` is the absence of a viewer; the read is disabled there, so
        // there is no entry to keep fresh.
        if (ctx.viewerUserId.length === 0) return;
        const queryKey = hostQueryKeys.chatAutoArchiveForViewer(
          ctx.hostId,
          ctx.viewerUserId,
        );
        // Cancel first, so an older in-flight read cannot land after this
        // write and put the previous policy back on screen.
        await queryClient.cancelQueries({ queryKey });
        queryClient.setQueriesData<ChatAutoArchiveGetResponse>(
          { queryKey },
          () => data,
        );
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't save the auto-archive setting."),
    },
  });
}

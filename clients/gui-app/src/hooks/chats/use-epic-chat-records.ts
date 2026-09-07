import { useEffect, useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { ChatRecordSummaryV11 } from "@traycer/protocol/host/epic/chat-records";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { hostQueryKeys } from "@/lib/query-keys";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { GUI_PROJECTS_EPIC_DOC_REPLICA } from "@/stores/epics/open-epic/projection-helpers";

/** The store merges omissions against that fence - a row the answer does not carry is retracted only if the answer was issued after the row landed - so the fence has to be captured before the RPC, not when the answer is applied. */
interface ChatRecordListAnswer {
  /** The `@1.1` row, NOT the base one.
   * The base row is assignable to it in the wrong direction, so typing this as `ChatRecordSummary` is a silent narrowing rather than a type error: the request asks for the doc-resident remainder and the cache then drops `docResident`, the one field that says which rows those are. */
  readonly chats: readonly ChatRecordSummaryV11[];
  readonly issuedAtSeq: number | null;
  /** ingestFenceIdentity of the store this seq was read from. Cache outlives a store; mismatch degrades the fence to null. */
  readonly fenceIdentity: number | null;
}

/** Host registry producer for chats; store unions this with the Y.Doc map. */
export function useEpicSyncChatRecords(epicId: string): void {
  // Session host, never the app-wide one: the previous session stays rendered through an A->B re-point.
  const client = useEpicSessionHostClient();
  const handle = useMaybeOpenEpicHandle();
  const params = useMemo(
    () => ({ epicId, hasDocReplica: GUI_PROJECTS_EPIC_DOC_REPLICA }),
    [epicId],
  );
  const viewerUserId = useCloudChatViewerId();
  const store = handle?.store ?? null;
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "epic.listChatRecords",
    ChatRecordListAnswer,
    { readonly seq: number; readonly fenceIdentity: number } | null
  >({
    cacheKeyIdentity: [viewerUserId],
    client,
    method: "epic.listChatRecords",
    params,
    options: {
      enabled: epicId.length > 0 && viewerUserId.length > 0,
      staleTime: 10_000,
      // fixed poll policies are opt-in; without this the 20s table cadence never arms.
      poll: true,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
    captureRequestContext: () => {
      if (store === null) return null;
      const state = store.getState();
      return {
        seq: state.peekChatIngestSeq(),
        fenceIdentity: state.ingestFenceIdentity,
      };
    },
    mapResponse: ({ response, requestContext }) => {
      const context = requestContext ?? null;
      return {
        chats: response.chats,
        issuedAtSeq: context === null ? null : context.seq,
        fenceIdentity: context === null ? null : context.fenceIdentity,
      };
    },
  });

  const answer = query.data ?? null;
  const recordListAuthoritative =
    query.isSuccess ||
    (query.isError && query.error.code === "E_HOST_UNSUPPORTED");
  useEffect(() => {
    if (store === null || !recordListAuthoritative) return;
    if (answer !== null) {
      const fence =
        answer.fenceIdentity === store.getState().ingestFenceIdentity
          ? answer.issuedAtSeq
          : null;
      store.getState().applyChatRecords(answer.chats, fence);
    }
    store.getState().markChatRecordListAuthoritative();
  }, [answer, recordListAuthoritative, store]);
}

/** Method-scoped invalidation after a chat mutation. Do not refetchType all: that re-reads every open epic on this host. */
export function invalidateEpicChatRecords(
  queryClient: QueryClient,
  hostId: string | null,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "epic.listChatRecords"),
  });
}

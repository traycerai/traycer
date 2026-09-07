import { useEffect, useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { GUI_PROJECTS_EPIC_DOC_REPLICA } from "@/stores/epics/open-epic/projection-helpers";
import type { TuiAgentRecordSummaryV12 } from "@traycer/protocol/host/epic/tui-agent-records";

/** The store merges omissions against that fence - a row the answer does not carry is retracted only if the answer was issued after the row landed - so the fence has to be captured before the RPC, not when the answer is applied. */
interface TuiAgentListAnswer {
  readonly tuiAgents: readonly TuiAgentRecordSummaryV12[];
  readonly issuedAtSeq: number | null;
  /** WHICH store's counter `issuedAtSeq` was read from - see the chat twin (`ChatRecordListAnswer.fenceIdentity`): a cached answer can outlive the store, and a cross-generation fence is degraded to `null` at apply. */
  readonly fenceIdentity: number | null;
}

/** Host registry producer for tuiAgents; store unions this with the Y.Doc map. */
export function useEpicSyncTuiAgentRecords(epicId: string): void {
  // The SESSION's host, not the app-wide one - same rationale as the chat-record sync hook: a pinned or retried session runs on a host the app-wide client may no longer answer for, and any other host's registry is not the one this session is projecting.
  const client = useEpicSessionHostClient();
  const handle = useMaybeOpenEpicHandle();
  // Declared by us because only we know it: the host would have to infer it from `epic.subscribe`'s negotiated major, which this method's own version cannot see.
  const params = useMemo(
    () => ({ epicId, hasDocReplica: GUI_PROJECTS_EPIC_DOC_REPLICA }),
    [epicId],
  );
  // Viewer-scoped: the response is one identity's own terminal agents, so two
  // users on one installation must never share a cache slot.
  const viewerUserId = useCloudChatViewerId();
  const store = handle?.store ?? null;
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "epic.listTuiAgents",
    TuiAgentListAnswer,
    { readonly seq: number; readonly fenceIdentity: number } | null
  >({
    cacheKeyIdentity: [viewerUserId],
    client,
    method: "epic.listTuiAgents",
    params,
    options: {
      enabled: epicId.length > 0 && viewerUserId.length > 0,
      staleTime: 10_000,
      // Opt in to the table's fixed cadence - `fixed` poll policies are
      // OPT-IN in `useHostQuery`, so without this the 20s the policy table
      // declares is never armed.
      poll: true,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
    // Runs immediately before the RPC is dispatched - see `TuiAgentListAnswer`.
    captureRequestContext: () => {
      if (store === null) return null;
      const state = store.getState();
      return {
        seq: state.peekTuiAgentIngestSeq(),
        fenceIdentity: state.ingestFenceIdentity,
      };
    },
    mapResponse: ({ response, requestContext }) => {
      const context = requestContext ?? null;
      return {
        tuiAgents: response.tuiAgents,
        issuedAtSeq: context === null ? null : context.seq,
        fenceIdentity: context === null ? null : context.fenceIdentity,
      };
    },
  });

  const answer = query.data ?? null;
  useEffect(() => {
    if (answer === null || store === null) return;
    // A cross-generation fence is degraded to `null`, never trusted - see
    // `TuiAgentListAnswer.fenceIdentity` and the chat twin.
    const fence =
      answer.fenceIdentity === store.getState().ingestFenceIdentity
        ? answer.issuedAtSeq
        : null;
    store.getState().applyTuiAgentRecords(answer.tuiAgents, fence);
  }, [answer, store]);
}

/** Method-scoped invalidation after a TUI mutation. Do not refetchType all. */
export function invalidateEpicTuiAgentRecords(
  queryClient: QueryClient,
  hostId: string | null,
): void {
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "epic.listTuiAgents"),
  });
}

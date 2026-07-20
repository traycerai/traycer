import {
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ListTerminalsResponseV20 } from "@traycer/protocol/host/terminal/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, terminalMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export interface RenameTerminalMutationContext {
  readonly hostId: string | null;
  readonly previous: ReadonlyArray<
    readonly [QueryKey, ListTerminalsResponseV20 | undefined]
  >;
}

/**
 * Renames a terminal session on an EXPLICIT host client rather than the
 * app-wide active host (a canvas tab is bound to its own host for life, which
 * may not be the default host).
 *
 * The host session record is the single source of truth for terminal titles;
 * every surface (sidebar rows, canvas tab strips, command palette) renders
 * from the host's cached `terminal.list` rows. The rename therefore fans out
 * through ONE optimistic patch of those cached rows - an explicitly justified
 * `setQueriesData`: the requested title IS the resulting host state, and the
 * host's `sessionUpdated` stream frame re-asserts it idempotently. No
 * stream-driven invalidation - the metadata stream subscription must never
 * trigger `terminal.list` refetches (see the feedback-loop note in
 * `terminal-session-registry.ts`).
 *
 * On success the persisted tile-name snapshots (the restart-recovery fallback
 * rendered only while the host has no row for the session) are refreshed in
 * every view tab, guarded latest-wins against out-of-order settles. On error
 * the patch is rolled back with a compare-and-swap guard plus a one-shot
 * mutation-boundary refetch as the authoritative repair.
 *
 * `useTerminalRename` is the default-host convenience wrapper over this hook.
 */
export function useTerminalRenameFor(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "terminal.rename">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "terminal.rename">,
  RenameTerminalMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "terminal.rename",
    RenameTerminalMutationContext
  >({
    client,
    method: "terminal.rename",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: terminalMutationKeys.rename(),
      onMutate: async (variables) => {
        const hostId = client === null ? null : client.getActiveHostId();
        if (hostId === null) return { hostId: null, previous: [] };
        const queryKey = hostQueryKeys.methodScope(hostId, "terminal.list");
        await queryClient.cancelQueries({ queryKey });
        const previous = queryClient.getQueriesData<ListTerminalsResponseV20>({
          queryKey,
        });
        queryClient.setQueriesData<ListTerminalsResponseV20>(
          { queryKey },
          (data) => {
            if (data === undefined) return undefined;
            const target = data.sessions.find(
              (session) => session.sessionId === variables.sessionId,
            );
            if (target === undefined || target.title === variables.title) {
              return data;
            }
            return {
              sessions: data.sessions.map((session) =>
                session.sessionId === variables.sessionId
                  ? { ...session, title: variables.title }
                  : session,
              ),
            };
          },
        );
        return { hostId, previous };
      },
      onSuccess: (_data, variables, ctx) => {
        if (ctx.hostId === null) return;
        // Latest-wins guard: two successful renames can settle out of order.
        // If any cached row already carries a DIFFERENT title, a newer rename
        // superseded this one - writing this title into the persisted
        // snapshots would preserve a stale fallback name.
        const superseded = queryClient
          .getQueriesData<ListTerminalsResponseV20>({
            queryKey: hostQueryKeys.methodScope(ctx.hostId, "terminal.list"),
          })
          .some(([, data]) => {
            const row = data?.sessions.find(
              (session) => session.sessionId === variables.sessionId,
            );
            return row !== undefined && row.title !== variables.title;
          });
        if (superseded) return;
        Analytics.getInstance().track(AnalyticsEvent.TerminalRenamed, {
          kind: "shell",
        });
        useEpicCanvasStore
          .getState()
          .updateTerminalNameSnapshots(
            ctx.hostId,
            variables.sessionId,
            variables.title,
          );
      },
      onError: (error, variables, ctx) => {
        toastFromHostError(error, "Couldn't rename the terminal.");
        if (ctx === undefined || ctx.hostId === null) return;
        // Instant unwind first (CAS-guarded below), then a one-shot refetch
        // as the authoritative repair: with overlapping renames the snapshots
        // can legitimately disagree about the pre-mutation title (a later
        // mutation's snapshot captured an earlier one's optimistic value), so
        // local unwind alone can strand a title the host never accepted. A
        // mutation-boundary invalidation is safe - the documented feedback
        // loop only applies to invalidating from the STREAM metadata
        // subscription.
        ctx.previous.forEach(([queryKey, snapshot]) => {
          const previousRow = snapshot?.sessions.find(
            (session) => session.sessionId === variables.sessionId,
          );
          if (previousRow === undefined) return;
          queryClient.setQueryData<ListTerminalsResponseV20>(
            queryKey,
            (current) => {
              if (current === undefined) return undefined;
              const target = current.sessions.find(
                (session) => session.sessionId === variables.sessionId,
              );
              // Compare-and-swap: only unwind rows still carrying THIS
              // mutation's optimistic title.
              if (target === undefined || target.title !== variables.title) {
                return current;
              }
              return {
                sessions: current.sessions.map((session) =>
                  session.sessionId === variables.sessionId
                    ? { ...session, title: previousRow.title }
                    : session,
                ),
              };
            },
          );
        });
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(ctx.hostId, "terminal.list"),
        });
      },
    },
  });
}

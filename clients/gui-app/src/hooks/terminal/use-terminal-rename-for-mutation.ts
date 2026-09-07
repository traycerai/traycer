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
import type { ListTerminalsResponseV23 } from "@traycer/protocol/host/terminal/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, terminalMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

export interface RenameTerminalMutationContext {
  readonly hostId: string | null;
  readonly previous: ReadonlyArray<
    readonly [QueryKey, ListTerminalsResponseV23 | undefined]
  >;
}

/**
 * Rename on the owning host client, never the app-wide one. Optimistic terminal.list patch; the metadata stream must never refetch that list.
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
        const previous = queryClient.getQueriesData<ListTerminalsResponseV23>({
          queryKey,
        });
        queryClient.setQueriesData<ListTerminalsResponseV23>(
          { queryKey },
          (data) => {
            if (data === undefined) return undefined;
            const target = data.sessions.find(
              (session) => session.sessionId === variables.sessionId,
            );
            if (target === undefined || target.title === variables.title) {
              return data;
            }
            // Preserve top-level response metadata (e.g. `homeCwd`); only
            // the sessions array is replaced.
            return {
              ...data,
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
        const superseded = queryClient
          .getQueriesData<ListTerminalsResponseV23>({
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
        // Instant unwind first (CAS-guarded below), then a one-shot refetch as the authoritative repair: with overlapping renames the snapshots can legitimately disagree about the pre-mutation title (a later mutation's snapshot captured an earlier one's optimistic value), so local unwind alone can strand a title the host never accepted.
        ctx.previous.forEach(([queryKey, snapshot]) => {
          const previousRow = snapshot?.sessions.find(
            (session) => session.sessionId === variables.sessionId,
          );
          if (previousRow === undefined) return;
          queryClient.setQueryData<ListTerminalsResponseV23>(
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
              // Preserve top-level response metadata (e.g. `homeCwd`); only
              // the sessions array is replaced.
              return {
                ...current,
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

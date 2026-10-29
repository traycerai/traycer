import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { SimulatorCatalogRecord } from "@traycer/protocol/host/simulator/catalog-contracts";
import { useHostBinding, useHostClient, useHostDirectory } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { hostQueryKeys, simulatorMutationKeys } from "@/lib/query-keys";
import { isSimulatorCatalogQueryKey } from "@/lib/query-keys/host-query-keys";
import { SESSION_INVALIDATIONS } from "@/hooks/simulator/use-simulator-mutations";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { closeSimulatorCatalogSessions } from "@/lib/simulator-view/simulator-catalog-owner-action";
import { useRequestContextUserId } from "@/hooks/host/use-request-context-user-id";
import {
  noteClosedSimulatorCatalogSession,
  withoutClosedSimulatorCatalogSessions,
} from "./simulator-catalog-closed-sessions";
import type { SimulatorCatalogQueryData } from "./use-simulator-catalog-inventory";

interface CloseVariables {
  readonly hostId: string;
  readonly records: readonly SimulatorCatalogRecord[];
}

/**
 * A task row's Close (every session in the row) and a closed row's Dismiss
 * (its one ended record), resolved to the row's own machine at click time:
 * merely listing rows never dials a host. A close the host confirmed hides
 * its records at once, before the tombstone push lands.
 */
export function useSimulatorCatalogActions(epicId: string) {
  const queryClient = useQueryClient();
  const directory = useHostDirectory();
  const binding = useHostBinding();
  const client = useHostClient();
  const userId = useRequestContextUserId(client);
  const mutation = useMutation<void, Error, CloseVariables>({
    mutationKey: simulatorMutationKeys.catalogClose(epicId),
    retry: false,
    mutationFn: async ({ hostId, records }) => {
      const outcome = await closeSimulatorCatalogSessions({
        epicId,
        hostId,
        records,
        owner: {
          userId,
          entry: directory.findById(hostId),
          client: resolveNamedHostClient(binding, hostId),
        },
      });
      // Whatever else the row refused, every session the host ended is
      // hidden here and never asked to close again; the refusal is reported
      // after, as the whole row's failure once was.
      if (userId !== null) {
        for (const record of outcome.closed)
          noteClosedSimulatorCatalogSession(userId, record);
        queryClient.setQueriesData<SimulatorCatalogQueryData>(
          {
            predicate: (query) =>
              isSimulatorCatalogQueryKey(query.queryKey, userId, epicId),
          },
          (data) =>
            data === undefined
              ? undefined
              : {
                  ...data,
                  records: withoutClosedSimulatorCatalogSessions(
                    userId,
                    epicId,
                    data.records,
                  ),
                },
        );
      }
      if (outcome.failures.length > 0) throw outcome.failures[0];
    },
    onSettled: (_data, _error, { hostId }) => {
      // The host-wide instance read names who holds each instance across
      // every task (`tasks`, `otherTaskCount`, `drivenByAgent`), and this
      // row's Close ends the agent's session beside the person's - so it is
      // moved by the same write, and nothing else asks it again inside the
      // freshness window. See `SESSION_INVALIDATIONS`.
      for (const method of SESSION_INVALIDATIONS) {
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(hostId, method),
        });
      }
      if (userId === null) return;
      void queryClient.invalidateQueries({
        predicate: (query) =>
          isSimulatorCatalogQueryKey(query.queryKey, userId, epicId),
      });
    },
    onError: (error) => {
      if (error instanceof HostRpcError) {
        toastFromHostError(error, "Couldn't close the simulator.");
        return;
      }
      reportableErrorToast(
        error.message,
        undefined,
        createReportIssueContext({
          title: "Couldn't close the simulator",
          message: null,
          code: null,
          source: "Mobile simulators",
        }),
      );
    },
  });
  const { mutate, isPending, variables } = mutation;
  const closeRecords = useCallback(
    (hostId: string, records: readonly SimulatorCatalogRecord[]) => {
      if (records.length === 0) return;
      mutate({ hostId, records });
    },
    [mutate],
  );
  /** Whether a close for this record is in flight. */
  const closing = useCallback(
    (sessionId: string) =>
      isPending &&
      variables.records.some((record) => record.sessionId === sessionId),
    [isPending, variables],
  );
  return { closeRecords, closing };
}

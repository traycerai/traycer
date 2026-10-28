import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { SimulatorCatalogRecord } from "@traycer/protocol/host/simulator/catalog-contracts";
import { useHostBinding, useHostClient, useHostDirectory } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { toastFromHostError } from "@/lib/host-error-toast";
import { simulatorMutationKeys } from "@/lib/query-keys";
import { isSimulatorCatalogQueryKey } from "@/lib/query-keys/host-query-keys";
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
      await closeSimulatorCatalogSessions({
        epicId,
        hostId,
        records,
        owner: {
          userId,
          entry: directory.findById(hostId),
          client: resolveNamedHostClient(binding, hostId),
        },
      });
      if (userId === null) return;
      for (const record of records)
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
    },
    onSettled: () => {
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

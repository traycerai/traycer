import {
  useIsMutating,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  ConfigCatalogResponse,
  ConfigCatalogSetRequest,
  ConfigCatalogSetResponse,
} from "@traycer/protocol/host/config/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { configMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

type CatalogSetContext = {
  readonly hostId: string | null;
};

/**
 * Writes the scoped host's Model list timeout (`config.catalog.set`) and
 * files the host's answer into its `config.catalog.get` read BEFORE the
 * mutation settles.
 *
 * The answer is authoritative: the host's resolver re-reads the file after
 * the write and returns the same shape the read does. The Model list rows
 * decide the NEXT write from the read - the switch's state picks `scope: "all"`
 * or `scope: "harness"` - so a row that re-enabled on a stale read would build
 * the next write on the state before this one: switch a provider off, pick a
 * value before the re-read lands, and the pick would go out as `scope: "all"`,
 * moving every provider that shares the value and leaving this one where it
 * was. So `onSuccess` CANCELS any read still in flight (one started before the
 * write would otherwise resolve on top of the answer), writes the answer, and
 * only then lets the mutation settle; the rows stay disabled while any write
 * on the host is outstanding (`useConfigCatalogSetOutstanding`). The read is revalidated afterwards, not awaited: the answer
 * already is the state, and the pick it settles should not wait on a read.
 *
 * The write carries a dispatch-time floor of `config.catalog.set@1.1` (see
 * below), so it is refused rather than downgraded on a 1.0 connection.
 *
 * `hostId` is captured in `onMutate`, so an answer is filed against the host
 * that was asked even if the surface's host moves mid-flight.
 */
export function useConfigCatalogSetMutation(
  client: HostClient<HostRpcRegistry>,
  hostId: string,
): UseMutationResult<
  ConfigCatalogSetResponse,
  HostRpcError,
  ConfigCatalogSetRequest,
  CatalogSetContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "config.catalog.set",
    CatalogSetContext
  >({
    client,
    method: "config.catalog.set",
    mapVariables: (variables) => variables,
    // Enforced against the handshake of the connection that carries THIS
    // write, not the render-time gate: a host rolled back to 1.0 after the
    // rows rendered would otherwise take the 1.1 body through the same-major
    // downgrade, which re-parses it with the 1.0 schema, strips `scope` and
    // `harnessId`, and moves the SHARED value when the user meant one
    // provider. A literal minor: 1.1 is where the scoped write arrived.
    requiredHostMethodVersion: () => ({
      method: "config.catalog.set",
      version: { major: 1, minor: 1 },
    }),
    options: {
      mutationKey: configMutationKeys.catalogSet(hostId),
      onMutate: () => ({ hostId: client.getActiveHostId() ?? null }),
      onSuccess: async (data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        const queryKey = hostQueryKeys.methodScope(
          ctx.hostId,
          "config.catalog.get",
        );
        await queryClient.cancelQueries({ queryKey });
        queryClient.setQueriesData<ConfigCatalogResponse>({ queryKey }, data);
        void queryClient.invalidateQueries({ queryKey });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't update the model list timeout"),
    },
  });
}

/**
 * Whether ANY `config.catalog.set` is outstanding on `hostId`, read from the
 * mutation cache rather than one observer's `isPending`. A write outlives the
 * rows that sent it - leaving the tab or switching provider unmounts them -
 * and rows mounted while it is in flight would otherwise enable on the read
 * from before it and build the next write on that (a pick going out as
 * `scope: "all"` while the switch-off is still on the wire). The rows stay
 * disabled until every outstanding write has filed its answer.
 */
export function useConfigCatalogSetOutstanding(hostId: string): boolean {
  return (
    useIsMutating({ mutationKey: configMutationKeys.catalogSet(hostId) }) > 0
  );
}

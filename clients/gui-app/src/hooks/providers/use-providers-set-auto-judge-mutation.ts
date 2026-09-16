import type { UseMutationResult } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import {
  providerAutoJudgeWriteScope,
  providersMutationKeys,
} from "@/lib/query-keys";

// The choice lands in `provider-overrides.json` beside `terminalAgentArgs` and
// is echoed back by `providers.list`, so that read is what needs refreshing -
// and nothing else does. Picking a judge cannot change a provider's
// availability, its credentials or its model catalog, so the harness selectors
// stay put, exactly as for its neighbour `providers.setTerminalAgentArgs`.
const AUTO_JUDGE_INVALIDATIONS: ReadonlyArray<keyof HostRpcRegistry & string> =
  ["providers.list"];

/**
 * Chooses which classifier decides this provider's `auto`-mode approvals.
 *
 * An OPTIONAL host capability: a host that predates auto mode advertises no
 * `providers.setAutoJudge` at all. **The row that calls this gates on that
 * exact method**, and the note that used to sit here - that `nativeAutoJudge`
 * rides the same catalog minor, so the flag alone proves the write exists -
 * was a cross-method inference the registry contradicts: the setter is
 * registered `degrade: { kind: "unsupported" }`, so a host can answer the
 * catalog and not the write. `ProviderAutoJudgeSection` now reads
 * `useHostMethodSupport(hostId, "providers.setAutoJudge")` and draws a
 * read-only panel for that host instead. Scoped like every other provider
 * mutation: it writes to the host the Providers panel is showing, never the
 * app-wide one.
 *
 * Takes the `harnessId` it will write rather than reading it off each
 * `mutate()`, because a TanStack `MutationScope` is a property of the OBSERVER
 * and is fixed for the life of the hook - and the ordering this needs is
 * per-provider. Every call site already renders one section per provider, so
 * the id is a prop away. Without the scope, two rapid picks on the same row
 * would sit in two coordinator queues (its `fifo` key carries the params) and
 * race, leaving the HOST holding the older choice while the `providers.list`
 * invalidation faithfully reports it back - the user's last click lost with no
 * error anywhere. See `providerAutoJudgeWriteScope`.
 */
export function useProvidersSetAutoJudge(
  harnessId: GuiHarnessId,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setAutoJudge">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setAutoJudge">,
  { readonly hostId: string | null }
> {
  const client = useHostClient();
  return useHostScopedMutationForClient(client, {
    method: "providers.setAutoJudge",
    mutationKey: providersMutationKeys.setAutoJudge(),
    errorMessage: "Couldn't save the Auto mode judge.",
    invalidateMethods: AUTO_JUDGE_INVALIDATIONS,
    scope: providerAutoJudgeWriteScope(client.getActiveHostId(), harnessId),
  });
}

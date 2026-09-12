import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { providersMutationKeys } from "@/lib/query-keys";

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
 * `providers.setAutoJudge` at all. The row that calls this never reaches such a
 * host, and it does not need `useHostSupportsMethod` to know that - it renders
 * only for a catalog row carrying `nativeAutoJudge: true`, a field that rides
 * the same catalog minor as this method, so a host without the write reports
 * the flag `false` and draws no row. Scoped like every other provider
 * mutation: it writes to the host the Providers panel is showing, never the
 * app-wide one.
 */
export function useProvidersSetAutoJudge(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setAutoJudge">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setAutoJudge">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.setAutoJudge",
    mutationKey: providersMutationKeys.setAutoJudge(),
    errorMessage: "Couldn't save the Auto mode judge.",
    invalidateMethods: AUTO_JUDGE_INVALIDATIONS,
  });
}

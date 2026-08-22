import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

// Any provider override change can flip a provider's availability (enabled
// toggle, selecting a binary that can't launch, or setting/clearing an API key
// like Cursor's), so every provider mutation refreshes the Settings panel,
// both harness selectors, and the generated agent-selection-guide default. The
// guide invalidation recomputes only the generated default; it does not write
// the user's global guide file.
export const PROVIDER_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = [
  "providers.list",
  "agent.gui.listHarnesses",
  "agent.tui.listHarnesses",
  "agent.selectionGuide.getGlobal",
  "agent.selectionGuide.getGlobalOnboardingDraft",
];

/** The two harness catalogs a provider's availability feeds. */
const HARNESS_CATALOG_METHODS: ReadonlyArray<keyof HostRpcRegistry & string> = [
  "agent.gui.listHarnesses",
  "agent.tui.listHarnesses",
];

/**
 * Drops a host's harness catalogs so the next read re-derives them.
 *
 * For the paths that write `providers.list` DIRECTLY - a login-completion echo,
 * a force-refresh - rather than going through `useHostScopedMutation`'s
 * `invalidateMethods`. Those paths deliberately did not touch the catalogs,
 * and that was correct while `available` was auth-blind: a sign-in could not
 * change what the catalog said, so invalidating it only cost a refetch.
 *
 * Auto-enablement makes it wrong. A provider with no detected account is now
 * effectively disabled and reported unavailable, so a successful sign-in DOES
 * flip `available` - and without this the picker keeps serving the cached "No
 * account detected" row until something else happens to invalidate it. The
 * host re-derives enablement on both of its login-completion funnels; this is
 * the client half of the same edge.
 *
 * The TUI catalog goes with it: it is built from the same availability rows,
 * so a sign-in moves both or the two disagree.
 */
export function invalidateHarnessCatalogsForHost(
  queryClient: QueryClient,
  hostId: string,
): void {
  for (const method of HARNESS_CATALOG_METHODS) {
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(hostId, method),
    });
  }
}

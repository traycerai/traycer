import type { QueryClient } from "@tanstack/react-query";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

// Any provider override change can flip a provider's availability (enabled
// toggle, selecting a binary that can't launch, or setting/clearing an API key
// like Cursor's), so every provider mutation refreshes the Settings panel,
// both harness selectors, and the generated agent-selection-guide default. The
// guide invalidation recomputes only the generated default; it does not write
// the user's global guide file.
//
// This list is BOTH mechanisms' source of truth, which is why the harness
// catalogs live here and nowhere else. Mutations that go through
// `useHostScopedMutation` consume it as `invalidateMethods`; the paths that
// write `providers.list` DIRECTLY (a login-completion echo, a force-refresh)
// consume it through `commitAuthoritativeProvidersList`, which invalidates
// every method here except `providers.list` itself - the one it has just
// written authoritatively. So a direct-write path needs no hand-rolled
// catalog invalidation of its own: adding one only marks the freshly refetched
// catalogs stale again and starts a second, redundant pair of RPCs.
export const PROVIDER_INVALIDATIONS: ReadonlyArray<
  keyof HostRpcRegistry & string
> = [
  "providers.list",
  "agent.gui.listHarnesses",
  "agent.tui.listHarnesses",
  "agent.selectionGuide.getGlobal",
  "agent.selectionGuide.getGlobalOnboardingDraft",
];

/**
 * Runs the {@link PROVIDER_INVALIDATIONS} sweep from a hand-rolled
 * `useMutation`. The profile-config writers (D01/D15) read the whole config
 * and write it back, i.e. two methods per mutation, so they cannot use
 * `useHostScopedMutation`'s single-`method` shape - but they owe the family
 * invalidation all the same: a new endpoint, env var, CLI pin or args string
 * can flip a provider's availability and every catalog that reads it.
 * `hostId` must be the one captured in `onMutate` (host-swap rule), and a
 * `null` host means the request was never attributable to one - nothing to
 * invalidate.
 */
export async function invalidateProviderFamily(
  queryClient: QueryClient,
  hostId: string | null,
): Promise<void> {
  if (hostId === null) return;
  await Promise.all(
    PROVIDER_INVALIDATIONS.map((method) =>
      queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(hostId, method),
      }),
    ),
  );
}

import type { HostRpcRegistry } from "@/lib/host";

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

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

/**
 * Shared mutation SCOPE for the per-profile API-key pair.
 *
 * TanStack runs mutations sharing a scope id one at a time, in the order they
 * were fired. Without it these two never serialize: the host request
 * coordinator keys its queues by `[hostId, userId, method, params]`, so a set
 * and a clear - different methods, and different params besides - always land
 * in separate queues and race, whatever scheduling mode the policy table
 * gives them. `fifo` there orders a method against ITSELF, and not even that
 * when two sets carry different keys.
 *
 * The inversion this prevents is user-visible and easy to hit: click Replace,
 * close the dialog while that request is in flight, reopen it, click Remove.
 * If the earlier set settles after the later clear, the credential survives
 * the action the user took last.
 *
 * One scope for the pair rather than one per profile, because the id has to
 * be fixed when the hook is created and the profile is only known at
 * `mutate()` time. The cost is that two different profiles' key changes also
 * serialize; they are rare, user-initiated, and fast.
 */
export const PROFILE_API_KEY_MUTATION_SCOPE = {
  id: "providers.profileApiKey",
} as const;

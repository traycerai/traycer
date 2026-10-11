export { PROVIDER_INVALIDATIONS } from "@/lib/query-keys/providers-query-keys";

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
 *
 * BOUND: this is per-`QueryClient`, so it orders presses inside ONE renderer.
 * Two desktop windows own separate clients and are not ordered by it.
 *
 * That residue is not closable here, and not by the host coordinator either
 * (`HostRequestCoordinator` keys queues by `[hostId, userId, method, params]`,
 * so a set and a clear never share one). The host DOES serialize the two -
 * `profileMutationLock(providerId, profileId).runExclusive(...)` wraps both
 * mutations - so neither can interleave with the other's writes; what is
 * unrecoverable is which press the USER meant to be last. Two clicks in two
 * independent windows have no happens-before relation, and inventing one would
 * take a per-profile sequence carried on the request and sourced somewhere
 * both renderers can see - which is precisely what does not exist.
 *
 * So the guarantee is: no lost update either way (host lock), deterministic
 * order within a window (this scope), and last-writer-wins across windows.
 */
export const PROFILE_API_KEY_MUTATION_SCOPE = {
  id: "providers.profileApiKey",
} as const;

import type { MutationScope } from "@tanstack/react-query";

/**
 * The ONE queue the three fallback-policy writes share - `set`,
 * `restoreTierGroups` and `reset` - keyed by host.
 *
 * ## The defect it closes
 *
 * All three write the same policy row, and two of them fold the response into
 * the `providers.fallbackPolicy.get` cache with `setQueriesData`. Nothing
 * ordered them. `HostRequestCoordinator.keyFor` is `JSON.stringify([hostId,
 * userId, method, stableWireJson(params)])`, so the PARAMS are part of the
 * queue key: two saves carrying two different policies sit in two different
 * FIFO queues and race, and three different methods are three keys again. The
 * cached policy therefore became whichever response LANDED last rather than
 * whichever write the user asked for last - and on the `.set` / `.reset` pair
 * the divergence outlives the render, because `reset` invalidates while `set`
 * writes in place.
 *
 * `host-method-policy-table.ts` says the same thing from the other side, on
 * `providers.fallbackPolicy.set`: `fifo` buys LANDING, never order, and the
 * ordering "has to come from a shared `MutationScope` on that hook, or from a
 * host-side revision check; this table cannot supply it". This is that scope.
 *
 * ## Why per HOST, and not per payload
 *
 * Per-payload granularity is exactly the broken key above - it is what
 * `HostRequestCoordinator` already does, and what puts two saves in two
 * queues. The policy is one row per host, so the host is the resource these
 * writes contend for and the right thing to serialize on.
 *
 * `null` is the host this surface could not resolve yet, and it gets its own
 * bucket rather than being folded into a named host's queue: two writes on an
 * unresolved client are still contending with each other, and a write that
 * later resolves to host A must not be ordered behind one aimed at nothing.
 * The three hooks (`use-fallback-policy-set-mutation.ts`,
 * `use-fallback-policy-reset-mutation.ts`,
 * `use-fallback-policy-restore-tier-groups-mutation.ts`) read the id from the
 * SAME `useHostClient()` result in the same render, so they always agree with
 * one another about which bucket they are in - which is the only agreement
 * the scope needs. A host that moves under the panel moves all three
 * together, and each response is still filed against the `hostId` its own
 * `onMutate` captured.
 *
 * ## Why this lives here, and not on one of the three hooks
 *
 * All three hooks import this function, so it used to live on
 * `use-fallback-policy-set-mutation.ts` as though that hook were the
 * "primary" one - which made that module a hook AND a shared utility at
 * once. A suite that replaced it with a bare `vi.mock` factory (rather than
 * `importOriginal`) silently dropped this export too, and broke whichever
 * sibling hook it left real with `fallbackPolicyWriteScope is not a
 * function` - a fixture gap wearing a production stack trace. A plain,
 * hook-free module has nothing a bare mock of a SIBLING hook module could
 * ever remove.
 */
export function fallbackPolicyWriteScope(hostId: string | null): MutationScope {
  return { id: `providers.fallbackPolicy:${hostId ?? "unresolved-host"}` };
}

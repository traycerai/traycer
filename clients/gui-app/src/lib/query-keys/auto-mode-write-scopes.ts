import type { MutationScope } from "@tanstack/react-query";
import type { GuiHarnessId } from "@traycer/protocol/host/index";

/** The bucket a surface whose host has not resolved yet writes into. */
const UNRESOLVED_HOST = "unresolved-host";

/**
 * The queues Auto mode's three settings writes run in - one per RESOURCE, so a
 * user's LAST choice is the one the host ends up holding.
 *
 * ## The defect these close
 *
 * All three methods sit in `fifo` in `host-method-policy-table.ts`, and `fifo`
 * is routinely misread as "in order". It is not, and the table says so:
 * `HostRequestCoordinator.keyFor` is `JSON.stringify([hostId, userId, method,
 * stableWireJson(params)])`, so the PARAMS are part of the queue key. Two
 * writes carrying two different values are two different queues and race; what
 * `fifo` buys is that an identical repeat LANDS rather than being coalesced.
 * A scheduling policy answers `modeFor` and can never supply this, because it
 * never sees the queue key - the ordering has to come from a client-side
 * `MutationScope`, which is what this module is.
 *
 * Why it matters differs slightly per method, and both readings are bad:
 *
 *   - `autoJudge.set` and `autoPolicy.set` fold their response into the
 *     matching `.get` cache with `setQueriesData`, so an unordered pair leaves
 *     the cache holding whichever response LANDED last - a durable wrong answer
 *     with no authority to correct it, exactly the reading
 *     `fallbackPolicyWriteScope` was minted for;
 *   - `providers.setAutoJudge` invalidates `providers.list` instead, so the UI
 *     self-corrects - but the HOST is then holding the older selection, and the
 *     refetch faithfully reports it. The user's last click silently loses.
 *
 * ## Why per resource, and not per payload
 *
 * Per-payload granularity is precisely the broken key above: it is what the
 * coordinator already does. Each scope is keyed by the row the writes contend
 * for - the host for the two host-scoped settings, the host AND the harness for
 * the per-provider judge, whose choice is one field of one provider's entry in
 * `provider-overrides.json`. Serializing two providers' judge writes against
 * each other would buy nothing and hold the second one in the CLIENT until the
 * first settles.
 *
 * `null` is the host a surface could not resolve yet and gets its own bucket
 * rather than being folded into a named host's queue: two writes on an
 * unresolved client still contend with each other, and a write that later
 * resolves to host A must not be ordered behind one aimed at nothing.
 *
 * ## Why this module, rather than the hooks
 *
 * Hook-free, for `providers-fallback-policy-scope.ts`'s reason: a scope that
 * lives on one of the hooks that uses it makes that module a hook AND a shared
 * utility, and a suite that replaces it with a bare `vi.mock` factory drops the
 * export too - breaking whichever sibling it left real, as a fixture gap
 * wearing a production stack trace.
 */
export function autoJudgeWriteScope(hostId: string | null): MutationScope {
  return { id: `autoJudge.set:${hostId ?? UNRESOLVED_HOST}` };
}

/** @see autoJudgeWriteScope - the account policy's own per-host queue. */
export function autoPolicyWriteScope(hostId: string | null): MutationScope {
  return { id: `autoPolicy.set:${hostId ?? UNRESOLVED_HOST}` };
}

/**
 * @see autoJudgeWriteScope - the per-provider judge's queue, keyed by host AND
 * harness because the resource is one provider's entry, not the whole file.
 */
export function providerAutoJudgeWriteScope(
  hostId: string | null,
  harnessId: GuiHarnessId,
): MutationScope {
  return {
    id: `providers.setAutoJudge:${hostId ?? UNRESOLVED_HOST}:${harnessId}`,
  };
}

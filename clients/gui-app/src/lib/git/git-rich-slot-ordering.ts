/**
 * Ordering authority for the RICH (nested-snapshot) git cache slot
 * (`gitQueryKeys.listChangedFilesWithSubmodules`).
 *
 * Under stream ownership (`git.subscribeStatus` negotiated at minor >= 1) the
 * stream writes this slot; every unary write into it (manual refresh, a
 * pre-transition in-flight fetch resolving late) must prove no stream write
 * landed since that fetch STARTED, or its response is dropped in favor of the
 * newer stream-fed value. Two counters per slot:
 *
 * - `streamGeneration` - bumped on every stream write into the rich slot;
 * - `ownershipEpoch`   - bumped on ownership/client transitions (negotiated
 *   version flip, stream-client rebuild), cheap defense against a superseded
 *   transport's late response.
 *
 * Scoped to the QUERY SLOT (hostId | runningDir | ignoreWhitespace), NOT to a
 * `WsStreamClient`/shared-subscription instance, so client-rebuild overlap and
 * manual refresh observe the SAME ordering authority.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { GitListChangedFilesResponseV11 } from "@traycer/protocol/host";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";

interface RichSlotOrdering {
  streamGeneration: number;
  ownershipEpoch: number;
  /**
   * Which side performed the LAST accepted write into the rich slot. Lets a
   * hook mounting directly into fallback ownership detect a stream-fed cache
   * value (which is `Infinity`-stale and would otherwise never refresh - the
   * ownership-transition effect can't see a flip that happened while nothing
   * was mounted).
   */
  lastWriter: "stream" | "unary" | null;
}

/**
 * Bounded LRU: a long-running session visiting many worktrees must not retain
 * every slot's ordering state forever. Eviction safety rests on two explicit
 * mechanisms (counter values alone are NOT safe - an evict/recreate cycle
 * resets them to zeros, which could alias a fetch's captured snapshot):
 * - `createRichSlotRequest` captures the ENTRY OBJECT and treats an identity
 *   change (evicted + recreated mid-flight) as superseded;
 * - consumers of `richSlotLastWriter` treat the post-eviction `null` as
 *   unknown provenance and act conservatively (see the mount/slot-switch
 *   check in `use-git-list-changed-files-with-submodules.ts`).
 */
const MAX_TRACKED_SLOTS = 256;

const orderings = new Map<string, RichSlotOrdering>();

export function richSlotOrderingKey(args: {
  readonly hostId: string | null;
  readonly runningDir: string;
  readonly ignoreWhitespace: boolean;
}): string {
  // JSON-encode rather than delimiter-join: `runningDir` is a filesystem path
  // and can legitimately contain "|", so naive concatenation could alias two
  // distinct slots (one slot's stream write would then make the OTHER slot
  // discard a fresher unary response in favor of stale cached data).
  return JSON.stringify([args.hostId, args.runningDir, args.ignoreWhitespace]);
}

function orderingFor(key: string): RichSlotOrdering {
  const existing = orderings.get(key);
  if (existing !== undefined) {
    // LRU refresh (Map preserves insertion order) so hot slots never age out.
    orderings.delete(key);
    orderings.set(key, existing);
    return existing;
  }
  const ordering: RichSlotOrdering = {
    streamGeneration: 0,
    ownershipEpoch: 0,
    lastWriter: null,
  };
  orderings.set(key, ordering);
  while (orderings.size > MAX_TRACKED_SLOTS) {
    const oldest = orderings.keys().next();
    if (oldest.done === true) break;
    orderings.delete(oldest.value);
  }
  return ordering;
}

export function readRichSlotOrdering(key: string): {
  readonly streamGeneration: number;
  readonly ownershipEpoch: number;
} {
  const ordering = orderingFor(key);
  return {
    streamGeneration: ordering.streamGeneration,
    ownershipEpoch: ordering.ownershipEpoch,
  };
}

export function bumpRichSlotStreamGeneration(key: string): void {
  const ordering = orderingFor(key);
  ordering.streamGeneration += 1;
  ordering.lastWriter = "stream";
}

export function bumpRichSlotOwnershipEpoch(key: string): void {
  orderingFor(key).ownershipEpoch += 1;
}

/**
 * Records stream provenance for a REFILL write (a consumer-join replay
 * repopulating a GC-collected slot from a session's cached last event).
 * Deliberately does NOT bump the stream generation: a replay is not a new
 * delivery and must never supersede an in-flight unary request.
 */
export function markRichSlotStreamRefill(key: string): void {
  orderingFor(key).lastWriter = "stream";
}

/**
 * The side that performed the last accepted write into the rich slot.
 * `null` means unknown - never written this session, OR the slot's ordering
 * entry was LRU-evicted; treat unknown conservatively.
 */
export function richSlotLastWriter(key: string): "stream" | "unary" | null {
  return orderingFor(key).lastWriter;
}

// Test helper to reset module state.
export function __resetRichSlotOrderingForTesting(): void {
  orderings.clear();
}

/**
 * Wraps a raw `git.listChangedFiles@1.1` request into a GENERATION-AWARE
 * queryFn for the rich slot. The ordering entry is captured before the
 * request is issued; the in-flight outcome decides what happens to the
 * response:
 * - no drift: the response is accepted (and recorded as the unary writer);
 * - STREAM-GENERATION drift (same entry): the stream demonstrably wrote the
 *   slot mid-flight, so the present cached value is strictly newer and is
 *   returned instead;
 * - epoch drift (ownership/client transition) or entry-identity drift
 *   (mid-flight LRU eviction): neither proves anything about the cache, so
 *   the request is RE-ISSUED under the new ordering (bounded; exhaustion
 *   throws rather than returning a proven-superseded response).
 * Used by the passive fallback query AND the explicit manual-refresh fetch,
 * so every unary writer of the rich slot goes through the same arbitration.
 *
 * The returned queryFn honors TanStack's AbortSignal for SIDE EFFECTS: a
 * canceled fetch's response is discarded by TanStack, so it must neither
 * stamp unary provenance (the "last ACCEPTED write" contract) nor burn
 * re-issue attempts on a result nobody will read.
 */
export function createRichSlotRequest(opts: {
  readonly queryClient: QueryClient;
  readonly request: () => Promise<GitListChangedFilesResponseV11>;
  readonly hostId: string | null;
  readonly runningDir: string;
  readonly ignoreWhitespace: boolean;
}): (context: {
  readonly signal: AbortSignal;
}) => Promise<GitListChangedFilesResponseV11> {
  const MAX_ATTEMPTS = 3;
  return async (context) => {
    const key = richSlotOrderingKey({
      hostId: opts.hostId,
      runningDir: opts.runningDir,
      ignoreWhitespace: opts.ignoreWhitespace,
    });
    for (let attempt = 1; ; attempt += 1) {
      // Capture the ENTRY OBJECT, not just its counters: an LRU-evicted +
      // recreated entry restarts at zeros, which could alias the captured
      // values (ABA) and let a stale response through - identity change is
      // itself supersession.
      const before = orderingFor(key);
      const beforeStreamGeneration = before.streamGeneration;
      const beforeOwnershipEpoch = before.ownershipEpoch;
      const response = await opts.request();
      const after = orderingFor(key);
      const identityChanged = after !== before;
      const streamDrift =
        !identityChanged && after.streamGeneration !== beforeStreamGeneration;
      const epochDrift =
        !identityChanged && after.ownershipEpoch !== beforeOwnershipEpoch;
      if (!identityChanged && !streamDrift && !epochDrift) {
        // Stamp provenance only for a result TanStack will actually accept:
        // a CANCELED fetch's response is discarded (this queryFn's inner
        // request keeps running past cancellation), and stamping "unary" for
        // it would let provenance-based recovery trust a cache value no
        // unary result ever wrote.
        if (!context.signal.aborted) {
          after.lastWriter = "unary";
        }
        return response;
      }
      if (streamDrift) {
        // ONLY proven stream-generation drift makes the cached value
        // authoritative: the stream wrote this slot while the fetch was in
        // flight, so the cache is strictly newer than the response. Identity
        // drift (mid-flight LRU eviction) and epoch drift (ownership/client
        // transition) prove nothing about the cached value's freshness -
        // preferring it there would resurrect arbitrarily old data.
        const current =
          opts.queryClient.getQueryData<GitListChangedFilesResponseV11>(
            gitQueryKeys.listChangedFilesWithSubmodules(
              opts.hostId,
              opts.runningDir,
              opts.ignoreWhitespace,
            ),
          );
        if (current !== undefined) {
          return current;
        }
      }
      // A canceled fetch must not re-issue: its result is discarded, so the
      // retry would be pure duplicate git work behind the replacement fetch.
      if (context.signal.aborted) {
        throw new HostRpcError({
          code: "RPC_ERROR",
          message: "git rich-slot fetch canceled while superseded",
          requestId: "",
          method: "git.listChangedFiles",
          fatalDetails: null,
        });
      }
      // Superseded (epoch/identity drift, or stream drift with a GC'd cache)
      // with nothing newer to prefer: re-issue under the new ordering rather
      // than returning a response whose ordering can no longer be proven.
      if (attempt >= MAX_ATTEMPTS) {
        // Never hand back a superseded response - not even as "best effort":
        // under stream ownership nothing would correct it until the next
        // frame. Throwing routes into TanStack's own retry/error machinery
        // (the manual-refresh caller already swallows rejections). A
        // `HostRpcError` (not a bare Error) because the consuming hooks
        // publicly declare that error type and UI surfaces read `.code`.
        throw new HostRpcError({
          code: "RPC_ERROR",
          message:
            "git rich-slot fetch superseded repeatedly mid-flight (ownership/client transitions or ordering-entry eviction)",
          requestId: "",
          method: "git.listChangedFiles",
          fatalDetails: null,
        });
      }
    }
  };
}

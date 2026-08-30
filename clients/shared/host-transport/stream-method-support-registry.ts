/**
 * Per-host record of which STREAM methods the last completed `/stream`
 * handshake negotiated - the stream half of what
 * `negotiated-manifest-registry.ts` does for unary RPC.
 *
 * ## Why a second registry rather than a field on the first
 *
 * That registry records the merged RPC manifest a `/rpc` `openAck` advertises.
 * It cannot answer "does this host serve `epic.state.subscribe`", because
 * stream support is not a name lookup: `applyHostManifest` runs
 * `checkStreamMethodCompatibility` against the client's own served majors, so a
 * method both sides NAME can still be incompatible. What is memoised here is
 * that computed verdict, not a manifest.
 *
 * ## The cost of not having it
 *
 * `WsStreamClient` keeps its support map per INSTANCE, and the Epic's stream
 * client is minted per session (`host-stream-client-cache.ts` keeps no warm
 * linger). So every Epic open started with an empty map, `readEpicAdapterVerdict`
 * read `undecided`, and `applySelection` PROBED - which dials the status lane,
 * waits for its first frame, and only then lets `attach()` open the records
 * lane. Two serial queue-and-handshake round trips where the arm is capable of
 * one: measured on the cold open as the status lane's socket at 1382 ms and the
 * records lane's at 1564 ms, and visible in the warm click waterfall too (status
 * 92 -> 136, records 137). Meanwhile ~50 boot subscriptions had already
 * negotiated this very host's manifest and thrown the answer away.
 *
 * ## The seed is COLD-START ONLY, and that is not a detail
 *
 * A reader might expect "answer from the memo whenever the instance map says
 * `unknown`". That would be wrong, and the two places it would break both say
 * so in their own words:
 *
 * - `WsStreamClient.resetMethodSupport`: "a reconnect may be a new host
 *   incarnation, so capability evidence is client-wide and must be RE-PROBED".
 *   Answering from a memo recorded before that reconnect is precisely the
 *   evidence it is throwing away.
 * - `epic-adapter-selection.ts`, "HOLD through unknown on reconnect": a healthy
 *   reconnect deliberately passes through a window where every lane method reads
 *   `unknown`, and `settleEpicAdapterArm` HOLDS the installed arm through it
 *   rather than re-deciding. A memo that answered `supported` there would turn a
 *   deliberate hold into a decision.
 *
 * So {@link getMemoizedStreamMethodSupport} is consulted by a client only while
 * that client has never completed a handshake of its own. After first contact -
 * including after a reconnect clears its map - the client's own evidence, its
 * absence included, is the only authority. The whole win is at session start,
 * which is exactly where this is still allowed to speak.
 *
 * ## The seed does not NOTIFY, and that is bounded rather than fixed
 *
 * `getMethodSupport` is read as a `useSyncExternalStore` snapshot
 * (`stream-runtime-context.ts`), paired with `subscribeMethodSupport`. Recording
 * here fires no listener, so a client constructed BEFORE its host's first
 * recording keeps answering `unknown` to an observer until something else
 * notifies - its own handshake, which always does.
 *
 * Deliberately not plumbed into the notification path. The gap moves a reader
 * from `unknown` to `unknown`, i.e. to exactly the behaviour before this memo
 * existed, and it closes on the first frame either way; wiring listeners across
 * a process-wide registry into per-client stores to shorten it would add a
 * fan-out with real teardown obligations to buy nothing the next event does not
 * already deliver. The case the lever exists for does not pass through the gap
 * at all: the boot's ~50 subscriptions record long before an Epic session mints
 * its client, so that client is seeded at construction and its first read is
 * already the right answer.
 *
 * ## Staleness
 *
 * An entry is refreshed by traffic and never evicted, like its unary sibling. A
 * host that stops serving a lane between one session and the next hands the new
 * session a `supported` it will disprove on its own subscribe - the cost is the
 * rejected subscribes `onRequiredLaneUnsupported` already budgets for, on the
 * path that already falls back to legacy.
 *
 * Only the LOCAL transport records here. `RemoteStreamClient.getMethodSupport`
 * is a hardcoded `return "unknown"` in a different class, so the mux keeps
 * answering `unknown` forever by construction - which
 * `epic-adapter-selection.ts` requires, since over the relay the probe is not
 * the first signal but the ONLY one.
 */

/** The two verdicts a completed handshake can produce. `unknown` is not one. */
export type NegotiatedStreamMethodSupport = "supported" | "unsupported";

const supportByHostId = new Map<
  string,
  Map<string, NegotiatedStreamMethodSupport>
>();

/**
 * Records what one host's handshake computed for one stream method. Called for
 * EVERY method in the negotiated manifest, not only the subscribed one -
 * `applyHostManifest` already evaluates them all, and a memo that held only the
 * subscribed method would answer `null` for exactly the lane a different
 * subscription's handshake just proved.
 */
export function recordNegotiatedStreamMethodSupport(
  hostId: string,
  method: string,
  support: NegotiatedStreamMethodSupport,
): void {
  const forHost = supportByHostId.get(hostId);
  if (forHost === undefined) {
    supportByHostId.set(hostId, new Map([[method, support]]));
    return;
  }
  forHost.set(method, support);
}

/**
 * What a completed handshake with `hostId` last computed for `method`, or
 * `null` when no handshake with that host has settled it.
 *
 * `null` rather than `"unknown"` deliberately: the caller's own map already has
 * a meaning for `unknown` and this must not be mistaken for it. Absence here is
 * "no evidence", which leaves the caller reporting `unknown` exactly as before.
 */
export function getMemoizedStreamMethodSupport(
  hostId: string,
  method: string,
): NegotiatedStreamMethodSupport | null {
  return supportByHostId.get(hostId)?.get(method) ?? null;
}

/** Test seam: drops every recorded verdict. */
export function resetStreamMethodSupportMemo(): void {
  supportByHostId.clear();
}

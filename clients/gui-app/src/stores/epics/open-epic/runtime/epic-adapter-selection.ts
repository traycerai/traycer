/**
 * Which adapter set serves this CONNECTION - the lanes, or the `@1` legacy arm.
 *
 * Selection is per connection and not per session, because a host can upgrade
 * under an open tab: the reconnect presents a manifest that now advertises the
 * three lane methods, and the tab has to move to them. The runtime compares
 * {@link epicAdapterFingerprint} across reconnects and treats a change as
 * replica REPLACEMENT (`"manifest-changed"`) rather than as a reconfiguration -
 * swapping adapters under a live replica would splice a legacy whole-epic
 * snapshot into a lane-fed one.
 *
 * ## `"unknown"` is not a selection, and the status lane is the probe
 *
 * `hostServesEpicLanes` is fail-closed as a PREDICATE - anything short of all
 * three methods known-supported is not a lane host. That is the right answer to
 * the question it asks. It is the wrong answer to the question a selector asks,
 * because "we have not been told yet" and "we have been told no" are different
 * facts and only one of them justifies opening the monolith.
 *
 * Reading them as one produced a worse open path than the baseline: a cold open
 * on a lane-serving host would take the legacy arm, pull the whole
 * `epic.subscribe@1` snapshot this cutover exists to retire, and then throw it
 * away in a `"manifest-changed"` replacement as soon as the manifest resolved.
 * The epic would open slower than before the lanes existed, which inverts the
 * point.
 *
 * So there are three verdicts, not two, and the third attaches nothing. The
 * runtime's first action on an undecided connection is the STATUS LANE OPEN,
 * used as the probe: on a lane host it succeeds and is the real first lane -
 * the epoch body lanes attach under comes from its `observedAuthorityEpoch()` -
 * and on an old host the subscribe resolves method-unsupported, which is a
 * typed answer that settles the verdict for that connection. One rejected
 * subscribe is the whole cost on an old host, and no `epic.subscribe@1` is ever
 * opened speculatively.
 *
 * There is no wall-clock deadline anywhere in this decision. A timer would be
 * an arbitrary number standing in for an answer the transport will give, and it
 * would put a clock read under `open-epic/runtime/`, which the worker
 * relocation forbids.
 *
 * ## Why the probe is load-bearing rather than an optimisation
 *
 * A remote mux transport reports `"unknown"` FOREVER, structurally:
 * `RemoteStreamClient.getMethodSupport` is a hardcoded `return "unknown"` and
 * its `subscribeMethodSupport` is a no-op, because the mux resolves an
 * incompatible method as a fatal error on that stream's subscribe attempt
 * rather than as a queryable pre-check. Over the relay the manifest therefore
 * never resolves and the probe is not the first signal - it is the ONLY one. A
 * selector that waited for support to settle would never open an epic on a
 * remote host at all.
 *
 * ## HOLD through unknown on reconnect
 *
 * `WsStreamClient.resetMethodSupport` CLEARS the whole support map on every
 * reconnect and re-probes, because a reconnect may be a new host incarnation.
 * So a healthy reconnect on a lane host passes through a window in which every
 * lane method reads `"unknown"`. Re-selecting there would flap the connection
 * to legacy and back, replacing the replica twice for a link that never
 * changed. {@link settleEpicAdapterArm} is that rule: an undecided verdict
 * keeps whatever is installed, and only a decided one can move it.
 *
 * ## Why the fingerprint digests the DECISION and not the raw manifest
 *
 * The seam calls a fingerprint "a stable digest of the negotiated capability
 * set", and the obvious implementation is to join the three methods' support
 * values. That implementation is wrong here, and reachably so.
 *
 * One resolved subscribe fills in every method in a `WsStreamClient`'s merged
 * manifest at once, so an ordinary legacy host walks `unknown → unsupported`
 * for all three lane methods the moment its first stream lands - a transition
 * that changes nothing about which adapters serve the epic. A raw digest would
 * call that a manifest change and drive a full replica replacement: detach,
 * discard, re-snapshot the whole epic, because we stopped assuming an answer
 * and were told the one we assumed. That is a spurious reseed, and a spurious
 * reseed is a failure by the standard every healthy path in the replay harness
 * is held to.
 *
 * Two manifests that select the same adapters must therefore produce the same
 * fingerprint. The epic has exactly two arms, so the honest digest is the arm
 * itself - and the equality comparison the seam permits is then a comparison of
 * the only thing a change in it could mean.
 *
 * ## Body lanes are not part of a selection
 *
 * `artifact.subscribe` is opened per OPEN TILE, under the `authorityEpoch` the
 * status lane observed, and an attach is bound to that epoch for life. So the
 * number of body adapters is a function of what the user has open, not of the
 * manifest, and they cannot be enumerated when the connection is selected. What
 * the arm decides is where bodies come from at all: `artifact.subscribe` lanes
 * on the lane arm, `epic.subscribe@1` room frames on the legacy arm.
 */
import type {
  AdapterSelection,
  LaneAdapter,
} from "@traycer-clients/shared/replica-runtime";
import {
  EPIC_LANE_METHODS,
  hostServesEpicLanes,
} from "@traycer-clients/shared/epic-lanes";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";

/**
 * Which arm serves this connection.
 *
 * A closed two-member union rather than a boolean, so the value that reaches a
 * log, a fingerprint and a test reads as the decision it is.
 */
export type EpicAdapterArm = "legacy" | "lanes";

/**
 * What the negotiated manifest says, including the honest third answer.
 *
 * `"undecided"` is NOT a degraded `"legacy"`. It is the state in which no
 * adapter set may be installed, and the caller's response to it is to probe,
 * not to fall back - see the module doc.
 */
export type EpicAdapterVerdict = EpicAdapterArm | "undecided";

/**
 * Whether an arm can carry ROOT-document writes to its authority.
 *
 * Only `@1` can. On the lane arm the root doc is not a write path at all -
 * records are typed rows and writes go through the command queue - so
 * `sendOutbound` routes a `root-update` to the detached `@1` adapter and drops
 * it. A local `Y.applyUpdate` into that document therefore succeeds while
 * reaching no authority, which is exactly the shape that makes an in-memory
 * apply look like a completed transfer.
 *
 * `null` - no arm selected yet - answers `false`, and that direction is the
 * whole point. Every caller of this predicate is deciding whether it may retire
 * the only copy of somebody's unsynced edits, so the unknown answer has to be
 * the conservative one; retention is recoverable and a discarded handle is not.
 */
export function armCarriesRootWrites(arm: EpicAdapterArm | null): boolean {
  return arm === "legacy";
}

/**
 * Reads this connection's negotiated support for one stream method.
 *
 * The three-valued vocabulary is the transport's own
 * ({@link StreamMethodSupport}), passed through rather than collapsed, because
 * `"unknown"` is the member the decision turns on and a boolean would have to
 * invent an answer for it.
 */
export type EpicMethodSupportReader = (method: string) => StreamMethodSupport;

/**
 * The manifest's verdict for this connection.
 *
 * `"lanes"` delegates the whole positive test to `hostServesEpicLanes`, which
 * owns the rule that all three methods are checked and owns it in ONE place -
 * the failure that predicate exists to prevent is checking a SUBSET, and a
 * records lane with no control lane leaves permission, dirtiness and deletion
 * unknowable forever.
 *
 * `"legacy"` requires an EXPLICIT `"unsupported"` on at least one of the three.
 * That is the asymmetry the third verdict buys: a host that has told us it
 * cannot serve a lane has told us it is an old host, while a host that has told
 * us nothing has told us nothing.
 */
export function readEpicAdapterVerdict(
  support: EpicMethodSupportReader,
): EpicAdapterVerdict {
  if (hostServesEpicLanes(support)) return "lanes";
  const refused = EPIC_LANE_METHODS.some(
    (method) => support(method) === "unsupported",
  );
  return refused ? "legacy" : "undecided";
}

/**
 * Fold a verdict into the arm currently installed.
 *
 * The one place the HOLD rule lives: an undecided verdict never displaces an
 * installed arm, so the support map a reconnect clears cannot flap a lane
 * connection through legacy and back. `null` in means nothing is installed yet,
 * and `null` out means nothing may be installed yet - the caller probes.
 */
export function settleEpicAdapterArm(
  installed: EpicAdapterArm | null,
  verdict: EpicAdapterVerdict,
): EpicAdapterArm | null {
  return verdict === "undecided" ? installed : verdict;
}

/**
 * The digest the runtime compares across reconnects. See the module doc for why
 * this is a function of the arm and not of the three support values.
 *
 * Namespaced so a fingerprint that escapes into a log or a replay capture says
 * what it is a fingerprint OF - the epic's adapter arm, not some other
 * selection's.
 */
export function epicAdapterFingerprint(arm: EpicAdapterArm): string {
  return `epic-adapters:${arm}`;
}

/**
 * Assemble the seam's {@link AdapterSelection} from the arm and the adapters
 * actually built for it.
 *
 * The descriptors are read OFF THE ADAPTERS rather than declared here, so there
 * is no second copy of a lane id or a label that could drift from the adapter
 * that owns it. A selection whose descriptors disagreed with the adapters
 * installed under it would be a selection that lies to every log and every
 * replay capture that reads it.
 */
export function epicAdapterSelection<TEvent>(
  arm: EpicAdapterArm,
  adapters: readonly LaneAdapter<TEvent>[],
): AdapterSelection {
  return {
    descriptors: adapters.map((adapter) => adapter.descriptor),
    fingerprint: epicAdapterFingerprint(arm),
  };
}

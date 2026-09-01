/**
 * What the host has actually sent this client, held as its own `Y.Doc`.
 *
 * Re-homed verbatim from the open-epic closure - four `let`s and three
 * closures, whose ordering invariants were recorded only in comments. The
 * comments come with it; they are the specification.
 *
 * Coverage is deliberately NOT the replica. `doc` additionally holds local
 * edits the host may not have accepted yet, and naming those in a seed offer
 * would tell the host "I already have this" - so the delta it computed would
 * omit the host's own copy of anything it had in fact accepted and not echoed
 * back. `doc ⊇ coverage` always (both receive every snapshot and update; only
 * `doc` also receives local edits), so a delta computed against coverage is a
 * superset of what the replica needs and applying it to both converges.
 */
import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicSubscribeClientSeedOffer } from "@traycer/protocol/host/epic/subscribe";
import { encodeDocStateVectorBase64 } from "./dirty-watermark";

export interface HostCoverage {
  /** Fold a host-originated root update into coverage. */
  applyUpdate(updateBytes: Uint8Array): void;
  /**
   * Fold this cycle's root payload in and record the room it came from.
   * See the implementation note for why a delta and a snapshot take
   * different arms.
   */
  applyRootSeed(meta: SnapshotMetaEpic, snapshotBytes: Uint8Array): void;
  /** Replace coverage outright, discarding whatever room it represented. */
  replace(snapshotBytes: Uint8Array | null): void;
  /** The reattach offer, read LIVE at every wire subscribe - never cached. */
  readSeedOffer(): EpicSubscribeClientSeedOffer | null;
  /** Coverage's own state vector, for the dirty-watermark comparison. */
  stateVectorBase64(): string;
  destroy(): void;
}

export function createHostCoverage(): HostCoverage {
  let doc = new Y.Doc();
  /**
   * The room {@link doc}'s contents came from, or `null` when it holds nothing
   * attributable to a room — a fresh store, a replica reset, or state seeded
   * by a pre-`@1.2` host that never reported a `roomId`.
   *
   * Gates the reattach seed offer: without a room name there is nothing safe
   * to offer, because a major migration mints a NEW room for the same
   * `epicId` and a host diffing against the wrong room's state would omit
   * bytes this client genuinely lacks.
   */
  let roomId: string | null = null;
  /**
   * Bumped every time {@link doc} is REPLACED (never when it is merged into).
   * Identifies the doc instance a seed offer was taken from, so a delta can be
   * checked against the doc it was actually diffed against rather than against
   * whatever coverage happens to name when the reply lands.
   *
   * Needed because doc identity is not carried on the wire: the offer says
   * "here is my state vector" and the reply says "this is a delta", and
   * nothing in that pair names the doc. Between the two lies a network round
   * trip in which the store may have thrown the doc away.
   *
   * DO NOT MAKE THIS BUMP ON EVERY UPDATE. A counter sitting beside a Y.Doc
   * looks like it should track every change, and tightening it that way would
   * silently disable delta-seed for any actively-syncing epic — every offer
   * would be invalidated by the next inbound update before its reply landed,
   * every reattach would fall back to the full document, and every test would
   * stay green. `applyRootSeed`'s "forward movement still merges" test exists
   * to catch exactly that edit.
   *
   * The reason only replacement counts is an asymmetry in Yjs itself: a delta
   * computed against an OLDER state vector is a SUPERSET of what the doc still
   * needs, and applying it is idempotent. So coverage moving FORWARD under an
   * in-flight offer is harmless — ordinary updates, and even a resolver
   * re-emitting a second delta against the original offer (`retryMigration`
   * re-runs the host's `initialize()` without re-reading params), all converge.
   * REPLACEMENT is the only thing that destroys the basis the host diffed
   * against, so replacement is the only thing that invalidates an offer.
   *
   * This guard is the WHOLE protection, deliberately. Two of the three paths
   * that replace coverage happen to be safe without it — `requestFreshSnapshot`
   * runs synchronously and ends by bumping the stream generation, so its stale
   * frames are dropped; a room migration cannot produce a delta at all, since
   * the host rejects an offer naming a different room. Neither of those is a
   * declared property: the first survives only until someone makes a step in
   * that block async, and nothing anywhere pins it. Do not restore either as
   * the reason this is safe. The third path — a permission loss, which clears
   * coverage WITHOUT ending the stream cycle — was never covered by them at
   * all.
   */
  let generation = 0;
  /**
   * The value of {@link generation} at the moment the live seed offer was
   * read, or `null` when no offer is outstanding.
   */
  let offeredGeneration: number | null = null;

  function replace(snapshotBytes: Uint8Array | null): void {
    const previous = doc;
    doc = new Y.Doc();
    if (snapshotBytes !== null) {
      Y.applyUpdate(doc, snapshotBytes);
    }
    // Whatever room the discarded doc represented, the replacement does not
    // represent it: callers either reset coverage to empty or rebase it onto a
    // full snapshot whose room only `applyRootSeed` knows. Left stale, this
    // would offer a new room's state under the old room's name.
    roomId = null;
    // The doc any outstanding offer was taken from no longer exists, so a
    // delta computed against it can no longer be applied anywhere.
    generation += 1;
    previous.destroy();
  }

  return {
    applyUpdate(updateBytes: Uint8Array): void {
      Y.applyUpdate(doc, updateBytes);
    },

    replace,

    /**
     * THE SEAM THE `seededFromOffer` FLAG EXISTS FOR. A full snapshot is
     * self-sufficient, so coverage is rebuilt from it — that is what `replace`
     * does and what every pre-`@1.3` cycle did. A DELTA is not self-sufficient:
     * it deliberately omits everything the host knew this client already had,
     * so rebuilding a fresh doc from it would discard exactly the state the
     * delta was computed to leave out, silently collapsing coverage to the
     * handful of bytes that changed. It must be merged into the existing doc
     * instead.
     *
     * WHY THE REBUILD ARM STILL EXISTS — and it is NOT to bound growth.
     *
     * Merging deltas forever does not make this doc grow. Yjs integrates
     * operations into a struct store keyed by client and clock; it does not
     * append the update messages that delivered them. So the encoded size is a
     * function of the document's operation set, not of how many merges built
     * it. Measured: 50 reattach cycles merging deltas produce a byte-IDENTICAL
     * doc to rebuilding from a full snapshot each cycle (ratio 1.000000), and
     * with deletions, in-place edits and redundant full-snapshot re-delivery
     * mixed in, 1.000108 — 78 bytes on 722 KB of fragmentation noise, with
     * identical content and identical state vectors. A client that reattaches
     * fifty times on a flaky link therefore needs no periodic re-baseline, and
     * none is armed.
     *
     * The rebuild arm earns its place on CORRECTNESS instead: a full snapshot
     * may come from a DIFFERENT ROOM. A major migration mints a new room for
     * the same `epicId`, and merging its snapshot into coverage built from the
     * old room would union two logically different documents. Discarding the
     * old doc is the only correct handling, and the arms line up with that by
     * construction — a room change makes the host reject the offer
     * (`offer.roomId !== storage.getRoomId()`), so it answers with a full
     * snapshot and no `seededFromOffer`, which lands here on exactly the
     * rebuild arm that drops the stale room.
     */
    applyRootSeed(meta: SnapshotMetaEpic, snapshotBytes: Uint8Array): void {
      if (meta.seededFromOffer !== true) {
        replace(snapshotBytes);
        roomId = meta.roomId ?? null;
        offeredGeneration = null;
        return;
      }
      // A delta, so it is only meaningful against the doc whose state vector
      // was offered. If that doc has been replaced since (permission loss
      // clears coverage without ending the stream cycle), merging here would
      // fold a diff into a doc it was never computed against, and the result
      // would silently hold only the bytes that changed.
      //
      // Leave coverage untouched in that case, and take no room id — so no
      // further offer is made until a full snapshot re-establishes a basis. The
      // replica still receives these bytes at the call site, so the user's view
      // is unaffected; only host-coverage precision degrades, and it degrades
      // by UNDER-stating what the host has. That is the safe direction:
      // coverage is read to decide whether local work is durable, and
      // over-reporting dirty work costs a redundant reconcile, while
      // under-reporting it would claim unsynced edits are safe.
      if (offeredGeneration !== generation) {
        offeredGeneration = null;
        return;
      }
      Y.applyUpdate(doc, snapshotBytes);
      roomId = meta.roomId ?? null;
      offeredGeneration = null;
    },

    /**
     * The reattach offer: what this client has already received from the host,
     * so the host can answer a resubscribe with only what changed.
     *
     * Read live at every wire subscribe, including reconnects — never cached.
     * Pure and synchronous by contract: `IStreamClient.subscribeWithParamsProvider`
     * invokes it immediately before every subscribe, so it must not create
     * transport or application state as a side effect.
     */
    readSeedOffer(): EpicSubscribeClientSeedOffer | null {
      if (roomId === null) {
        offeredGeneration = null;
        return null;
      }
      // Record WHICH doc this vector describes, so the reply can be checked
      // against it rather than against whatever coverage names by then.
      offeredGeneration = generation;
      return {
        stateVectorBase64: encodeDocStateVectorBase64(doc),
        roomId,
      };
    },

    stateVectorBase64(): string {
      return encodeDocStateVectorBase64(doc);
    },

    destroy(): void {
      doc.destroy();
    },
  };
}

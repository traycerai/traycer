/**
 * The main-thread half of the artifact-body lease, once the cold tier lives in
 * the worker.
 *
 * The shape is forced by one hard constraint and one ruling. The constraint:
 * Tiptap binds a `Y.XmlFragment` synchronously by reference, so a materialized
 * body is a MAIN-THREAD object and cannot become a promise at the binding site.
 * The ruling: demote is ACKNOWLEDGED - the main thread keeps the live doc until
 * the worker says it has settled the bytes - so there is never a moment where
 * an edit exists in neither place.
 *
 * `release()` is therefore synchronous and returns `void`, and the doc is
 * dropped by the ACK HANDLER rather than by the caller. That is what keeps this
 * out of the lease hook's signature: from the hook's side nothing changed.
 *
 * This module is deliberately free of `yjs`. It owns the lifecycle - reference
 * counts, generations, the demote state machine, what the accountant is told
 * and when - and the live doc itself is owned by whoever installs it, addressed
 * only by an opaque `docKey`. Splitting it that way is what makes the
 * lifecycle testable without standing up a document tier.
 */
import type { RuntimeWorkerPort } from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import {
  NO_TRANSFER,
  takeBytesForTransfer,
} from "@traycer-clients/shared/replica-runtime/worker/transferable-bytes";
import type { ArtifactBodySeedMode } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type {
  RuntimeScheduler,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime";

/**
 * The live main-thread documents, as this module addresses them.
 *
 * Every method is keyed by `docKey` and none of them mention `yjs`: installing
 * bytes, encoding them back, and dropping the doc are the document tier's job,
 * and the seed-mode rules that go with them (a `"full"` snapshot with a CHANGED
 * guid REPLACES rather than splices) live there too.
 */
export interface MainThreadBodyDocs {
  install(input: {
    readonly docKey: string;
    readonly update: Uint8Array;
    /**
     * The identity these bytes were cut at.
     *
     * Held so the demote that eventually returns them can be REFUSED if the
     * body was replaced in the meantime - a deleted-and-recreated body shares
     * no ancestor with what was installed, and merging the two is
     * unrecoverable rather than lossy.
     */
    readonly docGuid: string | null;
    readonly seedMode: ArtifactBodySeedMode;
    readonly hostStateVector: string | null;
  }): void;
  /** The doc's current state, for handing back to the worker. */
  encode(docKey: string): Uint8Array;
  /**
   * Release the live doc. Called ONLY from an accepted demote's ack handler -
   * never from `release()`, and never on a rejection.
   */
  drop(docKey: string): void;
  has(docKey: string): boolean;
  /**
   * A remote presence frame for a body this side holds.
   *
   * On this interface because presence arrives WITH the materialize - see the
   * call site - so the object that installs the doc is the one that must
   * apply it, in the same step.
   */
  applyRemoteAwareness(docKey: string, frame: Uint8Array): void;
}

/**
 * What the byte accountant is told, and when.
 *
 * The ordering is the contract, not the call list. A doc awaiting its demote
 * ack is still HOT - it is still resident on this thread - so its charge stands
 * until the ack, and it is the entry's `demotingGeneration`, not the
 * accountant, that stops a second demote being posted for it.
 */
export interface HotBodyBudget {
  /**
   * A body doc just became resident. `bytes` is its ENCODED size.
   *
   * `markDemoting` / `clearDemoting` used to sit here, to stop an eviction
   * chooser picking a doc whose demote was already under way. They are gone
   * because that chooser does not exist: the book never invents an LRU - it
   * calls the TIER's walk - and post-flip the tier is cold-only while the
   * main-side hot set is exactly this bridge's `entries`, each of them leased
   * or already demoting. `demotingGeneration` on the entry already prevents
   * the double post and the stale ack, so the pair was a second copy of that
   * state with no reader.
   */
  chargeHot(docKey: string, bytes: number): void;
  /**
   * The worker settled this doc's bytes cold. ONE call, not separable: the hot
   * charge is released and the cold figure is the worker's own.
   *
   * This does NOT record cold bytes - the TIER reports those, through its own
   * `settleCold`, because it holds cold state for every room whether leased or
   * not. One reporter per byte fact; recording here too would double-count.
   */
  settleCold(docKey: string, settledBytes: number): void;
}

export type ArtifactBodyGrant =
  | { readonly kind: "granted"; readonly docKey: string; release(): void }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface ArtifactBodyLeaseBridge {
  acquire(artifactId: string): Promise<ArtifactBodyGrant>;
  /**
   * Re-post every demote that was posted but never acknowledged.
   *
   * Called after a worker respawn. The main thread still holds those docs -
   * that is the entire reason an acknowledged demote holds them - so the bytes
   * are still available to send. Same generation as the original post, so a
   * worker that somehow received both settles once.
   */
  resendUnacknowledgedDemotes(): void;
  /** Doc keys posted for demotion and not yet settled. A test seam. */
  unacknowledgedDemoteKeys(): readonly string[];
  /**
   * Forget every entry WITHOUT posting anything.
   *
   * For a binding-epoch advance, which means the worker destroyed its room
   * replicas: there is nothing on the far side to settle bytes back INTO, so a
   * demote would be answered `not-held` and the entry would sit pending
   * forever. Distinct from `flushLingering`, which posts because the far side
   * is still there.
   *
   * The caller drops the live docs. That discards main-side edits which were
   * never sent - and that is the honest outcome rather than a loss this
   * introduces: the replica they belonged to is already gone, so keeping them
   * would show a user edits that can never reach anywhere.
   */
  forget(docKey: string): void;
  /**
   * Post every LINGERING doc's demote/release now, without waiting.
   *
   * For teardown. A linger is a bet that the user is coming back to this body;
   * at session dispose that bet is already lost, and waiting it out would hold
   * the session's docs - and the worker's holds - for a full window after
   * everything that could use them is gone. A sixty-second wait inside
   * teardown is a park wearing a UX feature's clothes.
   */
  flushLingering(): void;
}

interface BodyEntry {
  leases: number;
  /**
   * What this doc was materialized at; sent back on every demote.
   *
   * `null` on the `@1` arm, where a room snapshot states no identity by
   * design - `legacy-epic-stream-adapter.ts`: "it claims no doc identity,
   * which leaves the tier's replace rule unreachable from this arm by
   * construction rather than by luck". A `null` here is the tier's own
   * recorded truth carried one layer further, never a decision this side
   * made: `artifact-room-tier.ts:325` forbids inventing one, because "a
   * fabricated guid would be indistinguishable from a stated one".
   */
  docGuid: string | null;
  /**
   * Bumped on every demote post AND on every re-acquire.
   *
   * One counter serving both is what makes a late ack recognisable: an ack
   * naming a generation that is no longer current belongs to a demote the
   * lease outlived, and the only correct response to it is to do nothing.
   */
  generation: number;
  demotingGeneration: number | null;
  /**
   * The LINGER: this doc's last lease is gone, but the doc is still live and
   * will stay live until this fires.
   *
   * The hot doc's linger lives HERE because the hot doc lives here. Pre-flip
   * the tier ran it, because the tier owned the hot doc; ownership moved to
   * main, and the linger is part of that object's lifetime, so it moved with
   * it. The tier's remaining cooldown governs its own COLD copy - a different
   * object with its own memory story. One linger per object, each at its
   * owner.
   *
   * It covers BOTH lifecycles, which is what keeps it one timer rather than
   * two: at expiry the entry posts whichever of demote/release its identity
   * calls for. `null` while a lease is held, and cancelled by a re-acquire -
   * that cancellation is the property the whole thing exists for, because a
   * tab switch that remounts a tile must not pay to re-materialize the body.
   */
  lingerTimer: RuntimeTimer | null;
  /**
   * A monotonic stamp of when this doc was last HELD, for the cap's eviction
   * order.
   *
   * A counter rather than a clock: this only ever needs to order entries
   * against each other, and a wall-clock read would make the order depend on
   * timer resolution for two acquires in the same tick.
   */
  lastHeldSeq: number;
}

export function createArtifactBodyLeaseBridge(options: {
  readonly bridge: RuntimeWorkerPort;
  readonly docs: MainThreadBodyDocs;
  readonly budget: HotBodyBudget;
  /**
   * Where the linger's timer comes from. INJECTED rather than `setTimeout`, so
   * a suite drives the window instead of waiting out a real minute.
   */
  readonly scheduler: RuntimeScheduler;
  /**
   * How long a doc stays live after its last lease.
   *
   * Passed in from `ARTIFACT_ROOM_LEASE_POLICY.cooldownMs` - the SAME value the
   * tier's cooldown used - rather than restated here. The UX property is
   * preserved at its original magnitude; a second number beside the first is
   * how one silently becomes the other.
   */
  readonly lingerMs: number;
  /**
   * The BACKSTOP ceiling on hot docs - not the reclaim mechanism, which is the
   * linger.
   *
   * It moved here for the same reason the linger did: it bounds how many HOT
   * docs can exist, and the hot docs are main's now. The tier's own copy of
   * this cap governs its cold entries, which is a different population.
   *
   * A pinned (still-leased) doc is never evicted, so this can legitimately be
   * exceeded by editors genuinely in use - the tier says the same, and treats
   * a lower value as a regression rather than a tightening.
   */
  readonly maxHotDocs: number;
}): ArtifactBodyLeaseBridge {
  const entries = new Map<string, BodyEntry>();
  let leaseSeq = 0;

  function postDemote(docKey: string, generation: number): void {
    const entry = entries.get(docKey);
    // FORWARD-ONLY bodies are never DEMOTED. `body/demote` names an identity
    // and the tier decides its refusal on one, so an entry with no guid has
    // nothing to settle back TO - `settleColdState` would answer
    // `newer-generation` for it. Skipping the call is that existing refusal
    // moved to where it is cheap; the round trip it saves would always have
    // ended in a no.
    //
    // It does NOT mean nothing happens. See the branch below: they release
    // instead, which is a different operation rather than a weaker demote.
    if (entry === undefined) return;
    const docGuid = entry.docGuid;
    if (docGuid === null) {
      // FORWARD-ONLY: it does not SETTLE, and for a long time this line read
      // that as "nothing happens", which leaked every `@1` body on both sides
      // - main's live `Y.Doc` and the worker's retained hold, for the life of
      // the session.
      //
      // Settling returns BYTES and needs an identity to name what it is
      // returning them to. Releasing returns MEMORY and needs no identity at
      // all. A body has exactly one of the two lifecycles, decided by whether
      // its seed stated an identity; this is the other one, not a degenerate
      // case of the demote above.
      //
      // No ack to wait for, so the entry is retired here rather than in a
      // handler: there is no answer that could refuse, and nothing is at risk
      // because no bytes are being handed over. The worker's release is
      // idempotent for exactly the resend case the demote path needs an ack
      // for.
      //
      // NO BYTES are stranded by this arm, and that much is verified: on `@1`
      // main's copy is a relay MIRROR - every local edit is posted through
      // `body/update` the moment it is made, with no batching between the edit
      // and the post, and `postMessage` FIFO puts all of them ahead of this
      // release. By the time this runs the tier already holds what main held.
      //
      // But that answers the wrong half of the question, and this comment
      // said so too confidently before the tests corrected it. Bytes are not
      // the only reason a room must stay hot: a REMOTE COLLABORATOR pins it
      // too, and unlike the demote path - where the tier can answer `pinned` -
      // a release has no refusal channel, so nothing here can be told. A `@1`
      // room with a peer present is therefore released while the tier still
      // considers it pinned.
      //
      // KNOWN GAP, deliberately left visible rather than papered over: closing
      // it means giving the release an answer (which makes it a call) or
      // giving main the pin state another way, and that is a contract change
      // rather than a fix to make in passing.
      entry.demotingGeneration = entry.generation;
      void options.bridge.call("body/release", { docKey }, NO_TRANSFER).then(
        (answer) => {
          const current = entries.get(docKey);
          // A late answer for a lease since re-acquired, exactly as the demote
          // path guards it: the doc is live again and dropping it here would
          // take it out from under a bound editor.
          if (current === undefined || current.demotingGeneration === null) {
            return;
          }
          if (!answer.released) {
            // REFUSED - the tier still pins this room. Same answer as a
            // refused demote: keep the doc, keep the entry pending so a
            // respawn resend covers it, and look again next window.
            armLinger(docKey);
            return;
          }
          current.demotingGeneration = null;
          entries.delete(docKey);
          // No bytes came back, so nothing to record cold - only the hot
          // charge is released.
          options.budget.settleCold(docKey, 0);
          options.docs.drop(docKey);
        },
        () => {
          // The worker went away mid-release. The doc stays live and the entry
          // stays pending, exactly as for a demote: `resendUnacknowledgedDemotes`
          // re-posts, and `postDemote` routes it back down this same branch.
        },
      );
      return;
    }
    const encoded = takeBytesForTransfer(options.docs.encode(docKey));
    void options.bridge
      .call(
        "body/demote",
        {
          docKey,
          generation,
          docGuid,
          update: encoded.bytes,
        },
        encoded.transfer,
      )
      .then(
        (answer) => {
          const entry = entries.get(docKey);
          // A late ack for a lease that has since been re-acquired. The doc is
          // live again under a newer generation; dropping it here would take
          // the document out from under a bound editor.
          if (entry === undefined || entry.demotingGeneration !== generation) {
            return;
          }
          // The worker declined this generation. Keep the doc AND keep the
          // entry pending, so a later resend can settle it - a declined demote
          // that silently dropped the doc is the same data loss as an accepted
          // one that never arrived.
          if (!answer.accepted) {
            // REFUSED. The doc stays live - that has always been the contract -
            // but it must also be RETRIED, or a refusal is a wedge: the entry
            // sits pending with no timer and nothing ever posts for it again.
            // That is the leak in the other direction from the one the linger
            // fixed, and it is reachable by the ordinary case now that `pinned`
            // is a refusal: a room with a remote collaborator in it refuses
            // every demote until they leave, which may be hours.
            //
            // `demotingGeneration` is deliberately NOT cleared. It is what
            // keeps this doc in `unacknowledgedDemoteKeys`, and that set is
            // read by `resendUnacknowledgedDemotes` after a worker respawn -
            // so clearing it would narrow the died-mid-demote coverage to buy
            // the retry, when both are wanted and they are not exclusive.
            //
            // The two cover different failures and compose safely: the resend
            // re-posts the SAME generation, while a linger expiry bumps to a
            // fresh one, and the tier answers whichever it sees last while the
            // generation check makes the superseded ack a no-op.
            armLinger(docKey);
            return;
          }
          entry.demotingGeneration = null;
          entries.delete(docKey);
          options.budget.settleCold(docKey, answer.settledBytes);
          options.docs.drop(docKey);
        },
        () => {
          // The worker went away mid-demote (the call rejects rather than
          // hanging), or the post failed. Either way the doc stays live and the
          // entry stays pending, so `resendUnacknowledgedDemotes` re-posts it
          // to the replacement. Every rejection is treated alike, because the
          // one thing that must never happen is dropping the doc without a
          // settled ack - and a rejection is never a settled ack.
          //
          // A rejection handler rather than a trailing `.catch`: a `.catch`
          // would also swallow a throw from the success arm above, where
          // `docs.drop` failing silently is a real doc leak.
        },
      );
  }

  return {
    async acquire(artifactId): Promise<ArtifactBodyGrant> {
      const existing = findByArtifact(entries, artifactId);
      if (existing !== null) {
        return reviveAndHold(existing.docKey, existing.entry);
      }

      const answer = await options.bridge.call(
        "body/materialize",
        { artifactId },
        NO_TRANSFER,
      );
      if (answer.docKey === null || answer.update === null) {
        return { kind: "unavailable", reason: `no body for ${artifactId}` };
      }
      const docKey = answer.docKey;
      // An entry already under this doc key. Two ways to arrive here, and the
      // second is the one that matters:
      //
      //   - a concurrent acquire for the same artifact installed it while this
      //     call was in flight; or
      //   - the `@1` arm, where `docKey` is a ROOM id. `findByArtifact` is
      //     keyed by doc key, so a held legacy entry is not findable by
      //     artifact id at all, and EVERY legacy re-acquire lands here rather
      //     than on the fast path above.
      //
      // Both must revive a pending demote, which is why this shares one helper
      // with the fast path instead of only bumping the lease count. Skipping
      // the revive here leaves the earlier demote armed: its `accepted: true`
      // passes the generation guard, the entry is deleted, settled cold and
      // dropped - out from under the editor that just took the new grant.
      const raced = entries.get(docKey);
      if (raced !== undefined) {
        return reviveAndHold(docKey, raced);
      }
      // A granted answer with no identity is FORWARD-ONLY, not unavailable.
      //
      // This branch used to refuse, reasoning that a body which cannot be
      // demoted would be "installed and stranded". That reasoning holds for
      // the lanes arm, where every body states an identity - and it makes the
      // `@1` arm unserviceable, because `@1` states none BY DESIGN and its
      // bodies were never settled back even before the relocation:
      // `settleColdState` already refuses without a recorded guid, so the
      // demote path has always been unreachable there.
      //
      // Stranded is therefore `@1`'s normal state, not a hazard this side
      // introduces. Refusing here would mean no `@1` body ever reaches an
      // editor, which is the whole arm going dark.
      options.docs.install({
        docKey,
        update: answer.update,
        docGuid: answer.docGuid,
        seedMode: answer.seedMode,
        hostStateVector: answer.hostStateVector,
      });
      // Presence, in the same step as the install and never before it. These
      // frames rode the response precisely because a push could not: the
      // worker attaches its observer inside the materialize handler, so a
      // pushed frame would arrive for a docKey main had not installed yet and
      // be dropped. Without this a re-materialized room shows an empty
      // presence channel until each peer's next heartbeat.
      for (const frame of answer.awarenessFrames) {
        options.docs.applyRemoteAwareness(docKey, frame);
      }
      entries.set(docKey, {
        leases: 1,
        generation: 1,
        docGuid: answer.docGuid,
        demotingGeneration: null,
        lingerTimer: null,
        lastHeldSeq: (leaseSeq += 1),
      });
      options.budget.chargeHot(docKey, answer.update.byteLength);
      // AFTER the new doc is installed and charged, so the entry that just
      // arrived is part of the population being measured - and it is leased,
      // so it can never be its own victim.
      enforceHotCap();
      return { kind: "granted", docKey, release: releaseFor(docKey) };
    },
    resendUnacknowledgedDemotes(): void {
      for (const [docKey, entry] of entries) {
        if (entry.demotingGeneration === null) continue;
        postDemote(docKey, entry.demotingGeneration);
      }
    },
    unacknowledgedDemoteKeys(): readonly string[] {
      const keys: string[] = [];
      for (const [docKey, entry] of entries) {
        if (entry.demotingGeneration !== null) keys.push(docKey);
      }
      return keys;
    },
    forget(docKey): void {
      const entry = entries.get(docKey);
      if (entry === undefined) return;
      cancelLinger(entry);
      entries.delete(docKey);
    },
    flushLingering(): void {
      // Snapshot first: `postLifecycleEnd` mutates `entries` for the
      // forward-only arm (it retires the entry inline, having no ack to wait
      // for), and mutating a Map mid-iteration skips entries.
      const lingering: [string, BodyEntry][] = [];
      for (const pair of entries) {
        if (pair[1].lingerTimer !== null) lingering.push(pair);
      }
      for (const [docKey, entry] of lingering) {
        cancelLinger(entry);
        postLifecycleEnd(docKey, entry);
      }
    },
  };

  /**
   * Take a hold on an entry that already exists, cancelling any demote that is
   * still in flight for it.
   *
   * The single place a pending demote is disarmed, and it is shared on purpose:
   * there are TWO routes to "re-acquire a doc whose demote has not been
   * acknowledged" - the fast path (doc key equals artifact id, the lane arm)
   * and the post-materialize path (doc key is a room id, the `@1` arm) - and
   * for a while only the first one revived. Advancing the generation is what
   * makes the outstanding ack a no-op; without it the ack still matches, and
   * the document is dropped under a live grant.
   */
  function reviveAndHold(docKey: string, entry: BodyEntry): ArtifactBodyGrant {
    // THE point of the linger: a re-acquire inside the window costs nothing -
    // no materialize call, no round trip, no re-encode. The doc was never
    // released, so this is a reference count going back up.
    cancelLinger(entry);
    entry.lastHeldSeq = leaseSeq += 1;
    if (entry.demotingGeneration !== null) {
      entry.demotingGeneration = null;
      entry.generation += 1;
    }
    entry.leases += 1;
    return { kind: "granted", docKey, release: releaseFor(docKey) };
  }

  /**
   * End this doc's lifetime, whichever lifetime it has.
   *
   * The ONE place the two shapes diverge, so the linger above does not have to
   * know which it is holding: identity-stated bodies settle their bytes back
   * through `body/demote`, forward-only bodies release their hold. Both begin
   * by advancing the generation, because both make any outstanding ack stale.
   */
  function postLifecycleEnd(docKey: string, entry: BodyEntry): void {
    entry.generation += 1;
    entry.demotingGeneration = entry.generation;
    postDemote(docKey, entry.generation);
  }

  /**
   * Evict lingering docs until the hot population is back under the cap.
   *
   * Least-recently-held first, and ONLY docs whose last lease is already gone:
   * a leased doc is pinned, exactly as it was in the tier, because evicting a
   * body under a bound editor is data loss rather than reclamation. If every
   * hot doc is leased this does nothing and the cap is exceeded - which is the
   * documented behaviour, not a gap.
   */
  function enforceHotCap(): void {
    // Counted, NOT `entries.size`. An acknowledged demote leaves its entry in
    // place until the ack lands - that is the whole point of the shape - so a
    // doc already on its way out still occupies a slot in the map while no
    // longer occupying one in the population this cap governs. Measuring the
    // map instead evicts every evictable doc in one pass, because the size
    // never drops as the loop runs. (Written from the pin, which caught it.)
    const stayingHot = (): number => {
      let count = 0;
      for (const entry of entries.values()) {
        if (entry.demotingGeneration === null) count += 1;
      }
      return count;
    };
    while (stayingHot() > options.maxHotDocs) {
      let victimKey: string | null = null;
      let victim: BodyEntry | null = null;
      for (const [docKey, entry] of entries) {
        if (entry.leases > 0 || entry.demotingGeneration !== null) continue;
        if (victim === null || entry.lastHeldSeq < victim.lastHeldSeq) {
          victimKey = docKey;
          victim = entry;
        }
      }
      // Nothing evictable: every remaining doc is leased or already on its way
      // out. Stop rather than spin - this loop's exit cannot depend on finding
      // a victim it is allowed to take.
      if (victimKey === null || victim === null) return;
      cancelLinger(victim);
      postLifecycleEnd(victimKey, victim);
    }
  }

  function cancelLinger(entry: BodyEntry): void {
    entry.lingerTimer?.cancel();
    entry.lingerTimer = null;
  }

  function releaseFor(docKey: string): () => void {
    let live = true;
    return () => {
      // Idempotent per grant. Without this a caller's `finally` backstop
      // running after its own early release would decrement a second time and
      // demote a document another holder is still using.
      if (!live) return;
      live = false;
      const entry = entries.get(docKey);
      if (entry === undefined) return;
      entry.leases -= 1;
      if (entry.leases > 0) return;
      // Already on its way out - a second release before the ack must not post
      // a second demote, nor tell the accountant twice.
      if (entry.demotingGeneration !== null) return;
      // ...nor arm a second linger for a doc already inside one.
      if (entry.lingerTimer !== null) return;
      armLinger(docKey);
    };
  }

  /**
   * Start (or restart) one doc's linger window.
   *
   * Shared by the last-lease release and by a REFUSED demote, because the two
   * want exactly the same thing: hold the doc, and look again in a window. A
   * refusal that did not re-arm would wedge the entry pending for ever.
   */
  function armLinger(docKey: string): void {
    const entry = entries.get(docKey);
    if (entry === undefined || entry.lingerTimer !== null) return;
    entry.lingerTimer = options.scheduler.schedule(options.lingerMs, () => {
      // Re-read rather than closing over `entry`: the window is long enough
      // for the doc to have been dropped entirely, and a timer that resolved
      // against a stale object would post for a body that no longer exists.
      const current = entries.get(docKey);
      if (current === undefined) return;
      current.lingerTimer = null;
      // A re-acquire inside the window cancels this timer, but a cancel that
      // raced the fire still lands here - so the lease count decides, not the
      // fact that the timer ran.
      if (current.leases > 0) return;
      postLifecycleEnd(docKey, current);
    });
  }
}

function findByArtifact(
  entries: Map<string, BodyEntry>,
  artifactId: string,
): { readonly docKey: string; readonly entry: BodyEntry } | null {
  // The lane arm answers `docKey === artifactId`; the `@1` arm answers a room
  // id, which this map is keyed by. A held entry is therefore findable by
  // artifact id only on the lane arm, and on the `@1` arm a re-acquire goes
  // through `body/materialize` - which is correct, because only the worker
  // knows which room now hosts that artifact.
  const direct = entries.get(artifactId);
  return direct === undefined ? null : { docKey: artifactId, entry: direct };
}

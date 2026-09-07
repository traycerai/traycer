/**
 * The worker-side composition root, as far as it can be built without the
 * pieces that are still main-thread.
 *
 * What this module is FOR is naming the ports and fixing the shutdown order.
 * Everything the relocated runtime needs from the worker's side of the bridge
 * arrives through {@link EpicRuntimeCorePorts}; nothing is constructed here,
 * because the things that would be constructed - the stream clients, the lane
 * and legacy adapters, the root replica, the cold tier, the durable store -
 * are the very files that have not moved yet. A skeleton that guessed at their
 * construction would have to be rewritten when they arrive, and would read as
 * settled design in the meantime.
 *
 * The shutdown order IS settled, and is the reason this exists now rather than
 * later. It runs in one direction only:
 *
 *   1. stop serving - after this, a late call is answered by the host's
 *      no-core defaults (`unavailable` / `accepted: false`), never by a
 *      half-disposed replica;
 *   2. close the transport - so no frame arrives for a replica that is going
 *      away, and the host sees a clean close rather than a dropped socket;
 *   3. close the durable store last - it is the only thing here with state
 *      that outlives the process, and closing it while a frame could still
 *      arrive is how a write lands after the close that was supposed to
 *      finish it.
 *
 * There is deliberately no flush step. An in-flight durable write completes or
 * aborts as its own transaction; a "flush" here would be this module claiming
 * a guarantee the store already owns and stating it in a second, weaker place.
 */
import type { SendOutcome } from "@traycer-clients/shared/replica-runtime/adapter";
import {
  inertMutationResult,
  type EpicMutation,
  type EpicMutationResult,
  type RuntimeCommand,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type {
  ArtifactBodyMaterialization,
  EnqueuedWriteCommand,
  EpicRuntimeWorkerCore,
} from "./epic-runtime-worker-host";

/** What a settle answers, and what a resend replays. */
interface DemoteAnswer {
  readonly accepted: boolean;
  readonly settledBytes: number;
  readonly reason: "not-held" | "newer-generation" | "pinned" | null;
}

/**
 * What `body/demote` carries. Mirrors the member's parameter on
 * {@link EpicRuntimeWorkerCore} and the `bodies.settle` port between them;
 * named here because the serialization below passes it between helpers.
 */
interface DemoteInput {
  readonly docKey: string;
  readonly generation: number;
  readonly docGuid: string;
  readonly update: Uint8Array;
}

/**
 * The latest settled demote for one doc, within one lifetime of that doc.
 *
 * One entry per `docKey`, never a history.
 *
 * **The premise this doc used to state was false, and it is what licensed a
 * corruption bug:** "the main thread has at most one demote outstanding per
 * doc". It does not. `artifact-body-lease-bridge.ts` will re-acquire a doc
 * whose demote is unacknowledged (`reviveAndHold`, which bumps the generation)
 * and then end that lifetime again (`postLifecycleEnd`, which bumps once more
 * and posts) - so gen N and gen N+2 are both in flight here, and the settles
 * can resolve in either order. With the check before the await and the write
 * after it, the older completion overwrote the newer record, and a resend of
 * the newer generation then missed, re-settled against a tier that no longer
 * held the doc, and answered a refusal main could never clear.
 *
 * The record carries no lifetime marker of its own, and that is a property of
 * the write rather than an omission: `recordSettledDemote` refuses to write a
 * completion whose lifetime has ended, so every entry here belongs to the
 * CURRENT lifetime by construction and a reader never has to ask.
 *
 * Why a lifetime check is needed at all: the main-side `generation` is NOT
 * monotonic across lifetimes. The bridge deletes its entry once a demote is
 * acknowledged and a re-materialized doc starts again at `generation: 1`
 * (`artifact-body-lease-bridge.ts` - the `entries.set` with `generation: 1`).
 * So "older loses" cannot be decided on generation alone: a stale gen 5 from
 * the previous lifetime would outrank a live gen 1 and refuse every demote of
 * the new one forever.
 */
interface SettledDemote {
  readonly generation: number;
  readonly answer: DemoteAnswer;
}

export interface EpicRuntimeCorePorts {
  /**
   * The root replica's content-addressed attachment map.
   *
   * Answers `null` for a hash it does not hold rather than waiting for one to
   * arrive - the waiting variant of that read is a main-thread concern with
   * its own abort signal, and a worker that parked on a hash would hold a call
   * slot open indefinitely.
   */
  readonly attachments: {
    read(hash: string): Promise<Uint8Array | null>;
    /** Waits. Settles `null` on cancel or on {@link cancelAll}. */
    await(awaitId: number, hash: string): Promise<Uint8Array | null>;
    cancel(awaitId: number): boolean;
    /** Settle every pending wait `null`. Teardown must not park callers. */
    cancelAll(): void;
  };
  /** The cold-byte tier: encoded bodies in, encoded bodies out. */
  readonly bodies: {
    materialize(
      artifactId: string,
    ): Promise<ArtifactBodyMaterialization | null>;
    settle(input: {
      readonly docKey: string;
      readonly generation: number;
      /**
       * The identity the caller materialized at. The tier refuses a settle
       * whose guid has moved, which is a DIFFERENT refusal from the generation
       * check above it: generation is the main thread's lifetime counter, guid
       * is the doc's own identity, and a body replaced underneath a live
       * editor moves the second without moving the first.
       */
      readonly docGuid: string;
      readonly update: Uint8Array;
    }): Promise<{
      readonly accepted: boolean;
      readonly settledBytes: number;
      readonly reason: "not-held" | "newer-generation" | "pinned" | null;
    }>;
    /**
     * Let go of a FORWARD-ONLY body: release its retained lease and detach its
     * observers, settling nothing.
     *
     * The other half of the demote contract, not a variant of it. `settle`
     * returns BYTES and needs the identity to name what it is returning them
     * to; this returns MEMORY and needs no identity at all. Reading the
     * identity rule as governing both is what leaked every `@1` body.
     */
    release(docKey: string): {
      readonly released: boolean;
      readonly reason: "not-held" | "newer-generation" | "pinned" | null;
    };
    /**
     * The docKeys whose runtime lease this port still holds.
     *
     * The retained-hold map IS the contract here - it is what `materialize`
     * fills and what `settle`/`release` must empty - so reading it is reading
     * the invariant, not inspecting an implementation detail. Exposed because
     * a lifetime leak has no other honest observable: the tier, the projection
     * and the tile all look correct while a hold outlives its body.
     */
    heldDocKeys(): readonly string[];
    /**
     * Relay a local presence frame to the arm's presence mechanism, under the
     * main-side `Awareness.clientID` it speaks for.
     */
    applyAwareness(
      docKey: string,
      frame: Uint8Array,
      localClientId: number,
    ): void;
    /** Hand a local edit to the body lane. The lane's verdict is the answer. */
    sendUpdate(input: {
      readonly docKey: string;
      readonly update: Uint8Array;
    }): Promise<SendOutcome>;
  };
  /**
   * The replica's metadata mutations and its optimistic overlay.
   *
   * Synchronous here: the replica answers synchronously and the overlay is the
   * projector's fold input, so an async port would put a tick between a stamp
   * and the publish that folds it.
   */
  readonly mutations: {
    apply(mutation: EpicMutation): EpicMutationResult;
  };
  /** The fire-and-forget commands, applied in arrival order. */
  readonly commands: {
    apply(command: RuntimeCommand): void;
    /** The queue mints the id and decides the refusal; both come back. */
    enqueueWrite(intent: unknown): EnqueuedWriteCommand;
  };
  /**
   * Let go of every hold this core has on a body: each resident body's doc and
   * presence observers, and the demand retained for each AWAITING one.
   *
   * The third corner of the body lifetime, and the one that gets forgotten: a
   * worker tearing down with observers attached is the same shape as a pending
   * await left parked, so it is closed in the same place and for the same
   * reason.
   *
   * Named for the holds rather than for the observers because the two sets are
   * not the same: an awaiting body deliberately has NO observer, so a member
   * called `detachAllBodyObservers` would have been honest about what it did
   * and wrong about what this corner has to cover.
   */
  releaseAllBodyHolds(): void;
  /** The root replica's state, in and out, for session-to-session transfers. */
  readonly root: {
    encode(): Promise<Uint8Array>;
    apply(update: Uint8Array, asLocalEdit: boolean): Promise<boolean>;
  };
  /** The one durable transport this session owns (T12's ruling, worker-side). */
  readonly transport: { close(): void };
  /** The per-window indexed store. */
  readonly durableStore: { close(): void };
}

export function createEpicRuntimeWorkerCore(
  ports: EpicRuntimeCorePorts,
): EpicRuntimeWorkerCore {
  let serving = true;
  const settledDemotes = new Map<string, SettledDemote>();
  /**
   * This doc's lifetime, counted here rather than taken from main.
   *
   * Bumped by `materializeBody`, which is the only thing that starts a new
   * lifetime. A settle that began before the bump belongs to the lifetime that
   * ended, so its record is dropped rather than written - see
   * {@link SettledDemote} for why generation alone cannot decide that.
   */
  const bodyEpochs = new Map<string, number>();
  /**
   * The per-`docKey` demote chain: at most one settle in flight per doc.
   *
   * Two concurrent settles for one doc is the corruption {@link SettledDemote}
   * describes, and serializing them is what makes the record's ordering match
   * the main thread's posting order. The value is a tail that NEVER rejects, so
   * one failed settle cannot poison the doc's queue.
   */
  const demoteTails = new Map<string, Promise<undefined>>();
  /**
   * In-flight demotes, keyed by doc AND generation.
   *
   * The idempotence contract extended to the in-flight window.
   * `resendUnacknowledgedDemotes` re-posts the SAME generation precisely when
   * main does not know whether the first post was seen - and "not seen yet" and
   * "seen and still settling" are indistinguishable from over there. A resend
   * that arrives while its twin is running JOINS it, so the tier is asked once
   * and both callers get the same answer. Without this the resend queues behind
   * its twin and settles a second time, which is the double-release the settled
   * map exists to prevent, just moved earlier in time.
   *
   * Keyed by generation as well as doc because serialization means several
   * generations can be queued at once, and a resend must be able to find its
   * own twin rather than only the newest.
   */
  const demotesInFlight = new Map<string, Promise<DemoteAnswer>>();

  function epochOf(docKey: string): number {
    return bodyEpochs.get(docKey) ?? 0;
  }

  /**
   * Write the settled record, unless this doc's lifetime ended while the settle
   * was in flight.
   *
   * That is the ONE staleness this has to judge, and the reason is the chaining
   * above rather than anything here: serialized settles complete in the order
   * main posted them, so within a lifetime the newest completion is also the
   * last write and no "older loses" comparison has anything to do. One was
   * written and then removed - ablating it changed no test, because
   * serialization makes it unreachable, and an unreachable guard reads as a
   * defence that is really scaffolding.
   *
   * Across lifetimes the ordering argument does NOT hold: `materializeBody`
   * bumps the epoch while a settle from the previous lifetime is still out, and
   * that completion would otherwise write a record the new lifetime's
   * generations all lose to. See {@link SettledDemote}.
   */
  function recordSettledDemote(
    input: DemoteInput,
    epochAtStart: number,
    answer: DemoteAnswer,
  ): void {
    if (epochOf(input.docKey) !== epochAtStart) return;
    settledDemotes.set(input.docKey, {
      generation: input.generation,
      answer,
    });
  }

  async function settleOneDemote(input: DemoteInput): Promise<DemoteAnswer> {
    // Re-checked at the FRONT of the queue, not only on arrival: this call may
    // have waited behind another settle for the same doc, and disposal can land
    // in that window.
    if (!serving) {
      return { accepted: false, settledBytes: 0, reason: "not-held" };
    }

    // Idempotence lives HERE and not on the main thread's generation guard,
    // because `resendUnacknowledgedDemotes` deliberately re-posts the SAME
    // generation - the resend exists precisely for the case where the main
    // thread does not know whether the first post was seen. Releasing on both
    // copies would decrement body demand twice and unsubscribe a body that is
    // still open on the other side.
    const epochAtStart = epochOf(input.docKey);
    const settled = settledDemotes.get(input.docKey);
    // No lifetime check needed on the READ: `materializeBody` deletes the
    // record when a lifetime ends and `recordSettledDemote` declines to write
    // one after it, so anything found here belongs to the current lifetime.
    // A second, read-side check was written and removed - it could not be
    // ablated to red, because the write side already holds the invariant.
    if (settled !== undefined) {
      // The resend case: answer with what the first copy settled, and do not
      // touch demand again.
      if (settled.generation === input.generation) return settled.answer;
      // Older than what has settled - it belongs to a lifetime the main
      // thread has already moved past. Its own guard drops this answer, but
      // this side must not RELEASE on it, which is why it never reaches the
      // port.
      if (input.generation < settled.generation) {
        return { accepted: false, settledBytes: 0, reason: "newer-generation" };
      }
    }

    const answer = await ports.bodies.settle(input);
    recordSettledDemote(input, epochAtStart, answer);
    return answer;
  }

  return {
    async readAttachmentBytes(hash): Promise<Uint8Array | null> {
      // Every read is gated on `serving` rather than only the first: disposal
      // can land between a call arriving and its await resuming, and a replica
      // read after close is the failure that presents as a bewildering error
      // inside teardown rather than as "this is shutting down".
      if (!serving) return null;
      return ports.attachments.read(hash);
    },
    async materializeBody(
      artifactId,
    ): Promise<ArtifactBodyMaterialization | null> {
      if (!serving) return null;
      const materialized = await ports.bodies.materialize(artifactId);
      // A new lifetime for this doc starts a new generation sequence, so the
      // previous lifetime's settled answer must not shadow it. The epoch bump
      // is the same statement made durably: it also invalidates any settle
      // still in flight from the lifetime that just ended, which the delete
      // alone cannot do because that settle writes its record AFTER this runs.
      if (materialized !== null) {
        settledDemotes.delete(materialized.docKey);
        bodyEpochs.set(materialized.docKey, epochOf(materialized.docKey) + 1);
      }
      return materialized;
    },
    demoteBody(input) {
      // Refuse rather than accept-and-lose. The main thread keeps the live doc
      // on a refusal, so a demote that arrives during teardown costs a
      // re-send after respawn; one accepted here and never written costs the
      // edit.
      if (!serving) {
        return Promise.resolve({
          accepted: false,
          settledBytes: 0,
          reason: "not-held" as const,
        });
      }

      // A resend whose twin is still in flight gets the TWIN, not a second
      // settle - see `demotesInFlight`.
      const inFlightKey = `${input.docKey}\u0000${String(input.generation)}`;
      const twin = demotesInFlight.get(inFlightKey);
      if (twin !== undefined) return twin;

      // Chained behind this doc's previous demote, so two generations can never
      // be settling at once. The tail never rejects, so a failed settle does
      // not strand every later demote for the doc.
      const previous = demoteTails.get(input.docKey);
      const answer =
        previous === undefined
          ? settleOneDemote(input)
          : previous.then(() => settleOneDemote(input));
      const tail = answer.then(
        () => undefined,
        () => undefined,
      );
      demotesInFlight.set(inFlightKey, answer);
      demoteTails.set(input.docKey, tail);
      void tail.then(() => {
        demotesInFlight.delete(inFlightKey);
        // Only if nothing has queued behind this one, or the next demote for
        // this doc would start a second chain and lose the serialization.
        if (demoteTails.get(input.docKey) === tail) {
          demoteTails.delete(input.docKey);
        }
      });
      return answer;
    },
    applyMutation(mutation) {
      // Gated on `serving` like every other member, and the no-core answers
      // are the host's - this arm exists for the window between `dispose()`
      // and the host noticing, where a mutation must not reach a replica that
      // is tearing down. The port is synchronous by design (the overlay is the
      // projector's fold input); `Promise.resolve` is the lift to the shape
      // the host awaits, not a deferral.
      if (!serving) return Promise.resolve(inertMutationResult(mutation));
      return Promise.resolve(ports.mutations.apply(mutation));
    },
    awaitAttachmentBytes(awaitId, hash) {
      if (!serving) return Promise.resolve(null);
      return ports.attachments.await(awaitId, hash);
    },
    cancelAttachmentAwait(awaitId) {
      return ports.attachments.cancel(awaitId);
    },
    encodeRootState() {
      // Empty rather than a throw while shutting down: the caller is a
      // transfer, and its `applied` check is what decides whether the source
      // may be retired.
      if (!serving) return Promise.resolve(new Uint8Array());
      return ports.root.encode();
    },
    applyRootUpdate(update, asLocalEdit) {
      if (!serving) return Promise.resolve(false);
      return ports.root.apply(update, asLocalEdit);
    },
    enqueueWriteCommand(intent) {
      // Refused while shutting down, for the same reason a demote is: the
      // caller must not be handed an id for work this replica will not do.
      if (!serving) return Promise.resolve({ outcome: "refused" as const });
      return Promise.resolve(ports.commands.enqueueWrite(intent));
    },
    applyBodyAwareness(docKey, frame, localClientId): void {
      if (!serving) return;
      ports.bodies.applyAwareness(docKey, frame, localClientId);
    },
    releaseBody(docKey): {
      readonly released: boolean;
      readonly reason: "not-held" | "newer-generation" | "pinned" | null;
    } {
      // Dropped after teardown like every other member: `dispose` already
      // released every hold, so a release arriving afterwards has nothing to
      // do and must not resurrect bookkeeping the shutdown just finished.
      // `not-held` is the honest answer - there is no hold here any more.
      if (!serving) return { released: false, reason: "not-held" };
      return ports.bodies.release(docKey);
    },
    heldBodyDocKeysForTests(): readonly string[] {
      return ports.bodies.heldDocKeys();
    },
    applyCommand(command): void {
      // Dropped after teardown like every other member. A command applied to a
      // replica that is closing would race the durable store's close, and the
      // command's own effect is a projection nobody is listening for.
      if (!serving) return;
      ports.commands.apply(command);
    },
    async updateBody(input) {
      if (!serving) {
        return {
          outcome: {
            kind: "dropped",
            reason: "runtime worker is shutting down",
          },
        };
      }
      return { outcome: await ports.bodies.sendUpdate(input) };
    },
    dispose(): void {
      if (!serving) return;
      serving = false;
      settledDemotes.clear();
      // The demote bookkeeping goes with it. `settleOneDemote` re-checks
      // `serving` at the front of the queue, so anything still chained answers
      // "not-held" and main keeps its doc - the refusal that costs a resend
      // rather than an edit.
      bodyEpochs.clear();
      demoteTails.clear();
      demotesInFlight.clear();
      // BEFORE the transport closes. A pending wait settles `null` rather than
      // outliving the runtime it was waiting on - a caller parked on a
      // disposed replica is the failure this pair was built to prevent, and
      // teardown is the easiest way to reintroduce it.
      ports.attachments.cancelAll();
      ports.releaseAllBodyHolds();
      ports.transport.close();
      ports.durableStore.close();
    },
  };
}

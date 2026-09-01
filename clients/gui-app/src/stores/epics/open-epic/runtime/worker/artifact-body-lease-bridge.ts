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
import { BridgeDisposedError } from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
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

/**
 * THREE outcomes, and the middle one is not a weaker `unavailable`.
 *
 * `"awaiting-seed"` deliberately echoes `LeaseGrant`'s member of the same name
 * in the runtime, because it is the same fact one layer out: the demand is
 * held and it is the demand that makes the seed arrive. That member existed
 * before the relocation and the bridge's two-outcome answer is what lost it -
 * on the lane arm the lease IS the subscribe, so "no bytes yet" was answered by
 * releasing, which closed the subscription that would have produced them.
 *
 * A holder must release an `"awaiting-seed"` grant exactly as it releases a
 * `"granted"` one. That is why both carry `docKey` and `release` and why a
 * consumer should discriminate on `"unavailable"` rather than on `"granted"`:
 * the question a holder is asking is "do I owe a release", and two of the three
 * answers are yes.
 */
export type ArtifactBodyGrant =
  | { readonly kind: "granted"; readonly docKey: string; release(): void }
  | { readonly kind: "awaiting-seed"; readonly docKey: string; release(): void }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface ArtifactBodyLeaseBridge {
  acquire(artifactId: string): Promise<ArtifactBodyGrant>;
  /**
   * Re-materialize every awaiting body whose room the projection now calls
   * ready.
   *
   * The completion half of `"awaiting-seed"`. It is a RE-CALL rather than a
   * pushed seed, and that was the ruling: `body/doc-in` carries bytes only, so
   * installing from a push would have to invent `docGuid` / `seedMode` /
   * `hostStateVector` or add them to the wire - and a body installed with
   * `docGuid: null` on the lane arm is forward-only, which is un-demotable.
   * The second `body/materialize` answers with the full identity.
   *
   * The readiness predicate is the CALLER's, over doc keys, because the
   * projection is main's and there must be one reader of it - the same reason
   * `dropBodiesWhoseRoomIsGone` computes its ready set in the store and this
   * module never touches a slice.
   */
  retryAwaitingBodies(isReadyDocKey: (docKey: string) => boolean): void;
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

/** One body waiting for its first bytes. */
interface AwaitingBody {
  /**
   * The artifact the retry re-materializes.
   *
   * Held rather than derived from the doc key: the two are equal on the lane
   * arm and NOT on `@1`, where the key is a room id - and `@1` never awaits, so
   * a reader could "simplify" this away and be right in every case it tested.
   */
  readonly artifactId: string;
  leases: number;
  /** A retry is in flight; a second projection push must not start another. */
  retrying: boolean;
  /**
   * A projection push asked for a retry while one was already in flight.
   *
   * A LATCH rather than a dropped signal, and it is load-bearing on the
   * ordinary cold open. `artifact-lane-adapter.ts` emits `doc-ready` on the
   * transition into ready and THEN `doc-snapshot` with the bytes, so the
   * room reads `ready` one frame before the tier holds anything. The first
   * retry therefore fires on the ready edge and legitimately finds nothing;
   * the push that carries the seed arrives while it is still in flight.
   * Without this latch that push is swallowed by `retrying` and the body waits
   * for a projection that never comes again.
   */
  retryRequested: boolean;
}

/**
 * What one `body/materialize` settled to, BEFORE any grant is minted from it.
 *
 * The hold it describes has already been taken, for every holder that coalesced
 * onto it. What is deliberately NOT in here is a release closure: the answer is
 * shared by N holders and each of them owes its own idempotent release, so the
 * closures are minted per holder by `grantFor` rather than carried once here.
 * A single shared release would let the first unmount cancel the hold for all
 * of them, which is finding 11 wearing a different hat.
 */
type InFlightOutcome =
  | { readonly kind: "unavailable"; readonly reason: string }
  /** Installed and live on this side. */
  | { readonly kind: "resident"; readonly docKey: string }
  /** Demand retained worker-side, bytes still to come. */
  | { readonly kind: "awaiting"; readonly docKey: string };

/** One outstanding `body/materialize`, and everyone waiting on it. */
interface InFlightAcquire {
  /**
   * How many `acquire` callers are waiting on {@link answer}.
   *
   * Incremented SYNCHRONOUSLY as each one joins - the whole point of the
   * record. A holder counted only when its own answer resolves is invisible to
   * a release that lands first, and that under-count is finding 11.
   */
  holders: number;
  readonly answer: Promise<InFlightOutcome>;
}

/**
 * Whether a rejected bridge call is worth asking again.
 *
 * Every retry in this module re-arms on a rejection, because a rejection is
 * NOT a teardown - `serve()` turns a worker-handler fault into an error reply
 * and a malformed reply fails parsing, both on a worker that is still very much
 * alive. There is exactly one rejection that will never succeed on a retry, and
 * re-arming on it is an unbounded loop rather than a slow one: a disposed
 * bridge rejects every subsequent call IMMEDIATELY, so the retry fires, the
 * call rejects, and the handler arms the next one, for the life of the tab.
 *
 * It is reachable on the ordinary dispose path, not just in theory. `store.ts`
 * calls `flushLingering()` - which cancels every armed timer - and then
 * `runtime.dispose()`, which rejects the calls that flush just posted. Those
 * rejections land on a LATER microtask, so an unconditional re-arm re-populates
 * the very maps teardown had just emptied, and the closed epic's bridge state
 * is retained behind them.
 */
function worthAskingAgain(error: unknown): boolean {
  return !(error instanceof BridgeDisposedError);
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
  /**
   * A body the projection calls READY answered `body/materialize` with no bytes
   * again.
   *
   * Reported rather than swallowed, and this module takes it as a callback so
   * it stays free of the app logger - the same reason every other dependency
   * here is injected.
   *
   * The retry loop is bounded by projection pushes, so this cannot spin on its
   * own. But a body that keeps answering byteless while its room reads ready is
   * a genuine disagreement between the availability map and the tier, and the
   * failure it produces - a tile that never fills in - is exactly the kind that
   * gets reported as "sometimes the editor is empty" with nothing in any log.
   */
  readonly reportAwaitingStalled: (docKey: string, artifactId: string) => void;
}): ArtifactBodyLeaseBridge {
  const entries = new Map<string, BodyEntry>();
  /**
   * Bodies whose demand is held worker-side with no bytes yet, by doc key.
   *
   * REF-COUNTED like {@link BodyEntry.leases}, and for the same reason: several
   * tiles legitimately show one artifact, each takes its own awaiting grant,
   * and posting `body/release` on the first unmount would drop the one retained
   * demand out from under the others - which on the lane arm is the
   * subscription itself.
   *
   * Disjoint from {@link entries}: a doc key is awaiting or resident, never
   * both. The resolve path moves the count across in one step.
   */
  const awaiting = new Map<string, AwaitingBody>();
  /**
   * Materialize calls that have been issued and not yet settled, by ARTIFACT
   * id.
   *
   * Keyed by artifact rather than doc key because that is all an acquire knows:
   * the doc key is in the answer. An entry lives only for the duration of one
   * round trip - `resolveAcquire` clears it in the same step as the install.
   */
  const inFlight = new Map<string, InFlightAcquire>();
  /**
   * Where an awaiting body's doc key MOVED to, for release closures that were
   * handed the old one.
   *
   * Only the `@1` arm can populate this: there a doc key is the ROOM id read
   * off the records plane (`artifactBodyDocKey`), and the legacy root
   * projection can reassign an artifact to a different room while its initial
   * materialization is still awaiting a seed. On the lane arm the key IS the
   * artifact id, which cannot change.
   *
   * A closure, not a lookup, is what makes this necessary: `grantFor` hands
   * every holder a `release` captured over the key its acquire resolved, and a
   * string captured in a closure cannot be re-pointed. Without the redirect
   * the release decrements an entry that no longer exists and the worker keeps
   * the NEW room's demand, observer and subscription for the rest of the
   * session.
   */
  const movedAwaitingKeys = new Map<string, string>();
  /**
   * Timers re-driving a REFUSED awaiting release, one per doc key.
   *
   * There is no `BodyEntry` to hang this off: an awaiting body has no resident
   * entry, which is exactly why its release could not use `armLinger` and got
   * a fulfillment-only `.then` instead.
   */
  const awaitingReleaseRetries = new Map<string, RuntimeTimer>();
  let leaseSeq = 0;

  // EVERY `const` this factory closes over belongs in the block above, before
  // the `return`, and not beside the function that reads it. Function
  // declarations hoist and these do not, so a `const` declared after the
  // returned object literal is in its temporal dead zone for the entire life
  // of the bridge - the factory returns before the declaration ever runs. It
  // does not fail at construction; it throws a `ReferenceError` out of the
  // first release that consults it. The two maps above were written next to
  // their readers first, and that is how this was found.

  /**
   * Follow a key move, if this key was one. Identity for every other key.
   *
   * A CHAIN rather than one hop: a body can move, resolve, be released and
   * re-acquired, and move again, and a holder from before the first move still
   * owes a release. Bounded by the map's size, which is the number of moves
   * this session has seen - a simple path cannot be longer than the edge count
   * - so a cycle costs one wasted walk instead of hanging the tab. There is no
   * cycle to find: room ids are MINTED per assignment and never recycled, so
   * a key that has moved is never handed out again, which is also why a stale
   * redirect can never mis-point a closure created after the move.
   */
  function currentKeyFor(docKey: string): string {
    let key = docKey;
    for (let hop = 0; hop < movedAwaitingKeys.size; hop += 1) {
      const next = movedAwaitingKeys.get(key);
      if (next === undefined) return key;
      key = next;
    }
    return key;
  }

  /**
   * Move one awaiting body onto the key `body/materialize` just named, and
   * publish the redirect that lets already-issued closures follow it.
   *
   * Returns the entry the caller must go on using: usually the one passed in,
   * now filed under `nextKey`, but the one ALREADY awaiting there when two
   * artifacts' materializations converge on the same reassigned room. Merging
   * rather than overwriting for the same reason the granted path joins a raced
   * `BodyEntry`: both sets of holders are mounted and both owe a release, so a
   * lease count that replaced the other's would demote a doc someone holds.
   *
   * `retryRequested` merges as an OR. It is a signal that a projection push
   * arrived and has not been acted on, and dropping either side's would strand
   * whichever body was waiting on that push.
   */
  function adoptMovedAwaiting(
    previousKey: string,
    nextKey: string,
    held: AwaitingBody,
  ): AwaitingBody {
    // Already-issued `release` closures captured the old key as a STRING, so
    // they cannot be re-pointed; the redirect is how they still reach the
    // right entry.
    movedAwaitingKeys.set(previousKey, nextKey);
    awaiting.delete(previousKey);
    const existing = awaiting.get(nextKey);
    if (existing === undefined) {
      awaiting.set(nextKey, held);
      return held;
    }
    existing.leases += held.leases;
    existing.retryRequested = existing.retryRequested || held.retryRequested;
    return existing;
  }

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
      // CAPTURED, and compared for equality below - the demote path's fence,
      // which this one only looked like it had. `demotingGeneration` is set on
      // every release post and cleared on every ack, so a non-null test answers
      // "some release is in flight", not "THIS release is". Release, re-acquire
      // and release again before the first reply lands - consecutive hot-cap
      // evictions with a slow worker round trip will do it - and the first
      // reply finds the field repopulated by the SECOND lifecycle, passes, and
      // deletes an entry whose newer release may still be refused as pinned.
      // Dropping the doc there takes it out from under a bound editor, which is
      // the exact outcome the demote fence exists to prevent.
      const releaseGeneration = entry.generation;
      entry.demotingGeneration = releaseGeneration;
      void options.bridge.call("body/release", { docKey }, NO_TRANSFER).then(
        (answer) => {
          const current = entries.get(docKey);
          if (
            current === undefined ||
            current.demotingGeneration !== releaseGeneration
          ) {
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
        (error: unknown) => {
          // The doc stays live and the entry stays pending - a rejection is
          // never a settled ack, so dropping here would drop a body the worker
          // may still hold.
          //
          // But PENDING IS NOT PROGRESS, and the comment this replaces assumed
          // it was: "the worker went away" is only one of the ways this
          // rejects. `serve()` turns a worker-handler fault into an error
          // reply, and a malformed reply fails parsing - both surface as a
          // rejected call on a worker that is still very much alive, so no
          // respawn happens and `resendUnacknowledgedDemotes` never runs. The
          // entry would then sit with `demotingGeneration` set forever, which
          // `enforceHotCap` reads as "already on its way out": excluded from
          // the hot population it counts AND skipped as an eviction victim, so
          // the charge is held by a doc nothing will ever retry.
          //
          // Re-arming is the retry. It is safe for the died-mid-release case
          // too: the two mechanisms compose rather than compete - a respawn
          // resend re-posts the SAME generation while a linger expiry bumps to
          // a fresh one, and the generation fence makes whichever ack arrives
          // second a no-op.
          //
          // Except when the bridge itself is gone - see `worthAskingAgain`.
          // Dispose rejects this call AFTER `flushLingering` cancelled the
          // timers, so an unconditional re-arm re-populates what teardown just
          // emptied and then loops on a bridge that rejects instantly.
          if (!worthAskingAgain(error)) return;
          armLinger(docKey);
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
        (error: unknown) => {
          // The doc stays live and the entry stays pending. Every rejection is
          // treated alike for the DOC, because the one thing that must never
          // happen is dropping it without a settled ack - and a rejection is
          // never a settled ack. Only whether to RETRY is discriminated below.
          //
          // "The worker went away" is NOT the only way this rejects, which is
          // what the previous version of this comment assumed when it left the
          // recovery entirely to `resendUnacknowledgedDemotes`. That resend
          // runs after a worker REPLACEMENT; a handler fault comes back as an
          // error reply and a bad reply fails parsing, both on a live worker
          // that is never replaced. The entry then keeps `demotingGeneration`
          // set with nothing scheduled, and `enforceHotCap` treats that as
          // already-leaving - it is neither counted in the hot population nor
          // eligible as a victim - so the charge is held indefinitely.
          //
          // So arm the linger and let the retry come from there. See the
          // release arm above for why the two recovery paths compose.
          //
          // A rejection handler rather than a trailing `.catch`: a `.catch`
          // would also swallow a throw from the success arm above, where
          // `docs.drop` failing silently is a real doc leak.
          //
          // Same disposal guard as the release arm: a bridge that is gone
          // rejects instantly, so re-arming on it is a loop rather than a
          // retry.
          if (!worthAskingAgain(error)) return;
          armLinger(docKey);
        },
      );
  }

  /**
   * The round trip, run ONCE per outstanding acquire however many holders
   * coalesced onto it.
   *
   * It reads `inFlight`'s count at the moment the answer lands and installs
   * that many leases in one step, then clears the record - so the transfer
   * from "counted while in flight" to "counted on the entry" happens with no
   * suspension point between the read and the install, and a release landing
   * either side of it finds the count in exactly one place.
   *
   * Two edge cases, both decided here rather than left to a caller:
   *
   *   - EVERY HOLDER RELEASES WHILE THIS IS OUTSTANDING cannot happen, and it
   *     is worth saying why rather than guarding for it: a holder has no
   *     release closure until its own `acquire` promise resolves, and that
   *     resolution is this function returning. There is no window in which a
   *     holder both exists and can let go, so no zombie entry can be installed
   *     for holders that have all left.
   *   - A FAILED MATERIALIZE clears the record before rejecting, so every
   *     coalesced holder's promise rejects and the NEXT acquire starts a fresh
   *     call rather than awaiting a promise that will never resolve again.
   */
  async function resolveAcquire(artifactId: string): Promise<InFlightOutcome> {
    const answer = await options.bridge
      .call("body/materialize", { artifactId }, NO_TRANSFER)
      .catch((error: unknown) => {
        // Edge case (b). Clear FIRST, then rethrow: every coalesced holder is
        // awaiting this promise and all of them are about to see the
        // rejection, so leaving the record in place would make the next
        // acquire join a promise that has already failed and can never resolve
        // again.
        inFlight.delete(artifactId);
        throw error;
      });
    // The count, read at the moment the answer lands and consumed in the same
    // step. There is no `await` between here and the install below, so a
    // release cannot land halfway through the transfer and decrement a count
    // that is about to be replaced.
    //
    // The record is always there: the first statement of this function is an
    // `await`, which suspends unconditionally, so the caller's `inFlight.set`
    // has run by the time control reaches this line. The `1` is what a lone
    // uncounted holder would need if a future edit ever put a synchronous
    // return above that await - correct rather than clever, not a live case.
    const holders = inFlight.get(artifactId)?.holders ?? 1;
    inFlight.delete(artifactId);
    // THE DISCRIMINATOR, split. These two nulls used to be read as one
    // meaning and they are two:
    //
    //   `docKey === null`               NOT HELD  - no body for this artifact
    //                                              on the installed arm, and
    //                                              the worker released.
    //   `docKey` set, `update === null` AWAITING  - the worker RETAINED the
    //                                              demand and bytes will exist
    //                                              later.
    //
    // Collapsing them is the defect: on the lane arm the awaiting case is
    // every cold open, and answering `unavailable` there left the tile with no
    // release to hold and no reason to ask again.
    if (answer.docKey === null) {
      return { kind: "unavailable", reason: `no body for ${artifactId}` };
    }
    const docKey = answer.docKey;
    // An entry already under this doc key. Two ways to arrive here, and the
    // second is the one that matters:
    //
    //   - a concurrent acquire for the same artifact installed it while this
    //     call was in flight; or
    //   - the `@1` arm, where `docKey` is a ROOM id. `findByArtifact` is keyed
    //     by doc key, so a held legacy entry is not findable by artifact id at
    //     all, and EVERY legacy re-acquire lands here rather than on the fast
    //     path above.
    //
    // Both must revive a pending demote, which is why this shares one helper
    // with the fast path instead of only bumping the lease count. Skipping the
    // revive here leaves the earlier demote armed: its `accepted: true` passes
    // the generation guard, the entry is deleted, settled cold and dropped -
    // out from under the editor that just took the new grant.
    const raced = entries.get(docKey);
    if (raced !== undefined) {
      reviveAndHold(raced, holders);
      return { kind: "resident", docKey };
    }
    // AWAITING, checked after the raced-entry lookup on purpose: if this side
    // already holds a live doc under this key, that doc is the better answer
    // than a wait, and the worker dropped this call's lease rather than
    // retaining it (`hasBodyDemand` covers both of its maps).
    if (answer.update === null) {
      holdAwaiting(docKey, artifactId, holders);
      return { kind: "awaiting", docKey };
    }
    // A granted answer with no identity is FORWARD-ONLY, not unavailable.
    //
    // This branch used to refuse, reasoning that a body which cannot be
    // demoted would be "installed and stranded". That reasoning holds for the
    // lanes arm, where every body states an identity - and it makes the `@1`
    // arm unserviceable, because `@1` states none BY DESIGN and its bodies
    // were never settled back even before the relocation: `settleColdState`
    // already refuses without a recorded guid, so the demote path has always
    // been unreachable there.
    //
    // Stranded is therefore `@1`'s normal state, not a hazard this side
    // introduces. Refusing here would mean no `@1` body ever reaches an
    // editor, which is the whole arm going dark.
    installGranted({
      docKey,
      update: answer.update,
      docGuid: answer.docGuid,
      seedMode: answer.seedMode,
      hostStateVector: answer.hostStateVector,
      awarenessFrames: answer.awarenessFrames,
      leases: holders,
    });
    return { kind: "resident", docKey };
  }

  /**
   * Mint ONE holder's grant from a settled outcome.
   *
   * Separate from the hold itself because the two have different arities: the
   * hold is taken once for all `holders` that coalesced onto an answer, and a
   * grant is minted per holder - each with its own idempotent release, so N
   * holders own N releases against a count of N.
   */
  function grantFor(outcome: InFlightOutcome): ArtifactBodyGrant {
    if (outcome.kind === "unavailable") {
      return { kind: "unavailable", reason: outcome.reason };
    }
    if (outcome.kind === "awaiting") {
      return {
        kind: "awaiting-seed",
        docKey: outcome.docKey,
        release: releaseAwaitingFor(outcome.docKey),
      };
    }
    return {
      kind: "granted",
      docKey: outcome.docKey,
      release: releaseFor(outcome.docKey),
    };
  }

  return {
    async acquire(artifactId): Promise<ArtifactBodyGrant> {
      const existing = findByArtifact(entries, artifactId);
      if (existing !== null) {
        reviveAndHold(existing.entry, 1);
        return grantFor({ kind: "resident", docKey: existing.docKey });
      }
      // COALESCED, and counted SYNCHRONOUSLY. A second acquire arriving while
      // the first one's `body/materialize` is still outstanding joins it here
      // rather than issuing its own, and - the load-bearing half - it is
      // counted NOW, before any answer exists. Counting a holder only when its
      // own answer resolves is finding 11: four acquires were outstanding
      // together, the first answer installed a hold of one, and that holder's
      // release took the count to zero and posted `body/release` while three
      // holders were still waiting.
      const outstanding = inFlight.get(artifactId);
      if (outstanding !== undefined) {
        outstanding.holders += 1;
        return grantFor(await outstanding.answer);
      }
      const record: InFlightAcquire = {
        holders: 1,
        answer: resolveAcquire(artifactId),
      };
      inFlight.set(artifactId, record);
      return grantFor(await record.answer);
    },
    retryAwaitingBodies(isReadyDocKey): void {
      // A COPY of the keys: each iteration can resolve an entry and delete it,
      // and mutating the map mid-iteration is how a body gets skipped and left
      // waiting for a push that already happened.
      for (const [docKey, held] of [...awaiting]) {
        // The projection is the only completion signal, and asking it here is
        // what keeps this loop bounded: it runs once per delivered projection,
        // never on a timer, and does nothing at all for a body whose room is
        // still not ready.
        if (!isReadyDocKey(docKey)) continue;
        startAwaitingRetry(docKey, held);
      }
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
      // The hot charge is LOCAL and still has to come back. The doc-comment
      // argument for this method - "there is nothing on the far side to settle
      // bytes back INTO" - is about the WORKER: it justifies not posting a
      // demote that would be answered `not-held`. `budget` is main-side
      // accounting, so nothing about the worker's replicas being gone releases
      // the charge `chargeHot` took at installation. Skipping it left a
      // phantom holder for a body that no longer exists anywhere, which keeps
      // the plane over limit and evicts unrelated LIVE documents.
      //
      // Zero settled bytes, for the reason the acknowledged path states one
      // screen up: "No bytes came back, so nothing to record cold - only the
      // hot charge is released." That is exactly this situation, and the tier
      // is the one reporter of cold bytes either way.
      options.budget.settleCold(docKey, 0);
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
      // A pending awaiting-release retry is the same kind of bet as a linger,
      // and teardown loses it the same way: the worker is going, so a timer
      // that fires afterwards posts for a session that no longer exists.
      for (const timer of awaitingReleaseRetries.values()) timer.cancel();
      awaitingReleaseRetries.clear();
      // The redirects go with them. Every release closure they exist to
      // re-point belongs to a session that is being torn down, and this is
      // the only place the map is emptied - it is otherwise append-only, one
      // entry per key move, which is why it needs a floor at all.
      movedAwaitingKeys.clear();
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
  function reviveAndHold(entry: BodyEntry, holders: number): void {
    // THE point of the linger: a re-acquire inside the window costs nothing -
    // no materialize call, no round trip, no re-encode. The doc was never
    // released, so this is a reference count going back up.
    cancelLinger(entry);
    entry.lastHeldSeq = leaseSeq += 1;
    if (entry.demotingGeneration !== null) {
      entry.demotingGeneration = null;
      entry.generation += 1;
    }
    // `holders`, not 1: an answer can resolve for SEVERAL coalesced acquires at
    // once, and every one of them owes a release.
    entry.leases += holders;
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

  /**
   * Ask the worker once more for a body whose room now reads ready.
   *
   * At most ONE call in flight per doc key, with a latch for the pushes that
   * arrive while it is - see {@link AwaitingBody.retryRequested}. Coalescing
   * rather than dropping is what makes the ordinary cold open work: `ready`
   * arrives one frame ahead of the bytes, so the first attempt is expected to
   * find nothing and the push that carries the seed lands mid-flight.
   */
  function startAwaitingRetry(docKey: string, held: AwaitingBody): void {
    if (held.retrying) {
      held.retryRequested = true;
      return;
    }
    held.retrying = true;
    held.retryRequested = false;
    void options.bridge
      .call("body/materialize", { artifactId: held.artifactId }, NO_TRANSFER)
      .then(
        (answer) => {
          const stillAwaiting = awaiting.get(docKey);
          // Every holder released while this was in flight. The release already
          // posted `body/release`, so there is nothing to install INTO and
          // nothing to keep waiting for.
          if (stillAwaiting === undefined) return;
          stillAwaiting.retrying = false;
          // THE RETURNED KEY, not the captured one, and re-keyed BEFORE either
          // outcome is handled rather than only on the granted one. On the `@1`
          // arm a doc key is the ROOM id, and the legacy root projection can
          // reassign this artifact to a different room while its
          // materialization is awaiting a seed - so the answer can name a room
          // this retry did not ask about. Installing under the captured key
          // left `getArtifactFragment` reading the new key and finding nothing,
          // so the mounted editor stayed blank, while the worker kept the new
          // room's demand, observer and subscription alive behind an accounting
          // entry nothing would ever release.
          //
          // The reassignment does not wait for the new room to have bytes. A
          // non-null `docKey` beside `update: null` is the AWAITING answer, and
          // that answer's whole contract is that THE DEMAND IS RETAINED - under
          // the key it just named. Handling the move only where bytes arrived
          // left exactly the same leak on the byteless path: the entry stayed
          // under the old key with no redirect, readiness kept targeting the
          // old room, and the release posted `body/release` for a key the
          // worker no longer held anything under.
          const grantedKey = answer.docKey;
          const moved = grantedKey !== null && grantedKey !== docKey;
          const activeKey = moved ? grantedKey : docKey;
          // NOT named `held`: that is this function's own parameter, captured
          // when the retry was started, and this is the entry as it stands now
          // - re-read after the await and possibly merged into another by the
          // move above.
          const activeAwaiting = moved
            ? adoptMovedAwaiting(docKey, grantedKey, stillAwaiting)
            : stillAwaiting;
          if (grantedKey === null || answer.update === null) {
            if (activeAwaiting.retryRequested) {
              // A newer projection landed mid-flight, so this answer is already
              // stale - which is the ordinary seed sequence, not a fault. Ask
              // again on the state that push described, and say nothing.
              activeAwaiting.retryRequested = false;
              startAwaitingRetry(activeKey, activeAwaiting);
              return;
            }
            // STILL byteless, with the room reading ready and nothing newer to
            // go on. Stay awaiting - a later push tries again - but say so: this
            // is a disagreement between the availability map and the tier, and
            // the symptom it produces is a tile that never fills in.
            //
            // Named by the ACTIVE key. A move that just happened is reported
            // against the room the demand is actually on, and the later push
            // that resolves it drives a retry keyed there - whose granted arm
            // is where a room that turns out to be already resident is joined.
            options.reportAwaitingStalled(activeKey, activeAwaiting.artifactId);
            return;
          }
          awaiting.delete(activeKey);
          if (moved) {
            const raced = entries.get(activeKey);
            if (raced !== undefined) {
              // A concurrent acquire already materialized the new room. Its
              // entry is the live one - `installGranted` would overwrite its
              // lease count with ours - so these holders join it instead,
              // which is exactly what the acquire path's own raced-entry
              // branch does.
              reviveAndHold(raced, activeAwaiting.leases);
              return;
            }
          }
          // The awaiting count carries across whole. Every one of those holders
          // is still mounted and still owes a release; restarting at one would
          // let the first unmount demote a doc the others hold.
          installGranted({
            docKey: activeKey,
            update: answer.update,
            docGuid: answer.docGuid,
            seedMode: answer.seedMode,
            hostStateVector: answer.hostStateVector,
            awarenessFrames: answer.awarenessFrames,
            leases: activeAwaiting.leases,
          });
        },
        // The rejection arm, which this call was the only one in this module
        // without. The other three detached bridge calls here already take the
        // two-argument form; this one took a fulfillment-only `.then`, so a
        // worker-handler fault or a disposed bridge left `retrying` latched
        // TRUE forever. Every later ready/seed push then took the
        // `held.retrying` branch and set `retryRequested` for an in-flight call
        // that no longer existed, and the mounted artifact awaited for the life
        // of the session — a permanently blank tile from one transient failure.
        () => {
          const stillAwaiting = awaiting.get(docKey);
          if (stillAwaiting === undefined) return;
          // Unlatch FIRST, so the entry is retryable again whatever follows.
          stillAwaiting.retrying = false;
          if (stillAwaiting.retryRequested) {
            // A push landed mid-flight and is owed an attempt. Honouring it here
            // mirrors the fulfillment path, and it cannot spin: the re-drive
            // clears `retryRequested` on the way in, so a bridge that rejects
            // every time costs one extra call per push rather than a loop.
            stillAwaiting.retryRequested = false;
            startAwaitingRetry(docKey, stillAwaiting);
            return;
          }
          // No push is owed, so nothing here will ask again. Report it for the
          // same reason the byteless-answer branch above does: the symptom is a
          // tile that never fills in, and silence is what made that unexplainable.
          options.reportAwaitingStalled(docKey, held.artifactId);
        },
      );
  }

  /**
   * Take (or add to) an awaiting hold.
   *
   * The worker retains exactly ONE demand per doc key however many times it is
   * asked, so this side ref-counts the holders and posts one `body/release`
   * when the last of them goes.
   */
  function holdAwaiting(
    docKey: string,
    artifactId: string,
    holders: number,
  ): void {
    const held = awaiting.get(docKey);
    if (held === undefined) {
      awaiting.set(docKey, {
        artifactId,
        // `holders`, not 1. Every acquire that coalesced onto this one answer
        // is a holder that owes a release, and starting at 1 is precisely the
        // finding-11 under-count: the first release then took the entry to
        // zero and posted `body/release`, dropping the worker's single demand -
        // and on the lane arm that demand IS the subscription - while the other
        // holders were still waiting to be told they had one.
        leases: holders,
        retrying: false,
        retryRequested: false,
      });
    } else {
      held.leases += holders;
    }
  }

  /**
   * Install a materialized body and record it as resident.
   *
   * Shared by the first `acquire` and by the retry that resolves an awaiting
   * hold, because they differ only in the lease count they start at. Written as
   * one function rather than two similar blocks: the pair that drifted here
   * before was the revive, and the cost of that drift was a document dropped
   * under a live grant.
   */
  function installGranted(input: {
    readonly docKey: string;
    readonly update: Uint8Array;
    readonly docGuid: string | null;
    readonly seedMode: ArtifactBodySeedMode;
    readonly hostStateVector: string | null;
    readonly awarenessFrames: readonly Uint8Array[];
    readonly leases: number;
  }): void {
    options.docs.install({
      docKey: input.docKey,
      update: input.update,
      docGuid: input.docGuid,
      seedMode: input.seedMode,
      hostStateVector: input.hostStateVector,
    });
    // Presence, in the same step as the install and never before it. These
    // frames rode the response precisely because a push could not: the worker
    // attaches its observer inside the materialize handler, so a pushed frame
    // would arrive for a docKey main had not installed yet and be dropped.
    // Without this a re-materialized room shows an empty presence channel until
    // each peer's next heartbeat.
    for (const frame of input.awarenessFrames) {
      options.docs.applyRemoteAwareness(input.docKey, frame);
    }
    entries.set(input.docKey, {
      leases: input.leases,
      generation: 1,
      docGuid: input.docGuid,
      demotingGeneration: null,
      lingerTimer: null,
      lastHeldSeq: (leaseSeq += 1),
    });
    options.budget.chargeHot(input.docKey, input.update.byteLength);
    // AFTER the new doc is installed and charged, so the entry that just
    // arrived is part of the population being measured - and it is leased, so
    // it can never be its own victim.
    enforceHotCap();
  }

  /**
   * The awaiting holder's release.
   *
   * Idempotent per grant for the same reason {@link releaseFor} is, and it has
   * to reach the worker: the retained demand is the SUBSCRIPTION on the lane
   * arm, so a tile that unmounts while still waiting must post the release or
   * the tab stays subscribed to a body nobody is looking at.
   *
   * It also has to survive the resolve: a holder that took an awaiting grant
   * and released after the retry installed the doc is releasing a lease the
   * resident entry now counts, so this falls through to that entry rather than
   * finding nothing and returning.
   */
  function releaseAwaitingFor(capturedKey: string): () => void {
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const docKey = currentKeyFor(capturedKey);
      const held = awaiting.get(docKey);
      if (held === undefined) {
        // Resolved while this holder was mounted - its lease was carried into
        // the resident entry, so that is where the decrement belongs.
        releaseFor(docKey)();
        return;
      }
      held.leases -= 1;
      if (held.leases > 0) return;
      awaiting.delete(docKey);
      postAwaitingRelease(docKey);
    };
  }

  /**
   * Post an awaiting body's release, and keep asking if the worker refuses.
   *
   * The refusal is real rather than defensive: the last awaiting holder can
   * unmount AFTER the worker has materialized the room into a PINNED state - a
   * collaborator being present is enough - and `body/release` then honestly
   * answers `{ released: false, reason: "pinned" }`. Reading that as done left
   * the worker holding the body demand, its observer and its subscription for
   * the rest of the session, for a body no tile is using and nothing would ask
   * about again.
   *
   * The resident path already had this shape - a refused release re-arms the
   * linger and looks again next window - so this is that same answer on the
   * one arm that was missing it, not a new policy.
   */
  function postAwaitingRelease(docKey: string): void {
    void options.bridge.call("body/release", { docKey }, NO_TRANSFER).then(
      (answer) => {
        if (answer.released) return;
        // `not-held` is TERMINAL and the only refusal that is. It says the far
        // side has no hold to drop - a respawned worker starts with none, and
        // an epoch advance leaves `core === null`, which answers exactly this
        // - so the demand this retry exists to reclaim is already gone.
        // Re-arming on it would be a 60-second spin for the life of the
        // session, which is the failure this retry was added to prevent,
        // pointed the other way.
        if (answer.reason === "not-held") return;
        armAwaitingReleaseRetry(docKey);
      },
      (error: unknown) => {
        // A REJECTION IS NOT A TEARDOWN, and reading it as one is the mistake
        // `postDemote`'s rejection arm already recorded one screen up: "the
        // worker went away" is only one of the ways this rejects. `serve()`
        // turns a worker-handler fault into an error reply and a malformed
        // reply fails parsing, and both surface as a rejected call on a worker
        // that is still very much alive - so no respawn happens, and this side
        // is the only thing that will ever ask again.
        //
        // The first version of this arm swallowed, on the reasoning that
        // nothing here holds a doc so nothing can be stranded. That answered
        // the wrong half: bytes are not what an awaiting release reclaims. The
        // WORKER's body demand, its observer and its room subscription are,
        // and those are held on the far side whatever this side is holding.
        //
        // One rejection is still terminal, and it is the one this round's
        // fix made reachable: a DISPOSED bridge rejects every call
        // immediately, so re-arming on it spins for the life of the tab
        // while retaining the closed epic's state. See `worthAskingAgain`.
        if (!worthAskingAgain(error)) return;
        armAwaitingReleaseRetry(docKey);
      },
    );
  }

  function armAwaitingReleaseRetry(docKey: string): void {
    if (awaitingReleaseRetries.has(docKey)) return;
    awaitingReleaseRetries.set(
      docKey,
      options.scheduler.schedule(options.lingerMs, () => {
        awaitingReleaseRetries.delete(docKey);
        // Through the redirect, for the same reason a `release` closure is: a
        // key captured when this timer was armed can be moved before it fires,
        // and the demand the retry exists to reclaim is on the new room. Read
        // literally, the guard below would find the old key empty - because the
        // move emptied it - and post a release for a key the worker holds
        // nothing under, while the new room stayed retained.
        const current = currentKeyFor(docKey);
        // Re-read rather than closing over a decision: a holder can have
        // re-acquired inside the window, and then the demand is legitimately
        // held again and its own release will post when it unmounts. Posting
        // here would drop a body someone is using.
        if (awaiting.has(current) || entries.has(current)) return;
        postAwaitingRelease(current);
      }),
    );
  }

  function releaseFor(capturedKey: string): () => void {
    let live = true;
    return () => {
      // Idempotent per grant. Without this a caller's `finally` backstop
      // running after its own early release would decrement a second time and
      // demote a document another holder is still using.
      if (!live) return;
      live = false;
      // Follows a key move for the same reason the awaiting release does: a
      // holder that took its grant while the body was awaiting is handed
      // `releaseFor` through `releaseAwaitingFor`'s resolved arm, so this key
      // can be the pre-move one too.
      const docKey = currentKeyFor(capturedKey);
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

/**
 * The main-thread half of the artifact-body lease, once the cold tier lives in the worker. The
 * shape is forced by one hard constraint and one ruling.
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

/** The live main-thread documents, as this module addresses them. */
export interface MainThreadBodyDocs {
  install(input: {
    readonly docKey: string;
    readonly update: Uint8Array;
    /** The identity these bytes were cut at. */
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
  /** A remote presence frame for a body this side holds. */
  applyRemoteAwareness(docKey: string, frame: Uint8Array): void;
}

/** What the byte accountant is told, and when. The ordering is the contract, not the call list. */
export interface HotBodyBudget {
  /** A body doc just became resident. `bytes` is its ENCODED size. */
  chargeHot(docKey: string, bytes: number): void;
  /**
   * The worker settled this doc's bytes cold. ONE call, not separable: the hot charge is released
   * and the cold figure is the worker's own.
   */
  settleCold(docKey: string, settledBytes: number): void;
}

/** THREE outcomes, and the middle one is not a weaker `unavailable`. */
export type ArtifactBodyGrant =
  | { readonly kind: "granted"; readonly docKey: string; release(): void }
  | { readonly kind: "awaiting-seed"; readonly docKey: string; release(): void }
  | { readonly kind: "unavailable"; readonly reason: string };

/** What a holder's LAST release should do with the body. */
export type ArtifactBodyRetention = "linger" | "immediate";

export interface ArtifactBodyLeaseBridge {
  acquire(
    artifactId: string,
    retention: ArtifactBodyRetention,
  ): Promise<ArtifactBodyGrant>;
  /**
   * Re-materialize every awaiting body whose room the projection now calls ready. The completion
   * half of `"awaiting-seed"`.
   */
  retryAwaitingBodies(isReadyDocKey: (docKey: string) => boolean): void;
  /** Re-post every demote that was posted but never acknowledged. Called after a worker respawn. */
  resendUnacknowledgedDemotes(): void;
  /** Doc keys posted for demotion and not yet settled. A test seam. */
  unacknowledgedDemoteKeys(): readonly string[];
  /** Forget every entry WITHOUT posting anything. */
  forget(docKey: string): void;
  /** Post every LINGERING doc's demote/release now, without waiting. For teardown. */
  flushLingering(): void;
}

interface BodyEntry {
  leases: number;
  /** What this doc was materialized at; sent back on every demote. */
  docGuid: string | null;
  /** Bumped on every demote post AND on every re-acquire. */
  generation: number;
  demotingGeneration: number | null;
  /**
   * The LINGER: this doc's last lease is gone, but the doc is still live and will stay live until
   * this fires. The hot doc's linger lives HERE because the hot doc lives here.
   */
  lingerTimer: RuntimeTimer | null;
  /** A monotonic stamp of when this doc was last HELD, for the cap's eviction order. */
  lastHeldSeq: number;
}

/** One body waiting for its first bytes. */
interface AwaitingBody {
  /** The artifact the retry re-materializes. */
  readonly artifactId: string;
  leases: number;
  /** A retry is in flight; a second projection push must not start another. */
  retrying: boolean;
  /**
   * A projection push asked for a retry while one was already in flight. A LATCH rather than a
   * dropped signal, and it is load-bearing on the ordinary cold open.
   */
  retryRequested: boolean;
}

/**
 * What one `body/materialize` settled to, BEFORE any grant is minted from it. The hold it
 * describes has already been taken, for every holder that coalesced onto it.
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
   * How many `acquire` callers are waiting on {@link answer}. Incremented SYNCHRONOUSLY as each one
   * joins - the whole point of the record.
   */
  holders: number;
  readonly answer: Promise<InFlightOutcome>;
}

/** Whether a rejected bridge call is worth asking again. */
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
  /** How long a doc stays live after its last lease. */
  readonly lingerMs: number;
  /** The BACKSTOP ceiling on hot docs - not the reclaim mechanism, which is the linger. */
  readonly maxHotDocs: number;
  /** A body the projection calls READY answered `body/materialize` with no bytes again. */
  readonly reportAwaitingStalled: (docKey: string, artifactId: string) => void;
}): ArtifactBodyLeaseBridge {
  const entries = new Map<string, BodyEntry>();
  /** Bodies whose demand is held worker-side with no bytes yet, by doc key. */
  const awaiting = new Map<string, AwaitingBody>();
  /**
   * Materialize calls that have been issued and not yet settled, by ARTIFACT id. Keyed by artifact
   * rather than doc key because that is all an acquire knows: the doc key is in the answer.
   */
  const inFlight = new Map<string, InFlightAcquire>();
  /**
   * Only the `@1` arm can populate this: there a doc key is the ROOM id read off the records plane
   * (`artifactBodyDocKey`), and the legacy root projection can reassign an artifact to a different
   */
  const movedAwaitingKeys = new Map<string, string>();
  /** Timers re-driving a REFUSED awaiting release, one per doc key. */
  const awaitingReleaseRetries = new Map<string, RuntimeTimer>();
  /**
   * Pending re-posts of a VACATED key's worker release, keyed by that key. Separate from {@link
   * awaitingReleaseRetries} because the two retries answer different questions.
   */
  const vacatedReleaseRetries = new Map<string, RuntimeTimer>();
  let leaseSeq = 0;

  // EVERY `const` this factory closes over belongs in the block above, before the `return`, and not
  // beside the function that reads it.

  /** Follow a key move, if this key was one. Identity for every other key. */
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
   * Move one awaiting body onto the key `body/materialize` just named, and publish the redirect that
   * lets already-issued closures follow it.
   */
  function adoptMovedAwaiting(
    previousKey: string,
    nextKey: string,
    held: AwaitingBody,
  ): AwaitingBody {
    movedAwaitingKeys.set(previousKey, nextKey);
    awaiting.delete(previousKey);
    // `body/materialize` is sent by `artifactId`, so the retry made the worker re-resolve the room and
    // take a SECOND `awaitingDemand` entry under the new key; from this moment every release this side
    postVacatedRelease(previousKey);
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
    // FORWARD-ONLY bodies are never DEMOTED.
    if (entry === undefined) return;
    const docGuid = entry.docGuid;
    if (docGuid === null) {
      // A body has exactly one of the two lifecycles, decided by whether its seed stated an identity;
      // this is the other one, not a degenerate case of the demote above.
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
            // REFUSED - the tier still pins this room. Same answer as a refused demote: keep the doc, keep the
            // entry pending so a respawn resend covers it, and look again next window.
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
          // The doc stays live and the entry stays pending - a rejection is never a settled ack, so dropping
          // here would drop a body the worker may still hold.
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
          // A late ack for a lease that has since been re-acquired. The doc is live again under a newer
          // generation; dropping it here would take the document out from under a bound editor.
          if (entry === undefined || entry.demotingGeneration !== generation) {
            return;
          }
          // The worker declined this generation.
          if (!answer.accepted) {
            // REFUSED.
            armLinger(docKey);
            return;
          }
          entry.demotingGeneration = null;
          entries.delete(docKey);
          options.budget.settleCold(docKey, answer.settledBytes);
          options.docs.drop(docKey);
        },
        (error: unknown) => {
          // The doc stays live and the entry stays pending.
          if (!worthAskingAgain(error)) return;
          armLinger(docKey);
        },
      );
  }

  /** The round trip, run ONCE per outstanding acquire however many holders coalesced onto it. */
  async function resolveAcquire(artifactId: string): Promise<InFlightOutcome> {
    const answer = await options.bridge
      .call("body/materialize", { artifactId }, NO_TRANSFER)
      .catch((error: unknown) => {
        // Edge case (b).
        inFlight.delete(artifactId);
        throw error;
      });
    // The count, read at the moment the answer lands and consumed in the same step.
    const holders = inFlight.get(artifactId)?.holders ?? 1;
    inFlight.delete(artifactId);
    // THE DISCRIMINATOR, split.
    if (answer.docKey === null) {
      return { kind: "unavailable", reason: `no body for ${artifactId}` };
    }
    const docKey = answer.docKey;
    // An entry already under this doc key. Two ways to arrive here, and the second is the one that
    // matters:
    const raced = entries.get(docKey);
    if (raced !== undefined) {
      reviveAndHold(raced, holders);
      return { kind: "resident", docKey };
    }
    // AWAITING, checked after the raced-entry lookup on purpose: if this side already holds a live doc
    // under this key, that doc is the better answer than a wait, and the worker dropped this call's
    if (answer.update === null) {
      holdAwaiting(docKey, artifactId, holders);
      return { kind: "awaiting", docKey };
    }
    // A granted answer with no identity is FORWARD-ONLY, not unavailable.
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

  /** Mint ONE holder's grant from a settled outcome. */
  function grantFor(
    outcome: InFlightOutcome,
    retention: ArtifactBodyRetention,
  ): ArtifactBodyGrant {
    if (outcome.kind === "unavailable") {
      return { kind: "unavailable", reason: outcome.reason };
    }
    if (outcome.kind === "awaiting") {
      return {
        kind: "awaiting-seed",
        docKey: outcome.docKey,
        release: releaseAwaitingFor(outcome.docKey, retention),
      };
    }
    return {
      kind: "granted",
      docKey: outcome.docKey,
      release: releaseFor(outcome.docKey, retention),
    };
  }

  return {
    async acquire(artifactId, retention): Promise<ArtifactBodyGrant> {
      const existing = findByArtifact(entries, artifactId);
      if (existing !== null) {
        reviveAndHold(existing.entry, 1);
        return grantFor(
          { kind: "resident", docKey: existing.docKey },
          retention,
        );
      }
      // COALESCED, and counted SYNCHRONOUSLY.
      const outstanding = inFlight.get(artifactId);
      if (outstanding !== undefined) {
        outstanding.holders += 1;
        return grantFor(await outstanding.answer, retention);
      }
      const record: InFlightAcquire = {
        holders: 1,
        answer: resolveAcquire(artifactId),
      };
      inFlight.set(artifactId, record);
      return grantFor(await record.answer, retention);
    },
    retryAwaitingBodies(isReadyDocKey): void {
      // A COPY of the keys: each iteration can resolve an entry and delete it, and mutating the map
      // mid-iteration is how a body gets skipped and left waiting for a push that already happened.
      for (const [docKey, held] of [...awaiting]) {
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
      // The hot charge is LOCAL and still has to come back.
      options.budget.settleCold(docKey, 0);
    },
    flushLingering(): void {
      // Snapshot first: `postLifecycleEnd` mutates `entries` for the forward-only arm (it retires the
      // entry inline, having no ack to wait for), and mutating a Map mid-iteration skips entries.
      const lingering: [string, BodyEntry][] = [];
      for (const pair of entries) {
        if (pair[1].lingerTimer !== null) lingering.push(pair);
      }
      for (const [docKey, entry] of lingering) {
        cancelLinger(entry);
        postLifecycleEnd(docKey, entry);
      }
      // A pending awaiting-release retry is the same kind of bet as a linger, and teardown loses it the
      // same way: the worker is going, so a timer that fires afterwards posts for a session that no
      for (const timer of awaitingReleaseRetries.values()) timer.cancel();
      awaitingReleaseRetries.clear();
      // Same bet, same loss: a vacated key's re-post is for a session that is going away, and the worker
      // drops every retained demand on teardown regardless.
      for (const timer of vacatedReleaseRetries.values()) timer.cancel();
      vacatedReleaseRetries.clear();
      // The redirects go with them.
      movedAwaitingKeys.clear();
    },
  };

  /**
   * Take a hold on an entry that already exists, cancelling any demote that is still in flight for
   * it.
   */
  function reviveAndHold(entry: BodyEntry, holders: number): void {
    // THE point of the linger: a re-acquire inside the window costs nothing - no materialize call, no
    // round trip, no re-encode.
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

  /** End this doc's lifetime, whichever lifetime it has. */
  function postLifecycleEnd(docKey: string, entry: BodyEntry): void {
    entry.generation += 1;
    entry.demotingGeneration = entry.generation;
    postDemote(docKey, entry.generation);
  }

  /** Evict lingering docs until the hot population is back under the cap. */
  function enforceHotCap(): void {
    // Counted, NOT `entries.size`.
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
      // Nothing evictable: every remaining doc is leased or already on its way out. Stop rather than
      // spin - this loop's exit cannot depend on finding a victim it is allowed to take.
      if (victimKey === null || victim === null) return;
      cancelLinger(victim);
      postLifecycleEnd(victimKey, victim);
    }
  }

  function cancelLinger(entry: BodyEntry): void {
    entry.lingerTimer?.cancel();
    entry.lingerTimer = null;
  }

  /** Ask the worker once more for a body whose room now reads ready. */
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
          // Every holder released while this was in flight. The release already posted `body/release`, so
          // there is nothing to install INTO and nothing to keep waiting for.
          if (stillAwaiting === undefined) return;
          stillAwaiting.retrying = false;
          // THE RETURNED KEY, not the captured one, and re-keyed BEFORE either outcome is handled rather
          // than only on the granted one.
          const grantedKey = answer.docKey;
          const moved = grantedKey !== null && grantedKey !== docKey;
          const activeKey = moved ? grantedKey : docKey;
          // NOT named `held`: that is this function's own parameter, captured when the retry was started,
          // and this is the entry as it stands now
          const activeAwaiting = moved
            ? adoptMovedAwaiting(docKey, grantedKey, stillAwaiting)
            : stillAwaiting;
          if (grantedKey === null || answer.update === null) {
            if (activeAwaiting.retryRequested) {
              // A newer projection landed mid-flight, so this answer is already stale - which is the ordinary
              // seed sequence, not a fault. Ask again on the state that push described, and say nothing.
              activeAwaiting.retryRequested = false;
              startAwaitingRetry(activeKey, activeAwaiting);
              return;
            }
            // STILL byteless, with the room reading ready and nothing newer to go on.
            options.reportAwaitingStalled(activeKey, activeAwaiting.artifactId);
            return;
          }
          awaiting.delete(activeKey);
          if (moved) {
            const raced = entries.get(activeKey);
            if (raced !== undefined) {
              // A concurrent acquire already materialized the new room.
              reviveAndHold(raced, activeAwaiting.leases);
              return;
            }
          }
          // The awaiting count carries across whole. Every one of those holders is still mounted and still
          // owes a release; restarting at one would let the first unmount demote a doc the others hold.
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
        // The rejection arm, which this call was the only one in this module without.
        () => {
          const stillAwaiting = awaiting.get(docKey);
          if (stillAwaiting === undefined) return;
          // Unlatch FIRST, so the entry is retryable again whatever follows.
          stillAwaiting.retrying = false;
          if (stillAwaiting.retryRequested) {
            // A push landed mid-flight and is owed an attempt.
            stillAwaiting.retryRequested = false;
            startAwaitingRetry(docKey, stillAwaiting);
            return;
          }
          // No push is owed, so nothing here will ask again.
          options.reportAwaitingStalled(docKey, held.artifactId);
        },
      );
  }

  function holdAwaiting(
    docKey: string,
    artifactId: string,
    holders: number,
  ): void {
    const held = awaiting.get(docKey);
    if (held === undefined) {
      awaiting.set(docKey, {
        artifactId,
        // `holders`, not 1.
        leases: holders,
        retrying: false,
        retryRequested: false,
      });
    } else {
      held.leases += holders;
    }
  }

  /**
   * Install a materialized body and record it as resident. Shared by the first `acquire` and by the
   * retry that resolves an awaiting hold, because they differ only in the lease count they start at.
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
    // Presence, in the same step as the install and never before it.
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
    // AFTER the new doc is installed and charged, so the entry that just arrived is part of the
    // population being measured - and it is leased, so it can never be its own victim.
    enforceHotCap();
  }

  /** The awaiting holder's release. */
  function releaseAwaitingFor(
    capturedKey: string,
    retention: ArtifactBodyRetention,
  ): () => void {
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const docKey = currentKeyFor(capturedKey);
      const held = awaiting.get(docKey);
      if (held === undefined) {
        // Resolved while this holder was mounted - its lease was carried into
        // the resident entry, so that is where the decrement belongs.
        releaseFor(docKey, retention)();
        return;
      }
      held.leases -= 1;
      if (held.leases > 0) return;
      awaiting.delete(docKey);
      postAwaitingRelease(docKey);
    };
  }

  /** Post an awaiting body's release, and keep asking if the worker refuses. */
  function postAwaitingRelease(docKey: string): void {
    void options.bridge.call("body/release", { docKey }, NO_TRANSFER).then(
      (answer) => {
        if (answer.released) return;
        // `not-held` is TERMINAL and the only refusal that is.
        if (answer.reason === "not-held") return;
        armAwaitingReleaseRetry(docKey);
      },
      (error: unknown) => {
        // A REJECTION IS NOT A TEARDOWN, and reading it as one is the mistake `postDemote`'s rejection arm
        // already recorded one screen up: "the worker went away" is only one of the ways this rejects.
        if (!worthAskingAgain(error)) return;
        armAwaitingReleaseRetry(docKey);
      },
    );
  }

  /** Drop the worker's retained demand for a key an awaiting body has MOVED off. */
  function postVacatedRelease(vacatedKey: string): void {
    void options.bridge
      .call("body/release", { docKey: vacatedKey }, NO_TRANSFER)
      .then(
        (answer) => {
          if (answer.released) return;
          // Terminal for the same reason it is on the awaiting path: the far
          // side has nothing to drop, so there is nothing left to reclaim.
          if (answer.reason === "not-held") return;
          // Anything else - a room still pinned by a present collaborator - is a "not yet", and this is the
          // only caller that will ever ask again.
          armVacatedReleaseRetry(vacatedKey);
        },
        (error: unknown) => {
          if (!worthAskingAgain(error)) return;
          armVacatedReleaseRetry(vacatedKey);
        },
      );
  }

  function armVacatedReleaseRetry(vacatedKey: string): void {
    if (vacatedReleaseRetries.has(vacatedKey)) return;
    vacatedReleaseRetries.set(
      vacatedKey,
      options.scheduler.schedule(options.lingerMs, () => {
        vacatedReleaseRetries.delete(vacatedKey);
        // No redirect and no re-read of `awaiting`/`entries`, unlike the awaiting retry: this key is
        // vacated by construction and can never be re-acquired, so there is no later state that could make
        postVacatedRelease(vacatedKey);
      }),
    );
  }

  function armAwaitingReleaseRetry(docKey: string): void {
    if (awaitingReleaseRetries.has(docKey)) return;
    awaitingReleaseRetries.set(
      docKey,
      options.scheduler.schedule(options.lingerMs, () => {
        awaitingReleaseRetries.delete(docKey);
        // Through the redirect, for the same reason a `release` closure is: a key captured when this timer
        // was armed can be moved before it fires, and the demand the retry exists to reclaim is on the new
        const current = currentKeyFor(docKey);
        // Re-read rather than closing over a decision: a holder can have re-acquired inside the window,
        // and then the demand is legitimately held again and its own release will post when it unmounts.
        if (awaiting.has(current) || entries.has(current)) return;
        postAwaitingRelease(current);
      }),
    );
  }

  function releaseFor(
    capturedKey: string,
    retention: ArtifactBodyRetention,
  ): () => void {
    let live = true;
    return () => {
      // Idempotent per grant. Without this a caller's `finally` backstop running after its own early
      // release would decrement a second time and demote a document another holder is still using.
      if (!live) return;
      live = false;
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
      if (retention === "immediate") {
        // The same demote `enforceHotCap` and `flushLingering` post, taken now rather than after the
        // cooldown. Reached only on the LAST release, so nothing is holding this body.
        postLifecycleEnd(docKey, entry);
        return;
      }
      armLinger(docKey);
    };
  }

  /**
   * Start (or restart) one doc's linger window. Shared by the last-lease release and by a REFUSED
   * demote, because the two want exactly the same thing: hold the doc, and look again in a window.
   */
  function armLinger(docKey: string): void {
    const entry = entries.get(docKey);
    if (entry === undefined || entry.lingerTimer !== null) return;
    entry.lingerTimer = options.scheduler.schedule(options.lingerMs, () => {
      // Re-read rather than closing over `entry`: the window is long enough for the doc to have been
      // dropped entirely, and a timer that resolved against a stale object would post for a body that no
      const current = entries.get(docKey);
      if (current === undefined) return;
      current.lingerTimer = null;
      // A re-acquire inside the window cancels this timer, but a cancel that raced the fire still lands
      // here - so the lease count decides, not the fact that the timer ran.
      if (current.leases > 0) return;
      postLifecycleEnd(docKey, current);
    });
  }
}

function findByArtifact(
  entries: Map<string, BodyEntry>,
  artifactId: string,
): { readonly docKey: string; readonly entry: BodyEntry } | null {
  // The lane arm answers `docKey === artifactId`; the `@1` arm answers a room id, which this map is
  // keyed by.
  const direct = entries.get(artifactId);
  return direct === undefined ? null : { docKey: artifactId, entry: direct };
}

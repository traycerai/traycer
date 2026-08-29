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
    readonly docGuid: string;
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
}

interface BodyEntry {
  leases: number;
  /** What this doc was materialized at; sent back on every demote. */
  docGuid: string;
  /**
   * Bumped on every demote post AND on every re-acquire.
   *
   * One counter serving both is what makes a late ack recognisable: an ack
   * naming a generation that is no longer current belongs to a demote the
   * lease outlived, and the only correct response to it is to do nothing.
   */
  generation: number;
  demotingGeneration: number | null;
}

export function createArtifactBodyLeaseBridge(options: {
  readonly bridge: RuntimeWorkerPort;
  readonly docs: MainThreadBodyDocs;
  readonly budget: HotBodyBudget;
}): ArtifactBodyLeaseBridge {
  const entries = new Map<string, BodyEntry>();

  function postDemote(docKey: string, generation: number): void {
    const entry = entries.get(docKey);
    // No entry means nothing to demote - and no identity to demote it AT. The
    // guid is not optional on the wire, so this is the honest early return
    // rather than sending bytes the worker cannot decide about.
    if (entry === undefined) return;
    const encoded = takeBytesForTransfer(options.docs.encode(docKey));
    void options.bridge
      .call(
        "body/demote",
        {
          docKey,
          generation,
          docGuid: entry.docGuid,
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
          if (!answer.accepted) return;
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
      // A granted answer with no identity cannot be demoted later - the guid
      // is what a refusal is decided on - so it is treated as unavailable
      // rather than installed and stranded.
      if (answer.docGuid === null) {
        return { kind: "unavailable", reason: `no identity for ${artifactId}` };
      }
      options.docs.install({
        docKey,
        update: answer.update,
        docGuid: answer.docGuid,
        seedMode: answer.seedMode,
        hostStateVector: answer.hostStateVector,
      });
      entries.set(docKey, {
        leases: 1,
        generation: 1,
        docGuid: answer.docGuid,
        demotingGeneration: null,
      });
      options.budget.chargeHot(docKey, answer.update.byteLength);
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
    if (entry.demotingGeneration !== null) {
      entry.demotingGeneration = null;
      entry.generation += 1;
    }
    entry.leases += 1;
    return { kind: "granted", docKey, release: releaseFor(docKey) };
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
      entry.generation += 1;
      entry.demotingGeneration = entry.generation;
      postDemote(docKey, entry.generation);
    };
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

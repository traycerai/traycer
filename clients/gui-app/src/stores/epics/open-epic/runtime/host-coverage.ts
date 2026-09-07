/** What the host has actually sent this client, held as its own `Y.Doc`. */
import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicSubscribeClientSeedOffer } from "@traycer/protocol/host/epic/subscribe";
import { encodeDocStateVectorBase64 } from "./dirty-watermark";

export interface HostCoverage {
  /** Fold a host-originated root update into coverage. */
  applyUpdate(updateBytes: Uint8Array): void;
  /**
   * Fold this cycle's root payload in and record the room it came from. See the implementation note
   * for why a delta and a snapshot take different arms.
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
   * The room {@link doc}'s contents came from, or `null` when it holds nothing attributable to a
   * room - a fresh store, a replica reset, or state seeded by a pre-`@1.2` host that never reported
   */
  let roomId: string | null = null;
  /** Bumped every time {@link doc} is REPLACED (never when it is merged into). */
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
    // Whatever room the discarded doc represented, the replacement does not represent it: callers
    // either reset coverage to empty or rebase it onto a full snapshot whose room only `applyRootSeed`
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
     * THE SEAM THE `seededFromOffer` FLAG EXISTS FOR. A full snapshot is self-sufficient, so coverage
     * is rebuilt from it - that is what `replace` does and what every pre-`@1.3` cycle did.
     */
    applyRootSeed(meta: SnapshotMetaEpic, snapshotBytes: Uint8Array): void {
      if (meta.seededFromOffer !== true) {
        replace(snapshotBytes);
        roomId = meta.roomId ?? null;
        offeredGeneration = null;
        return;
      }
      // A delta, so it is only meaningful against the doc whose state vector was offered.
      if (offeredGeneration !== generation) {
        offeredGeneration = null;
        return;
      }
      Y.applyUpdate(doc, snapshotBytes);
      roomId = meta.roomId ?? null;
      offeredGeneration = null;
    },

    /**
     * The reattach offer: what this client has already received from the host, so the host can answer
     * a resubscribe with only what changed.
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

/**
 * `MainThreadBodyDocs` backed by the artifact-room tier.
 *
 * **THE DEGENERACY, named because it is invisible from either side.** In-process
 * the lease bridge round-trips through ONE object: the port materializes from
 * the tier that this adapter is backed by, so a body's bytes leave the tier
 * through `encodeColdState` and come back into the same tier through
 * `install`. What 4c therefore exercises is the LIFECYCLE - the ref-count, the
 * generation guard, the acknowledged demote, the release-before-settle
 * ordering - and NOT the hot/cold split, because in-process there is no split
 * to exercise.
 *
 * The real split lands at the flip: the tier becomes cold-only and a main-side
 * store holds the hot docs. That is a body-OWNERSHIP change and it touches
 * `getArtifactFragment`, `getArtifactBodyAwareness` and
 * `hotArtifactRoomIdsForTests` - which is why it is not attempted here. The
 * alternative (standing up a second main-side doc store now) was rejected: it
 * would hold two copies of every open body for no gain until the tier is
 * actually worker-side.
 *
 * Read this file as scaffolding with a known expiry, not as the destination.
 */
import type { ArtifactBodySeedMode } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { MainThreadBodyDocs } from "./artifact-body-lease-bridge";

/** The tier members this adapter needs, named rather than the whole tier. */
export interface TierBodyDocsSource {
  installColdState(input: {
    readonly docKey: string;
    readonly update: Uint8Array;
    readonly docGuid: string;
    readonly seedMode: ArtifactBodySeedMode;
    readonly hostStateVector: string | null;
  }): void;
  encodeColdState(docKey: string): { readonly update: Uint8Array } | null;
  dropColdState(docKey: string): void;
  holdsColdState(docKey: string): boolean;
}

export function createTierBodyDocs(
  source: TierBodyDocsSource,
): MainThreadBodyDocs {
  return {
    install: (input) => source.installColdState(input),
    encode: (docKey) => {
      const cold = source.encodeColdState(docKey);
      // An empty array, NOT a throw. `encode` is called on the demote path
      // while the caller is deciding whether it may drop a live document, and a
      // throw there strands the doc; an empty update settles to nothing, which
      // the byte count then reports honestly as zero.
      return cold === null ? new Uint8Array() : cold.update;
    },
    drop: (docKey) => source.dropColdState(docKey),
    has: (docKey) => source.holdsColdState(docKey),
  };
}

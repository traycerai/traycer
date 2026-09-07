/** `MainThreadBodyDocs` backed by the artifact-room tier. */
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
    applyRemoteAwareness: () => {
      // A NO-OP, and honestly so.
    },
    install: (input) => {
      // The `@1` arm states no identity, and this adapter cannot represent that: `installColdState`
      // requires one.
      if (input.docGuid === null) return;
      source.installColdState({ ...input, docGuid: input.docGuid });
    },
    encode: (docKey) => {
      const cold = source.encodeColdState(docKey);
      // An empty array, NOT a throw.
      return cold === null ? new Uint8Array() : cold.update;
    },
    drop: (docKey) => source.dropColdState(docKey),
    has: (docKey) => source.holdsColdState(docKey),
  };
}

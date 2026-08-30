/**
 * The composed runtime, as the bridge's {@link EpicRuntimeWorkerCore}.
 *
 * `in-process-runtime-port.ts` is the same mapping in the other direction: it
 * serves the four calls from a LOCAL runtime with no worker, so the lease
 * bridge could be pinned before the worker existed. This is what the worker
 * installs, and the two agree member for member on purpose - a body
 * materialized through one and demoted through the other has to mean the same
 * thing, because during the merge window both are alive.
 *
 * Named members rather than the runtime itself, exactly as the in-process port
 * does: the runtime has 44 members and the core serves four calls. A parameter
 * typed as the whole runtime would let a future member reach across this seam
 * without anyone noticing the seam had moved.
 */
import type { SendOutcome } from "@traycer-clients/shared/replica-runtime/adapter";
import type {
  ArtifactBodyMaterialization,
  EpicRuntimeWorkerCore,
} from "./epic-runtime-worker-host";
import type { ArtifactRoomColdState } from "../artifact-room-tier";

/** What the core needs from the runtime, member by member. */
export interface WorkerRuntimeCoreSource {
  bodyDocKey(artifactId: string): string | null;
  encodeColdState(docKey: string): ArtifactRoomColdState | null;
  settleColdState(
    docKey: string,
    update: Uint8Array,
    expectedDocGuid: string,
  ): { readonly accepted: boolean; readonly settledBytes: number };
  sendBodyUpdate(docKey: string, update: Uint8Array): SendOutcome;
  readAttachmentBytes(
    hash: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null>;
  dispose(): void;
}

export function createEpicRuntimeWorkerCore(
  source: WorkerRuntimeCoreSource,
): EpicRuntimeWorkerCore {
  return {
    readAttachmentBytes(hash): Promise<Uint8Array | null> {
      // A fresh controller per read, never aborted here. The runtime's
      // signature takes one because a MAIN-side caller could cancel; across
      // the bridge the call is already in flight by the time anyone could, and
      // the response is dropped by the endpoint if the caller has gone. An
      // `AbortSignal` cannot cross a `postMessage` boundary in any case.
      return source.readAttachmentBytes(hash, new AbortController().signal);
    },

    materializeBody(artifactId): Promise<ArtifactBodyMaterialization | null> {
      const docKey = source.bodyDocKey(artifactId);
      if (docKey === null) return Promise.resolve(null);
      const cold = source.encodeColdState(docKey);
      // `null` is NOT empty bytes, and the distinction is the whole reason
      // this arm is separate: a zero-length update applies cleanly and yields
      // an empty document, so conflating them replaces a body with nothing.
      if (cold === null) return Promise.resolve(null);
      return Promise.resolve({
        docKey,
        update: cold.update,
        docGuid: cold.docGuid,
        seedMode: cold.seedMode,
        hostStateVector: cold.hostStateVector,
      });
    },

    demoteBody(input): Promise<{
      readonly accepted: boolean;
      readonly settledBytes: number;
    }> {
      // `input.generation` is deliberately not forwarded, matching the
      // in-process port: the tier refuses on IDENTITY (`docGuid`), and the
      // generation is the main side's own bookkeeping for the live doc it is
      // deciding whether to drop.
      return Promise.resolve(
        source.settleColdState(input.docKey, input.update, input.docGuid),
      );
    },

    updateBody(input): Promise<{ readonly outcome: SendOutcome }> {
      return Promise.resolve({
        outcome: source.sendBodyUpdate(input.docKey, input.update),
      });
    },

    dispose(): void {
      source.dispose();
    },
  };
}

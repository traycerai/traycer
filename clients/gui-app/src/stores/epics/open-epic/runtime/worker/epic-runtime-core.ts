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
import type {
  ArtifactBodyMaterialization,
  EpicRuntimeWorkerCore,
} from "./epic-runtime-worker-host";

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
  };
  /** The cold-byte tier: encoded bodies in, encoded bodies out. */
  readonly bodies: {
    materialize(
      artifactId: string,
    ): Promise<ArtifactBodyMaterialization | null>;
    settle(input: {
      readonly docKey: string;
      readonly generation: number;
      readonly update: Uint8Array;
    }): Promise<{ readonly accepted: boolean; readonly settledBytes: number }>;
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
      return ports.bodies.materialize(artifactId);
    },
    async demoteBody(input) {
      // Refuse rather than accept-and-lose. The main thread keeps the live doc
      // on a refusal, so a demote that arrives during teardown costs a
      // re-send after respawn; one accepted here and never written costs the
      // edit.
      if (!serving) return { accepted: false, settledBytes: 0 };
      return ports.bodies.settle(input);
    },
    dispose(): void {
      if (!serving) return;
      serving = false;
      ports.transport.close();
      ports.durableStore.close();
    },
  };
}

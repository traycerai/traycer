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

/**
 * The latest settled demote for one doc.
 *
 * One entry per `docKey`, never a history: the main thread has at most one
 * demote outstanding per doc, so anything older than the stored generation is
 * from a lifetime it has already moved past.
 */
interface SettledDemote {
  readonly generation: number;
  readonly answer: {
    readonly accepted: boolean;
    readonly settledBytes: number;
  };
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
    }): Promise<{ readonly accepted: boolean; readonly settledBytes: number }>;
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
      // previous lifetime's settled answer must not shadow it.
      if (materialized !== null) settledDemotes.delete(materialized.docKey);
      return materialized;
    },
    async demoteBody(input) {
      // Refuse rather than accept-and-lose. The main thread keeps the live doc
      // on a refusal, so a demote that arrives during teardown costs a
      // re-send after respawn; one accepted here and never written costs the
      // edit.
      if (!serving) return { accepted: false, settledBytes: 0 };

      // Idempotence lives HERE and not on the main thread's generation guard,
      // because `resendUnacknowledgedDemotes` deliberately re-posts the SAME
      // generation - the resend exists precisely for the case where the main
      // thread does not know whether the first post was seen. Releasing on both
      // copies would decrement body demand twice and unsubscribe a body that is
      // still open on the other side.
      const settled = settledDemotes.get(input.docKey);
      if (settled !== undefined) {
        // The resend case: answer with what the first copy settled, and do not
        // touch demand again.
        if (settled.generation === input.generation) return settled.answer;
        // Older than what has settled - it belongs to a lifetime the main
        // thread has already moved past. Its own guard drops this answer, but
        // this side must not RELEASE on it, which is why it never reaches the
        // port.
        if (input.generation < settled.generation) {
          return { accepted: false, settledBytes: 0 };
        }
      }
      const answer = await ports.bodies.settle(input);
      settledDemotes.set(input.docKey, {
        generation: input.generation,
        answer,
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
    enqueueWriteCommand(intent) {
      // Refused while shutting down, for the same reason a demote is: the
      // caller must not be handed an id for work this replica will not do.
      if (!serving) return Promise.resolve({ outcome: "refused" as const });
      return Promise.resolve(ports.commands.enqueueWrite(intent));
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
      ports.transport.close();
      ports.durableStore.close();
    },
  };
}

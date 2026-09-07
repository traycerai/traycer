/**
 * The worker-side composition root, as far as it can be built without the pieces that are still
 * main-thread. What this module is FOR is naming the ports and fixing the shutdown order.
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

/** What `body/demote` carries. */
interface DemoteInput {
  readonly docKey: string;
  readonly generation: number;
  readonly docGuid: string;
  readonly update: Uint8Array;
}

/**
 * The latest settled demote for one doc, within one lifetime of that doc. One entry per `docKey`,
 * never a history.
 */
interface SettledDemote {
  readonly generation: number;
  readonly answer: DemoteAnswer;
}

export interface EpicRuntimeCorePorts {
  /** The root replica's content-addressed attachment map. */
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
      /** The identity the caller materialized at. */
      readonly docGuid: string;
      readonly update: Uint8Array;
    }): Promise<{
      readonly accepted: boolean;
      readonly settledBytes: number;
      readonly reason: "not-held" | "newer-generation" | "pinned" | null;
    }>;
    /**
     * Let go of a FORWARD-ONLY body: release its retained lease and detach its observers, settling
     * nothing. The other half of the demote contract, not a variant of it.
     */
    release(docKey: string): {
      readonly released: boolean;
      readonly reason: "not-held" | "newer-generation" | "pinned" | null;
    };
    /** The docKeys whose runtime lease this port still holds. */
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
  /** The replica's metadata mutations and its optimistic overlay. */
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
   * Let go of every hold this core has on a body: each resident body's doc and presence observers,
   * and the demand retained for each AWAITING one.
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
   * This doc's lifetime, counted here rather than taken from main. Bumped by `materializeBody`,
   * which is the only thing that starts a new lifetime.
   */
  const bodyEpochs = new Map<string, number>();
  /** The per-`docKey` demote chain: at most one settle in flight per doc. */
  const demoteTails = new Map<string, Promise<undefined>>();
  /**
   * In-flight demotes, keyed by doc AND generation. The idempotence contract extended to the
   * in-flight window.
   */
  const demotesInFlight = new Map<string, Promise<DemoteAnswer>>();

  function epochOf(docKey: string): number {
    return bodyEpochs.get(docKey) ?? 0;
  }

  /** Write the settled record, unless this doc's lifetime ended while the settle was in flight. */
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
    // Re-checked at the FRONT of the queue, not only on arrival: this call may have waited behind
    // another settle for the same doc, and disposal can land in that window.
    if (!serving) {
      return { accepted: false, settledBytes: 0, reason: "not-held" };
    }

    // Idempotence lives HERE and not on the main thread's generation guard, because
    // `resendUnacknowledgedDemotes` deliberately re-posts the SAME generation - the resend exists
    const epochAtStart = epochOf(input.docKey);
    const settled = settledDemotes.get(input.docKey);
    if (settled !== undefined) {
      // The resend case: answer with what the first copy settled, and do not
      // touch demand again.
      if (settled.generation === input.generation) return settled.answer;
      // Older than what has settled - it belongs to a lifetime the main thread has already moved past.
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
      if (!serving) return null;
      return ports.attachments.read(hash);
    },
    async materializeBody(
      artifactId,
    ): Promise<ArtifactBodyMaterialization | null> {
      if (!serving) return null;
      const materialized = await ports.bodies.materialize(artifactId);
      // A new lifetime for this doc starts a new generation sequence, so the previous lifetime's settled
      // answer must not shadow it.
      if (materialized !== null) {
        settledDemotes.delete(materialized.docKey);
        bodyEpochs.set(materialized.docKey, epochOf(materialized.docKey) + 1);
      }
      return materialized;
    },
    demoteBody(input) {
      // Refuse rather than accept-and-lose.
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

      // Chained behind this doc's previous demote, so two generations can never be settling at once. The
      // tail never rejects, so a failed settle does not strand every later demote for the doc.
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
      // Gated on `serving` like every other member, and the no-core answers are the host's - this arm
      // exists for the window between `dispose()` and the host noticing, where a mutation must not reach
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
      // Empty rather than a throw while shutting down: the caller is a transfer, and its `applied` check
      // is what decides whether the source may be retired.
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
      // Dropped after teardown like every other member: `dispose` already released every hold, so a
      // release arriving afterwards has nothing to do and must not resurrect bookkeeping the shutdown
      if (!serving) return { released: false, reason: "not-held" };
      return ports.bodies.release(docKey);
    },
    heldBodyDocKeysForTests(): readonly string[] {
      return ports.bodies.heldDocKeys();
    },
    applyCommand(command): void {
      // Dropped after teardown like every other member.
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
      // The demote bookkeeping goes with it.
      bodyEpochs.clear();
      demoteTails.clear();
      demotesInFlight.clear();
      // BEFORE the transport closes.
      ports.attachments.cancelAll();
      ports.releaseAllBodyHolds();
      ports.transport.close();
      ports.durableStore.close();
    },
  };
}

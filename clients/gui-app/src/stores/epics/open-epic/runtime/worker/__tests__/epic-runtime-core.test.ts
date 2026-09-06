/**
 * The composition root's two settled behaviours: what it answers once it has
 * stopped serving, and the order it tears down in.
 */
import { describe, expect, it } from "vitest";
import { inertMutationResult } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { RuntimeWorkerCallRequest } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import { createEpicRuntimeWorkerCore } from "../epic-runtime-core";
import type { EpicRuntimeCorePorts } from "../epic-runtime-core";

/**
 * The ONE demote-params construction site in this file.
 *
 * It existed before, unannotated and scoped to a single `describe`, so the
 * contract's `docGuid` failed at ELEVEN call sites instead of once here - and
 * the two literals outside that block had to be swept by hand and were missed.
 * The annotation is what makes it a single point of failure: naming
 * `RuntimeWorkerCallRequest<"body/demote">` rather than restating its members
 * means the next field added to the contract reds this line and nothing else.
 *
 * `docGuid` is per-docKey because two docKeys are two documents; the core keys
 * idempotence on (docKey, generation) and never reads the guid, so no assertion
 * here depends on the value.
 */
const demote = (
  docKey: string,
  generation: number,
): RuntimeWorkerCallRequest<"body/demote"> => ({
  docKey,
  generation,
  docGuid: `guid-${docKey}`,
  update: Uint8Array.from([1]),
});

function createPorts(): EpicRuntimeCorePorts & {
  readonly closed: string[];
  /** Every `bodies.settle` that actually reached the port, in order. */
  readonly settles: string[];
} {
  const closed: string[] = [];
  const settles: string[] = [];
  return {
    closed,
    settles,
    attachments: {
      read: () => Promise.resolve(Uint8Array.from([1])),
      await: () => Promise.resolve(null),
      cancel: () => false,
      cancelAll: () => {},
    },
    releaseAllBodyHolds: () => {},
    // The shared fail-closed answer, so this fixture does not become a fifth
    // hand-written switch over the mutation union.
    mutations: { apply: (mutation) => inertMutationResult(mutation) },
    commands: {
      apply: () => {},
      enqueueWrite: () => ({ outcome: "refused" as const }),
    },
    root: {
      encode: () => Promise.resolve(new Uint8Array()),
      apply: () => Promise.resolve(false),
    },
    bodies: {
      materialize: (artifactId) =>
        Promise.resolve({
          docKey: artifactId,
          docGuid: `guid-${artifactId}`,
          update: Uint8Array.from([2]),
          seedMode: "full",
          hostStateVector: null,
          awarenessFrames: [],
        }),
      settle: (input) => {
        settles.push(`${input.docKey}:${String(input.generation)}`);
        return Promise.resolve({
          accepted: true,
          settledBytes: 7,
          reason: null,
        });
      },
      sendUpdate: () => Promise.resolve({ kind: "sent" }),
      applyAwareness: () => {},
      release: () => ({ released: true, reason: null }),
      heldDocKeys: () => [],
    },
    transport: {
      close: () => {
        closed.push("transport");
      },
    },
    durableStore: {
      close: () => {
        closed.push("durableStore");
      },
    },
  };
}

describe("shutdown order", () => {
  it("closes the transport before the durable store, and only once", () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    core.dispose();
    core.dispose();

    // The store is the only thing here with state outliving the process, so a
    // frame arriving after it closed is how a write lands past its own close.
    expect(ports.closed).toEqual(["transport", "durableStore"]);
  });
});

describe("after dispose", () => {
  it("answers reads and materializations as unavailable instead of touching the replica", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);
    core.dispose();

    await expect(core.readAttachmentBytes("hash")).resolves.toBeNull();
    await expect(core.materializeBody("artifact-1")).resolves.toBeNull();
  });

  it("REFUSES a demote rather than accepting bytes it will not write", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);
    core.dispose();

    // Accepting here costs the edit: the main thread drops its live doc on an
    // accepted demote. Refusing costs one re-send after respawn.
    await expect(core.demoteBody(demote("artifact-1", 2))).resolves.toEqual({
      accepted: false,
      settledBytes: 0,
      reason: "not-held",
    });
  });

  it("serves normally before dispose", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await expect(core.readAttachmentBytes("hash")).resolves.toEqual(
      Uint8Array.from([1]),
    );
    await expect(core.demoteBody(demote("artifact-1", 1))).resolves.toEqual({
      accepted: true,
      settledBytes: 7,
      reason: null,
    });
  });
});

describe("the settled-demote map — idempotence per (docKey, generation)", () => {
  it("answers a RESEND from the stored answer without touching the port again", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    const first = await core.demoteBody(demote("doc-1", 2));
    // `resendUnacknowledgedDemotes` re-posts the SAME generation on purpose:
    // the main thread does not know whether the first post was seen. Releasing
    // demand on both copies would unsubscribe a body that is still open.
    const resend = await core.demoteBody(demote("doc-1", 2));

    expect(first).toEqual({ accepted: true, settledBytes: 7, reason: null });
    expect(resend).toEqual(first);
    expect(ports.settles).toEqual(["doc-1:2"]);
  });

  it("REFUSES a generation older than the one already settled, without reaching the port", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await core.demoteBody(demote("doc-1", 3));
    const stale = await core.demoteBody(demote("doc-1", 2));

    // It belongs to a lifetime the main thread has already moved past. Its own
    // guard drops this answer, but the worker must not RELEASE on it - and the
    // REASON names which refusal this is, which is the whole point of carrying
    // it: `newer-generation` is a stale post, `not-held` would be a worker with
    // nothing to settle into.
    expect(stale).toEqual({
      accepted: false,
      settledBytes: 0,
      reason: "newer-generation",
    });
    expect(ports.settles).toEqual(["doc-1:3"]);
  });

  it("runs a NEWER generation and replaces the entry", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await core.demoteBody(demote("doc-1", 1));
    await core.demoteBody(demote("doc-1", 2));
    await core.demoteBody(demote("doc-1", 2));

    expect(ports.settles).toEqual(["doc-1:1", "doc-1:2"]);
  });

  it("keeps one entry per docKey, so two docs do not shadow each other", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await core.demoteBody(demote("doc-1", 5));
    await core.demoteBody(demote("doc-2", 1));

    expect(ports.settles).toEqual(["doc-1:5", "doc-2:1"]);
  });

  it("clears the entry when the doc is materialized again — a new lifetime, a new sequence", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await core.demoteBody(demote("artifact-1", 4));
    await core.materializeBody("artifact-1");
    // Generation 4 again, but for a doc that has been re-materialized since.
    // Without the clear this would answer from the previous lifetime and never
    // settle the new one.
    await core.demoteBody(demote("artifact-1", 4));

    expect(ports.settles).toEqual(["artifact-1:4", "artifact-1:4"]);
  });
});

/**
 * Ports whose settles the TEST decides the answer and the timing of.
 *
 * `answer(generation, …)` may be called before or after the settle for that
 * generation actually reaches the port, and that flexibility is the point: it
 * lets one script run against both the broken and the fixed core. Without
 * serialization both settles are in flight at once and the test resolves them
 * out of order; with it, the second has not been invoked yet when its answer is
 * armed, and it returns an already-resolved promise the moment it starts.
 */
function createGatedPorts(): EpicRuntimeCorePorts & {
  readonly settles: string[];
  /** The most settles this port ever had in flight AT ONCE for one docKey. */
  peakConcurrencyPerDoc(): number;
  answer(docKey: string, generation: number, value: DemoteAnswerForTest): void;
  /** Reject that settle instead of answering it. */
  fail(docKey: string, generation: number): void;
} {
  const base = createPorts();
  const armed = new Map<string, DemoteAnswerForTest>();
  const waiting = new Map<string, (value: DemoteAnswerForTest) => void>();
  // Keyed by doc AND generation: two docs legitimately share a generation
  // number, and a generation-only key silently answers the wrong one.
  const gateKey = (docKey: string, generation: number): string =>
    `${docKey}:${String(generation)}`;
  const rejecters = new Map<string, (reason: Error) => void>();
  const liveByDoc = new Map<string, number>();
  let peak = 0;
  const finish = (docKey: string): void => {
    liveByDoc.set(docKey, (liveByDoc.get(docKey) ?? 1) - 1);
  };
  return {
    ...base,
    peakConcurrencyPerDoc: () => peak,
    fail: (docKey, generation) => {
      const key = gateKey(docKey, generation);
      const pending = rejecters.get(key);
      if (pending === undefined)
        throw new Error(`no settle waiting for ${key}`);
      waiting.delete(key);
      rejecters.delete(key);
      pending(new Error(`settle failed for ${key}`));
    },
    answer: (docKey, generation, value) => {
      const key = gateKey(docKey, generation);
      const pending = waiting.get(key);
      if (pending === undefined) {
        armed.set(key, value);
        return;
      }
      waiting.delete(key);
      pending(value);
    },
    bodies: {
      ...base.bodies,
      settle: (input) => {
        base.settles.push(`${input.docKey}:${String(input.generation)}`);
        const live = (liveByDoc.get(input.docKey) ?? 0) + 1;
        liveByDoc.set(input.docKey, live);
        peak = Math.max(peak, live);
        const key = gateKey(input.docKey, input.generation);
        const already = armed.get(key);
        if (already !== undefined) {
          armed.delete(key);
          finish(input.docKey);
          return Promise.resolve(already);
        }
        return new Promise<DemoteAnswerForTest>((resolve, reject) => {
          waiting.set(key, (value) => {
            finish(input.docKey);
            resolve(value);
          });
          rejecters.set(key, (reason) => {
            finish(input.docKey);
            reject(reason);
          });
        });
      },
    },
  };
}

interface DemoteAnswerForTest {
  readonly accepted: boolean;
  readonly settledBytes: number;
  readonly reason: "not-held" | "newer-generation" | "pinned" | null;
}

describe("concurrent demote generations", () => {
  /**
   * The corruption this serialization exists to prevent.
   *
   * The main thread CAN have two demotes outstanding for one doc: the lease
   * bridge re-acquires a doc whose demote is unacknowledged (`reviveAndHold`,
   * which bumps the generation) and then ends that lifetime again
   * (`postLifecycleEnd`, which bumps and posts). With the settled check before
   * the await and the write after it, the older completion overwrote the newer
   * record - and the resend that exists for exactly this case then MISSED,
   * re-settled against a tier that no longer held the doc, and answered a
   * refusal the main thread could never clear. The doc stays hot and the demote
   * stays pending forever.
   *
   * TWO mechanisms defend this, and they are NOT interchangeable - measured,
   * not assumed. Ablating the chaining leaves this test GREEN, because the
   * post-await generation compare in `recordSettledDemote` refuses the older
   * overwrite on its own. What the chaining uniquely owns is the sibling test
   * below: keeping two settles for one doc off the tier at the same time.
   * Ablate `recordSettledDemote`'s compare instead and this one reds.
   */
  it("does not let an older completion overwrite a newer settled record", async () => {
    const ports = createGatedPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    const older = core.demoteBody(demote("artifact-1", 2));
    const newer = core.demoteBody(demote("artifact-1", 4));

    // Resolved NEWEST FIRST, which is the interleave that corrupts the record:
    // under the old code gen 4 recorded its accept and gen 2 then overwrote it.
    ports.answer("artifact-1", 4, {
      accepted: true,
      settledBytes: 11,
      reason: null,
    });
    ports.answer("artifact-1", 2, {
      accepted: false,
      settledBytes: 0,
      reason: "not-held",
    });

    await expect(older).resolves.toEqual({
      accepted: false,
      settledBytes: 0,
      reason: "not-held",
    });
    await expect(newer).resolves.toEqual({
      accepted: true,
      settledBytes: 11,
      reason: null,
    });

    // THE PIN. `resendUnacknowledgedDemotes` re-posts the SAME generation, and
    // it must replay the answer gen 4 already settled.
    await expect(core.demoteBody(demote("artifact-1", 4))).resolves.toEqual({
      accepted: true,
      settledBytes: 11,
      reason: null,
    });
    // And must NOT have asked the tier a third time: a second settle for a doc
    // the tier has already released decrements demand twice.
    expect(ports.settles).toEqual(["artifact-1:2", "artifact-1:4"]);
  });

  /**
   * What the per-docKey chaining uniquely buys, and the reason it is not
   * redundant with the generation compare above.
   *
   * The compare protects the RECORD. This protects the TIER: `bodies.settle`
   * releases the doc's retained lease and returns its bytes, and two of those
   * running at once for one docKey is the double-release the whole idempotence
   * scheme exists to prevent - just moved earlier, into the window before
   * either has recorded anything. A record-only fix leaves the second settle
   * reaching a tier the first has already emptied.
   *
   * ABLATION: replace the chaining in `demoteBody` with a bare
   * `settleOneDemote(input)` and this reds at 2 concurrent.
   */
  it("never has two settles in flight for one doc at the same time", async () => {
    const ports = createGatedPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    const older = core.demoteBody(demote("artifact-1", 2));
    const newer = core.demoteBody(demote("artifact-1", 4));
    // A THIRD doc key, to show the serialization is per-doc and not a global
    // lock - two different docs may settle at once and must not queue.
    const other = core.demoteBody(demote("artifact-2", 2));

    ports.answer("artifact-1", 4, {
      accepted: true,
      settledBytes: 11,
      reason: null,
    });
    ports.answer("artifact-1", 2, {
      accepted: false,
      settledBytes: 0,
      reason: "not-held",
    });
    ports.answer("artifact-2", 2, {
      accepted: true,
      settledBytes: 1,
      reason: null,
    });
    await Promise.all([older, newer, other]);

    expect(ports.peakConcurrencyPerDoc()).toBe(1);
    // Both docs did reach the port - a "peak of 1" that came from one of them
    // never settling at all would be vacuous.
    expect(ports.settles).toEqual([
      "artifact-1:2",
      "artifact-2:2",
      "artifact-1:4",
    ]);
  });

  /**
   * What the in-flight SHARE uniquely buys, measured rather than assumed.
   *
   * On a settle that RESOLVES, the share is not load-bearing: the resend queues
   * behind its twin and then reads the twin's settled record, so the tier is
   * asked once either way. (Ablating the share leaves the sibling test below
   * green - that was checked, not guessed.)
   *
   * A settle that REJECTS writes no record, so the queued resend finds nothing
   * and asks the tier a SECOND time - against a doc the first attempt may
   * already have released. Sharing the promise is what makes the idempotence
   * contract hold on the failure path too.
   *
   * ABLATION: remove the `demotesInFlight` lookup in `demoteBody` and this reds
   * with two settles.
   */
  it("does not re-ask the tier when the shared settle REJECTS", async () => {
    const ports = createGatedPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    const first = core.demoteBody(demote("artifact-1", 3));
    const resend = core.demoteBody(demote("artifact-1", 3));

    ports.fail("artifact-1", 3);

    await expect(first).rejects.toThrow("settle failed");
    await expect(resend).rejects.toThrow("settle failed");
    expect(ports.settles).toEqual(["artifact-1:3"]);
  });

  it("shares one settle with a resend that arrives while its twin is in flight", async () => {
    const ports = createGatedPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    // "Not seen yet" and "seen and still settling" are indistinguishable from
    // the main thread, so the resend can land inside the settle window. It must
    // join, not queue behind and settle a second time.
    const first = core.demoteBody(demote("artifact-1", 3));
    const resend = core.demoteBody(demote("artifact-1", 3));

    ports.answer("artifact-1", 3, {
      accepted: true,
      settledBytes: 5,
      reason: null,
    });

    await expect(first).resolves.toEqual({
      accepted: true,
      settledBytes: 5,
      reason: null,
    });
    await expect(resend).resolves.toEqual({
      accepted: true,
      settledBytes: 5,
      reason: null,
    });
    expect(ports.settles).toEqual(["artifact-1:3"]);
  });

  it("drops a settle whose lifetime ended while it was in flight", async () => {
    const ports = createGatedPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    const inFlight = core.demoteBody(demote("artifact-1", 6));
    // The doc is re-materialized before that settle comes back, so main's
    // generation counter restarts at 1 for the new lifetime - it is NOT
    // monotonic across lifetimes (`artifact-body-lease-bridge.ts` deletes its
    // entry on ack and re-creates it at `generation: 1`). A record written by
    // the old lifetime would therefore outrank every generation of the new one
    // and refuse them all.
    await core.materializeBody("artifact-1");
    ports.answer("artifact-1", 6, {
      accepted: true,
      settledBytes: 3,
      reason: null,
    });
    await inFlight;

    // The new lifetime's first demote must REACH the port rather than be
    // answered "newer-generation" from the dead lifetime's record.
    ports.answer("artifact-1", 1, {
      accepted: true,
      settledBytes: 2,
      reason: null,
    });
    await expect(core.demoteBody(demote("artifact-1", 1))).resolves.toEqual({
      accepted: true,
      settledBytes: 2,
      reason: null,
    });
    expect(ports.settles).toEqual(["artifact-1:6", "artifact-1:1"]);
  });
});

describe("body/update", () => {
  it("forwards the lane's own outcome while serving", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);

    await expect(
      core.updateBody({ docKey: "doc-1", update: Uint8Array.from([1]) }),
    ).resolves.toEqual({ outcome: { kind: "sent" } });
  });

  it("drops an update after dispose rather than claiming it was queued", async () => {
    const ports = createPorts();
    const core = createEpicRuntimeWorkerCore(ports);
    core.dispose();

    const answer = await core.updateBody({
      docKey: "doc-1",
      update: Uint8Array.from([1]),
    });

    // `queued` would claim something here is holding it. Nothing is - the
    // main thread's live doc is, and the edit crosses on the next
    // materialize/demote cycle.
    expect(answer.outcome.kind).toBe("dropped");
  });
});

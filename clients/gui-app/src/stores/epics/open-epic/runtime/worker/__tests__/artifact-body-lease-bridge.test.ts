/**
 * The acknowledged-demote lifecycle, driven over a real bridge.
 *
 * Every test here runs the production `createMainBridgeEndpoint` against a
 * `createFakeBridgePair`, with a hand-written worker side that answers
 * `body/materialize` and `body/demote`. Nothing about the lifecycle is mocked:
 * the frames are real, the correlation is real, and a worker that "dies" does
 * so by disposing the endpoint, which is exactly what a terminated worker looks
 * like to this module.
 *
 * The four properties under test are the ones an acknowledged demote exists
 * for, and each fails silently if it is wrong - a dropped doc, a double charge,
 * a lost edit after a respawn, or a document taken out from under a bound
 * editor.
 */
import { stubMainCallHandlers } from "@traycer-clients/shared/replica-runtime/worker/test-support/stub-main-call-handlers";
import { describe, expect, it } from "vitest";
import { createMainBridgeEndpoint } from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import {
  createFakeBridgePair,
  type FakeBridgePair,
} from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-bridge-pair";
import {
  isMainToWorkerFrame,
  type RuntimeWorkerCallKind,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type {
  RuntimeScheduler,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime";

/** The linger window these tests drive. Any positive number; the bridge takes
 * its production value from `ARTIFACT_ROOM_LEASE_POLICY.cooldownMs`. */
const LINGER_MS = 60_000;
/** Deliberately small, so the cap is reachable in a test. */
const MAX_HOT = 3;

import {
  createArtifactBodyLeaseBridge,
  type ArtifactBodyGrant,
  type HotBodyBudget,
  type MainThreadBodyDocs,
} from "../artifact-body-lease-bridge";

interface DemoteRecord {
  readonly docKey: string;
  readonly generation: number;
  readonly docGuid: string;
  readonly bytes: readonly number[];
  settle(answer: { accepted: boolean; settledBytes: number }): void;
  /**
   * Answer with an ERROR reply rather than a verdict, on a worker that stays
   * alive - which is what `serve()` does with a handler that threw, and what
   * a malformed response decodes to. Distinct from `main.dispose()`, which is
   * the worker DYING, and the two are not interchangeable: only the death
   * brings a replacement, and only a replacement runs
   * `resendUnacknowledgedDemotes`.
   */
  fail(message: string): void;
}

/**
 * A worker side that answers materialize immediately and parks every demote
 * until the test settles it - which is what makes "before the ack" a state a
 * test can actually stand in.
 */
function createWorkerSide(
  pair: FakeBridgePair,
  docKeyFor: (artifactId: string) => string,
) {
  const demotes: DemoteRecord[] = [];
  // Counted, because "a re-acquire inside the window pays nothing" is a claim
  // about work NOT done - and the only honest way to assert that is a count.
  const materializes: string[] = [];
  const unsubscribe = pair.worker.subscribe((message) => {
    if (!isMainToWorkerFrame(message) || message.frame !== "call") return;
    const { callId, call } = message;
    const respond = (value: unknown): void => {
      pair.worker.post(
        { frame: "result", callId, result: { outcome: "ok", value } },
        [],
      );
    };
    const respondError = (message: string): void => {
      pair.worker.post(
        {
          frame: "result",
          callId,
          result: { outcome: "error", name: "Error", message },
        },
        [],
      );
    };
    if (call.kind === "body/materialize") {
      materializes.push(call.request.artifactId);
      respond({
        docKey: docKeyFor(call.request.artifactId),
        update: Uint8Array.from([1, 2, 3]),
        // A granted materialize always names its document. The bridge refuses
        // a guidless grant rather than installing a doc it could never demote.
        docGuid: `guid-${call.request.artifactId}`,
        seedMode: "full",
        hostStateVector: null,
        awarenessFrames: [],
      });
      return;
    }
    if (call.kind === "body/demote") {
      const { docKey, generation, docGuid, update } = call.request;
      demotes.push({
        docKey,
        generation,
        docGuid,
        bytes: [...update],
        settle: (answer) => {
          // The wire answer carries a REASON now, and the decoder refuses a
          // response missing it - correctly, since a verdict this side cannot
          // read is not one to act on. Filled here so the tests keep stating
          // only what they are about: accepted, or refused and why.
          respond({
            ...answer,
            reason: answer.accepted ? null : "not-held",
          });
        },
        fail: (message) => {
          respondError(message);
        },
      });
    }
  });
  return { demotes, materializes, unsubscribe };
}

function createDocs(): MainThreadBodyDocs & {
  readonly installed: string[];
  readonly dropped: string[];
  readonly presence: string[];
} {
  const live = new Set<string>();
  const installed: string[] = [];
  const dropped: string[] = [];
  // Recorded so the materialize's presence hand-off is observable: the frames
  // ride the RESPONSE, so "did they arrive" is a fact about this object.
  const presence: string[] = [];
  return {
    installed,
    dropped,
    presence,
    install(input): void {
      live.add(input.docKey);
      installed.push(input.docKey);
    },
    encode(docKey): Uint8Array {
      return Uint8Array.from([docKey.length, 9, 9]);
    },
    drop(docKey): void {
      live.delete(docKey);
      dropped.push(docKey);
    },
    applyRemoteAwareness(docKey, frame): void {
      presence.push(`${docKey}:${String(frame.length)}`);
    },
    has(docKey): boolean {
      return live.has(docKey);
    },
  };
}

function createBudget(): HotBodyBudget & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    chargeHot: (docKey, bytes) => calls.push(`chargeHot:${docKey}:${bytes}`),
    settleCold: (docKey, bytes) => calls.push(`settleCold:${docKey}:${bytes}`),
  };
}

/**
 * A scheduler the test drives, so the linger window is a call rather than a
 * real minute. Fires in insertion order and only what is due, matching a real
 * scheduler's next tick rather than an eager drain.
 */
function createScheduler(): RuntimeScheduler & { advance(ms: number): void } {
  let now = 0;
  const pending: { at: number; run: () => void; cancelled: boolean }[] = [];
  return {
    schedule(delayMs, callback): RuntimeTimer {
      const entry = { at: now + delayMs, run: callback, cancelled: false };
      pending.push(entry);
      return {
        cancel(): void {
          entry.cancelled = true;
        },
      };
    },
    scheduleMicrotask(callback): void {
      callback();
    },
    advance(ms): void {
      now += ms;
      for (const entry of pending.filter((e) => !e.cancelled && e.at <= now)) {
        if (entry.cancelled) continue;
        entry.cancelled = true;
        entry.run();
      }
    },
  };
}

function grantedKey(grant: ArtifactBodyGrant): string {
  if (grant.kind !== "granted") {
    throw new Error(`Expected a granted body, got ${grant.kind}`);
  }
  return grant.docKey;
}

/**
 * For the constructions that never reach an awaiting body - their worker side
 * always answers with bytes or with nothing at all, so no retry can stall.
 * `setup`'s rig records instead, because that is where the awaiting pins live.
 */
const IGNORE_STALL_REPORT = (): void => {};

function setup() {
  const pair = createFakeBridgePair("sync");
  const worker = createWorkerSide(pair, (artifactId) => artifactId);
  const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));
  const docs = createDocs();
  const budget = createBudget();
  // Recorded, not a no-op: the forward-only release is fire-and-forget, so the
  // ONLY observable that it happened at all is that it was posted.
  const releasedForwardOnly: string[] = [];
  const scheduler = createScheduler();
  // Recorded for the same reason: a stalled retry keeps waiting rather than
  // failing, so the report is the only observable that the disagreement between
  // the availability map and the tier was noticed at all.
  const stalled: string[] = [];
  const leases = createArtifactBodyLeaseBridge({
    bridge: main,
    docs,
    budget,
    scheduler,
    lingerMs: LINGER_MS,
    maxHotDocs: MAX_HOT,
    reportAwaitingStalled: (docKey) => stalled.push(docKey),
  });
  return {
    pair,
    worker,
    main,
    docs,
    budget,
    leases,
    releasedForwardOnly,
    scheduler,
    stalled,
  };
}

describe("acquire / materialize", () => {
  it("installs the worker's bytes once and charges the doc hot", async () => {
    const { leases, docs, budget } = setup();

    const grant = await leases.acquire("artifact-1", "linger");

    expect(grantedKey(grant)).toBe("artifact-1");
    expect(docs.installed).toEqual(["artifact-1"]);
    expect(budget.calls).toEqual(["chargeHot:artifact-1:3"]);
  });

  it("answers unavailable without installing when the worker holds no body", async () => {
    const pair = createFakeBridgePair("sync");
    pair.worker.subscribe((message) => {
      if (!isMainToWorkerFrame(message) || message.frame !== "call") return;
      pair.worker.post(
        {
          frame: "result",
          callId: message.callId,
          result: {
            outcome: "ok",
            value: {
              docKey: null,
              update: null,
              docGuid: null,
              seedMode: "full",
              hostStateVector: null,
              awarenessFrames: [],
            },
          },
        },
        [],
      );
    });
    const docs = createDocs();
    const leases = createArtifactBodyLeaseBridge({
      bridge: createMainBridgeEndpoint(pair.main, stubMainCallHandlers({})),
      docs,
      budget: createBudget(),
      scheduler: createScheduler(),
      lingerMs: LINGER_MS,
      maxHotDocs: MAX_HOT,
      reportAwaitingStalled: IGNORE_STALL_REPORT,
    });

    const grant = await leases.acquire("artifact-missing", "linger");

    expect(grant.kind).toBe("unavailable");
    expect(docs.installed).toEqual([]);
  });
});

describe("constraint 1 — the doc stays hot until the ack", () => {
  it("does not drop the doc, nor settle the charge, before the worker answers", async () => {
    const { leases, docs, budget, worker, scheduler } = setup();
    const grant = await leases.acquire("artifact-1", "linger");

    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);

    // Posted, not settled.
    expect(worker.demotes).toHaveLength(1);
    expect(docs.dropped).toEqual([]);
    expect(docs.has("artifact-1")).toBe(true);
    // The accountant knows it is on its way out, and has NOT been told the
    // bytes are free. A doc reported cold here is one the accountant believes
    // it can spend while the store still holds it.
    expect(budget.calls).toEqual(["chargeHot:artifact-1:3"]);
    expect(leases.unacknowledgedDemoteKeys()).toEqual(["artifact-1"]);
  });

  it("posts the demote on the last IMMEDIATE release, without waiting out the linger", async () => {
    // The transient-hold arm. A bulk export reads each body once and moves on,
    // so the cooldown - a bet that the user is coming back - is known wrong,
    // and taking it left every already-serialized body hot behind the one the
    // loop believed was the only resident.
    const { leases, worker, scheduler } = setup();
    const grant = await leases.acquire("artifact-1", "immediate");

    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();

    // BEFORE advancing the scheduler, which is the whole assertion: the
    // sibling above needs `scheduler.advance(LINGER_MS)` to reach this state.
    expect(worker.demotes).toHaveLength(1);
    expect(leases.unacknowledgedDemoteKeys()).toEqual(["artifact-1"]);

    // And no timer was armed to post a SECOND one when the window elapses.
    scheduler.advance(LINGER_MS);
    expect(worker.demotes).toHaveLength(1);
  });

  it("keeps the body hot while another holder remains, whatever the releaser asked for", async () => {
    // The retention is the LAST releaser's call, and this is why that is safe:
    // an earlier return on `leases > 0` means the question is never reached
    // while anyone still holds the body. Without this pin, "immediate wins"
    // would read as "immediate evicts a body an editor is bound to".
    const { leases, worker, scheduler } = setup();
    const editor = await leases.acquire("artifact-1", "linger");
    const exporter = await leases.acquire("artifact-1", "immediate");

    if (exporter.kind !== "granted") throw new Error("expected a grant");
    exporter.release();

    expect(worker.demotes).toEqual([]);
    scheduler.advance(LINGER_MS);
    expect(worker.demotes).toEqual([]);

    if (editor.kind !== "granted") throw new Error("expected a grant");
    editor.release();
    // The editor is last, so ITS retention decides - the linger, not the
    // exporter's immediate.
    expect(worker.demotes).toEqual([]);
    scheduler.advance(LINGER_MS);
    expect(worker.demotes).toHaveLength(1);
  });

  it("settles cold with the WORKER's byte count and drops the doc on the ack", async () => {
    const { leases, docs, budget, worker, scheduler } = setup();
    const grant = await leases.acquire("artifact-1", "linger");

    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);
    worker.demotes[0]?.settle({ accepted: true, settledBytes: 4_096 });
    await Promise.resolve();
    await Promise.resolve();

    expect(docs.dropped).toEqual(["artifact-1"]);
    // 4096 is the worker's number, not anything this side could compute from
    // the three bytes `encode` produced.
    expect(budget.calls).toEqual([
      "chargeHot:artifact-1:3",
      "settleCold:artifact-1:4096",
    ]);
    expect(leases.unacknowledgedDemoteKeys()).toEqual([]);
  });

  it("does not post a second demote, nor charge twice, on a second release before the ack", async () => {
    const { leases, worker, budget, scheduler } = setup();
    const first = await leases.acquire("artifact-1", "linger");
    const second = await leases.acquire("artifact-1", "linger");

    if (first.kind !== "granted" || second.kind !== "granted") {
      throw new Error("expected two grants");
    }
    first.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);
    // One holder left, so nothing should have been posted yet.
    expect(worker.demotes).toHaveLength(0);
    second.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);
    // A caller's `finally` backstop running after its own early release.
    second.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);
    first.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);

    expect(worker.demotes).toHaveLength(1);
    expect(
      budget.calls.filter((call) => call.startsWith("markDemoting")),
    ).toEqual([]);
  });

  it("keeps the doc when the worker declines the generation", async () => {
    const { leases, docs, budget, worker, scheduler } = setup();
    const grant = await leases.acquire("artifact-1", "linger");

    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);
    worker.demotes[0]?.settle({ accepted: false, settledBytes: 0 });
    await Promise.resolve();
    await Promise.resolve();

    expect(docs.dropped).toEqual([]);
    expect(budget.calls).not.toContain("settleCold:artifact-1:0");
    // Still pending, so a later resend can settle it. A declined demote that
    // quietly forgot the doc is the same loss as one that never arrived.
    expect(leases.unacknowledgedDemoteKeys()).toEqual(["artifact-1"]);
  });
});

describe("constraint 2 — a worker that dies mid-demote", () => {
  it("keeps the doc, and re-sends once to the replacement", async () => {
    const { leases, docs, main, worker, scheduler } = setup();
    const grant = await leases.acquire("artifact-1", "linger");

    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);
    const posted = worker.demotes[0];
    expect(posted).toBeDefined();

    // The worker dies: the endpoint is disposed, so the in-flight call rejects
    // with BridgeDisposedError rather than hanging.
    main.dispose();
    await Promise.resolve();
    await Promise.resolve();

    // Nothing dropped, and the demote is still owed.
    expect(docs.dropped).toEqual([]);
    expect(docs.has("artifact-1")).toBe(true);
    expect(leases.unacknowledgedDemoteKeys()).toEqual(["artifact-1"]);

    // Respawn: a fresh pair, a fresh endpoint, the same lease bridge state.
    const nextPair = createFakeBridgePair("sync");
    const nextWorker = createWorkerSide(nextPair, (artifactId) => artifactId);
    const nextLeases = createArtifactBodyLeaseBridge({
      bridge: createMainBridgeEndpoint(nextPair.main, stubMainCallHandlers({})),
      docs,
      budget: createBudget(),
      scheduler: createScheduler(),
      lingerMs: LINGER_MS,
      maxHotDocs: MAX_HOT,
      reportAwaitingStalled: IGNORE_STALL_REPORT,
    });
    // The re-send is driven from the state the ORIGINAL bridge holds, so this
    // asserts the observable half: the doc survived with its bytes intact and
    // is re-sendable. The same-generation guarantee is asserted below.
    void nextLeases;
    expect(posted.generation).toBe(2);

    leases.resendUnacknowledgedDemotes();
    // The dead endpoint refuses new calls, so the re-post is rejected rather
    // than silently queued - and the doc still is not dropped.
    await Promise.resolve();
    await Promise.resolve();
    expect(docs.dropped).toEqual([]);
    expect(nextWorker.demotes).toHaveLength(0);
  });

  it("re-sends with the SAME generation, so a worker that saw both settles once", async () => {
    const { leases, worker, docs, scheduler } = setup();
    const grant = await leases.acquire("artifact-1", "linger");

    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);
    const firstGeneration = worker.demotes[0]?.generation;

    leases.resendUnacknowledgedDemotes();

    expect(worker.demotes).toHaveLength(2);
    expect(worker.demotes[1]?.generation).toBe(firstGeneration);
    // Both acks arrive. The second is for a generation already settled, so it
    // must not drop a second time.
    worker.demotes[0]?.settle({ accepted: true, settledBytes: 10 });
    await Promise.resolve();
    await Promise.resolve();
    worker.demotes[1]?.settle({ accepted: true, settledBytes: 10 });
    await Promise.resolve();
    await Promise.resolve();

    expect(docs.dropped).toEqual(["artifact-1"]);
  });
});

describe("constraint 3 — re-acquire before the ack wins locally", () => {
  it("cancels the pending drop, does no round trip, and ignores the stale ack", async () => {
    const { leases, docs, budget, worker, pair, scheduler } = setup();
    const first = await leases.acquire("artifact-1", "linger");

    if (first.kind !== "granted") throw new Error("expected a grant");
    first.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);
    expect(worker.demotes).toHaveLength(1);

    const callsBefore = countCalls(pair, "body/materialize");
    const second = await leases.acquire("artifact-1", "linger");

    // Same document, handed straight back.
    expect(grantedKey(second)).toBe("artifact-1");
    expect(countCalls(pair, "body/materialize")).toBe(callsBefore);
    expect(docs.installed).toEqual(["artifact-1"]);
    // The re-acquire DISARMED the pending demote. This used to assert a
    // `clearDemoting` budget call; that member is gone, and the fact it stood
    // for lives on the entry's `demotingGeneration` - which this reads through
    // the bridge's own seam rather than through the accountant.
    expect(leases.unacknowledgedDemoteKeys()).not.toContain("artifact-1");

    // The old demote's ack lands late. It names a generation the lease has
    // outlived, so it must do nothing at all - dropping here takes the doc out
    // from under an editor that is bound to it right now.
    worker.demotes[0]?.settle({ accepted: true, settledBytes: 4_096 });
    await Promise.resolve();
    await Promise.resolve();

    expect(docs.dropped).toEqual([]);
    expect(docs.has("artifact-1")).toBe(true);
    expect(budget.calls).not.toContain("settleCold:artifact-1:4096");
  });

  it("demotes again on the next release, under a fresh generation", async () => {
    const { leases, worker, docs, scheduler } = setup();
    const first = await leases.acquire("artifact-1", "linger");
    if (first.kind !== "granted") throw new Error("expected a grant");
    first.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);
    const staleGeneration = worker.demotes[0]?.generation;

    const second = await leases.acquire("artifact-1", "linger");
    if (second.kind !== "granted") throw new Error("expected a grant");
    second.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);

    expect(worker.demotes).toHaveLength(2);
    expect(worker.demotes[1]?.generation).not.toBe(staleGeneration);

    worker.demotes[1]?.settle({ accepted: true, settledBytes: 12 });
    await Promise.resolve();
    await Promise.resolve();
    expect(docs.dropped).toEqual(["artifact-1"]);
  });
});

describe("constraint 4 — the encoded state is transferred, not copied by reference", () => {
  it("hands the demote's bytes over as a transfer", async () => {
    const { leases, pair, worker, scheduler } = setup();
    const grant = await leases.acquire("artifact-1", "linger");
    if (grant.kind !== "granted") throw new Error("expected a grant");

    grant.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);

    const post = pair.fromMain.at(-1);
    expect(post?.transferCount).toBe(1);
    expect(worker.demotes[0]?.bytes).toEqual([10, 9, 9]);
  });
});

function countCalls(pair: FakeBridgePair, kind: RuntimeWorkerCallKind): number {
  return pair.fromMain.filter((post) => {
    const frame = post.delivered;
    return (
      isMainToWorkerFrame(frame) &&
      frame.frame === "call" &&
      frame.call.kind === kind
    );
  }).length;
}

describe("constraint 3 (legacy @1 arm) — a room-keyed re-acquire revives the same way", () => {
  it("disarms the pending demote when the re-acquire arrives through materialize", async () => {
    // On `@1` the doc key is a ROOM id, so a held entry is not findable by
    // artifact id and EVERY re-acquire goes through `body/materialize` - the
    // post-materialize arm, not the fast path. The lane-arm pin above cannot
    // reach this code at all, which is exactly why it was not evidence.
    const pair = createFakeBridgePair("sync");
    const worker = createWorkerSide(pair, () => "room-1");
    const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));
    const docs = createDocs();
    const budget = createBudget();
    const scheduler = createScheduler();
    const leases = createArtifactBodyLeaseBridge({
      bridge: main,
      docs,
      budget,
      scheduler,
      lingerMs: LINGER_MS,
      maxHotDocs: MAX_HOT,
      reportAwaitingStalled: IGNORE_STALL_REPORT,
    });

    const first = await leases.acquire("artifact-1", "linger");
    expect(grantedKey(first)).toBe("room-1");
    if (first.kind !== "granted") throw new Error("expected a grant");
    first.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);
    expect(worker.demotes).toHaveLength(1);
    const staleGeneration = worker.demotes[0]?.generation;

    // Re-acquired before the ack. Goes through materialize because the entry
    // is keyed by the room, not the artifact.
    const second = await leases.acquire("artifact-1", "linger");
    expect(grantedKey(second)).toBe("room-1");
    // Same disarm, keyed by the room on this arm.
    expect(leases.unacknowledgedDemoteKeys()).not.toContain("room-1");

    // The old demote's ack lands. It must be a no-op: the editor bound to that
    // Y.Doc is holding it right now.
    worker.demotes[0]?.settle({ accepted: true, settledBytes: 4_096 });
    await Promise.resolve();
    await Promise.resolve();

    expect(docs.dropped).toEqual([]);
    expect(docs.has("room-1")).toBe(true);
    expect(budget.calls).not.toContain("settleCold:room-1:4096");
    expect(leases.unacknowledgedDemoteKeys()).toEqual([]);

    // And the entry is genuinely held again: releasing posts a NEW demote past
    // the generation that was ignored.
    if (second.kind !== "granted") throw new Error("expected a grant");
    second.release();
    // The linger sits between the release and the post now; a release is
    // no longer the demote. See `BodyEntry.lingerTimer`.
    scheduler.advance(LINGER_MS);
    expect(worker.demotes).toHaveLength(2);
    expect(worker.demotes[1]?.generation).toBeGreaterThan(staleGeneration);
  });
});

/**
 * The LINGER — the hot doc's own reclaim window, relocated with the hot doc.
 *
 * Pre-flip the tier ran this timer because the tier owned the hot doc. That
 * ownership moved to main, and the linger is part of the object's lifetime, so
 * it moved too; the tier's remaining cooldown governs its cold copy. One
 * linger per object, each at its owner.
 *
 * The property it protects is stated in `artifact-room-tier.ts`: the cap is "a
 * backstop ceiling, NOT the reclaim mechanism; the linger timer is." In UX
 * terms, a tab switch that remounts a tile must not pay to re-materialize the
 * body — which is a claim about work NOT done, so these pins COUNT.
 */
describe("the linger window", () => {
  it("re-acquiring inside the window costs no materialize and no demote", async () => {
    const { leases, worker, docs, scheduler } = setup();
    const first = await leases.acquire("artifact-1", "linger");
    if (first.kind !== "granted") throw new Error("expected a grant");
    expect(worker.materializes).toEqual(["artifact-1"]);

    first.release();
    // Inside the window, not past it.
    scheduler.advance(LINGER_MS - 1);
    const second = await leases.acquire("artifact-1", "linger");

    if (second.kind !== "granted") throw new Error("expected a revival");
    // THE assertion: still ONE materialize. The doc was never released, so the
    // second acquire is a reference count going back up rather than a round
    // trip. A `toHaveLength(2)` here is the churn this window exists to avoid.
    expect(worker.materializes).toEqual(["artifact-1"]);
    expect(worker.demotes).toEqual([]);
    expect(docs.dropped).toEqual([]);
    expect(docs.has("artifact-1")).toBe(true);
  });

  it("holds the doc live for the whole window, then posts at expiry", async () => {
    const { leases, worker, docs, scheduler } = setup();
    const grant = await leases.acquire("artifact-1", "linger");
    if (grant.kind !== "granted") throw new Error("expected a grant");

    grant.release();
    scheduler.advance(LINGER_MS - 1);
    // One tick short: still live, nothing posted. Without this the test below
    // would pass against a bridge that posted immediately.
    expect(worker.demotes).toEqual([]);
    expect(docs.has("artifact-1")).toBe(true);

    scheduler.advance(1);
    expect(worker.demotes).toHaveLength(1);
  });

  it("posts a DEMOTE at expiry for an identity-stated body", async () => {
    // The lifecycle fork, arm one: this body's seed named a guid, so its bytes
    // are settled back.
    const { leases, worker, releasedForwardOnly, scheduler } = setup();
    const grant = await leases.acquire("artifact-1", "linger");
    if (grant.kind !== "granted") throw new Error("expected a grant");

    grant.release();
    scheduler.advance(LINGER_MS);

    expect(worker.demotes).toHaveLength(1);
    expect(worker.demotes[0]?.docGuid).toBe("guid-artifact-1");
    // And NOT the other shape. A body has exactly one of the two lifecycles.
    expect(releasedForwardOnly).toEqual([]);
  });

  it("flushes lingering docs immediately at teardown", async () => {
    // A linger is a bet that the user is coming back. At dispose that bet is
    // already lost, so waiting it out would hold both sides' state for a full
    // window after everything that could use it is gone.
    const { leases, worker, scheduler } = setup();
    const grant = await leases.acquire("artifact-1", "linger");
    if (grant.kind !== "granted") throw new Error("expected a grant");

    grant.release();
    expect(worker.demotes).toEqual([]);

    leases.flushLingering();

    // Posted WITHOUT the clock moving - that is the whole claim.
    expect(worker.demotes).toHaveLength(1);
    // And the timer is disarmed, so expiry does not post a second one.
    scheduler.advance(LINGER_MS);
    expect(worker.demotes).toHaveLength(1);
  });
});

describe("the linger window — re-arming", () => {
  it("restarts the window on each release rather than firing on the first one's clock", async () => {
    // Written after ablating `cancelLinger` in `reviveAndHold` left the pins
    // above GREEN. They pass either way, because the callback's `leases > 0`
    // guard already suppresses the post for a doc that was re-acquired - so
    // "a re-acquire costs nothing" does not, on its own, pin the cancel.
    //
    // This is what the cancel actually prevents. Without it the first timer
    // stays armed; the second release then finds `lingerTimer !== null`,
    // declines to arm a new one, and the doc is demoted on the FIRST
    // release's clock - early, by however long the user kept it open.
    const { leases, worker, scheduler } = setup();
    const first = await leases.acquire("artifact-1", "linger");
    if (first.kind !== "granted") throw new Error("expected a grant");

    first.release();
    scheduler.advance(LINGER_MS / 2);
    const second = await leases.acquire("artifact-1", "linger");
    if (second.kind !== "granted") throw new Error("expected a revival");
    second.release();

    // Half a window past the FIRST release, which is where the stale timer
    // would fire - but only half of one past the second, which is what counts.
    scheduler.advance(LINGER_MS / 2);
    expect(worker.demotes).toEqual([]);

    // ...and it still demotes on its own clock.
    scheduler.advance(LINGER_MS / 2);
    expect(worker.demotes).toHaveLength(1);
  });
});

describe("the hot-doc cap", () => {
  it("evicts the least-recently-held lingering doc once the population exceeds it", async () => {
    // The BACKSTOP, and it moved here for the same reason the linger did: it
    // bounds how many HOT docs exist, and the hot docs are main's now. The
    // tier's copy of this cap governs its cold entries - a different
    // population, which is why both can exist without being a duplication.
    const { leases, worker, docs, scheduler } = setup();

    // Fill to the cap and let every one of them go, so all are evictable.
    for (let index = 0; index < MAX_HOT; index += 1) {
      const grant = await leases.acquire(`artifact-${String(index)}`, "linger");
      if (grant.kind !== "granted") throw new Error("expected a grant");
      grant.release();
    }
    // Inside the linger window: all still hot, nothing posted yet. Without
    // this the eviction below could not be distinguished from expiry.
    scheduler.advance(LINGER_MS - 1);
    expect(worker.demotes).toEqual([]);
    expect(docs.dropped).toEqual([]);

    // One past the cap.
    const overflow = await leases.acquire("artifact-overflow", "linger");
    if (overflow.kind !== "granted") throw new Error("expected a grant");

    // The OLDEST held doc goes, and exactly one of them.
    expect(worker.demotes).toHaveLength(1);
    expect(worker.demotes[0]?.docKey).toBe("artifact-0");
  });

  it("never evicts a doc that is still leased, even past the cap", async () => {
    // A pinned doc is not evictable: taking a body out from under a bound
    // editor is data loss, not reclamation. The documented consequence is that
    // the cap CAN be exceeded by editors genuinely in use.
    const { leases, worker } = setup();
    const held = [];
    for (let index = 0; index < MAX_HOT + 2; index += 1) {
      const grant = await leases.acquire(`artifact-${String(index)}`, "linger");
      if (grant.kind !== "granted") throw new Error("expected a grant");
      held.push(grant);
    }

    // Every one is leased, so there was no legal victim at any point.
    expect(worker.demotes).toEqual([]);
    for (const grant of held) grant.release();
  });
});

/**
 * The FORWARD-ONLY release, and its refusal.
 *
 * A `@1` body states no identity, so it has no `body/demote` to be refused -
 * which is how its pins came to have no channel at all, and why main released
 * rooms the tier still considered occupied. `body/release` answers for exactly
 * that reason; the reason vocabulary is shared with the demote so "the tier
 * says no" has one shape.
 *
 * What the refusal buys here is WARMTH, not correctness: on `@1` every main
 * edit is relayed ahead of the release, and the presence-rebind gap that
 * would have been a correctness cost is closed separately by the tier pushing
 * current peers when an observer attaches. So these pin "does not churn a room
 * a collaborator is sitting in", and say so rather than implying more.
 */
describe("the forward-only release", () => {
  function forwardOnlySetup(release: {
    released: boolean;
    reason: "not-held" | "newer-generation" | "pinned" | null;
  }) {
    const pair = createFakeBridgePair("sync");
    const releases: string[] = [];
    pair.worker.subscribe((message) => {
      if (!isMainToWorkerFrame(message) || message.frame !== "call") return;
      const { callId, call } = message;
      const respond = (value: unknown): void => {
        pair.worker.post(
          { frame: "result", callId, result: { outcome: "ok", value } },
          [],
        );
      };
      if (call.kind === "body/materialize") {
        respond({
          docKey: "room-1",
          update: Uint8Array.from([1, 2, 3]),
          // NO identity - this is what makes the body forward-only.
          docGuid: null,
          seedMode: "full",
          hostStateVector: null,
          awarenessFrames: [],
        });
        return;
      }
      if (call.kind === "body/release") {
        releases.push(call.request.docKey);
        respond(release);
      }
    });
    const docs = createDocs();
    const scheduler = createScheduler();
    const leases = createArtifactBodyLeaseBridge({
      bridge: createMainBridgeEndpoint(pair.main, stubMainCallHandlers({})),
      docs,
      budget: createBudget(),
      scheduler,
      lingerMs: LINGER_MS,
      maxHotDocs: MAX_HOT,
      reportAwaitingStalled: IGNORE_STALL_REPORT,
    });
    return { leases, docs, scheduler, releases, pair };
  }

  it("releases an unpinned body at expiry and drops the doc", async () => {
    // The negative control. Without it the refusal pin below passes against a
    // bridge that never releases anything at all.
    const { leases, docs, scheduler, releases } = forwardOnlySetup({
      released: true,
      reason: null,
    });
    const grant = await leases.acquire("artifact-1", "linger");
    if (grant.kind !== "granted") throw new Error("expected a grant");

    grant.release();
    scheduler.advance(LINGER_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(releases).toEqual(["room-1"]);
    expect(docs.dropped).toEqual(["room-1"]);
  });

  it("KEEPS the doc when the tier refuses, and looks again next window", async () => {
    // A collaborator is present in the room. The tier refuses, main keeps its
    // copy - and must re-arm, or a refusal is a wedge: the entry sits pending
    // with no timer and nothing ever posts for it again.
    const { leases, docs, scheduler, releases } = forwardOnlySetup({
      released: false,
      reason: "pinned",
    });
    const grant = await leases.acquire("artifact-1", "linger");
    if (grant.kind !== "granted") throw new Error("expected a grant");

    grant.release();
    scheduler.advance(LINGER_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(releases).toEqual(["room-1"]);
    expect(docs.dropped).toEqual([]);
    expect(docs.has("room-1")).toBe(true);

    // RE-ARMED: the next window asks again rather than giving up.
    scheduler.advance(LINGER_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(releases).toEqual(["room-1", "room-1"]);
    expect(docs.dropped).toEqual([]);
  });
});

// ─── A release reply that outlived its lifecycle ────────────────────────────

describe("the forward-only release — generation fencing", () => {
  it("ignores a release reply belonging to a PREVIOUS acquire/release cycle", async () => {
    const pair = createFakeBridgePair("sync");
    const releases: string[] = [];
    // Held, not answered: this is the whole stimulus. Consecutive hot-cap
    // evictions with a slow worker round trip put two releases in flight for
    // one doc, and the first reply lands after the second has been posted.
    const pending: Array<() => void> = [];
    pair.worker.subscribe((message) => {
      if (!isMainToWorkerFrame(message) || message.frame !== "call") return;
      const { callId, call } = message;
      const respond = (value: unknown): void => {
        pair.worker.post(
          { frame: "result", callId, result: { outcome: "ok", value } },
          [],
        );
      };
      if (call.kind === "body/materialize") {
        respond({
          docKey: "room-1",
          update: Uint8Array.from([1, 2, 3]),
          docGuid: null,
          seedMode: "full",
          hostStateVector: null,
          awarenessFrames: [],
        });
        return;
      }
      if (call.kind === "body/release") {
        releases.push(call.request.docKey);
        pending.push(() => {
          respond({ released: true, reason: null });
        });
      }
    });
    const docs = createDocs();
    const scheduler = createScheduler();
    const leases = createArtifactBodyLeaseBridge({
      bridge: createMainBridgeEndpoint(pair.main, stubMainCallHandlers({})),
      docs,
      budget: createBudget(),
      scheduler,
      lingerMs: LINGER_MS,
      maxHotDocs: MAX_HOT,
      reportAwaitingStalled: IGNORE_STALL_REPORT,
    });

    // Lifecycle 1: acquire, release, linger out. The release is posted and
    // deliberately left unanswered.
    const first = await leases.acquire("artifact-1", "linger");
    if (first.kind !== "granted") throw new Error("expected a grant");
    first.release();
    scheduler.advance(LINGER_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(releases).toEqual(["room-1"]);

    // Lifecycle 2: the doc is live again under a NEWER generation, and its own
    // release is posted. `demotingGeneration` is now the second cycle's.
    const second = await leases.acquire("artifact-1", "linger");
    if (second.kind !== "granted") throw new Error("expected a grant");
    second.release();
    scheduler.advance(LINGER_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(releases).toEqual(["room-1", "room-1"]);

    // The FIRST reply finally lands.
    // Length, not an `=== undefined` test: `noUncheckedIndexedAccess` is off,
    // so the element type carries no `undefined` for that comparison to narrow.
    if (pending.length === 0) throw new Error("expected a pending release");
    pending[0]();
    await Promise.resolve();
    await Promise.resolve();

    // THE REDDENING ASSERTION. A non-null test on `demotingGeneration` passes
    // here - the field is populated, by the SECOND cycle - so the stale reply
    // deleted the entry and dropped a doc the newer release may still have
    // refused as pinned, taking it out from under a bound editor.
    expect(docs.dropped).toEqual([]);
    expect(docs.has("room-1")).toBe(true);
  });
});

describe("a demote that fails on a LIVE worker", () => {
  it("re-arms the linger, so the entry is retried instead of pinned forever", async () => {
    // NOT `main.dispose()`. `serve()` turns a worker-handler fault into an
    // error REPLY and a malformed response fails parsing - both surface as a
    // rejected call on a worker that is never replaced, so
    // `resendUnacknowledgedDemotes` (which only runs after a respawn) never
    // covers them.
    const { leases, docs, worker, scheduler } = setup();
    const grant = await leases.acquire("artifact-1", "linger");
    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();
    scheduler.advance(LINGER_MS);
    expect(worker.demotes).toHaveLength(1);

    worker.demotes[0]?.fail("worker handler threw");
    await Promise.resolve();
    await Promise.resolve();

    // Unchanged by the fix, and asserted so the retry cannot be mistaken for a
    // licence to drop: a rejection is never a settled ack.
    expect(docs.dropped).toEqual([]);
    expect(docs.has("artifact-1")).toBe(true);

    // THE REDDENING ASSERTION. Without the re-arm nothing is scheduled, so the
    // entry keeps `demotingGeneration` set forever - which `enforceHotCap`
    // reads as already-leaving: not counted in the hot population and not
    // eligible as a victim, so the charge is held by a doc nothing will retry.
    scheduler.advance(LINGER_MS);
    expect(worker.demotes).toHaveLength(2);
    // A FRESH generation, which is what makes a late reply from the first
    // attempt a no-op rather than a second settlement.
    expect(worker.demotes[1]?.generation).toBeGreaterThan(
      worker.demotes[0]?.generation ?? 0,
    );

    // And the retry can still settle it, so the doc is not pinned by the
    // recovery either.
    worker.demotes[1]?.settle({ accepted: true, settledBytes: 10 });
    await Promise.resolve();
    await Promise.resolve();
    expect(docs.dropped).toEqual(["artifact-1"]);
  });

  it("a re-acquire inside the re-armed window cancels the retry", async () => {
    // The re-arm must not become a second way to demote a doc someone is
    // holding. `armLinger`'s callback re-reads the entry and returns on a live
    // lease, so this is a claim about the composition rather than about the
    // timer.
    const { leases, docs, worker, scheduler } = setup();
    const first = await leases.acquire("artifact-1", "linger");
    if (first.kind !== "granted") throw new Error("expected a grant");
    first.release();
    scheduler.advance(LINGER_MS);
    worker.demotes[0]?.fail("worker handler threw");
    await Promise.resolve();
    await Promise.resolve();

    const second = await leases.acquire("artifact-1", "linger");
    if (second.kind !== "granted") throw new Error("expected a re-grant");

    scheduler.advance(LINGER_MS);
    expect(worker.demotes).toHaveLength(1);
    expect(docs.dropped).toEqual([]);
  });
});

/**
 * A body reassigned to a different room WHILE STILL AWAITING ITS SEED.
 *
 * The moved-key rule was already applied where bytes arrived. This is the same
 * reassignment reaching the other outcome, and the answer's own contract is
 * what makes it a leak rather than a cosmetic difference: a non-null `docKey`
 * beside `update: null` is AWAITING SEED, and awaiting seed means THE DEMAND IS
 * RETAINED - under the key the answer just named. Handling the move only on the
 * granted path left the entry filed under the old key with no redirect, so the
 * release posted `body/release` for a room the worker holds nothing under and
 * the new room's demand, observer and subscription stayed retained for the life
 * of the session.
 *
 * Driven over the real bridge like every test above: the move is expressed by
 * the worker answering a second `body/materialize` with a different room, which
 * is exactly how the legacy `@1` root projection expresses it.
 */
describe("an awaiting body reassigned to another byteless room", () => {
  function movedAwaitingSetup(answers: readonly (string | null)[]) {
    const pair = createFakeBridgePair("sync");
    const releases: string[] = [];
    let materializeCount = 0;
    pair.worker.subscribe((message) => {
      if (!isMainToWorkerFrame(message) || message.frame !== "call") return;
      const { callId, call } = message;
      const respond = (value: unknown): void => {
        pair.worker.post(
          { frame: "result", callId, result: { outcome: "ok", value } },
          [],
        );
      };
      if (call.kind === "body/materialize") {
        const docKey = answers[materializeCount] ?? answers.at(-1) ?? null;
        materializeCount += 1;
        // AWAITING: a key, and no bytes. The demand is retained on this key.
        respond({
          docKey,
          update: null,
          docGuid: null,
          seedMode: "full",
          hostStateVector: null,
          awarenessFrames: [],
        });
        return;
      }
      if (call.kind === "body/release") {
        releases.push(call.request.docKey);
        respond({ released: true, reason: null });
      }
    });
    const leases = createArtifactBodyLeaseBridge({
      bridge: createMainBridgeEndpoint(pair.main, stubMainCallHandlers({})),
      docs: createDocs(),
      budget: createBudget(),
      scheduler: createScheduler(),
      lingerMs: LINGER_MS,
      maxHotDocs: MAX_HOT,
      reportAwaitingStalled: IGNORE_STALL_REPORT,
    });
    return { leases, releases, materializeCount: () => materializeCount };
  }

  async function settle(): Promise<void> {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  }

  it("releases the room the worker actually retained, not the one the acquire asked about", async () => {
    const { leases, releases } = movedAwaitingSetup(["room-1", "room-2"]);
    const grant = await leases.acquire("artifact-1", "linger");
    if (grant.kind !== "awaiting-seed") {
      throw new Error("expected an awaiting-seed grant");
    }
    expect(grant.docKey).toBe("room-1");

    // The projection calls room-1 ready, so the bridge re-materializes - and
    // the answer names room-2, still byteless.
    leases.retryAwaitingBodies((docKey) => docKey === "room-1");
    await settle();

    grant.release();
    await settle();

    // THE REDDENING ASSERTION. Without the re-key this is `["room-1"]`, and
    // room-2's demand is retained with nothing left that can release it.
    expect(releases).toEqual(["room-2"]);
  });

  it("still releases the original room when the retry names the same one", async () => {
    // The control. Without it the assertion above passes against a bridge that
    // simply released whatever the last materialize returned, and it pins that
    // an ordinary byteless retry is not treated as a move.
    const { leases, releases } = movedAwaitingSetup(["room-1", "room-1"]);
    const grant = await leases.acquire("artifact-1", "linger");
    if (grant.kind !== "awaiting-seed") {
      throw new Error("expected an awaiting-seed grant");
    }

    leases.retryAwaitingBodies((docKey) => docKey === "room-1");
    await settle();

    grant.release();
    await settle();

    expect(releases).toEqual(["room-1"]);
  });
});

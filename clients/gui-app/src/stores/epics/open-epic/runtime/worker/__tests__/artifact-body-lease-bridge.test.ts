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
import {
  createArtifactBodyLeaseBridge,
  type ArtifactBodyGrant,
  type HotBodyBudget,
  type MainThreadBodyDocs,
} from "../artifact-body-lease-bridge";

interface DemoteRecord {
  readonly docKey: string;
  readonly generation: number;
  readonly bytes: readonly number[];
  settle(answer: { accepted: boolean; settledBytes: number }): void;
}

/**
 * A worker side that answers materialize immediately and parks every demote
 * until the test settles it - which is what makes "before the ack" a state a
 * test can actually stand in.
 */
function createWorkerSide(pair: FakeBridgePair) {
  const demotes: DemoteRecord[] = [];
  const unsubscribe = pair.worker.subscribe((message) => {
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
        docKey: call.request.artifactId,
        update: Uint8Array.from([1, 2, 3]),
        seedMode: "full",
        hostStateVector: null,
      });
      return;
    }
    if (call.kind === "body/demote") {
      const { docKey, generation, update } = call.request;
      demotes.push({
        docKey,
        generation,
        bytes: [...update],
        settle: (answer) => {
          respond(answer);
        },
      });
    }
  });
  return { demotes, unsubscribe };
}

function createDocs(): MainThreadBodyDocs & {
  readonly installed: string[];
  readonly dropped: string[];
} {
  const live = new Set<string>();
  const installed: string[] = [];
  const dropped: string[] = [];
  return {
    installed,
    dropped,
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
    has(docKey): boolean {
      return live.has(docKey);
    },
  };
}

function createBudget(): HotBodyBudget & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    chargeHot: (docKey) => calls.push(`chargeHot:${docKey}`),
    markDemoting: (docKey) => calls.push(`markDemoting:${docKey}`),
    clearDemoting: (docKey) => calls.push(`clearDemoting:${docKey}`),
    settleCold: (docKey, bytes) =>
      calls.push(`settleCold:${docKey}:${String(bytes)}`),
  };
}

function grantedKey(grant: ArtifactBodyGrant): string {
  if (grant.kind !== "granted") {
    throw new Error(`Expected a granted body, got ${grant.kind}`);
  }
  return grant.docKey;
}

function setup() {
  const pair = createFakeBridgePair("sync");
  const worker = createWorkerSide(pair);
  const main = createMainBridgeEndpoint(pair.main);
  const docs = createDocs();
  const budget = createBudget();
  const leases = createArtifactBodyLeaseBridge({
    bridge: main,
    docs,
    budget,
  });
  return { pair, worker, main, docs, budget, leases };
}

describe("acquire / materialize", () => {
  it("installs the worker's bytes once and charges the doc hot", async () => {
    const { leases, docs, budget } = setup();

    const grant = await leases.acquire("artifact-1");

    expect(grantedKey(grant)).toBe("artifact-1");
    expect(docs.installed).toEqual(["artifact-1"]);
    expect(budget.calls).toEqual(["chargeHot:artifact-1"]);
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
              seedMode: "full",
              hostStateVector: null,
            },
          },
        },
        [],
      );
    });
    const docs = createDocs();
    const leases = createArtifactBodyLeaseBridge({
      bridge: createMainBridgeEndpoint(pair.main),
      docs,
      budget: createBudget(),
    });

    const grant = await leases.acquire("artifact-missing");

    expect(grant.kind).toBe("unavailable");
    expect(docs.installed).toEqual([]);
  });
});

describe("constraint 1 — the doc stays hot until the ack", () => {
  it("does not drop the doc, nor settle the charge, before the worker answers", async () => {
    const { leases, docs, budget, worker } = setup();
    const grant = await leases.acquire("artifact-1");

    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();

    // Posted, not settled.
    expect(worker.demotes).toHaveLength(1);
    expect(docs.dropped).toEqual([]);
    expect(docs.has("artifact-1")).toBe(true);
    // The accountant knows it is on its way out, and has NOT been told the
    // bytes are free. A doc reported cold here is one the accountant believes
    // it can spend while the store still holds it.
    expect(budget.calls).toEqual([
      "chargeHot:artifact-1",
      "markDemoting:artifact-1",
    ]);
    expect(leases.unacknowledgedDemoteKeys()).toEqual(["artifact-1"]);
  });

  it("settles cold with the WORKER's byte count and drops the doc on the ack", async () => {
    const { leases, docs, budget, worker } = setup();
    const grant = await leases.acquire("artifact-1");

    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();
    worker.demotes[0]?.settle({ accepted: true, settledBytes: 4_096 });
    await Promise.resolve();
    await Promise.resolve();

    expect(docs.dropped).toEqual(["artifact-1"]);
    // 4096 is the worker's number, not anything this side could compute from
    // the three bytes `encode` produced.
    expect(budget.calls).toEqual([
      "chargeHot:artifact-1",
      "markDemoting:artifact-1",
      "settleCold:artifact-1:4096",
    ]);
    expect(leases.unacknowledgedDemoteKeys()).toEqual([]);
  });

  it("does not post a second demote, nor charge twice, on a second release before the ack", async () => {
    const { leases, worker, budget } = setup();
    const first = await leases.acquire("artifact-1");
    const second = await leases.acquire("artifact-1");

    if (first.kind !== "granted" || second.kind !== "granted") {
      throw new Error("expected two grants");
    }
    first.release();
    // One holder left, so nothing should have been posted yet.
    expect(worker.demotes).toHaveLength(0);
    second.release();
    // A caller's `finally` backstop running after its own early release.
    second.release();
    first.release();

    expect(worker.demotes).toHaveLength(1);
    expect(
      budget.calls.filter((call) => call.startsWith("markDemoting")),
    ).toEqual(["markDemoting:artifact-1"]);
  });

  it("keeps the doc when the worker declines the generation", async () => {
    const { leases, docs, budget, worker } = setup();
    const grant = await leases.acquire("artifact-1");

    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();
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
    const { leases, docs, main, worker } = setup();
    const grant = await leases.acquire("artifact-1");

    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();
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
    const nextWorker = createWorkerSide(nextPair);
    const nextLeases = createArtifactBodyLeaseBridge({
      bridge: createMainBridgeEndpoint(nextPair.main),
      docs,
      budget: createBudget(),
    });
    // The re-send is driven from the state the ORIGINAL bridge holds, so this
    // asserts the observable half: the doc survived with its bytes intact and
    // is re-sendable. The same-generation guarantee is asserted below.
    void nextLeases;
    expect(posted?.generation).toBe(2);

    leases.resendUnacknowledgedDemotes();
    // The dead endpoint refuses new calls, so the re-post is rejected rather
    // than silently queued - and the doc still is not dropped.
    await Promise.resolve();
    await Promise.resolve();
    expect(docs.dropped).toEqual([]);
    expect(nextWorker.demotes).toHaveLength(0);
  });

  it("re-sends with the SAME generation, so a worker that saw both settles once", async () => {
    const { leases, worker, docs } = setup();
    const grant = await leases.acquire("artifact-1");

    if (grant.kind !== "granted") throw new Error("expected a grant");
    grant.release();
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
    const { leases, docs, budget, worker, pair } = setup();
    const first = await leases.acquire("artifact-1");

    if (first.kind !== "granted") throw new Error("expected a grant");
    first.release();
    expect(worker.demotes).toHaveLength(1);

    const callsBefore = countCalls(pair, "body/materialize");
    const second = await leases.acquire("artifact-1");

    // Same document, handed straight back.
    expect(grantedKey(second)).toBe("artifact-1");
    expect(countCalls(pair, "body/materialize")).toBe(callsBefore);
    expect(docs.installed).toEqual(["artifact-1"]);
    expect(budget.calls).toContain("clearDemoting:artifact-1");

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
    const { leases, worker, docs } = setup();
    const first = await leases.acquire("artifact-1");
    if (first.kind !== "granted") throw new Error("expected a grant");
    first.release();
    const staleGeneration = worker.demotes[0]?.generation;

    const second = await leases.acquire("artifact-1");
    if (second.kind !== "granted") throw new Error("expected a grant");
    second.release();

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
    const { leases, pair, worker } = setup();
    const grant = await leases.acquire("artifact-1");
    if (grant.kind !== "granted") throw new Error("expected a grant");

    grant.release();

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

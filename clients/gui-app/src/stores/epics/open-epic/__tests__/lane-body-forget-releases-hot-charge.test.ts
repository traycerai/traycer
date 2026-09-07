/**
 * `forget()` must release the hot-doc charge, not just drop the entry.
 *
 * A body is charged through `budget.chargeHot(docKey, bytes)` when it is
 * installed. Both acknowledged demote paths end in the same triple - delete the
 * entry, `budget.settleCold(...)`, drop the doc - but `forget()` did only the
 * first. `dropBodiesWhoseRoomIsGone()` calls it whenever a binding-epoch change
 * or a projection update makes a resident room disappear, and then destroys the
 * main-thread Y.Doc, so every forgotten room left a permanent phantom holder in
 * a process-wide budget for a body that no longer exists anywhere. The plane
 * reads over limit and evicts unrelated LIVE documents to get back under it.
 *
 * ## Why the method's own doc comment does not excuse it
 *
 * It argues "there is nothing on the far side to settle bytes back INTO, so a
 * demote would be answered `not-held`". That is true and it is about the
 * WORKER - it justifies not POSTING a demote. `budget` is main-side
 * accounting, and nothing about the worker's replicas being gone releases a
 * charge the main thread took. The two got conflated, which is the whole bug.
 *
 * Zero settled bytes is the right argument, and the acknowledged path already
 * states it: "No bytes came back, so nothing to record cold - only the hot
 * charge is released."
 */
import { describe, expect, it } from "vitest";
import { stubMainCallHandlers } from "@traycer-clients/shared/replica-runtime/worker/test-support/stub-main-call-handlers";
import { createMainBridgeEndpoint } from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import {
  createFakeBridgePair,
  type FakeBridgePair,
} from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-bridge-pair";
import { isMainToWorkerFrame } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { RuntimeScheduler } from "@traycer-clients/shared/replica-runtime";
import {
  createArtifactBodyLeaseBridge,
  type ArtifactBodyLeaseBridge,
  type HotBodyBudget,
  type MainThreadBodyDocs,
} from "../runtime/worker/artifact-body-lease-bridge";

const LINGER_MS = 60_000;
const MAX_HOT = 10;
const ARTIFACT_ID = "artifact-1";
const DOC_KEY = "room-1";
/** Any non-empty payload: the charge is taken on `update.byteLength`. */
const BODY_BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

/**
 * Answers every `body/materialize` with bytes, so installation charges hot.
 *
 * Shaped like `artifact-body-lease-bridge.test.ts`'s worker side - the value is
 * posted through an `unknown` seam rather than a `BridgeCallResult<...>`
 * literal, because the generic response type does not narrow through the frame
 * union and the annotated form lands on `no-unsafe-assignment`.
 */
function createGrantingWorker(pair: FakeBridgePair): void {
  pair.worker.subscribe((message) => {
    if (!isMainToWorkerFrame(message) || message.frame !== "call") return;
    const { callId, call } = message;
    if (call.kind !== "body/materialize") return;
    const respond = (value: unknown): void => {
      pair.worker.post(
        { frame: "result", callId, result: { outcome: "ok", value } },
        [],
      );
    };
    respond({
      docKey: DOC_KEY,
      update: BODY_BYTES,
      // A granted materialize always names its document; the bridge refuses a
      // guidless grant rather than installing a doc it could never demote.
      docGuid: "guid-1",
      seedMode: "full",
      hostStateVector: null,
      awarenessFrames: [],
    });
  });
}

interface BudgetLog {
  readonly charged: ReadonlyArray<{
    readonly docKey: string;
    readonly bytes: number;
  }>;
  readonly settled: ReadonlyArray<{
    readonly docKey: string;
    readonly settledBytes: number;
  }>;
}

function createRecordingBudget(): { port: HotBodyBudget; log: BudgetLog } {
  const charged: { docKey: string; bytes: number }[] = [];
  const settled: { docKey: string; settledBytes: number }[] = [];
  return {
    port: {
      chargeHot: (docKey, bytes) => charged.push({ docKey, bytes }),
      settleCold: (docKey, settledBytes) =>
        settled.push({ docKey, settledBytes }),
    },
    log: { charged, settled },
  };
}

function createInertDocs(): MainThreadBodyDocs {
  return {
    install: () => undefined,
    encode: () => Uint8Array.from([]),
    drop: () => undefined,
    has: () => false,
    applyRemoteAwareness: () => undefined,
  };
}

function createInertScheduler(): RuntimeScheduler {
  return {
    schedule: () => ({ cancel: () => undefined }),
    scheduleMicrotask: (callback) => callback(),
  };
}

function setup(): { leases: ArtifactBodyLeaseBridge; log: BudgetLog } {
  const pair = createFakeBridgePair("sync");
  createGrantingWorker(pair);
  const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));
  const budget = createRecordingBudget();
  const leases = createArtifactBodyLeaseBridge({
    bridge: main,
    docs: createInertDocs(),
    budget: budget.port,
    scheduler: createInertScheduler(),
    lingerMs: LINGER_MS,
    maxHotDocs: MAX_HOT,
    reportAwaitingStalled: () => undefined,
  });
  return { leases, log: budget.log };
}

describe("forget() - the binding-epoch drop path", () => {
  it("releases the hot charge it was given at installation", async () => {
    const { leases, log } = setup();

    const grant = await leases.acquire(ARTIFACT_ID, "linger");
    if (grant.kind !== "granted") {
      throw new Error(`expected a granted lease, got ${grant.kind}`);
    }

    // ANTI-VACUITY: the charge really happened, so the release below is
    // releasing something. Without this the test would pass on a build where
    // installation never charged at all.
    expect(log.charged).toEqual([
      { docKey: DOC_KEY, bytes: BODY_BYTES.byteLength },
    ]);
    expect(log.settled).toEqual([]);

    // The room is gone - `dropBodiesWhoseRoomIsGone`'s call, verbatim.
    leases.forget(DOC_KEY);

    // Charged once, released once. Under the unfixed tree `settled` stays
    // empty and the eight bytes are held against the process-wide budget
    // forever, for a doc the caller destroys on the very next line.
    expect(log.settled).toEqual([{ docKey: DOC_KEY, settledBytes: 0 }]);
  });

  it("stays silent for a doc key it never held", () => {
    const { leases, log } = setup();

    // The early return must not settle: releasing a charge that was never
    // taken would credit the budget for bytes nobody charged, which is the
    // same accounting error with the sign flipped.
    leases.forget("room-never-held");

    expect(log.charged).toEqual([]);
    expect(log.settled).toEqual([]);
  });
});

/**
 * Concurrent acquires for one artifact, answered ONE AT A TIME.
 *
 * ## The defect this pins (epic-sync-overhaul finding 11)
 *
 * `CollabTileBody` takes two body leases, and the canvas remounts it during
 * boot, so four `acquire` calls for one artifact are outstanding at once. The
 * worker keeps exactly ONE demand per doc key, and on the lane arm that demand
 * IS the `artifact.subscribe` subscription. Measured in the running app:
 *
 *   +7551  four concurrent `body/materialize`; the `awaiting` map is EMPTY
 *   +7625  an awaiting entry is created  (`leasesNow: 1, fresh: true`)
 *   +7625  ...and destroyed by a release that arrives before the next answer
 *   +7626  `body/release` posted -> the worker's one demand goes to zero
 *          -> `closeLane` -> the subscription is torn down BEFORE it dialled
 *   +7629  a fresh entry finally reaches `leasesNow: 2`, three ms too late
 *
 * The ledger is not mis-counting. It is being BUILT AND TORN DOWN concurrently
 * with the releases that read it: a holder is counted only when ITS OWN
 * materialize resolves, so a release belonging to an earlier holder can drive
 * the count to zero while three later holders are already waiting. The tile
 * then sits on the absent-key `"unavailable"` default with nothing to retry it.
 *
 * ## Why the pin lives HERE
 *
 * Two full-stack attempts could not fail on this. `openStoreForTest`'s pipe
 * answers each call before the next caller starts, and even the queued bridge's
 * `flush()` drains atomically - it delivers all four answers in sequence, so
 * the count rises cleanly to four and the lane correctly survives. Expressing
 * the defect needs delivery at FRAME granularity, and the object whose ledger
 * is wrong can be driven directly. The store and worker-host layers above were
 * shown innocent: they call this bridge and nothing else.
 *
 * ## The observable
 *
 * `body/release` is the drain. Posting it drops the worker's single demand,
 * which is what closes the subscription, so "the bridge must not post
 * `body/release` while holders remain" is the invariant stated in the terms the
 * failure actually takes.
 */
import { describe, expect, it } from "vitest";
import { createMainBridgeEndpoint } from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import {
  createFakeBridgePair,
  type FakeBridgePair,
} from "@traycer-clients/shared/replica-runtime/worker/test-support/fake-bridge-pair";
import { isMainToWorkerFrame } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import { stubMainCallHandlers } from "@traycer-clients/shared/replica-runtime/worker/test-support/stub-main-call-handlers";
import type {
  RuntimeScheduler,
  RuntimeTimer,
} from "@traycer-clients/shared/replica-runtime";
import {
  createArtifactBodyLeaseBridge,
  type ArtifactBodyGrant,
  type HotBodyBudget,
  type MainThreadBodyDocs,
} from "../artifact-body-lease-bridge";

const ARTIFACT = "art-1";
/** The lane arm answers `docKey === artifactId`. */
const DOC_KEY = ARTIFACT;
const LINGER_MS = 60_000;
const MAX_HOT = 3;

function createDocs(): MainThreadBodyDocs {
  const live = new Set<string>();
  return {
    install: (input) => {
      live.add(input.docKey);
    },
    encode: () => Uint8Array.from([]),
    drop: (docKey) => {
      live.delete(docKey);
    },
    has: (docKey) => live.has(docKey),
    applyRemoteAwareness: () => undefined,
  };
}

function createBudget(): HotBodyBudget {
  return { chargeHot: () => undefined, settleCold: () => undefined };
}

function createScheduler(): RuntimeScheduler {
  return {
    schedule(): RuntimeTimer {
      return { cancel: () => undefined };
    },
    scheduleMicrotask(callback): void {
      callback();
    },
  };
}

interface SteppedWorkerSide {
  /** One thunk per materialize the bridge has issued and nobody has answered. */
  readonly pendingMaterializes: readonly (() => void)[];
  /** Every `body/release` the bridge posted, in order. THE observable. */
  readonly releasedDocKeys: readonly string[];
  /** Answer exactly one outstanding materialize, oldest first. */
  answerNext(): Promise<void>;
}

/**
 * A worker side that PARKS every `body/materialize` until the test answers it.
 *
 * That parking is the whole point: it is the only way to stand in the state the
 * field was in - several acquires outstanding, none of them counted yet.
 */
function createSteppedWorkerSide(pair: FakeBridgePair): SteppedWorkerSide {
  const pendingMaterializes: Array<() => void> = [];
  const releasedDocKeys: string[] = [];

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
      // AWAITING: a doc key, and no bytes yet. The cold open on the lane arm,
      // and the answer whose holder must still be counted.
      pendingMaterializes.push(() =>
        respond({
          docKey: DOC_KEY,
          update: null,
          docGuid: null,
          seedMode: "full",
          hostStateVector: null,
          awarenessFrames: [],
        }),
      );
      return;
    }
    if (call.kind === "body/release") {
      releasedDocKeys.push(call.request.docKey);
      respond({ released: true });
    }
  });

  return {
    pendingMaterializes,
    releasedDocKeys,
    /** Answer exactly one outstanding materialize, oldest first. */
    async answerNext(): Promise<void> {
      const answer = pendingMaterializes.shift();
      if (answer === undefined) throw new Error("no materialize outstanding");
      answer();
      await pair.flush();
    },
  };
}

describe("four concurrent acquires for one artifact", () => {
  it("does not post body/release while later holders are still waiting on their answer", async () => {
    const pair = createFakeBridgePair("sync");
    const worker = createSteppedWorkerSide(pair);
    const leases = createArtifactBodyLeaseBridge({
      bridge: createMainBridgeEndpoint(pair.main, stubMainCallHandlers({})),
      docs: createDocs(),
      budget: createBudget(),
      scheduler: createScheduler(),
      lingerMs: LINGER_MS,
      maxHotDocs: MAX_HOT,
      reportAwaitingStalled: () => undefined,
    });

    // THE FIELD SEQUENCE. Four holders ask before any of them is answered -
    // two hooks per mount, two mounts - so none of them can see an entry the
    // others have not installed yet.
    const grants: Promise<ArtifactBodyGrant>[] = [
      leases.acquire(ARTIFACT),
      leases.acquire(ARTIFACT),
      leases.acquire(ARTIFACT),
      leases.acquire(ARTIFACT),
    ];
    await pair.flush();
    expect(worker.pendingMaterializes.length).toBeGreaterThan(0);

    // Answer the FIRST one only. Three holders are still outstanding.
    await worker.answerNext();
    const first = await grants[0];
    if (first.kind === "unavailable") {
      throw new Error(`expected a held grant, got ${first.reason}`);
    }

    // The first mount goes away while the later holders are still waiting.
    first.release();
    await pair.flush();

    // THE PIN. Three holders are outstanding, so the demand they are waiting on
    // must still be held. Before the fix the first holder's release found a
    // count of one - itself - dropped it to zero and posted the release that
    // closes the subscription out from under them.
    expect(worker.releasedDocKeys).toEqual([]);

    // And the survivors must still reach a held grant rather than an refusal.
    while (worker.pendingMaterializes.length > 0) await worker.answerNext();
    for (const pending of grants.slice(1)) {
      const grant = await pending;
      if (grant.kind === "unavailable") {
        throw new Error(`a surviving holder was refused: ${grant.reason}`);
      }
    }
    expect(worker.releasedDocKeys).toEqual([]);
  });

  it("posts body/release once the last concurrent holder lets go", async () => {
    // The counterpart: coalescing to a single demand is correct and is kept, so
    // a fix that simply stopped posting the release would leak a subscription
    // per artifact ever opened and would satisfy the case above.
    const pair = createFakeBridgePair("sync");
    const worker = createSteppedWorkerSide(pair);
    const leases = createArtifactBodyLeaseBridge({
      bridge: createMainBridgeEndpoint(pair.main, stubMainCallHandlers({})),
      docs: createDocs(),
      budget: createBudget(),
      scheduler: createScheduler(),
      lingerMs: LINGER_MS,
      maxHotDocs: MAX_HOT,
      reportAwaitingStalled: () => undefined,
    });

    const grants = [leases.acquire(ARTIFACT), leases.acquire(ARTIFACT)];
    await pair.flush();
    while (worker.pendingMaterializes.length > 0) await worker.answerNext();

    for (const pending of grants) {
      const grant = await pending;
      if (grant.kind === "unavailable") {
        throw new Error(`expected a held grant, got ${grant.reason}`);
      }
      grant.release();
    }
    await pair.flush();

    expect(worker.releasedDocKeys).toEqual([DOC_KEY]);
  });
});

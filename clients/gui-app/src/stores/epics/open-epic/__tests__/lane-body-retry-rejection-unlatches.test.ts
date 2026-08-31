/**
 * Regression pin for `startAwaitingRetry`'s rejection arm
 * (`runtime/worker/artifact-body-lease-bridge.ts`).
 *
 * `startAwaitingRetry` issues a detached `bridge.call("body/materialize", …)`
 * to re-drive an awaiting body once its room reads ready. Every OTHER
 * detached bridge call in this module takes the two-argument `.then(fulfilled,
 * rejected)` form; this one used to take a fulfillment-only `.then`, so a
 * worker-handler fault (or a disposed bridge) left `held.retrying` latched
 * `true` FOREVER. Every later ready/seed push then took the `held.retrying`
 * branch and merely set `retryRequested` for a call that no longer existed -
 * the artifact awaited for the life of the session, a permanently blank tile
 * from one transient failure.
 *
 * This drives `createArtifactBodyLeaseBridge` directly, over the same
 * `createFakeBridgePair` / `createMainBridgeEndpoint` / `stubMainCallHandlers`
 * primitives `runtime/worker/__tests__/artifact-body-lease-bridge.test.ts`
 * uses for this exact module - the level at which a specific `body/materialize`
 * call can be made to REJECT (via a scripted worker-side handler answering
 * `{ outcome: "error", … }`) while the bridge stays alive for later calls,
 * which the full-store lane rigs in this directory do not expose control over.
 *
 * `DOC_KEY` is deliberately DIFFERENT from `ARTIFACT_ID` (the `@1`-arm shape,
 * where `docKey` is a room id) so an argument-order mistake in
 * `reportAwaitingStalled(docKey, artifactId)` cannot hide behind the two
 * strings being equal.
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

/**
 * What the worker should do for one `body/materialize` call.
 *
 * A local two-member union rather than
 * `BridgeCallResult<RuntimeWorkerCallResponse<"body/materialize">>`: that
 * generic does not narrow through the frame union, so the annotated form lands
 * on `no-unsafe-assignment`. The answer is posted through an `unknown` seam
 * instead, which is the idiom `artifact-body-lease-bridge.test.ts` already
 * uses for the same worker side.
 */
type CannedAnswer = "awaiting-seed" | "reject";

const AWAITING_SEED: CannedAnswer = "awaiting-seed";
const REJECT: CannedAnswer = "reject";

/** Answers each `body/materialize` call with the next canned result, in order. */
function createScriptedWorker(
  pair: FakeBridgePair,
  script: readonly CannedAnswer[],
): { readonly materializeCalls: readonly string[] } {
  const materializeCalls: string[] = [];
  const queue = [...script];
  pair.worker.subscribe((message) => {
    if (!isMainToWorkerFrame(message) || message.frame !== "call") return;
    const { callId, call } = message;
    if (call.kind !== "body/materialize") return;
    materializeCalls.push(call.request.artifactId);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(
        "createScriptedWorker: no canned answer left for a body/materialize call",
      );
    }
    if (next === "reject") {
      pair.worker.post(
        {
          frame: "result",
          callId,
          result: {
            outcome: "error",
            name: "Error",
            message: "materialize failed",
          },
        },
        [],
      );
      return;
    }
    const value: unknown = {
      docKey: DOC_KEY,
      update: null,
      docGuid: null,
      seedMode: "full",
      hostStateVector: null,
      awarenessFrames: [],
    };
    pair.worker.post(
      { frame: "result", callId, result: { outcome: "ok", value } },
      [],
    );
  });
  return { materializeCalls };
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

function createInertBudget(): HotBodyBudget {
  return {
    chargeHot: () => undefined,
    settleCold: () => undefined,
  };
}

function createInertScheduler(): RuntimeScheduler {
  return {
    schedule: () => ({ cancel: () => undefined }),
    scheduleMicrotask: (callback) => callback(),
  };
}

interface Rig {
  readonly leases: ArtifactBodyLeaseBridge;
  readonly worker: { readonly materializeCalls: readonly string[] };
  readonly stalled: ReadonlyArray<{
    readonly docKey: string;
    readonly artifactId: string;
  }>;
}

function setup(script: readonly CannedAnswer[]): Rig {
  const pair = createFakeBridgePair("sync");
  const worker = createScriptedWorker(pair, script);
  const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));
  const stalled: { docKey: string; artifactId: string }[] = [];
  const leases = createArtifactBodyLeaseBridge({
    bridge: main,
    docs: createInertDocs(),
    budget: createInertBudget(),
    scheduler: createInertScheduler(),
    lingerMs: LINGER_MS,
    maxHotDocs: MAX_HOT,
    reportAwaitingStalled: (docKey, artifactId) => {
      stalled.push({ docKey, artifactId });
    },
  });
  return { leases, worker, stalled };
}

/** Two microtask turns - enough for a `.then(fulfilled, rejected)` handler
 * chained onto an already-settled promise to run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("startAwaitingRetry - the rejection arm unlatches retrying", () => {
  it("issues a fresh body/materialize on a LATER push, instead of silently swallowing it forever", async () => {
    const { leases, worker } = setup([
      AWAITING_SEED, // the initial acquire
      REJECT, // the first retry - REJECTS
      AWAITING_SEED, // the second retry, once unlatched
    ]);

    const grant = await leases.acquire(ARTIFACT_ID);
    if (grant.kind !== "awaiting-seed") {
      throw new Error(`expected an awaiting-seed grant, got ${grant.kind}`);
    }
    expect(worker.materializeCalls).toHaveLength(1);

    // The room reads ready: the projection's ordinary re-drive trigger.
    leases.retryAwaitingBodies(() => true);
    expect(worker.materializeCalls).toHaveLength(2);

    // Let the rejection's `.then` handler run.
    await flushMicrotasks();

    // A LATER push - exactly what a subsequent projection delivery does. The
    // old fulfillment-only `.then` never unlatched `retrying`, so this call
    // was swallowed into `retryRequested` for an in-flight call that no
    // longer existed, and no fresh `body/materialize` was ever issued again.
    leases.retryAwaitingBodies(() => true);
    expect(worker.materializeCalls).toHaveLength(3);
  });

  it("with no pending push, reports the stall through reportAwaitingStalled", async () => {
    const { leases, worker, stalled } = setup([AWAITING_SEED, REJECT]);

    const grant = await leases.acquire(ARTIFACT_ID);
    if (grant.kind !== "awaiting-seed") {
      throw new Error(`expected an awaiting-seed grant, got ${grant.kind}`);
    }

    leases.retryAwaitingBodies(() => true);
    await flushMicrotasks();

    expect(worker.materializeCalls).toHaveLength(2);
    expect(stalled).toEqual([{ docKey: DOC_KEY, artifactId: ARTIFACT_ID }]);
  });
});

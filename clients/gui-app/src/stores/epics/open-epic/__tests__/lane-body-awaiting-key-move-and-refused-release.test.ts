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
const MOVED_DOC_KEY = "room-2";

/** Timers the bridge armed, fireable by the test. */
interface FakeScheduler {
  readonly scheduler: RuntimeScheduler;
  /** Fires every live timer. Returns how many ran. */
  fireAll(): number;
  liveCount(): number;
}

function createFakeScheduler(): FakeScheduler {
  const live = new Map<number, () => void>();
  let nextHandle = 0;
  return {
    scheduler: {
      schedule: (_delayMs, callback) => {
        const handle = ++nextHandle;
        live.set(handle, callback);
        return {
          cancel: () => {
            live.delete(handle);
          },
        };
      },
      scheduleMicrotask: (callback) => callback(),
    },
    fireAll: () => {
      const due = [...live.values()];
      live.clear();
      for (const callback of due) callback();
      return due.length;
    },
    liveCount: () => live.size,
  };
}

/** What the worker should answer for one `body/materialize`. */
type MaterializeAnswer =
  | { readonly kind: "awaiting"; readonly docKey: string }
  | { readonly kind: "granted"; readonly docKey: string };

/**
 * How the worker should answer one key's `body/release`. Four answers rather than a boolean,
 * because they are not four flavours of the same thing.
 */
type ReleaseBehavior = "ok" | "pinned" | "not-held" | "reject" | "hang";

interface ScriptedWorker {
  readonly materializeCalls: readonly string[];
  readonly releasedKeys: readonly string[];
  /** Per key; absent means `"ok"`. */
  readonly releaseBehavior: Map<string, ReleaseBehavior>;
}

function createScriptedWorker(
  pair: FakeBridgePair,
  script: readonly MaterializeAnswer[],
): ScriptedWorker {
  const materializeCalls: string[] = [];
  const releasedKeys: string[] = [];
  const releaseBehavior = new Map<string, ReleaseBehavior>();
  const queue = [...script];
  pair.worker.subscribe((message) => {
    if (!isMainToWorkerFrame(message) || message.frame !== "call") return;
    const { callId, call } = message;
    if (call.kind === "body/release") {
      const docKey = call.request.docKey;
      releasedKeys.push(docKey);
      const behavior = releaseBehavior.get(docKey) ?? "ok";
      // Never answers, so the call is still outstanding when the bridge is disposed - which is the only
      // way to observe `BridgeDisposedError` reaching a rejection arm.
      if (behavior === "hang") return;
      if (behavior === "reject") {
        pair.worker.post(
          {
            frame: "result",
            callId,
            result: {
              outcome: "error",
              name: "Error",
              message: "release handler faulted",
            },
          },
          [],
        );
        return;
      }
      const value: unknown =
        behavior === "ok"
          ? { released: true, reason: null }
          : { released: false, reason: behavior };
      pair.worker.post(
        { frame: "result", callId, result: { outcome: "ok", value } },
        [],
      );
      return;
    }
    if (call.kind !== "body/materialize") return;
    materializeCalls.push(call.request.artifactId);
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(
        "createScriptedWorker: no canned answer left for a body/materialize call",
      );
    }
    const value: unknown =
      next.kind === "awaiting"
        ? {
            docKey: next.docKey,
            update: null,
            docGuid: null,
            seedMode: "full",
            hostStateVector: null,
            awarenessFrames: [],
          }
        : {
            docKey: next.docKey,
            update: Uint8Array.from([1, 2, 3]),
            // `null`, which makes the body FORWARD-ONLY - the `@1` shape, and
            // the one whose lifecycle end is a release rather than a demote.
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
  return { materializeCalls, releasedKeys, releaseBehavior };
}

interface Rig {
  readonly leases: ArtifactBodyLeaseBridge;
  readonly worker: ScriptedWorker;
  readonly installedKeys: readonly string[];
  readonly timers: FakeScheduler;
  /** Disposing this is what teardown does, and what rejects in-flight calls. */
  readonly disposeBridge: () => void;
}

function setup(script: readonly MaterializeAnswer[]): Rig {
  const pair = createFakeBridgePair("sync");
  const worker = createScriptedWorker(pair, script);
  const main = createMainBridgeEndpoint(pair.main, stubMainCallHandlers({}));
  const installedKeys: string[] = [];
  const timers = createFakeScheduler();
  const docs: MainThreadBodyDocs = {
    install: (input) => {
      installedKeys.push(input.docKey);
    },
    encode: () => Uint8Array.from([]),
    drop: () => undefined,
    has: () => false,
    applyRemoteAwareness: () => undefined,
  };
  const budget: HotBodyBudget = {
    chargeHot: () => undefined,
    settleCold: () => undefined,
  };
  const leases = createArtifactBodyLeaseBridge({
    bridge: main,
    docs,
    budget,
    scheduler: timers.scheduler,
    lingerMs: LINGER_MS,
    maxHotDocs: MAX_HOT,
    reportAwaitingStalled: () => undefined,
  });
  return {
    leases,
    worker,
    installedKeys,
    timers,
    disposeBridge: () => {
      main.dispose();
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("an awaiting body whose doc key MOVES before its seed arrives", () => {
  it("installs under the key the answer returned, not the one the retry captured", async () => {
    const { leases, worker, installedKeys } = setup([
      { kind: "awaiting", docKey: DOC_KEY },
      // The room moved while this body was awaiting: the retry asked about the
      // artifact, and the answer names a different room.
      { kind: "granted", docKey: MOVED_DOC_KEY },
    ]);

    const grant = await leases.acquire(ARTIFACT_ID, "linger");
    if (grant.kind !== "awaiting-seed") {
      throw new Error(`expected an awaiting-seed grant, got ${grant.kind}`);
    }
    expect(grant.docKey).toBe(DOC_KEY);
    expect(worker.materializeCalls).toHaveLength(1);

    leases.retryAwaitingBodies(() => true);
    await flushMicrotasks();

    // THE REDDENING ASSERTION. Installed under `DOC_KEY`, the doc is invisible
    // to `getArtifactFragment`, which reads the room the projection now names.
    expect(installedKeys).toEqual([MOVED_DOC_KEY]);
  });

  it("routes the holder's release - captured over the OLD key - to the new room", async () => {
    const { leases, worker, timers } = setup([
      { kind: "awaiting", docKey: DOC_KEY },
      { kind: "granted", docKey: MOVED_DOC_KEY },
    ]);

    const grant = await leases.acquire(ARTIFACT_ID, "linger");
    if (grant.kind !== "awaiting-seed") {
      throw new Error(`expected an awaiting-seed grant, got ${grant.kind}`);
    }
    leases.retryAwaitingBodies(() => true);
    await flushMicrotasks();

    // The holder still holds the closure it was handed at acquire time, over `DOC_KEY`. A captured
    // string cannot be re-pointed, which is why the redirect exists at all.
    grant.release();
    // The last lease drops, so the doc enters its linger; firing it posts the
    // lifecycle end.
    expect(timers.fireAll()).toBeGreaterThan(0);
    await flushMicrotasks();

    // THE REDDENING ASSERTION, in both directions.
    expect(worker.releasedKeys).toEqual([DOC_KEY, MOVED_DOC_KEY]);
  });
});

describe("an awaiting body whose release the worker REFUSES", () => {
  it("asks again in the next window instead of leaving the demand held forever", async () => {
    const { leases, worker, timers } = setup([
      { kind: "awaiting", docKey: DOC_KEY },
    ]);
    // The worker materialized this room into a pinned state - a collaborator
    // is present - so it legitimately declines to drop the demand.
    worker.releaseBehavior.set(DOC_KEY, "pinned");

    const grant = await leases.acquire(ARTIFACT_ID, "linger");
    if (grant.kind !== "awaiting-seed") {
      throw new Error(`expected an awaiting-seed grant, got ${grant.kind}`);
    }

    grant.release();
    await flushMicrotasks();
    expect(worker.releasedKeys).toEqual([DOC_KEY]);

    // THE REDDENING ASSERTION. Ignoring the verdict leaves nothing armed, so
    // the pin clearing later is an event no one is listening for.
    expect(timers.liveCount()).toBe(1);

    // The pin clears, and the next window asks again - and this time it takes.
    worker.releaseBehavior.delete(DOC_KEY);
    timers.fireAll();
    await flushMicrotasks();
    expect(worker.releasedKeys).toEqual([DOC_KEY, DOC_KEY]);
    // Released for real, so nothing is left armed.
    expect(timers.liveCount()).toBe(0);
  });

  it("asks again when the release call REJECTS on a live worker", async () => {
    // A rejection is not a teardown.
    const { leases, worker, timers } = setup([
      { kind: "awaiting", docKey: DOC_KEY },
    ]);
    worker.releaseBehavior.set(DOC_KEY, "reject");

    const grant = await leases.acquire(ARTIFACT_ID, "linger");
    if (grant.kind !== "awaiting-seed") {
      throw new Error(`expected an awaiting-seed grant, got ${grant.kind}`);
    }
    grant.release();
    await flushMicrotasks();
    expect(worker.releasedKeys).toEqual([DOC_KEY]);

    // THE REDDENING ASSERTION. The first version of this arm swallowed, on the reasoning that nothing
    // on this side holds a doc so nothing can be stranded - which answered the wrong half.
    expect(timers.liveCount()).toBe(1);

    worker.releaseBehavior.delete(DOC_KEY);
    timers.fireAll();
    await flushMicrotasks();
    expect(worker.releasedKeys).toEqual([DOC_KEY, DOC_KEY]);
    expect(timers.liveCount()).toBe(0);
  });

  it("stops asking when the worker answers not-held, which is terminal", async () => {
    // The other half of the same fix, and it points the opposite way.
    const { leases, worker, timers } = setup([
      { kind: "awaiting", docKey: DOC_KEY },
    ]);
    worker.releaseBehavior.set(DOC_KEY, "not-held");

    const grant = await leases.acquire(ARTIFACT_ID, "linger");
    if (grant.kind !== "awaiting-seed") {
      throw new Error(`expected an awaiting-seed grant, got ${grant.kind}`);
    }
    grant.release();
    await flushMicrotasks();

    expect(worker.releasedKeys).toEqual([DOC_KEY]);
    // THE REDDENING ASSERTION, against a `!answer.released` that treats every
    // refusal alike.
    expect(timers.liveCount()).toBe(0);
  });

  it("stops asking when the bridge itself was DISPOSED - the one rejection that is terminal", async () => {
    // The teardown race the live-rejection retry opened.
    const { leases, worker, timers, disposeBridge } = setup([
      { kind: "awaiting", docKey: DOC_KEY },
    ]);
    worker.releaseBehavior.set(DOC_KEY, "hang");

    const grant = await leases.acquire(ARTIFACT_ID, "linger");
    if (grant.kind !== "awaiting-seed") {
      throw new Error(`expected an awaiting-seed grant, got ${grant.kind}`);
    }
    grant.release();
    await flushMicrotasks();
    // In flight and unanswered - the state teardown actually finds.
    expect(worker.releasedKeys).toEqual([DOC_KEY]);
    expect(timers.liveCount()).toBe(0);

    disposeBridge();
    await flushMicrotasks();

    // THE REDDENING ASSERTION.
    expect(timers.liveCount()).toBe(0);
    // ...and nothing was posted again, which is the loop's first iteration.
    expect(worker.releasedKeys).toEqual([DOC_KEY]);
  });

  it("stops asking once a holder re-acquires inside the window", async () => {
    // The control that keeps the retry from becoming a leak of its own: a re-acquired body's demand is
    // legitimately held again, and its own release will post when it unmounts.
    const { leases, worker, timers } = setup([
      { kind: "awaiting", docKey: DOC_KEY },
      { kind: "awaiting", docKey: DOC_KEY },
    ]);
    worker.releaseBehavior.set(DOC_KEY, "pinned");

    const first = await leases.acquire(ARTIFACT_ID, "linger");
    if (first.kind !== "awaiting-seed") {
      throw new Error(`expected an awaiting-seed grant, got ${first.kind}`);
    }
    first.release();
    await flushMicrotasks();
    expect(worker.releasedKeys).toEqual([DOC_KEY]);

    const second = await leases.acquire(ARTIFACT_ID, "linger");
    if (second.kind !== "awaiting-seed") {
      throw new Error(`expected an awaiting-seed grant, got ${second.kind}`);
    }
    timers.fireAll();
    await flushMicrotasks();

    // Still one release: the timer found the body held again and stood down.
    expect(worker.releasedKeys).toEqual([DOC_KEY]);
  });
});

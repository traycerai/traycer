import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BARRIER_ACTION_TIMEOUT_MS,
  BrowserJarSerializer,
} from "../browser-jar-serializer";

/**
 * The barrier's liveness escape (browser-security-hardening H11). Ordering
 * itself is settlement-driven and needs no clock; this pins the one case a
 * settlement fact cannot cover - a Chromium call inside "forget all browser
 * logins" that never comes back - and the invariant that the gate opens
 * anyway.
 */
describe("BrowserJarSerializer whole-jar barrier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds domain work behind a barrier that is still running", async () => {
    const serializer = new BrowserJarSerializer();
    let releaseBarrier = (): void => undefined;
    const barrier = serializer.runOnEveryDomain(
      () =>
        new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        }),
      BARRIER_ACTION_TIMEOUT_MS,
    );
    let domainRan = false;
    const domain = serializer.runOnDomain("example.com", async () => {
      domainRan = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(domainRan).toBe(false);

    releaseBarrier();
    await barrier;
    await domain;
    expect(domainRan).toBe(true);
  });

  it("forces the gate open when the barrier action never settles", async () => {
    const serializer = new BrowserJarSerializer();
    // Never resolves: the wedged CDP call the escape exists for.
    const barrier = serializer.runOnEveryDomain(
      () => new Promise<void>(() => undefined),
      BARRIER_ACTION_TIMEOUT_MS,
    );
    const rejection = expect(barrier).rejects.toThrow(/did not settle within/);

    let domainRan = false;
    const domain = serializer.runOnDomain("example.com", async () => {
      domainRan = true;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(domainRan).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    await domain;
    expect(domainRan).toBe(true);
  });

  it("never rejects a barrier that settled before the bound", async () => {
    const serializer = new BrowserJarSerializer();
    await expect(
      serializer.runOnEveryDomain(
        async () => "done",
        BARRIER_ACTION_TIMEOUT_MS,
      ),
    ).resolves.toBe("done");
    // Past the bound: the cleared timer must not surface a late rejection.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(
      serializer.runOnDomain("example.com", async () => "after"),
    ).resolves.toBe("after");
  });

  // Pins that expiry aborts the action's signal BEFORE the gate opens (so
  // queued domain work never races an action that is still writing), and
  // that a caller-provided timeout shorter than BARRIER_ACTION_TIMEOUT_MS is
  // honoured rather than the module constant.
  it("aborts the action's signal before opening the gate when the barrier expires", async () => {
    const serializer = new BrowserJarSerializer();
    const events: string[] = [];
    const shortTimeoutMs = 1_000;
    const barrier = serializer.runOnEveryDomain(
      (signal) =>
        new Promise<void>(() => {
          signal.addEventListener("abort", () => {
            events.push("aborted");
          });
        }),
      shortTimeoutMs,
    );
    const rejection = expect(barrier).rejects.toThrow(/did not settle within/);

    const domain = serializer.runOnDomain("example.com", async () => {
      events.push("domain-ran");
    });

    // Not yet at the shorter bound: neither the abort nor the queued domain
    // work has happened.
    await vi.advanceTimersByTimeAsync(shortTimeoutMs - 1);
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    await domain;
    expect(events).toEqual(["aborted", "domain-ran"]);
  });

  it("a barrier that expires while waiting never runs its action", async () => {
    const serializer = new BrowserJarSerializer();
    let releaseA = (): void => undefined;
    // Barrier A holds the jar for the whole test until releaseA() is called.
    const barrierA = serializer.runOnEveryDomain(
      () =>
        new Promise<void>((resolve) => {
          releaseA = resolve;
        }),
      BARRIER_ACTION_TIMEOUT_MS,
    );
    const shortTimeoutMs = 1_000;
    const actionB = vi.fn(async () => "b-result");
    const barrierB = serializer.runOnEveryDomain(actionB, shortTimeoutMs);
    const rejectionB = expect(barrierB).rejects.toThrow(
      /did not settle within/,
    );

    // B gives up while still waiting behind A - its action must never start.
    await vi.advanceTimersByTimeAsync(shortTimeoutMs);
    await rejectionB;
    expect(actionB).not.toHaveBeenCalled();

    // A finally settles; B's abandoned run wakes up and must still refuse to
    // run its action, rather than running it late under no barrier.
    releaseA();
    await barrierA;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(actionB).not.toHaveBeenCalled();
  });

  it("a queued barrier that gives up does not admit domain work under the barrier ahead", async () => {
    const serializer = new BrowserJarSerializer();
    let releaseA = (): void => undefined;
    const barrierA = serializer.runOnEveryDomain(
      () =>
        new Promise<void>((resolve) => {
          releaseA = resolve;
        }),
      BARRIER_ACTION_TIMEOUT_MS,
    );
    const shortTimeoutMs = 1_000;
    const barrierB = serializer.runOnEveryDomain(
      async () => "b-result",
      shortTimeoutMs,
    );
    const rejectionB = expect(barrierB).rejects.toThrow(
      /did not settle within/,
    );

    let domainRan = false;
    const domain = serializer.runOnDomain("example.com", async () => {
      domainRan = true;
    });

    // B's own timer fires and it gives up, but A is still holding the jar -
    // the domain work behind B must not slip in front of A.
    await vi.advanceTimersByTimeAsync(shortTimeoutMs);
    await rejectionB;
    expect(domainRan).toBe(false);

    // Only once A finally settles does the chain open and admit the domain
    // work that was queued behind B.
    releaseA();
    await barrierA;
    await domain;
    expect(domainRan).toBe(true);
  });
});

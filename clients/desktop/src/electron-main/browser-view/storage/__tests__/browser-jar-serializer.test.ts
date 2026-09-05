import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BARRIER_ACTION_TIMEOUT_MS,
  BARRIER_SETTLE_GRACE_MS,
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

    // The bound: the action is told to stop, and the caller waits with the
    // gate for it to settle - a call already made is not cancelled by the
    // abort, and a cooperative action's own answer is the caller's.
    await vi.advanceTimersByTimeAsync(1);
    expect(domainRan).toBe(false);

    // It never does: the grace answers the caller with the expiry and forces
    // the gate open.
    await vi.advanceTimersByTimeAsync(BARRIER_SETTLE_GRACE_MS);
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

    // At the bound the action is told to stop; the caller and the domain
    // work both still wait for the action to settle.
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["aborted"]);

    // It never settles, so the grace answers the caller and opens the gate -
    // after the abort.
    await vi.advanceTimersByTimeAsync(BARRIER_SETTLE_GRACE_MS);
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

  // Pins BARRIER_SETTLE_GRACE_MS (browser-security-hardening H11 follow-up):
  // an expiry aborts the signal at once, but a COOPERATIVE action that is
  // still running when the timer fires keeps the gate closed until it
  // actually settles - never until the timer alone says so - and its own
  // settlement is what answers the caller.
  it("keeps the gate closed after expiry until the running action settles", async () => {
    const serializer = new BrowserJarSerializer();
    let releaseAction = (): void => undefined;
    const shortTimeoutMs = 1_000;
    const barrier = serializer.runOnEveryDomain(
      () =>
        new Promise<string>((resolve) => {
          releaseAction = (): void => resolve("settled-late");
        }),
      shortTimeoutMs,
    );

    let domainRan = false;
    const domain = serializer.runOnDomain("example.com", async () => {
      domainRan = true;
    });

    await vi.advanceTimersByTimeAsync(shortTimeoutMs);
    // The action was told to stop but is still running (never released) -
    // the gate stays closed, the queued domain work has not run, and the
    // caller is still waiting for the action's own answer.
    expect(domainRan).toBe(false);

    // Well under BARRIER_SETTLE_GRACE_MS: still not forced open by the timer.
    await vi.advanceTimersByTimeAsync(BARRIER_SETTLE_GRACE_MS - 1);
    expect(domainRan).toBe(false);

    releaseAction();
    await expect(barrier).resolves.toBe("settled-late");
    await domain;
    expect(domainRan).toBe(true);
  });

  it("forces the gate open after BARRIER_SETTLE_GRACE_MS if the action never settles", async () => {
    const serializer = new BrowserJarSerializer();
    const shortTimeoutMs = 1_000;
    const barrier = serializer.runOnEveryDomain(
      // Never resolves: the wedged call the grace window exists for.
      () => new Promise<void>(() => undefined),
      shortTimeoutMs,
    );
    const rejection = expect(barrier).rejects.toThrow(/did not settle within/);

    let domainRan = false;
    const domain = serializer.runOnDomain("example.com", async () => {
      domainRan = true;
    });

    await vi.advanceTimersByTimeAsync(shortTimeoutMs);
    expect(domainRan).toBe(false);

    await vi.advanceTimersByTimeAsync(BARRIER_SETTLE_GRACE_MS - 1);
    expect(domainRan).toBe(false);

    // The end of the grace is what answers the caller and opens the gate.
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    await domain;
    expect(domainRan).toBe(true);
  });
});

/**
 * `readBehindBarrier` shares the same accounting as `runOnDomain`: the gate
 * is captured and the read registered in `inFlight` synchronously, so a
 * barrier requested after the read waits behind it, and a barrier requested
 * before the read is the gate the read waits on.
 */
describe("BrowserJarSerializer.readBehindBarrier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds a barrier's action behind a read requested before it", async () => {
    const serializer = new BrowserJarSerializer();
    let releaseRead = (): void => undefined;
    const read = serializer.readBehindBarrier(
      () =>
        new Promise<string>((resolve) => {
          releaseRead = () => resolve("read-value");
        }),
      null,
    );

    let actionRan = false;
    const barrier = serializer.runOnEveryDomain(async () => {
      actionRan = true;
      return "barrier-value";
    }, BARRIER_ACTION_TIMEOUT_MS);

    await vi.advanceTimersByTimeAsync(0);
    expect(actionRan).toBe(false);

    releaseRead();
    await expect(read).resolves.toEqual({ ok: true, value: "read-value" });
    await expect(barrier).resolves.toBe("barrier-value");
    expect(actionRan).toBe(true);
  });

  it("holds a read behind a running barrier, and holds a barrier requested after the read behind the read", async () => {
    const serializer = new BrowserJarSerializer();
    let releaseBarrierA = (): void => undefined;
    const barrierA = serializer.runOnEveryDomain(
      () =>
        new Promise<void>((resolve) => {
          releaseBarrierA = resolve;
        }),
      BARRIER_ACTION_TIMEOUT_MS,
    );
    // Flush before anything relies on `releaseBarrierA`: the executor above
    // only runs (and reassigns it) once A's own waits settle, so calling it
    // before this would invoke a stale no-op and never release the barrier.
    await vi.advanceTimersByTimeAsync(0);

    // Controlled so the read has visibly started (past the gate) but not
    // settled, which is what B's `ahead` actually waits on - a read that
    // resolves immediately would settle in the same microtask flush as B's
    // own wait for the gate, and the ordering claim would go unverified.
    let readStarted = false;
    let releaseRead = (): void => undefined;
    const read = serializer.readBehindBarrier(
      () =>
        new Promise<string>((resolve) => {
          readStarted = true;
          releaseRead = () => resolve("value");
        }),
      null,
    );

    let barrierBActionRan = false;
    const barrierB = serializer.runOnEveryDomain(async () => {
      barrierBActionRan = true;
      return "b-value";
    }, BARRIER_ACTION_TIMEOUT_MS);

    releaseBarrierA();
    await barrierA;
    await vi.advanceTimersByTimeAsync(0);
    // Barrier A's gate is open, so the read has started, but B must still
    // wait behind it since the read was registered before B.
    expect(readStarted).toBe(true);
    expect(barrierBActionRan).toBe(false);

    releaseRead();
    await expect(read).resolves.toEqual({ ok: true, value: "value" });

    await expect(barrierB).resolves.toBe("b-value");
    expect(barrierBActionRan).toBe(true);
  });

  it("answers barrier-held once the bounded wait elapses, then reads normally after the barrier ends", async () => {
    const serializer = new BrowserJarSerializer();
    let releaseBarrier = (): void => undefined;
    const barrier = serializer.runOnEveryDomain(
      () =>
        new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        }),
      BARRIER_ACTION_TIMEOUT_MS,
    );

    const read = vi.fn(async () => "value");
    const outcome = serializer.readBehindBarrier(read, 50);

    await vi.advanceTimersByTimeAsync(49);
    expect(read).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toEqual({
      ok: false,
      reason: "barrier-held",
    });
    expect(read).not.toHaveBeenCalled();

    releaseBarrier();
    await barrier;

    await expect(
      serializer.readBehindBarrier(async () => "later", 50),
    ).resolves.toEqual({ ok: true, value: "later" });
  });

  it("resolves the barrier with the action's own value when it settles within the grace period after expiry", async () => {
    const serializer = new BrowserJarSerializer();
    const shortTimeoutMs = 1_000;
    let resolveAction = (): void => undefined;
    const barrier = serializer.runOnEveryDomain(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => {
            resolveAction = () => resolve("cooperative-result");
          });
        }),
      shortTimeoutMs,
    );

    let domainRan = false;
    const domain = serializer.runOnDomain("example.com", async () => {
      domainRan = true;
    });

    await vi.advanceTimersByTimeAsync(shortTimeoutMs);
    // Aborted, but the action has not settled yet - the grace has not
    // expired, so the gate must still be closed.
    await vi.advanceTimersByTimeAsync(BARRIER_SETTLE_GRACE_MS - 1);
    expect(domainRan).toBe(false);

    resolveAction();
    await expect(barrier).resolves.toBe("cooperative-result");
    await domain;
    expect(domainRan).toBe(true);
  });

  it("rejects the barrier with the action's own error when it rejects within the grace period after expiry", async () => {
    const serializer = new BrowserJarSerializer();
    const shortTimeoutMs = 1_000;
    const ownError = new Error("action-specific-failure");
    let rejectAction = (): void => undefined;
    const barrier = serializer.runOnEveryDomain(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            rejectAction = () => reject(ownError);
          });
        }),
      shortTimeoutMs,
    );
    const rejection = expect(barrier).rejects.toBe(ownError);

    let domainRan = false;
    const domain = serializer.runOnDomain("example.com", async () => {
      domainRan = true;
    });

    await vi.advanceTimersByTimeAsync(shortTimeoutMs);
    await vi.advanceTimersByTimeAsync(BARRIER_SETTLE_GRACE_MS - 1);
    expect(domainRan).toBe(false);

    rejectAction();
    await rejection;
    await domain;
    expect(domainRan).toBe(true);
  });
});

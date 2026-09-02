import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserJarSerializer } from "../browser-jar-serializer";

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
    await expect(serializer.runOnEveryDomain(async () => "done")).resolves.toBe(
      "done",
    );
    // Past the bound: the cleared timer must not surface a late rejection.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(
      serializer.runOnDomain("example.com", async () => "after"),
    ).resolves.toBe("after");
  });
});

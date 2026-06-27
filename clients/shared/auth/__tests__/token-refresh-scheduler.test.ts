import { describe, expect, it, vi } from "vitest";
import {
  createProactiveRefreshScheduler,
  DEFAULT_REFRESH_LEAD_MS,
  DEFAULT_REFRESH_MIN_DELAY_MS,
} from "../token-refresh-scheduler";

const HOUR_MS = 60 * 60_000;

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A JWS-shaped token whose payload carries `exp` (epoch ms → seconds). */
function tokenExpiringAtMs(expMs: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ id: "user-1", exp: Math.trunc(expMs / 1000) }),
  );
  return `${header}.${payload}.signature`;
}

type FakeTimer = { id: number; cb: () => void; at: number };

function makeFakeClock() {
  let now = 0;
  let nextId = 1;
  let timers: FakeTimer[] = [];
  return {
    now: () => now,
    setTimer: (cb: () => void, ms: number): number => {
      const id = nextId++;
      timers.push({ id, cb, at: now + ms });
      return id;
    },
    clearTimer: (id: number): void => {
      timers = timers.filter((t) => t.id !== id);
    },
    pendingCount: (): number => timers.length,
    // Advance the wall clock WITHOUT firing any timer - models an OS suspend,
    // where `Date.now()` keeps moving but the monotonic `setTimeout` countdown
    // is frozen, so an armed timer does not fire while the device sleeps.
    jump(ms: number): void {
      now += ms;
    },
    async advance(ms: number): Promise<void> {
      now += ms;
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      for (const timer of due) {
        timers = timers.filter((t) => t.id !== timer.id);
        timer.cb();
        // Flush the microtask chain so the async onFire (revalidate + re-arm)
        // settles before the next assertion.
        for (let i = 0; i < 8; i++) {
          await Promise.resolve();
        }
      }
    },
  };
}

describe("createProactiveRefreshScheduler", () => {
  it("refreshes once the scheduled fire lands inside the lead window", async () => {
    const clock = makeFakeClock();
    let token: string | null = tokenExpiringAtMs(4 * HOUR_MS);
    const revalidate = vi.fn(async () => {
      // Simulate a rotation to a fresh 4h token off the current clock.
      token = tokenExpiringAtMs(clock.now() + 4 * HOUR_MS);
    });

    const scheduler = createProactiveRefreshScheduler<number>({
      getToken: () => token,
      revalidate,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      leadMs: DEFAULT_REFRESH_LEAD_MS,
      minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
      onDiagnostic: null,
    });

    scheduler.start();
    expect(revalidate).not.toHaveBeenCalled();

    // Advance to the scheduled fire (exp - lead). The token is now within the
    // lead window, so onFire refreshes.
    await clock.advance(4 * HOUR_MS - DEFAULT_REFRESH_LEAD_MS);
    expect(revalidate).toHaveBeenCalledTimes(1);
    // Re-armed off the rotated token; a future refresh is pending.
    expect(clock.pendingCount()).toBe(1);

    scheduler.stop();
    expect(clock.pendingCount()).toBe(0);
  });

  it("skips the refresh and re-arms when the token was already refreshed out of band", async () => {
    const clock = makeFakeClock();
    let token: string | null = tokenExpiringAtMs(4 * HOUR_MS);
    const revalidate = vi.fn(async () => {});

    const scheduler = createProactiveRefreshScheduler<number>({
      getToken: () => token,
      revalidate,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      leadMs: DEFAULT_REFRESH_LEAD_MS,
      minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
      onDiagnostic: null,
    });

    scheduler.start();
    // A reactive 401 refresh rotated the bearer before our timer fired: the
    // live token now expires well beyond the lead window.
    token = tokenExpiringAtMs(clock.now() + 4 * HOUR_MS + 4 * HOUR_MS);

    await clock.advance(4 * HOUR_MS - DEFAULT_REFRESH_LEAD_MS);
    expect(revalidate).not.toHaveBeenCalled();
    // Still armed (off the fresher token), so it keeps watching.
    expect(clock.pendingCount()).toBe(1);
  });

  it("retries on the min-delay floor when a refresh leaves the bearer unchanged", async () => {
    const clock = makeFakeClock();
    // The token never rotates - models a network-error refresh that leaves the
    // bearer untouched, so each fire stays inside the lead window and must
    // re-arm on the floor rather than refreshing immediately in a tight spin.
    const token: string = tokenExpiringAtMs(4 * HOUR_MS);
    const revalidate = vi.fn(async () => {});

    const scheduler = createProactiveRefreshScheduler<number>({
      getToken: () => token,
      revalidate,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      leadMs: DEFAULT_REFRESH_LEAD_MS,
      minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
      onDiagnostic: null,
    });

    scheduler.start();
    await clock.advance(4 * HOUR_MS - DEFAULT_REFRESH_LEAD_MS);
    expect(revalidate).toHaveBeenCalledTimes(1);
    // Re-armed at the floor (token still unchanged + inside the lead window).
    expect(clock.pendingCount()).toBe(1);

    // The retry lands exactly one floor-delay later, not immediately.
    await clock.advance(DEFAULT_REFRESH_MIN_DELAY_MS - 1);
    expect(revalidate).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    expect(revalidate).toHaveBeenCalledTimes(2);

    scheduler.stop();
    expect(clock.pendingCount()).toBe(0);
  });

  it("does not re-arm when stopped while a refresh is in flight", async () => {
    const clock = makeFakeClock();
    const token: string = tokenExpiringAtMs(4 * HOUR_MS);
    let resolveRefresh: (() => void) | null = null;
    const revalidate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const scheduler = createProactiveRefreshScheduler<number>({
      getToken: () => token,
      revalidate,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      leadMs: DEFAULT_REFRESH_LEAD_MS,
      minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
      onDiagnostic: null,
    });

    scheduler.start();
    // Fire the scheduled refresh; onFire suspends on the unresolved revalidate.
    await clock.advance(4 * HOUR_MS - DEFAULT_REFRESH_LEAD_MS);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(clock.pendingCount()).toBe(0);

    // Stop mid-flight, then let the refresh settle: the post-await `stopped`
    // guard must suppress the re-arm so no timer is left scheduled.
    scheduler.stop();
    resolveRefresh?.();
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(clock.pendingCount()).toBe(0);
  });

  it("disables scheduling for a token with no decodable exp", async () => {
    const clock = makeFakeClock();
    const revalidate = vi.fn(async () => {});
    const diagnostics: string[] = [];

    const scheduler = createProactiveRefreshScheduler<number>({
      getToken: () => "not-a-decodable-jwt",
      revalidate,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      leadMs: DEFAULT_REFRESH_LEAD_MS,
      minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
      onDiagnostic: (message) => diagnostics.push(message),
    });

    scheduler.start();
    expect(clock.pendingCount()).toBe(0);
    expect(diagnostics).toEqual([
      "proactive token refresh disabled: access token carries no decodable exp",
    ]);

    await clock.advance(8 * HOUR_MS);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("disarms when signed out and stays silent", async () => {
    const clock = makeFakeClock();
    const revalidate = vi.fn(async () => {});

    const scheduler = createProactiveRefreshScheduler<number>({
      getToken: () => null,
      revalidate,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      leadMs: DEFAULT_REFRESH_LEAD_MS,
      minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
      onDiagnostic: null,
    });

    scheduler.start();
    expect(clock.pendingCount()).toBe(0);
    await clock.advance(8 * HOUR_MS);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("refreshes on notifyResumed when a sleep pushed the token into the lead window", async () => {
    const clock = makeFakeClock();
    let token: string | null = tokenExpiringAtMs(4 * HOUR_MS);
    const revalidate = vi.fn(async () => {
      token = tokenExpiringAtMs(clock.now() + 4 * HOUR_MS);
    });

    const scheduler = createProactiveRefreshScheduler<number>({
      getToken: () => token,
      revalidate,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      leadMs: DEFAULT_REFRESH_LEAD_MS,
      minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
      onDiagnostic: null,
    });

    scheduler.start();
    expect(clock.pendingCount()).toBe(1);

    // The device sleeps until the token is inside the lead window. The armed
    // timer's monotonic countdown is frozen, so it never fires - the bearer just
    // rots in place (the overnight-session bug).
    clock.jump(4 * HOUR_MS - DEFAULT_REFRESH_LEAD_MS + 60_000);
    expect(revalidate).not.toHaveBeenCalled();

    // Wake: re-evaluate against the wall clock → token inside the lead window →
    // refresh now. The stale frozen timer is dropped and a fresh one armed off
    // the rotated token (so the count stays at exactly one).
    scheduler.notifyResumed();
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(clock.pendingCount()).toBe(1);

    scheduler.stop();
    expect(clock.pendingCount()).toBe(0);
  });

  it("re-arms without refreshing on notifyResumed when the token is still outside the lead window", async () => {
    const clock = makeFakeClock();
    const token: string = tokenExpiringAtMs(4 * HOUR_MS);
    const revalidate = vi.fn(async () => {});

    const scheduler = createProactiveRefreshScheduler<number>({
      getToken: () => token,
      revalidate,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      leadMs: DEFAULT_REFRESH_LEAD_MS,
      minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
      onDiagnostic: null,
    });

    scheduler.start();
    // A short nap that leaves the token well clear of the lead window.
    clock.jump(60_000);

    scheduler.notifyResumed();
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(revalidate).not.toHaveBeenCalled();
    // Still armed (off the same, still-valid token), so it keeps watching.
    expect(clock.pendingCount()).toBe(1);

    scheduler.stop();
  });

  it("notifyResumed is a no-op while stopped", async () => {
    const clock = makeFakeClock();
    const token: string = tokenExpiringAtMs(60_000);
    const revalidate = vi.fn(async () => {});

    const scheduler = createProactiveRefreshScheduler<number>({
      getToken: () => token,
      revalidate,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      leadMs: DEFAULT_REFRESH_LEAD_MS,
      minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
      onDiagnostic: null,
    });

    // Never started (or already stopped): a wake signal must not refresh or arm.
    scheduler.notifyResumed();
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    expect(revalidate).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(0);
  });

  it("clamps a far-future exp so the timer can't overflow and fire immediately", async () => {
    const clock = makeFakeClock();
    // exp 100 days out → the raw delay far exceeds the 32-bit timer ceiling,
    // which would overflow and fire near-instantly without the clamp.
    const token: string = tokenExpiringAtMs(100 * 24 * HOUR_MS);
    const revalidate = vi.fn(async () => {});

    const scheduler = createProactiveRefreshScheduler<number>({
      getToken: () => token,
      revalidate,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      leadMs: DEFAULT_REFRESH_LEAD_MS,
      minDelayMs: DEFAULT_REFRESH_MIN_DELAY_MS,
      onDiagnostic: null,
    });

    scheduler.start();
    // A timer is armed (not fired synchronously) and stays pending well past the
    // floor - it must NOT have collapsed into an immediate fire.
    expect(clock.pendingCount()).toBe(1);
    await clock.advance(DEFAULT_REFRESH_MIN_DELAY_MS * 1000);
    expect(revalidate).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(1);

    scheduler.stop();
  });
});

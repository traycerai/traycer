import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlanRestrictedSessionRebuildBackoff,
  PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS,
  PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS,
} from "../plan-restricted-session-rebuild-backoff";

describe("createPlanRestrictedSessionRebuildBackoff", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs immediately, then follows the 1m/2m/4m ladder and caps at 15m", () => {
    vi.useFakeTimers();
    const rebuild = vi.fn();
    const backoff = createPlanRestrictedSessionRebuildBackoff();

    backoff.request(rebuild);
    expect(rebuild).toHaveBeenCalledTimes(1);

    const delays = [
      PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS,
      PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS * 2,
      PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS * 4,
      PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS * 8,
      PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS,
      PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS,
    ];
    for (const [index, delay] of delays.entries()) {
      backoff.request(rebuild);
      expect(rebuild).toHaveBeenCalledTimes(index + 1);
      vi.advanceTimersByTime(delay - 1);
      expect(rebuild).toHaveBeenCalledTimes(index + 1);
      vi.advanceTimersByTime(1);
      expect(rebuild).toHaveBeenCalledTimes(index + 2);
    }
  });

  it("coalesces a pending request, and markHealthy resets and cancels its ladder", () => {
    vi.useFakeTimers();
    const rebuild = vi.fn();
    const backoff = createPlanRestrictedSessionRebuildBackoff();

    backoff.request(rebuild);
    backoff.request(rebuild);
    backoff.request(rebuild);
    expect(rebuild).toHaveBeenCalledTimes(1);

    backoff.markHealthy();
    vi.advanceTimersByTime(PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS);
    expect(rebuild).toHaveBeenCalledTimes(1);

    backoff.request(rebuild);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it("cancel cancels a pending request and resets the next request to immediate", () => {
    vi.useFakeTimers();
    const rebuild = vi.fn();
    const backoff = createPlanRestrictedSessionRebuildBackoff();

    backoff.request(rebuild);
    backoff.request(rebuild);
    backoff.request(rebuild);
    backoff.cancel();
    vi.advanceTimersByTime(PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS);
    expect(rebuild).toHaveBeenCalledTimes(1);

    backoff.request(rebuild);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });
});

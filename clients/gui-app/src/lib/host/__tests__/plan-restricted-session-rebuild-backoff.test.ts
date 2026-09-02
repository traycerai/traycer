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

  it("runs immediately, then follows the 1m/2m/4m/8m ladder and caps at 15m", () => {
    vi.useFakeTimers();
    const rebuild = vi.fn();
    const backoff = createPlanRestrictedSessionRebuildBackoff();
    function newOwner(): object {
      return {};
    }

    backoff.request(newOwner(), rebuild);
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
      backoff.request(newOwner(), rebuild);
      expect(rebuild).toHaveBeenCalledTimes(index + 1);
      vi.advanceTimersByTime(delay - 1);
      expect(rebuild).toHaveBeenCalledTimes(index + 1);
      vi.advanceTimersByTime(1);
      expect(rebuild).toHaveBeenCalledTimes(index + 2);
    }
  });

  it("markHealthy cancels a pending request and resets its ladder", () => {
    vi.useFakeTimers();
    const rebuild = vi.fn();
    const backoff = createPlanRestrictedSessionRebuildBackoff();
    const immediateOwner = {};
    const pendingOwner = {};
    const resetOwner = {};

    backoff.request(immediateOwner, rebuild);
    backoff.request(pendingOwner, rebuild);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    backoff.markHealthy();
    vi.advanceTimersByTime(PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS);
    expect(rebuild).toHaveBeenCalledTimes(1);

    backoff.request(resetOwner, rebuild);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it("ignores a duplicate old owner and gives the delayed callback to a newer owner", () => {
    vi.useFakeTimers();
    const oldRebuild = vi.fn();
    const newRebuild = vi.fn();
    const oldOwner = {};
    const newOwner = {};
    const backoff = createPlanRestrictedSessionRebuildBackoff();

    backoff.request(oldOwner, oldRebuild);
    expect(oldRebuild).toHaveBeenCalledTimes(1);

    backoff.request(oldOwner, oldRebuild);
    expect(oldRebuild).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    backoff.request(newOwner, newRebuild);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(
      PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS - 1,
    );
    expect(newRebuild).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(newRebuild).toHaveBeenCalledTimes(1);
    expect(oldRebuild).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending callback without advancing or duplicating the ladder", () => {
    vi.useFakeTimers();
    const firstRebuild = vi.fn();
    const secondRebuild = vi.fn();
    const thirdRebuild = vi.fn();
    const fourthRebuild = vi.fn();
    const firstOwner = {};
    const secondOwner = {};
    const thirdOwner = {};
    const fourthOwner = {};
    const backoff = createPlanRestrictedSessionRebuildBackoff();

    backoff.request(firstOwner, firstRebuild);
    backoff.request(secondOwner, secondRebuild);
    backoff.request(thirdOwner, thirdRebuild);

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(
      PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS - 1,
    );
    expect(secondRebuild).not.toHaveBeenCalled();
    expect(thirdRebuild).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(firstRebuild).toHaveBeenCalledTimes(1);
    expect(secondRebuild).not.toHaveBeenCalled();
    expect(thirdRebuild).toHaveBeenCalledTimes(1);

    backoff.request(fourthOwner, fourthRebuild);
    vi.advanceTimersByTime(
      PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS * 2 - 1,
    );
    expect(fourthRebuild).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fourthRebuild).toHaveBeenCalledTimes(1);
  });

  it("cancel cancels a pending request and resets the next request to immediate", () => {
    vi.useFakeTimers();
    const rebuild = vi.fn();
    const backoff = createPlanRestrictedSessionRebuildBackoff();
    const immediateOwner = {};
    const pendingOwner = {};
    const resetOwner = {};

    backoff.request(immediateOwner, rebuild);
    backoff.request(pendingOwner, rebuild);
    expect(vi.getTimerCount()).toBe(1);
    backoff.cancel();
    vi.advanceTimersByTime(PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS);
    expect(rebuild).toHaveBeenCalledTimes(1);

    backoff.request(resetOwner, rebuild);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });
});

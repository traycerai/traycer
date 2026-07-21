import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorktreeChangedInvalidationScheduler,
  type WorktreeChangedAccumulatedScopes,
  type WorktreeChangedInvalidationScheduler,
} from "@/lib/worktree/worktree-changed-invalidation-scheduler";

describe("createWorktreeChangedInvalidationScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function tracked(): {
    readonly flushes: WorktreeChangedAccumulatedScopes[];
    readonly scheduler: WorktreeChangedInvalidationScheduler;
  } {
    const flushes: WorktreeChangedAccumulatedScopes[] = [];
    const scheduler = createWorktreeChangedInvalidationScheduler({
      onFlush: (scopes) => flushes.push(scopes),
      debounceMs: 300,
      maxWaitMs: 1_000,
    });
    return { flushes, scheduler };
  }

  it("collapses a burst of path events into one flush with the path union", () => {
    const { flushes, scheduler } = tracked();

    scheduler.push({ kind: "worktreePath", worktreePath: "/wt/a" });
    vi.advanceTimersByTime(100);
    scheduler.push({ kind: "worktreePath", worktreePath: "/wt/b" });
    vi.advanceTimersByTime(100);
    scheduler.push({ kind: "worktreePath", worktreePath: "/wt/a" });
    expect(flushes).toHaveLength(0);

    vi.advanceTimersByTime(300);
    expect(flushes).toHaveLength(1);
    expect(flushes[0].root).toBe(false);
    expect([...flushes[0].worktreePaths].sort()).toEqual(["/wt/a", "/wt/b"]);
  });

  it("absorbs path precision into root when any root event is in the window", () => {
    const { flushes, scheduler } = tracked();

    scheduler.push({ kind: "worktreePath", worktreePath: "/wt/a" });
    scheduler.push({ kind: "root", root: "worktrees" });
    vi.advanceTimersByTime(300);

    expect(flushes).toHaveLength(1);
    expect(flushes[0].root).toBe(true);
  });

  it("bounds a continuous drizzle with maxWait instead of sliding forever", () => {
    const { flushes, scheduler } = tracked();

    // Events every 100ms - each resets the 300ms trailing edge, so only the
    // 1s maxWait bound produces the flush.
    Array.from({ length: 12 }).forEach((_, i) => {
      scheduler.push({ kind: "worktreePath", worktreePath: `/wt/${i}` });
      vi.advanceTimersByTime(100);
    });
    expect(flushes).toHaveLength(1);
    expect(flushes[0].worktreePaths.size).toBeGreaterThanOrEqual(10);

    // The tail after the forced flush drains via the trailing edge.
    vi.advanceTimersByTime(300);
    expect(flushes).toHaveLength(2);
  });

  it("starts a fresh accumulation after each flush", () => {
    const { flushes, scheduler } = tracked();

    scheduler.push({ kind: "worktreePath", worktreePath: "/wt/a" });
    vi.advanceTimersByTime(300);
    scheduler.push({ kind: "worktreePath", worktreePath: "/wt/b" });
    vi.advanceTimersByTime(300);

    expect(flushes).toHaveLength(2);
    expect([...flushes[0].worktreePaths]).toEqual(["/wt/a"]);
    expect([...flushes[1].worktreePaths]).toEqual(["/wt/b"]);
  });

  it("flushes pending scopes on dispose and ignores later pushes", () => {
    const { flushes, scheduler } = tracked();

    scheduler.push({ kind: "worktreePath", worktreePath: "/wt/a" });
    scheduler.dispose();
    expect(flushes).toHaveLength(1);

    scheduler.push({ kind: "worktreePath", worktreePath: "/wt/b" });
    vi.advanceTimersByTime(2_000);
    expect(flushes).toHaveLength(1);
  });

  it("does not flush at all when no events arrived", () => {
    const { flushes, scheduler } = tracked();
    scheduler.dispose();
    vi.advanceTimersByTime(2_000);
    expect(flushes).toHaveLength(0);
  });
});

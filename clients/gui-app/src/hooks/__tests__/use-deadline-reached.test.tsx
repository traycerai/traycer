import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDeadlineReached } from "../use-deadline-reached";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * The sibling of `useLoadDeadline` (see its own test suite): this hook takes
 * an ABSOLUTE instant rather than a budget, because its anchor is recorded
 * outside React. The case that only this shape can get right is a mount into
 * a deadline already in the past - a test that merely advances timers would
 * pass a version that forgot to check the instant on the very first effect.
 */
describe("useDeadlineReached", () => {
  it("stays false forever when atMs is null", () => {
    const { result } = renderHook(() => useDeadlineReached(null));
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1_000_000);
    });
    expect(result.current).toBe(false);
  });

  it("flips to true exactly when a future instant is reached", () => {
    const now = Date.now();
    const atMs = now + 5_000;
    const { result } = renderHook(() => useDeadlineReached(atMs));
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("is true after the first effect for an instant already in the past", () => {
    const now = Date.now();
    const { result } = renderHook(() => useDeadlineReached(now - 1));
    expect(result.current).toBe(true);
  });

  it("still reaches the deadline when the wall clock is corrected backwards after the timer is armed", () => {
    // The timer is monotonic; the deadline is wall-clock. A clock corrected
    // backwards after arming (a bad clock fixed after resume) lets the timer
    // fire while `Date.now()` still reads below `atMs`. A sample-only answer
    // stayed false there with nothing left to re-arm it, and a silent wait
    // spun past its bound for as long as the correction was large.
    const now = Date.now();
    const atMs = now + 5_000;
    const { result } = renderHook(() => useDeadlineReached(atMs));
    expect(result.current).toBe(false);

    act(() => {
      // Ten minutes backwards, then the full interval elapses on the timer.
      vi.setSystemTime(now - 600_000);
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(true);
  });

  it("a deadline reached by its timer under a rewound clock does not pre-answer the next wait anchored on that clock", () => {
    const now = Date.now();
    const { result, rerender } = renderHook(
      ({ atMs }: { readonly atMs: number | null }) => useDeadlineReached(atMs),
      { initialProps: { atMs: now + 5_000 } },
    );
    act(() => {
      vi.setSystemTime(now - 600_000);
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(true);

    // The next wait is recorded against the corrected clock and falls well
    // before the instant the timer answered for. It is a different wait and
    // must run its own interval.
    const nextAtMs = Date.now() + 5_000;
    rerender({ atMs: nextAtMs });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("answers false immediately when atMs changes to a new future instant - never a stale true", () => {
    const now = Date.now();
    const { result, rerender } = renderHook(
      ({ atMs }: { readonly atMs: number | null }) => useDeadlineReached(atMs),
      { initialProps: { atMs: now + 1_000 } },
    );

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(true);

    // A new future deadline is a different wait. The very next render - no
    // timer advance, no reset effect - must already read false.
    rerender({ atMs: Date.now() + 5_000 });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });
});

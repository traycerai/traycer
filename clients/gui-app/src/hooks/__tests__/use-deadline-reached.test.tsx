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

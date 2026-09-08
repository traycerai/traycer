import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreSnapshotRetryEvidence } from "@/stores/chats/chat-session-store";
import {
  STALLED_CHAT_LOAD_ATTEMPTS,
  STALLED_CHAT_LOAD_ELAPSED_MS,
  useChatLoadStalled,
} from "../use-chat-load-stalled";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function retriesWith(
  overrides: Partial<PreSnapshotRetryEvidence>,
): PreSnapshotRetryEvidence {
  return {
    count: 1,
    firstAt: Date.now(),
    code: null,
    reason: null,
    ...overrides,
  };
}

/**
 * The one clock the tile's stall verdict is anchored to - see the hook's own
 * doc for why the pane and the refusal recorder must read the same instance
 * rather than each carrying its own `Date.now()`.
 */
describe("useChatLoadStalled", () => {
  it("stalls a host that acks chat.subscribe and then goes silent, once the elapsed budget passes", () => {
    const { result } = renderHook(() =>
      useChatLoadStalled({ retries: null, snapshotLoaded: false }),
    );
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(STALLED_CHAT_LOAD_ELAPSED_MS);
    });
    expect(result.current).toBe(true);
  });

  it("does not stall early for a host that acks chat.subscribe and then goes silent", () => {
    const { result } = renderHook(() =>
      useChatLoadStalled({ retries: null, snapshotLoaded: false }),
    );

    act(() => {
      vi.advanceTimersByTime(STALLED_CHAT_LOAD_ELAPSED_MS - 1000);
    });
    expect(result.current).toBe(false);
  });

  it("switches to stalled once the attempt count reaches the threshold, with no elapsed time required", () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useChatLoadStalled({
        retries: retriesWith({
          count: STALLED_CHAT_LOAD_ATTEMPTS,
          firstAt: now,
        }),
        snapshotLoaded: false,
      }),
    );

    expect(result.current).toBe(true);
  });

  it("inherits an already-elapsed streak on mount instead of restarting the budget", () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useChatLoadStalled({
        retries: retriesWith({
          count: 1,
          firstAt: now - STALLED_CHAT_LOAD_ELAPSED_MS - 1,
        }),
        snapshotLoaded: false,
      }),
    );

    expect(result.current).toBe(true);
  });

  it("stalls at the anchor's own budget, not a streak whose firstAt is later than mount", () => {
    // A `firstAt` later than this hook's own mount instant must not win the
    // `Math.min` - that would let a streak arriving after the wait began
    // postpone the deadline instead of only ever pulling it earlier.
    const now = Date.now();
    const { result } = renderHook(() =>
      useChatLoadStalled({
        retries: retriesWith({ count: 1, firstAt: now + 60_000 }),
        snapshotLoaded: false,
      }),
    );
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(STALLED_CHAT_LOAD_ELAPSED_MS - 1);
    });
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it("stays false regardless of retries once the snapshot has loaded", () => {
    const now = Date.now();
    const { result } = renderHook(() =>
      useChatLoadStalled({
        retries: retriesWith({
          count: 5,
          firstAt: now - STALLED_CHAT_LOAD_ELAPSED_MS * 10,
        }),
        snapshotLoaded: true,
      }),
    );

    expect(result.current).toBe(false);
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicSyncPillState } from "@/lib/epic-sync-pill-state";
import { useLinkDownTooLong } from "../use-link-down-too-long";

// The escalation clock ("Reconnecting…" → "Still reconnecting…") runs per
// OUTAGE. Two properties define it: it must not start before an outage exists,
// and it must not restart on the handshake-only `connected` flips an
// ack-then-fatal loop produces mid-outage.
describe("useLinkDownTooLong", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderState(initial: EpicSyncPillState) {
    return renderHook(({ state }) => useLinkDownTooLong(state), {
      initialProps: { state: initial },
    });
  }

  // Neutral `connected` is not proof of recovery, but it is not an outage
  // either. Arming the clock there pre-set `escalated` for any epic that
  // idles in `connected` past the threshold (an older host, or cloud/dirty
  // evidence that never arrives), so a later outage's FIRST frame already
  // said "Still reconnecting…" about a retry that had just begun.
  it("does not pre-arm escalation while the link idles in neutral connected", () => {
    const { result, rerender } = renderState("connected");

    act(() => {
      vi.advanceTimersByTime(90_000);
    });

    rerender({ state: "reconnecting" });
    expect(result.current).toBe(false);

    // The outage's own minute still escalates.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(true);
  });

  it("keeps one outage's clock running across handshake-only connected flips", () => {
    const { result, rerender } = renderState("reconnecting");

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    // Ack-then-fatal: the transport reaches `open` on every handshake before
    // the resolver's retryable close lands. Same outage.
    rerender({ state: "connected" });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    rerender({ state: "reconnecting" });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(true);
  });

  it("resets on real recovery so the next outage starts un-escalated", () => {
    const { result, rerender } = renderState("reconnecting");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(true);

    rerender({ state: "synced" });
    expect(result.current).toBe(false);

    rerender({ state: "reconnecting" });
    expect(result.current).toBe(false);
  });
});

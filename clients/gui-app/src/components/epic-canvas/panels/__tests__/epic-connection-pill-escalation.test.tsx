import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicSyncPillState } from "@/lib/epic-sync-pill-state";
import { useLinkDownTooLong } from "../use-link-down-too-long";

// The escalation clock ("Reconnecting…" → "Still reconnecting…") runs per
// OUTAGE. Three properties define it: it must not start before an outage
// exists, it must not restart on the handshake-only `connected`/`syncing`
// flips an ack-then-fatal loop produces mid-outage, and it must END on
// evidence (a genuine cloud frame this cycle) rather than on a state label -
// a legacy host that never sends the dirty snapshot derives `connected` even
// for a fully evidenced recovery.
describe("useLinkDownTooLong", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderState(initial: EpicSyncPillState, hasFresh: boolean) {
    return renderHook(({ state, fresh }) => useLinkDownTooLong(state, fresh), {
      initialProps: { state: initial, fresh: hasFresh },
    });
  }

  // Neutral `connected` is not proof of recovery, but it is not an outage
  // either. Arming the clock there pre-set `escalated` for any epic that
  // idles in `connected` past the threshold (an older host, or cloud/dirty
  // evidence that never arrives), so a later outage's FIRST frame already
  // said "Still reconnecting…" about a retry that had just begun.
  it("does not pre-arm escalation while the link idles in neutral connected", () => {
    const { result, rerender } = renderState("connected", false);

    act(() => {
      vi.advanceTimersByTime(90_000);
    });

    rerender({ state: "reconnecting", fresh: false });
    expect(result.current).toBe(false);

    // The outage's own minute still escalates.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(true);
  });

  it("keeps one outage's clock running across handshake-only connected flips", () => {
    const { result, rerender } = renderState("reconnecting", false);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    // Ack-then-fatal: the transport reaches `open` on every handshake before
    // the resolver's retryable close lands. No cloud frame ever arrives in
    // those laps, so the evidence bit stays false. Same outage.
    rerender({ state: "connected", fresh: false });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    rerender({ state: "reconnecting", fresh: false });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(true);
  });

  // Same loop, epic with renderer-only unsynced edits: the handshake lap
  // derives `syncing` instead of `connected` (open socket + local dirty, no
  // genuine cloud frame yet - `deriveEpicSyncPillState` rule 2). It is the
  // same absence of evidence wearing a different label, so it must not end
  // the outage either - resetting here is exactly how the escalation stayed
  // invisible for the user most likely to be watching it: the one with
  // unsaved work.
  it("keeps one outage's clock running across handshake-only syncing flips", () => {
    const { result, rerender } = renderState("reconnecting", false);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    rerender({ state: "syncing", fresh: false });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    rerender({ state: "reconnecting", fresh: false });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(true);
  });

  it("resets on real recovery so the next outage starts un-escalated", () => {
    const { result, rerender } = renderState("reconnecting", false);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(true);

    rerender({ state: "synced", fresh: true });
    expect(result.current).toBe(false);

    rerender({ state: "reconnecting", fresh: false });
    expect(result.current).toBe(false);
  });

  // Legacy host: no `epic.subscribe@1.1` dirty snapshot ever arrives, so
  // `hostDirtyState` stays `unknown` and even a fully evidenced recovery
  // derives `connected` - never `synced`. The outage must end on the
  // EVIDENCE (a genuine cloud frame this cycle), or one outage's clock runs
  // straight through the healthy connection, silently arms escalation, and
  // every later brief drop says "Still reconnecting…" from its first frame.
  it("ends the outage on an evidenced connected state (legacy host recovery)", () => {
    const { result, rerender } = renderState("reconnecting", false);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    // Genuine recovery: transport open AND a cloudSyncStatus frame landed
    // this cycle - but the derived label is still `connected`.
    rerender({ state: "connected", fresh: true });
    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(result.current).toBe(false);

    // A fresh drop after the evidenced recovery is a NEW outage: it gets its
    // own full minute instead of inheriting the previous clock.
    rerender({ state: "reconnecting", fresh: false });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(true);
  });

  // The escalated flag itself must also clear on an evidenced `connected`,
  // not just the outage boolean - otherwise a legacy-host epic that once
  // escalated shows the escalated copy on the first frame of every later
  // drop forever.
  it("clears an escalated outage on evidenced connected so later drops start calm", () => {
    const { result, rerender } = renderState("reconnecting", false);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(true);

    rerender({ state: "connected", fresh: true });
    expect(result.current).toBe(false);

    rerender({ state: "reconnecting", fresh: false });
    expect(result.current).toBe(false);
  });
});

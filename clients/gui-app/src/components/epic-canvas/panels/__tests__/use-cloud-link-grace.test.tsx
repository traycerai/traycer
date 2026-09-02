import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EpicSyncPillState } from "@/lib/epic-sync-pill-state";
import {
  CLOUD_LINK_GRACE_MS,
  isCloudOnlyOutage,
  useCloudLinkGrace,
} from "@/components/epic-canvas/panels/use-cloud-link-grace";

const CLOUD_ONLY_OUTAGE_STATES: readonly EpicSyncPillState[] = [
  "connecting",
  "reconnecting",
  "offlineWithHostPending",
  "offlineChangesSavedLocally",
];

describe("isCloudOnlyOutage", () => {
  it.each(CLOUD_ONLY_OUTAGE_STATES)(
    "reads true for %s while the transport is open",
    (state) => {
      expect(isCloudOnlyOutage(state, "open")).toBe(true);
    },
  );

  it.each(CLOUD_ONLY_OUTAGE_STATES)(
    "reads false for %s once the transport itself is not open",
    (state) => {
      expect(isCloudOnlyOutage(state, "connecting")).toBe(false);
      expect(isCloudOnlyOutage(state, "reconnecting")).toBe(false);
      expect(isCloudOnlyOutage(state, "closed")).toBe(false);
    },
  );

  it.each<EpicSyncPillState>([
    "synced",
    "syncing",
    "hostPending",
    "connected",
    "offline",
  ])(
    "reads false for %s regardless of transport - not a cloud-only-shaped state",
    (state) => {
      expect(isCloudOnlyOutage(state, "open")).toBe(false);
    },
  );

  it("reads false for offlineWithUnsavedChanges even with the transport open", () => {
    // The one state that LOOKS cloud-only and is not: it is the deriver's
    // divergence arm, so the work is renderer-only and awaiting the host's
    // ack. An open transport does not make it durable anywhere.
    expect(isCloudOnlyOutage("offlineWithUnsavedChanges", "open")).toBe(false);
  });
});

describe("useCloudLinkGrace", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(CLOUD_ONLY_OUTAGE_STATES)(
    "holds %s back as 'syncing' with transport open until the grace elapses, then passes it through",
    (state) => {
      vi.useFakeTimers();
      const { result, rerender } = renderHook(
        (props: {
          derived: EpicSyncPillState;
          transport: StreamConnectionStatus;
        }) => useCloudLinkGrace(props.derived, props.transport),
        { initialProps: { derived: state, transport: "open" } },
      );

      expect(result.current).toBe("syncing");

      act(() => {
        vi.advanceTimersByTime(CLOUD_LINK_GRACE_MS - 1);
      });
      rerender({ derived: state, transport: "open" });
      expect(result.current).toBe("syncing");

      act(() => {
        vi.advanceTimersByTime(1);
      });
      rerender({ derived: state, transport: "open" });
      expect(result.current).toBe(state);
    },
  );

  it.each<StreamConnectionStatus>(["reconnecting", "closed"])(
    "passes 'reconnecting' through immediately when the transport itself is %s - a host-link drop gets no grace",
    (transport) => {
      const { result } = renderHook(() =>
        useCloudLinkGrace("reconnecting", transport),
      );

      expect(result.current).toBe("reconnecting");
    },
  );

  it("passes 'offlineWithUnsavedChanges' through on the first frame and keeps it there", () => {
    // Renderer-only work awaiting the host's ack: closing the window discards
    // it, and the amber copy is the only thing that says so. Quieting it even
    // briefly is the one thing this grace must never do - so the assertion is
    // not just "amber at t=0" but "amber for the whole window a graced state
    // would have spent as 'syncing'".
    vi.useFakeTimers();
    const { result, rerender } = renderHook(() =>
      useCloudLinkGrace("offlineWithUnsavedChanges", "open"),
    );

    expect(result.current).toBe("offlineWithUnsavedChanges");

    act(() => {
      vi.advanceTimersByTime(CLOUD_LINK_GRACE_MS * 2);
    });
    rerender();
    expect(result.current).toBe("offlineWithUnsavedChanges");
  });

  it("does not let a graced outage carry its quiet verdict into unsaved renderer work", () => {
    // The grace latches per outage, and a cloud drop can turn into local
    // divergence without an intervening recovery frame. Both directions are
    // covered: mid-window (the latch is still false) and after a COMPLETED
    // window (it is true) - the second is what actually exercises the
    // render-phase reset, since the first passes either way.
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      (props: { derived: EpicSyncPillState }) =>
        useCloudLinkGrace(props.derived, "open"),
      { initialProps: { derived: "reconnecting" as EpicSyncPillState } },
    );
    expect(result.current).toBe("syncing");

    // Mid-window: never quieted, even with a graced outage in flight.
    rerender({ derived: "offlineWithUnsavedChanges" });
    expect(result.current).toBe("offlineWithUnsavedChanges");

    // Now run a window all the way out so the latch is genuinely set.
    rerender({ derived: "reconnecting" });
    act(() => {
      vi.advanceTimersByTime(CLOUD_LINK_GRACE_MS);
    });
    rerender({ derived: "reconnecting" });
    expect(result.current).toBe("reconnecting");

    // Passing through the excluded state must CLEAR that latch, not just be
    // exempt from it. Without the reset the next outage would inherit
    // `sustained` and skip its window entirely.
    rerender({ derived: "offlineWithUnsavedChanges" });
    expect(result.current).toBe("offlineWithUnsavedChanges");

    rerender({ derived: "reconnecting" });
    expect(result.current).toBe("syncing");
  });

  it("recovering to 'synced' at any point returns 'synced' immediately", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      (props: { derived: EpicSyncPillState }) =>
        useCloudLinkGrace(props.derived, "open"),
      { initialProps: { derived: "reconnecting" as EpicSyncPillState } },
    );
    expect(result.current).toBe("syncing");

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    rerender({ derived: "synced" });
    expect(result.current).toBe("synced");
  });

  it("starts a fresh grace window for a later outage after a recovery", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      (props: { derived: EpicSyncPillState }) =>
        useCloudLinkGrace(props.derived, "open"),
      { initialProps: { derived: "reconnecting" as EpicSyncPillState } },
    );

    act(() => {
      vi.advanceTimersByTime(CLOUD_LINK_GRACE_MS);
    });
    rerender({ derived: "reconnecting" });
    expect(result.current).toBe("reconnecting");

    // Recover, then drop again - the new outage must earn its own full
    // window rather than inheriting the earlier sustained verdict.
    rerender({ derived: "synced" });
    expect(result.current).toBe("synced");

    rerender({ derived: "offlineWithHostPending" });
    expect(result.current).toBe("syncing");

    act(() => {
      vi.advanceTimersByTime(CLOUD_LINK_GRACE_MS - 1);
    });
    rerender({ derived: "offlineWithHostPending" });
    expect(result.current).toBe("syncing");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    rerender({ derived: "offlineWithHostPending" });
    expect(result.current).toBe("offlineWithHostPending");
  });
});

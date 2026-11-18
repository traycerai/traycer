import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { EpicSyncPillState } from "@/lib/epic-sync-pill-state";
import {
  CLOUD_LINK_GRACE_MS,
  isCloudLinkDown,
  isCloudOnlyOutage,
  useCloudLinkGrace,
} from "@/components/epic-canvas/panels/use-cloud-link-grace";

const CLOUD_ONLY_OUTAGE_STATES: readonly EpicSyncPillState[] = [
  "connecting",
  "reconnecting",
  "offlineChangesSavedLocally",
];

/**
 * Cloud-down verdicts whose own copy is the only thing telling the user to
 * protect their work - "Keep this window open" and "keep it running". They run
 * the outage clock like any other cloud-down state, and are never quieted.
 */
const NEVER_QUIET_STATES: readonly EpicSyncPillState[] = [
  "offlineWithUnsavedChanges",
  "offlineWithHostPending",
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

  it.each(NEVER_QUIET_STATES)(
    "reads false for %s even with the transport open - cloud-down, but never quiet",
    (state) => {
      expect(isCloudOnlyOutage(state, "open")).toBe(false);
      // Still a cloud-down verdict: it runs the outage clock, it just may not
      // be rendered as `syncing`. Losing this distinction is what let an edit
      // mid-outage restart the window.
      expect(isCloudLinkDown(state, "open")).toBe(true);
    },
  );
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

  it("shows unsaved renderer work immediately without stopping the outage clock", () => {
    // The excluded state is exempt from the QUIET, not from the CLOCK. Here
    // the edit lands mid-window: it must show through at once, and the window
    // must still expire on its original schedule rather than restarting.
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      (props: { derived: EpicSyncPillState }) =>
        useCloudLinkGrace(props.derived, "open"),
      { initialProps: { derived: "reconnecting" as EpicSyncPillState } },
    );
    expect(result.current).toBe("syncing");

    act(() => {
      vi.advanceTimersByTime(CLOUD_LINK_GRACE_MS - 1_000);
    });
    rerender({ derived: "offlineWithUnsavedChanges" });
    expect(result.current).toBe("offlineWithUnsavedChanges");

    // The host acks; the same outage continues. The remaining 1s of the
    // ORIGINAL window is all that is left - a restarted clock would need a
    // further 15s here and would read `syncing` instead.
    rerender({ derived: "reconnecting" });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    rerender({ derived: "reconnecting" });
    expect(result.current).toBe("reconnecting");
  });

  it("keeps a sustained outage amber across an edit and its host ack", () => {
    // The continuous-editing hole: during a sustained outage every keystroke
    // briefly derives `offlineWithUnsavedChanges`, and the host acks a moment
    // later. If that round trip counted as a recovery, each edit would buy
    // another 15s of quiet and an Epic being typed into would never reach
    // amber at all, however long the outage ran.
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

    // Three edits, each acknowledged. Amber throughout - never `syncing`.
    for (let edit = 0; edit < 3; edit += 1) {
      rerender({ derived: "offlineWithUnsavedChanges" });
      expect(result.current).toBe("offlineWithUnsavedChanges");

      rerender({ derived: "offlineWithHostPending" });
      expect(result.current).toBe("offlineWithHostPending");

      rerender({ derived: "reconnecting" });
      expect(result.current).toBe("reconnecting");
    }
  });

  it("still treats a real recovery as the end of the outage", () => {
    // The counterpart to the two above: `synced` is not a cloud-down verdict,
    // so it DOES clear the latch and a later drop earns a full fresh window.
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

    rerender({ derived: "synced" });
    expect(result.current).toBe("synced");

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

    rerender({ derived: "reconnecting" });
    expect(result.current).toBe("syncing");

    act(() => {
      vi.advanceTimersByTime(CLOUD_LINK_GRACE_MS - 1);
    });
    rerender({ derived: "reconnecting" });
    expect(result.current).toBe("syncing");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    rerender({ derived: "reconnecting" });
    expect(result.current).toBe("reconnecting");
  });
});

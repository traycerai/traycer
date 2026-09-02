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
  "offlineWithUnsavedChanges",
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

import { beforeEach, describe, expect, it } from "vitest";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  isSurfacePinDeposed,
  isSurfacePinFleetKnown,
  resolvedSurfaceHostId,
  useSurfaceHostSelectionStore,
  type SurfacePinFleetView,
} from "@/stores/host/surface-host-selection-store";

/**
 * Pure-function suite over the per-surface pin's auto-follow / sticky-return
 * rule (redesign, host-lifecycle epic): a pin resolves to its own host while
 * that host can serve, and to `effective` while it cannot - and the pin
 * itself is NEVER cleared by death, which is what makes the return sticky.
 *
 * `isSurfacePinDeposed` is exercised both directly and through
 * `resolvedSurfaceHostId` (which is defined in terms of it), so a regression
 * in either shows up here without standing up React or a fleet-reporting
 * hook.
 */

function readyLease(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "ready", dead: null };
}

function deadLease(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "dead", dead: { reason: "offline" } };
}

function restartingLease(hostId: string): HostLeaseSnapshot {
  return { hostId, status: "restarting-expected", dead: null };
}

function fleet(
  authorityAttached: boolean,
  leases: readonly HostLeaseSnapshot[],
): SurfacePinFleetView {
  return { authorityAttached, leases };
}

function resetStore(): void {
  window.localStorage.clear();
  useSurfaceHostSelectionStore.getState().resetForTests();
}

describe("surface pin auto-follow / sticky return", () => {
  beforeEach(resetStore);

  it("1. unpinned resolves to effective, whatever the fleet says", () => {
    // Even a fleet where the effective host itself reads dead must not change
    // this: `resolvedSurfaceHostId` only consults the fleet when a pin is
    // present (`selection !== null`).
    expect(
      resolvedSurfaceHostId(
        null,
        "host-eff",
        fleet(true, [deadLease("host-eff")]),
      ),
    ).toBe("host-eff");
  });

  it("2. pinned host with a ready lease resolves to the pin", () => {
    expect(
      resolvedSurfaceHostId(
        "host-pin",
        "host-eff",
        fleet(true, [readyLease("host-pin")]),
      ),
    ).toBe("host-pin");
  });

  it("3. pinned host with a dead lease auto-follows to effective", () => {
    expect(
      resolvedSurfaceHostId(
        "host-pin",
        "host-eff",
        fleet(true, [deadLease("host-pin")]),
      ),
    ).toBe("host-eff");
  });

  it("4. sticky return: resolves pin -> effective -> pin across a dead-then-ready cycle, with the stored selection unchanged throughout", () => {
    const surfaceKey = "sticky-return-surface";
    useSurfaceHostSelectionStore
      .getState()
      .setSelection(surfaceKey, "host-pin");
    const selection = (): string | null =>
      useSurfaceHostSelectionStore.getState().selections[surfaceKey] ?? null;

    expect(
      resolvedSurfaceHostId(
        selection(),
        "host-eff",
        fleet(true, [readyLease("host-pin")]),
      ),
    ).toBe("host-pin");
    expect(selection()).toBe("host-pin");

    expect(
      resolvedSurfaceHostId(
        selection(),
        "host-eff",
        fleet(true, [deadLease("host-pin")]),
      ),
    ).toBe("host-eff");
    expect(selection()).toBe("host-pin");

    expect(
      resolvedSurfaceHostId(
        selection(),
        "host-eff",
        fleet(true, [readyLease("host-pin")]),
      ),
    ).toBe("host-pin");
    expect(selection()).toBe("host-pin");
  });

  it("5. pinned host with a restarting-expected lease resolves to the pin (a hold, not a death)", () => {
    // This is the case that distinguishes `status === "dead"` from
    // `!isUsableForSelection`: `restarting-expected` is not usable for
    // candidate selection, but it is also not `dead`. A pin is an incumbent,
    // not a candidate, so it holds through an expected restart exactly like
    // the app-wide failover does.
    expect(
      resolvedSurfaceHostId(
        "host-pin",
        "host-eff",
        fleet(true, [restartingLease("host-pin")]),
      ),
    ).toBe("host-pin");
    expect(
      isSurfacePinDeposed(
        "host-pin",
        fleet(true, [restartingLease("host-pin")]),
      ),
    ).toBe(false);
  });

  it("6. pinned host resolves to the pin when the authority has not attached yet (bootstrap is not death)", () => {
    expect(
      resolvedSurfaceHostId(
        "host-pin",
        "host-eff",
        // Even a dead-looking lease must not matter here: the attach guard
        // short-circuits before the lease set is ever consulted.
        fleet(false, [deadLease("host-pin")]),
      ),
    ).toBe("host-pin");
  });

  it("7. pinned host resolves to the pin when the fleet is attached but empty (empty set is not an answer)", () => {
    expect(resolvedSurfaceHostId("host-pin", "host-eff", fleet(true, []))).toBe(
      "host-pin",
    );
  });

  it("8. pinned host resolves to effective when a non-empty fleet no longer lists it (the host left the fleet)", () => {
    expect(
      resolvedSurfaceHostId(
        "host-pin",
        "host-eff",
        fleet(true, [readyLease("host-other")]),
      ),
    ).toBe("host-eff");
  });

  it("9. isSurfacePinFleetKnown is false when unattached and false when the lease set is empty; true otherwise", () => {
    expect(isSurfacePinFleetKnown(fleet(false, []))).toBe(false);
    expect(isSurfacePinFleetKnown(fleet(false, [readyLease("host-a")]))).toBe(
      false,
    );
    expect(isSurfacePinFleetKnown(fleet(true, []))).toBe(false);
    expect(isSurfacePinFleetKnown(fleet(true, [readyLease("host-a")]))).toBe(
      true,
    );
  });

  it("10. clearPinsForHost removes every surface key pinned to that host and leaves other hosts' pins untouched", () => {
    const store = useSurfaceHostSelectionStore.getState();
    store.setSelection("surface-1", "host-a");
    store.setSelection("surface-2", "host-a");
    store.setSelection("surface-3", "host-b");

    useSurfaceHostSelectionStore.getState().clearPinsForHost("host-a");

    const selections = useSurfaceHostSelectionStore.getState().selections;
    expect(selections["surface-1"]).toBeUndefined();
    expect(selections["surface-2"]).toBeUndefined();
    expect(selections["surface-3"]).toBe("host-b");
  });

  it("11. clearPinsForHost on a host nobody is pinned to does not change the selections object identity", () => {
    useSurfaceHostSelectionStore.getState().setSelection("surface-1", "host-b");
    const before = useSurfaceHostSelectionStore.getState().selections;

    useSurfaceHostSelectionStore
      .getState()
      .clearPinsForHost("host-nobody-pins");

    expect(useSurfaceHostSelectionStore.getState().selections).toBe(before);
  });

  it("12. latchOnFirstUse does not overwrite an existing pin (keeps the sticky return alive)", () => {
    const store = useSurfaceHostSelectionStore.getState();
    store.setSelection("surface-1", "host-original");

    store.latchOnFirstUse("surface-1", "host-other");

    expect(
      useSurfaceHostSelectionStore.getState().selections["surface-1"],
    ).toBe("host-original");
  });
});

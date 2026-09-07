import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import { AVAILABLE_HOST_ROW_SURFACE_STATE } from "@/components/settings/host-scope/host-option-model";
import {
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateView,
} from "@/lib/host/fleet-update/fleet-update-view";

// Also pins the row's other isolation property: it is pure content, with no interactive element of its own for
// any banner/update state to disable.

function fleetView(overrides: Partial<FleetUpdateView>): FleetUpdateView {
  // Built by spreading the shared "we know nothing" constant rather than hand-writing every field.
  return {
    ...UNKNOWN_FLEET_UPDATE_VIEW,
    kind: "idle",
    qualified: false,
    ...overrides,
  };
}

describe("HostOptionRow — per-host update badge isolation (Ticket 06 subject F)", () => {
  // This suite has no RTL auto-cleanup configured (confirmed project-wide gap).
  afterEach(cleanup);

  it("renders each row's badge from its OWN updateView prop only, independent of a sibling row's state", () => {
    const hostA = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const hostB = hostScopeOptionFixture({ hostId: "host-b", name: "Host B" });
    const viewA = fleetView({ kind: "downloading" });
    const viewB = fleetView({ kind: "idle" });

    const { getByTestId, queryByTestId } = render(
      <>
        <HostOptionRow
          host={hostA}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={viewA}
        />
        <HostOptionRow
          host={hostB}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={viewB}
        />
      </>,
    );

    expect(getByTestId("host-option-update-badge-host-a").textContent).toBe(
      "updating",
    );
    // The isolation claim: B's idle view renders NO badge at all, not a stale
    // or shared copy of A's.
    expect(queryByTestId("host-option-update-badge-host-b")).toBeNull();
  });

  it("positive control: swapping which row holds the active view moves the badge with it, proving the isolation claim above could fail", () => {
    const hostA = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const hostB = hostScopeOptionFixture({ hostId: "host-b", name: "Host B" });

    const { getByTestId, queryByTestId, rerender } = render(
      <>
        <HostOptionRow
          host={hostA}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={fleetView({ kind: "idle" })}
        />
        <HostOptionRow
          host={hostB}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={fleetView({ kind: "failed" })}
        />
      </>,
    );
    expect(queryByTestId("host-option-update-badge-host-a")).toBeNull();
    expect(getByTestId("host-option-update-badge-host-b").textContent).toBe(
      "update failed",
    );

    rerender(
      <>
        <HostOptionRow
          host={hostA}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={fleetView({ kind: "failed" })}
        />
        <HostOptionRow
          host={hostB}
          picked={false}
          active={false}
          intent="view"
          surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
          updateView={fleetView({ kind: "idle" })}
        />
      </>,
    );
    expect(getByTestId("host-option-update-badge-host-a").textContent).toBe(
      "update failed",
    );
    expect(queryByTestId("host-option-update-badge-host-b")).toBeNull();
  });

  it("a `null` updateView (every non-Settings picker) renders no badge — opt-in by data, never a default", () => {
    const host = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const { queryByTestId } = render(
      <HostOptionRow
        host={host}
        picked={false}
        active={false}
        intent="view"
        surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
        updateView={null}
      />,
    );
    expect(queryByTestId("host-option-update-badge-host-a")).toBeNull();
  });

  it("an active update state renders no interactive or disable-able element — the row itself cannot gate selection", () => {
    const host = hostScopeOptionFixture({ hostId: "host-a", name: "Host A" });
    const { container } = render(
      <HostOptionRow
        host={host}
        picked={false}
        active={false}
        intent="view"
        surfaceState={AVAILABLE_HOST_ROW_SURFACE_STATE}
        updateView={fleetView({
          kind: "waiting-for-work",
          blockingSessionCount: 3,
        })}
      />,
    );
    // Structural, not a checklist of specific attributes: nothing this row renders is a button, link, or anything
    // carrying `disabled` / `aria-disabled`.
    expect(
      container.querySelectorAll("button, a, [role='button']"),
    ).toHaveLength(0);
    expect(container.querySelectorAll("[disabled]")).toHaveLength(0);
    expect(container.querySelectorAll("[aria-disabled]")).toHaveLength(0);
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostOverviewUpdatePillButton,
  HostOverviewUpdateStrip,
} from "@/components/settings/panels/host-overview-update-pill";
import {
  deriveHostOverviewUpdatePill,
  type HostOverviewUpdatePill,
} from "@/components/settings/panels/host-overview-update-pill-model";
import { HostOverviewSelectTabContext } from "@/components/settings/panels/host-overview-tab-state";
import {
  UNKNOWN_FLEET_UPDATE_VIEW,
  type FleetUpdateView,
  type FleetUpdateViewKind,
} from "@/lib/host/fleet-update/fleet-update-view";

afterEach(() => {
  cleanup();
});

function liveView(
  kind: FleetUpdateViewKind,
  overrides: Partial<FleetUpdateView>,
): FleetUpdateView {
  return { ...UNKNOWN_FLEET_UPDATE_VIEW, kind, qualified: false, ...overrides };
}

function derive(
  view: FleetUpdateView | null,
  restarting: boolean,
  completionDismissed: boolean,
  cliFloorBlocked: boolean,
): HostOverviewUpdatePill | null {
  return deriveHostOverviewUpdatePill({
    view,
    restarting,
    completionDismissed,
    cliFloorBlocked,
  });
}

const IN_FLIGHT_KINDS: ReadonlyArray<FleetUpdateViewKind> = [
  "updating",
  "downloading",
  "preparing",
  "applying",
  "waiting-for-work",
  "waiting-to-activate",
  "restarting",
  "reconnecting",
  "verifying",
  "complete",
  "failed",
  "finalizing-record",
  "verification-refused",
  "unavailable",
  "idle",
];

describe("deriveHostOverviewUpdatePill", () => {
  it("returns null for a null view", () => {
    expect(derive(null, false, false, false)).toBeNull();
  });

  it("draws Updating… for updating", () => {
    expect(derive(liveView("updating", {}), false, false, false)).toEqual({
      label: "Updating…",
      tone: "info",
    });
  });

  it("draws a bare Downloading… when the host reported no percent", () => {
    const view = liveView("downloading", { progress: { kind: "none" } });
    expect(derive(view, false, false, false)).toEqual({
      label: "Downloading…",
      tone: "info",
    });
  });

  it("draws the measured percent when the host reported one", () => {
    const view = liveView("downloading", {
      progress: {
        kind: "determinate",
        percent: 42.6,
        bytes: null,
        totalBytes: null,
      },
    });
    expect(derive(view, false, false, false)).toEqual({
      label: "Downloading 43%",
      tone: "info",
    });
  });

  it("draws Preparing… for preparing", () => {
    expect(derive(liveView("preparing", {}), false, false, false)).toEqual({
      label: "Preparing…",
      tone: "info",
    });
  });

  it("draws Installing… for applying", () => {
    expect(derive(liveView("applying", {}), false, false, false)).toEqual({
      label: "Installing…",
      tone: "info",
    });
  });

  it("draws Verifying… for verifying", () => {
    expect(derive(liveView("verifying", {}), false, false, false)).toEqual({
      label: "Verifying…",
      tone: "info",
    });
  });

  it("draws Restart to finish update for waiting-to-activate", () => {
    expect(
      derive(liveView("waiting-to-activate", {}), false, false, false),
    ).toEqual({ label: "Restart to finish update", tone: "warning" });
  });

  it("draws Update waiting on work for waiting-for-work when the CLI is not blocking", () => {
    expect(
      derive(liveView("waiting-for-work", {}), false, false, false),
    ).toEqual({ label: "Update waiting on work", tone: "warning" });
  });

  it("draws Update waiting on CLI tools for waiting-for-work when the floor blocks it, over the work word", () => {
    expect(
      derive(liveView("waiting-for-work", {}), false, false, true),
    ).toEqual({ label: "Update waiting on CLI tools", tone: "warning" });
  });

  it("draws Update failed for failed", () => {
    expect(derive(liveView("failed", {}), false, false, false)).toEqual({
      label: "Update failed",
      tone: "destructive",
    });
  });

  it("draws Updated to vX for complete with a target version, not dismissed", () => {
    const view = liveView("complete", { targetVersion: "2.1.0" });
    expect(derive(view, false, false, false)).toEqual({
      label: "Updated to v2.1.0",
      tone: "success",
    });
  });

  it("draws a bare Updated for complete with no target version", () => {
    const view = liveView("complete", { targetVersion: null });
    expect(derive(view, false, false, false)).toEqual({
      label: "Updated",
      tone: "success",
    });
  });

  it("returns null for complete once the completion acknowledgement is dismissed", () => {
    const view = liveView("complete", { targetVersion: "2.1.0" });
    expect(derive(view, false, true, false)).toBeNull();
  });

  it("draws no pill for restarting, reconnecting, finalizing-record, verification-refused, unavailable or idle", () => {
    for (const kind of [
      "restarting",
      "reconnecting",
      "finalizing-record",
      "verification-refused",
      "unavailable",
      "idle",
    ] as const) {
      expect(derive(liveView(kind, {}), false, false, false)).toBeNull();
    }
  });

  it("returns null for every kind when the header already reads Restarting…, whatever the view says", () => {
    for (const kind of IN_FLIGHT_KINDS) {
      expect(derive(liveView(kind, {}), true, false, false)).toBeNull();
    }
    const complete = liveView("complete", { targetVersion: "2.1.0" });
    expect(derive(complete, true, false, false)).toBeNull();
  });

  it("draws the picker's retained word for a qualified live view, in place of the present-tense row", () => {
    const view = liveView("downloading", { qualified: true });
    expect(derive(view, false, false, false)).toEqual({
      label: "Last seen: updating",
      tone: "muted",
    });
  });

  it("draws the retained word for a qualified failed view", () => {
    const view = liveView("failed", { qualified: true });
    expect(derive(view, false, false, false)).toEqual({
      label: "Last seen: update failed",
      tone: "muted",
    });
  });

  it("draws no pill for a qualified view whose retained word is null (e.g. complete)", () => {
    const view = liveView("complete", {
      qualified: true,
      targetVersion: "2.1.0",
    });
    expect(derive(view, false, false, false)).toBeNull();
  });

  it("draws the retained word for an unknown view carrying a retained downloading phase", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      lastKnownKind: "downloading",
    };
    expect(derive(view, false, false, false)).toEqual({
      label: "Last seen: updating",
      tone: "muted",
    });
  });

  it("draws the retained word for an unknown view carrying a retained failed phase", () => {
    const view: FleetUpdateView = {
      ...UNKNOWN_FLEET_UPDATE_VIEW,
      lastKnownKind: "failed",
    };
    expect(derive(view, false, false, false)).toEqual({
      label: "Last seen: update failed",
      tone: "muted",
    });
  });

  it("draws no pill for a bare unknown view with no retained phase", () => {
    expect(derive(UNKNOWN_FLEET_UPDATE_VIEW, false, false, false)).toBeNull();
  });
});

describe("<HostOverviewUpdatePillButton/>", () => {
  it("renders the label and tone, and selects Status on click when a provider is present", () => {
    const selectTab = vi.fn();
    const pill: HostOverviewUpdatePill = {
      label: "Downloading 43%",
      tone: "info",
    };
    render(
      <HostOverviewSelectTabContext value={selectTab}>
        <HostOverviewUpdatePillButton pill={pill} />
      </HostOverviewSelectTabContext>,
    );
    const button = screen.getByTestId("host-overview-update-pill");
    expect(button.textContent).toBe("Downloading 43%");
    expect(button.getAttribute("data-tone")).toBe("info");
    fireEvent.click(button);
    expect(selectTab).toHaveBeenCalledExactlyOnceWith("status");
  });

  it("renders without a provider (a unit-mounted pill), and a click does nothing", () => {
    const pill: HostOverviewUpdatePill = {
      label: "Update failed",
      tone: "destructive",
    };
    render(<HostOverviewUpdatePillButton pill={pill} />);
    const button = screen.getByTestId("host-overview-update-pill");
    expect(() => fireEvent.click(button)).not.toThrow();
  });
});

describe("<HostOverviewUpdateStrip/>", () => {
  it("renders the label and tone, and selects Status when tapped", () => {
    const selectTab = vi.fn();
    const pill: HostOverviewUpdatePill = {
      label: "Restart to finish update",
      tone: "warning",
    };
    render(
      <HostOverviewSelectTabContext value={selectTab}>
        <HostOverviewUpdateStrip pill={pill} />
      </HostOverviewSelectTabContext>,
    );
    const strip = screen.getByTestId("host-overview-update-strip");
    expect(strip.getAttribute("data-tone")).toBe("warning");
    expect(strip.textContent).toContain("Restart to finish update");
    fireEvent.click(strip);
    expect(selectTab).toHaveBeenCalledExactlyOnceWith("status");
  });

  it("renders without a provider, and a tap does nothing", () => {
    const pill: HostOverviewUpdatePill = {
      label: "Updated to v2.1.0",
      tone: "success",
    };
    render(<HostOverviewUpdateStrip pill={pill} />);
    const strip = screen.getByTestId("host-overview-update-strip");
    expect(() => fireEvent.click(strip)).not.toThrow();
  });
});

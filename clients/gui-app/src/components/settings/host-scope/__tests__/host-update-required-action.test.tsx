const appVersion = vi.hoisted((): { current: string | null } => ({
  current: null,
}));
vi.mock("@/lib/app-version", () => ({
  getClientAppVersion: () => appVersion.current,
  getClientAppVersionLabel: () => "v0.0.0",
}));

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectionIncompatibility } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { HostUpdateRequiredAction } from "@/components/settings/host-scope/host-update-required-action";

/** Rider 1's affordance, and specifically the cases where it must not appear. "Settings rows render
 * dead(incompatible) with the update affordance" reads unconditional; it cannot be. */

afterEach(() => {
  cleanup();
  appVersion.current = null;
});

function incompatibility(hostVersion: string | null): SelectionIncompatibility {
  return {
    code: "PROTOCOL_MAJOR_MISMATCH",
    hostVersion,
    minSupportedVersion: "1.2.0",
    clientCompatibility: null,
  };
}

function renderAction(props: {
  readonly hostVersion: string | null;
  readonly canManageHost: boolean;
  readonly onUpdateHost?: () => void;
  readonly pending?: boolean;
}): void {
  render(
    <HostUpdateRequiredAction
      detail={incompatibility(props.hostVersion)}
      canManageHost={props.canManageHost}
      onUpdateHost={props.onUpdateHost ?? (() => undefined)}
      pending={props.pending ?? false}
    />,
  );
}

describe("<HostUpdateRequiredAction />", () => {
  it("offers the update for a manageable host that is behind this app", () => {
    appVersion.current = "1.5.0";
    renderAction({ hostVersion: "1.1.4", canManageHost: true });

    const button = screen.getByTestId("host-scope-update-host");
    expect(button.textContent).toBe("Update host");
  });

  /** The host is not the problem: this app is older than it, and updating the host would move it further away. */
  it("withholds the update when THIS APP is the outdated leg", () => {
    appVersion.current = "1.0.0";
    renderAction({ hostVersion: "9.9.9", canManageHost: true });

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
  });

  /** Force-provisioning is the bundled host's lifecycle on this computer, so there is no action to offer - naming
   * the problem without offering a control you cannot reach is the honest half. */
  it("withholds the update for a host this app does not manage", () => {
    appVersion.current = "1.5.0";
    renderAction({ hostVersion: "1.1.4", canManageHost: false });

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
  });

  it("runs the update lane on click", () => {
    appVersion.current = "1.5.0";
    const onUpdateHost = vi.fn();
    renderAction({ hostVersion: "1.1.4", canManageHost: true, onUpdateHost });

    fireEvent.click(screen.getByTestId("host-scope-update-host"));
    expect(onUpdateHost).toHaveBeenCalledTimes(1);
  });

  it("locks the trigger while an update is already running", () => {
    appVersion.current = "1.5.0";
    const onUpdateHost = vi.fn();
    renderAction({
      hostVersion: "1.1.4",
      canManageHost: true,
      onUpdateHost,
      pending: true,
    });

    const button = screen.getByTestId("host-scope-update-host");
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onUpdateHost).not.toHaveBeenCalled();
  });

  /** An unparsable pair does not single out a leg, and the shared helper defaults that to host-outdated rather
   * than silently withholding. */
  it("still offers the update when neither version can be compared", () => {
    appVersion.current = null;
    renderAction({ hostVersion: null, canManageHost: true });

    expect(screen.queryByTestId("host-scope-update-host")).not.toBeNull();
  });
});

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

/**
 * Rider 1's affordance, and specifically the cases where it must NOT appear.
 *
 * "Settings rows render dead(incompatible) with the update affordance" reads
 * unconditional; it cannot be. Updating the host cannot fix an app that is
 * itself the outdated leg, and there is no update this app can perform against
 * a machine on someone else's desk. A button offered in either case could only
 * ever fail — the F8 "Retry now" class this epic deleted — so both are
 * withheld, and the row still carries the word `update required` either way.
 *
 * The gates are not restated here: they are the same `hostUpdateActionApplies`
 * and the same `canManageHost` reduction the window modal's `resolveUpdateHost`
 * uses, called rather than copied, so the two surfaces cannot drift.
 */

afterEach(() => {
  cleanup();
  appVersion.current = null;
});

function incompatibility(hostVersion: string | null): SelectionIncompatibility {
  return {
    code: "PROTOCOL_MAJOR_MISMATCH",
    hostVersion,
    minSupportedVersion: "1.2.0",
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

  /**
   * THE withheld case that matters most. The host is not the problem: this app
   * is older than it, and updating the host would move it further away. The
   * modal withholds it here for the same reason, from the same predicate.
   */
  it("withholds the update when THIS APP is the outdated leg", () => {
    appVersion.current = "1.0.0";
    renderAction({ hostVersion: "9.9.9", canManageHost: true });

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
  });

  /**
   * A remote machine. Force-provisioning is the bundled host's lifecycle on
   * THIS computer, so there is no action to offer — naming the problem without
   * offering a control you cannot reach is the honest half.
   */
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

  /**
   * An unparsable pair does not single out a leg, and the shared helper
   * defaults that to host-outdated rather than silently withholding. Pinned so
   * the default stays deliberate: a host that reported no version at all is
   * still one this app can try to update, and refusing would leave the user
   * with a named problem and nothing to press.
   */
  it("still offers the update when neither version can be compared", () => {
    appVersion.current = null;
    renderAction({ hostVersion: null, canManageHost: true });

    expect(screen.queryByTestId("host-scope-update-host")).not.toBeNull();
  });
});

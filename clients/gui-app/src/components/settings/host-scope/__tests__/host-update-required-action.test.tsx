const appVersion = vi.hoisted((): { current: string | null } => ({
  current: null,
}));
vi.mock("@/lib/app-version", () => ({
  getClientAppVersion: () => appVersion.current,
  getClientAppVersionLabel: () => "v0.0.0",
}));

const olderHostUpdate = vi.hoisted(() => ({
  update: vi.fn(),
  pending: false,
  remotePending: false,
  failure: null as {
    readonly message: string;
    readonly code: string | null;
  } | null,
}));
vi.mock("@/hooks/host/use-older-host-update", () => ({
  useOlderHostUpdate: () => olderHostUpdate,
}));
vi.mock("@/hooks/host/use-host-provisioning-progress", () => ({
  useHostProvisioningProgress: () => null,
}));

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectionIncompatibility } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { HostUpdateRequiredAction } from "@/components/settings/host-scope/host-update-required-action";

/**
 * The action renders "Update now" from the shared skew copy when updating the
 * host can fix the skew. The component owns the update hook: a presentation
 * test supplies that hook. The control locks only while its own update is in
 * flight. A remote pending row shows "Update pending" and leaves the button
 * usable.
 */

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  appVersion.current = null;
  olderHostUpdate.update = vi.fn();
  olderHostUpdate.pending = false;
  olderHostUpdate.remotePending = false;
  olderHostUpdate.failure = null;
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
  readonly pending?: boolean;
  readonly remotePending?: boolean;
}): void {
  olderHostUpdate.pending = props.pending ?? false;
  olderHostUpdate.remotePending = props.remotePending ?? false;
  render(
    <HostUpdateRequiredAction
      hostId="host-a"
      detail={incompatibility(props.hostVersion)}
      testId="host-scope-update-host"
    />,
  );
}

function updateButton(): HTMLButtonElement {
  const button = screen.getByTestId("host-scope-update-host");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("update control is not a button");
  }
  return button;
}

describe("<HostUpdateRequiredAction />", () => {
  it("offers Update now for a host that is behind this app", () => {
    appVersion.current = "1.5.0";
    renderAction({ hostVersion: "1.1.4" });

    expect(updateButton().textContent).toBe("Update now");
    expect(updateButton().disabled).toBe(false);
  });

  it("withholds the update when THIS APP is the outdated leg", () => {
    appVersion.current = "1.0.0";
    renderAction({ hostVersion: "9.9.9" });

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
  });

  it("runs the update hook on click", () => {
    appVersion.current = "1.5.0";
    renderAction({ hostVersion: "1.1.4" });

    updateButton().click();
    expect(olderHostUpdate.update).toHaveBeenCalledTimes(1);
  });

  it("locks the trigger while an update is already running", () => {
    appVersion.current = "1.5.0";
    renderAction({ hostVersion: "1.1.4", pending: true });

    const button = updateButton();
    expect(button.disabled).toBe(true);
    button.click();
    expect(olderHostUpdate.update).not.toHaveBeenCalled();
  });

  it("shows Update pending for a remote pending row and still runs the hook", () => {
    appVersion.current = "1.5.0";
    renderAction({ hostVersion: "1.1.4", remotePending: true });

    const button = updateButton();
    expect(screen.getByText("Update pending")).toBeTruthy();
    expect(button.disabled).toBe(false);
    button.click();
    expect(olderHostUpdate.update).toHaveBeenCalledTimes(1);
  });

  it("still offers the update when neither version can be compared", () => {
    appVersion.current = null;
    renderAction({ hostVersion: null });

    expect(screen.queryByTestId("host-scope-update-host")).not.toBeNull();
  });
});

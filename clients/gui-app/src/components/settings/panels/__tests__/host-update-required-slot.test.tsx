const appVersion = vi.hoisted((): { current: string | null } => ({
  current: "1.5.0",
}));
vi.mock("@/lib/app-version", () => ({
  getClientAppVersion: () => appVersion.current,
  getClientAppVersionLabel: () => "v1.5.0",
}));

const olderHostUpdate = vi.hoisted(() => ({
  update: vi.fn(),
  pending: false,
  remotePending: false,
  available: true,
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
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return {
    ...actual,
    useHostDirectoryEntry: () => null,
  };
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { HostUpdateRequiredSlot } from "@/components/settings/panels/host-overview-panel";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * The slot offers Update now from the lease's incompatibility. Card health is
 * not an input: a stopped card still shows the action when the lease says
 * incompatible. The directory read is nulled here so the floor arm stays out
 * of this lease-only presentation.
 */

const INCOMPATIBLE: HostLeaseSnapshot = {
  hostId: "host-a",
  status: "dead",
  dead: {
    reason: "incompatible",
    detail: {
      code: "PROTOCOL_MAJOR_MISMATCH",
      hostVersion: "1.1.4",
      minSupportedVersion: "1.2.0",
      clientCompatibility: null,
    },
  },
};

function seedLeases(leases: readonly HostLeaseSnapshot[]): void {
  useSelectionAuthorityStore.getState().applyKernelSnapshot({
    attached: true,
    preferredHostId: "host-a",
    targetHostId: "host-a",
    effectiveHostId: "host-a",
    leases,
    selectionRevision: 1,
  });
}

function renderSlot(state: HostHealthState): void {
  render(
    <HostUpdateRequiredSlot
      host={hostScopeOptionFixture({
        hostId: "host-a",
        name: "Studio Mac",
        isLocalMachine: true,
        health: {
          state,
          label: "irrelevant to the gate",
          detail: null,
          tone: "warn",
          live: false,
        },
      })}
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

beforeEach(() => {
  olderHostUpdate.update = vi.fn();
  olderHostUpdate.pending = false;
  olderHostUpdate.remotePending = false;
  olderHostUpdate.available = true;
  olderHostUpdate.failure = null;
  appVersion.current = "1.5.0";
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
});

describe("<HostUpdateRequiredSlot />", () => {
  it("offers the update when the lease says incompatible", () => {
    seedLeases([INCOMPATIBLE]);
    renderSlot("update-required");

    expect(updateButton().textContent).toBe("Update now");
  });

  it("still offers the update when the card's health word is stopped", () => {
    seedLeases([INCOMPATIBLE]);
    renderSlot("stopped");

    expect(screen.queryByTestId("host-scope-update-host")).not.toBeNull();
  });

  it("withholds the update when no lease carries an incompatibility", () => {
    seedLeases([{ hostId: "host-a", status: "ready", dead: null }]);
    renderSlot("update-required");

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
  });

  it("does not borrow another host's incompatibility", () => {
    seedLeases([{ ...INCOMPATIBLE, hostId: "host-b" }]);
    renderSlot("update-required");

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
  });

  it("runs the older-host update hook on click", () => {
    seedLeases([INCOMPATIBLE]);
    renderSlot("update-required");

    updateButton().click();
    expect(olderHostUpdate.update).toHaveBeenCalledTimes(1);
  });

  it("keeps Update now present and disabled when the hook has no target", () => {
    olderHostUpdate.available = false;
    seedLeases([INCOMPATIBLE]);
    renderSlot("update-required");

    const button = updateButton();
    expect(button.disabled).toBe(true);
    button.click();
    expect(olderHostUpdate.update).not.toHaveBeenCalled();
  });
});

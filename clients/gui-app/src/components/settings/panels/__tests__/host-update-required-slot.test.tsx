const appVersion = vi.hoisted((): { current: string | null } => ({
  current: "1.5.0",
}));
vi.mock("@/lib/app-version", () => ({
  getClientAppVersion: () => appVersion.current,
  getClientAppVersionLabel: () => "v1.5.0",
}));

vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return { ...actual, MINIMUM_HOST_VERSION: "2.0.0" };
  },
);

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

const directoryRow = vi.hoisted(
  (): {
    current:
      | import("@traycer-clients/shared/host-client/host-directory").HostDirectoryEntry
      | null;
  } => ({
    current: null,
  }),
);
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return {
    ...actual,
    useHostDirectoryEntry: () => directoryRow.current,
  };
});

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { HostUpdateRequiredSlot } from "@/components/settings/panels/host-overview-panel";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostHealthState } from "@/components/settings/host-scope/host-health";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/**
 * A generic incompatible lease still follows the card's health word: stopped
 * withholds the action. A directory row below this test's floor ("2.0.0")
 * shows Update now even when the card is stopped and the lease is fine.
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

function localEntry(version: string): HostDirectoryEntry {
  return {
    hostId: "host-a",
    label: "Studio Mac",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:1/rpc",
    version,
    transportDialability: "dialable",
  };
}

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
  olderHostUpdate.failure = null;
  appVersion.current = "1.5.0";
  directoryRow.current = null;
});

afterEach(() => {
  cleanup();
  useSelectionAuthorityStore.getState().reset();
});

describe("<HostUpdateRequiredSlot />", () => {
  it("offers the update when the lease says incompatible and the card is update-required", () => {
    seedLeases([INCOMPATIBLE]);
    renderSlot("update-required");

    expect(updateButton().textContent).toBe("Update now");
  });

  it("withholds a generic incompatible lease when the card's health word is stopped", () => {
    seedLeases([INCOMPATIBLE]);
    renderSlot("stopped");

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
  });

  it("offers Update now for a below-floor directory row even when the card is stopped", () => {
    directoryRow.current = localEntry("1.5.4");
    seedLeases([{ hostId: "host-a", status: "ready", dead: null }]);
    renderSlot("stopped");

    expect(updateButton().textContent).toBe("Update now");
  });

  it("withholds a stopped card when the directory row meets this test's floor", () => {
    directoryRow.current = localEntry("2.0.0");
    seedLeases([INCOMPATIBLE]);
    renderSlot("stopped");

    expect(screen.queryByTestId("host-scope-update-host")).toBeNull();
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
});

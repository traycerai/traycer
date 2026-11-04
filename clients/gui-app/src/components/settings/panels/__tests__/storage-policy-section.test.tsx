import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import type {
  EnvironmentConfigurationItem,
  EnvironmentConfigurationItemWriteResponse,
} from "@traycer/protocol/host/environment/configuration-contracts";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  configurationItem,
  mountTeamPage,
  poolSource,
  requireTeamHostClient,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import { Toaster } from "@/components/ui/sonner";

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => requireTeamHostClient(),
}));
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

import { StoragePolicySection } from "@/components/settings/panels/storage-policy-section";
import { StorageSettingsPanel } from "@/components/settings/environment/storage-settings-panel";
import {
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const PERSONAL_ENV = "env-personal";
const PERSONAL_SECTION = <StoragePolicySection pick={PERSONAL_PICK} />;
const TEAM_ENV = "env-acme";
const PUT = "environment.configuration.items.put";

function descriptor(
  effectiveRole: EnvironmentDescriptorV11["effectiveRole"],
): EnvironmentDescriptorV11 {
  return {
    environmentId: PERSONAL_ENV,
    ownerKind: "user",
    ownerId: "u1",
    roomId: "room-personal",
    label: "u1",
    effectiveRole,
    kind: "personal",
    hostCount: 0,
    providerHandle: "handle-personal",
  };
}

const TEAM_DESCRIPTOR: EnvironmentDescriptorV11 = {
  environmentId: TEAM_ENV,
  ownerKind: "organization",
  ownerId: "team-1",
  roomId: "room-acme",
  label: "Acme",
  effectiveRole: "admin",
  kind: "team",
  hostCount: 0,
  providerHandle: "handle-acme",
};

const host = {
  role: "owner" as EnvironmentDescriptorV11["effectiveRole"],
  items: [] as EnvironmentConfigurationItem[],
  teamItems: [] as EnvironmentConfigurationItem[],
  put: null as
    | null
    | (() => Promise<EnvironmentConfigurationItemWriteResponse>),
};
let harness: TeamPageHarness | null = null;

function storageItem(
  value: EnvironmentConfigurationItem["value"],
  revision: number,
): EnvironmentConfigurationItem {
  return configurationItem({
    kind: "storage_policy",
    key: "storage",
    value,
    revision,
  });
}

function renderSection(ui: ReactNode): void {
  harness = mountTeamPage(poolSource("owner"), {
    "environment.list": () => ({
      environments: [descriptor(host.role), TEAM_DESCRIPTOR],
    }),
    "environment.configuration.items": (params) => ({
      items: params.environmentId === TEAM_ENV ? host.teamItems : host.items,
    }),
    [PUT]: () =>
      host.put === null
        ? Promise.resolve({ outcome: "saved", revision: 1 })
        : host.put(),
  });
  render(
    <>
      {ui}
      <Toaster />
    </>,
    { wrapper: harness.Wrapper },
  );
}

async function theSwitch(): Promise<HTMLElement> {
  return screen.findByRole("switch", {
    name: "Free up space on this computer",
  });
}

const FOOTNOTE =
  "Runs only when the disk is getting full. A chat comes back when an agent continues it.";

describe("<StoragePolicySection />", () => {
  beforeEach(() => {
    resetNegotiatedManifests();
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [PUT]);
    host.role = "owner";
    host.items = [];
    host.teamItems = [];
    host.put = null;
    harness = null;
  });
  afterEach(() => {
    cleanup();
  });

  it("is on with its footnote while no storage_policy item is set", async () => {
    renderSection(PERSONAL_SECTION);

    const control = await theSwitch();
    await waitFor(() => {
      expect(control.getAttribute("aria-checked")).toBe("true");
      expect(control.hasAttribute("disabled")).toBe(false);
    });
    expect(screen.getByText(FOOTNOTE)).toBeTruthy();
  });

  it("creates the item with no revision when switched off", async () => {
    renderSection(PERSONAL_SECTION);
    const control = await theSwitch();
    await waitFor(() => {
      expect(control.hasAttribute("disabled")).toBe(false);
    });

    await userEvent.click(control);

    await waitFor(() => {
      expect(harness?.paramsOf(PUT)).toEqual([
        {
          environmentId: PERSONAL_ENV,
          kind: "storage_policy",
          key: "storage",
          os: null,
          value: { freeUpSpace: false },
          revision: null,
        },
      ]);
    });
  });

  it("quotes the existing item's revision when switched back on", async () => {
    host.items = [storageItem({ freeUpSpace: false }, 4)];
    renderSection(PERSONAL_SECTION);
    const control = await theSwitch();
    await waitFor(() => {
      expect(control.getAttribute("aria-checked")).toBe("false");
    });
    expect(screen.queryByText(FOOTNOTE)).toBeNull();

    await userEvent.click(control);

    await waitFor(() => {
      expect(harness?.paramsOf(PUT)).toEqual([
        {
          environmentId: PERSONAL_ENV,
          kind: "storage_policy",
          key: "storage",
          os: null,
          value: { freeUpSpace: true },
          revision: 4,
        },
      ]);
    });
  });

  it("drops back to the value it read and toasts when the write is refused", async () => {
    host.put = () => Promise.reject(new Error("write refused"));
    renderSection(PERSONAL_SECTION);
    const control = await theSwitch();
    await waitFor(() => {
      expect(control.hasAttribute("disabled")).toBe(false);
    });

    await userEvent.click(control);

    const toast = await screen.findByText("Couldn't save these settings.");
    expect(toast).toBeTruthy();
    await waitFor(() => {
      expect(control.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("reads an item whose value does not parse as off", async () => {
    host.items = [storageItem({ freeUpSpace: "yes" }, 2)];
    renderSection(PERSONAL_SECTION);

    const control = await theSwitch();
    await waitFor(() => {
      expect(control.getAttribute("aria-checked")).toBe("false");
    });
  });

  it("renders nothing on a host that does not advertise the item write", async () => {
    renderSection(PERSONAL_SECTION);
    await theSwitch();

    // The same host, renegotiated without the write: the row goes, so its
    // absence is the gate's answer and not a read still in flight.
    act(() => {
      recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
        "environment.list",
        "environment.configuration.items",
      ]);
    });

    await waitFor(() => {
      expect(
        within(document.body).queryByRole("switch", {
          name: "Free up space on this computer",
        }),
      ).toBeNull();
    });
  });

  it("disables the switch for a viewer", async () => {
    host.role = "viewer";
    renderSection(PERSONAL_SECTION);

    const control = await theSwitch();
    await waitFor(() => {
      expect(control.hasAttribute("disabled")).toBe(true);
    });
  });

  it("reads and writes the picked team's environment, not Personal's", async () => {
    host.items = [storageItem({ freeUpSpace: false }, 9)];
    host.teamItems = [storageItem({ freeUpSpace: true }, 2)];
    const pick: EnvironmentPick = { kind: "team", environmentId: TEAM_ENV };
    renderSection(<StoragePolicySection pick={pick} />);
    const control = await theSwitch();
    await waitFor(() => {
      expect(control.getAttribute("aria-checked")).toBe("true");
      expect(control.hasAttribute("disabled")).toBe(false);
    });

    await userEvent.click(control);

    await waitFor(() => {
      expect(harness?.paramsOf(PUT)).toEqual([
        {
          environmentId: TEAM_ENV,
          kind: "storage_policy",
          key: "storage",
          os: null,
          value: { freeUpSpace: false },
          revision: 2,
        },
      ]);
    });
  });

  it("has no environment to write under a Local pick, so the switch is disabled", async () => {
    renderSection(
      <StoragePolicySection
        pick={{ kind: "local", hostId: "host-1", hostName: "Laptop" }}
      />,
    );

    const control = await theSwitch();
    expect(control.hasAttribute("disabled")).toBe(true);
  });
});

describe("<StorageSettingsPanel />", () => {
  beforeEach(() => {
    resetNegotiatedManifests();
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [PUT]);
    host.items = [];
    host.teamItems = [];
    host.put = null;
    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: PERSONAL_PICK,
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("shows the page title and no switch under a Local pick", () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-1", hostName: "Laptop" },
    });
    renderSection(<StorageSettingsPanel />);

    expect(screen.getByRole("heading", { name: "Storage" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("draws the row under the Personal pick", async () => {
    renderSection(<StorageSettingsPanel />);

    expect(await theSwitch()).toBeTruthy();
  });
});

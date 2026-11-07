import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
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
import type { StoragePolicyValue } from "@/hooks/environment/use-storage-policy";
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

const APPLIES = "Applies on every host in this environment.";
const COMES_BACK = "A chat comes back when an agent continues it.";
const FOOTNOTE = `${APPLIES} ${COMES_BACK}`;
const SWITCH_DESCRIPTION = "Keep them in the cloud instead of on disk.";
const IDLE_GROUP = "Tasks you haven't used lately";
const ARCHIVED_GROUP = "Archived chats";

/** The card of rows under a group's heading. */
function groupOf(heading: string): HTMLElement {
  const section = screen
    .getByRole("heading", { name: heading })
    .closest("section");
  if (section === null) throw new Error(`no group under ${heading}`);
  return section;
}

async function chatsSwitch(): Promise<HTMLElement> {
  return screen.findByRole("switch", { name: "Chats" });
}

function artifactsSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: "Artifacts" });
}

function idleTasksSelect(): HTMLElement {
  return screen.getByRole("combobox", { name: `${IDLE_GROUP}: When` });
}

function archivedChatsSelect(): HTMLElement {
  return screen.getByRole("combobox", { name: `${ARCHIVED_GROUP}: When` });
}

/** Waits for the read to land: every control enabled for an owner. */
async function settled(): Promise<void> {
  const control = await chatsSwitch();
  await waitFor(() => {
    expect(control.hasAttribute("disabled")).toBe(false);
  });
}

/** Opens a Radix select the way jsdom can (the keyboard), then picks an option. */
function pickOption(trigger: HTMLElement, optionName: string): void {
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

function expectPut(
  environmentId: string,
  value: StoragePolicyValue,
  revision: number | null,
): void {
  expect(harness?.paramsOf(PUT)).toEqual([
    {
      environmentId,
      kind: "storage_policy",
      key: "storage",
      os: null,
      value,
      revision,
    },
  ]);
}

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

  it("shows the defaults and the footnote while no storage_policy item is set", async () => {
    renderSection(PERSONAL_SECTION);

    await settled();
    expect((await chatsSwitch()).getAttribute("aria-checked")).toBe("true");
    expect(artifactsSwitch().getAttribute("aria-checked")).toBe("true");
    expect(idleTasksSelect().textContent).toContain(
      "When the disk is getting full",
    );
    expect(archivedChatsSelect().textContent).toContain("After 4 hours");
    expect(screen.getByText(FOOTNOTE)).toBeTruthy();
  });

  it("creates the item with the whole value and no revision when Chats is switched off", async () => {
    renderSection(PERSONAL_SECTION);
    await settled();

    await userEvent.click(await chatsSwitch());

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        {
          chats: false,
          artifacts: true,
          idleTaskDays: null,
          archivedChatHours: 4,
        },
        null,
      );
    });
  });

  it("writes the whole stored value under the item's revision when Artifacts is switched off", async () => {
    host.items = [
      storageItem(
        {
          chats: true,
          artifacts: true,
          idleTaskDays: 14,
          archivedChatHours: 2160,
        },
        4,
      ),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    await userEvent.click(artifactsSwitch());

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        {
          chats: true,
          artifacts: false,
          idleTaskDays: 14,
          archivedChatHours: 2160,
        },
        4,
      );
    });
  });

  it("writes the whole value under the item's revision when a task window is picked", async () => {
    host.items = [
      storageItem(
        {
          chats: true,
          artifacts: false,
          idleTaskDays: null,
          archivedChatHours: 168,
        },
        6,
      ),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    pickOption(idleTasksSelect(), "After 14 days");

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        {
          chats: true,
          artifacts: false,
          idleTaskDays: 14,
          archivedChatHours: 168,
        },
        6,
      );
    });
  });

  it("writes no window when Never is picked for Archived chats", async () => {
    renderSection(PERSONAL_SECTION);
    await settled();

    pickOption(archivedChatsSelect(), "Never");

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        {
          chats: true,
          artifacts: true,
          idleTaskDays: null,
          archivedChatHours: null,
        },
        null,
      );
    });
  });

  it("writes the whole value in hours when After 7 days is picked for Archived chats", async () => {
    renderSection(PERSONAL_SECTION);
    await settled();

    pickOption(archivedChatsSelect(), "After 7 days");

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        {
          chats: true,
          artifacts: true,
          idleTaskDays: null,
          archivedChatHours: 168,
        },
        null,
      );
    });
  });

  it("drops back to the value it read and toasts when the write is refused", async () => {
    host.put = () => Promise.reject(new Error("write refused"));
    renderSection(PERSONAL_SECTION);
    await settled();
    const control = await chatsSwitch();

    await userEvent.click(control);

    expect(
      await screen.findByText("Couldn't save these settings."),
    ).toBeTruthy();
    await waitFor(() => {
      expect(control.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("reads an item whose value does not parse as nothing cleanable, and a write from there is a whole valid value", async () => {
    host.items = [storageItem({ freeUpSpace: true }, 2)];
    renderSection(PERSONAL_SECTION);

    const control = await chatsSwitch();
    await waitFor(() => {
      expect(control.getAttribute("aria-checked")).toBe("false");
    });
    expect(artifactsSwitch().getAttribute("aria-checked")).toBe("false");
    expect(archivedChatsSelect().textContent).toContain("Never");
    expect(idleTasksSelect().hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText(/Applies on every host/)).toBeNull();

    pickOption(archivedChatsSelect(), "After 7 days");

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        {
          chats: false,
          artifacts: false,
          idleTaskDays: null,
          archivedChatHours: 168,
        },
        2,
      );
    });
  });

  it("groups the controls under two headings, with the switches describing themselves alike", async () => {
    renderSection(PERSONAL_SECTION);
    await settled();

    const idle = within(groupOf(IDLE_GROUP));
    expect(idle.getByRole("switch", { name: "Chats" })).toBeTruthy();
    expect(idle.getByRole("switch", { name: "Artifacts" })).toBeTruthy();
    expect(idle.getByRole("combobox")).toBe(idleTasksSelect());
    expect(idle.getAllByText(SWITCH_DESCRIPTION)).toHaveLength(2);
    const archived = within(groupOf(ARCHIVED_GROUP));
    expect(archived.getByRole("combobox")).toBe(archivedChatsSelect());
    expect(archived.queryByRole("switch")).toBeNull();
  });

  it.each([
    {
      state: "nothing cleanable",
      value: { chats: false, artifacts: false, archivedChatHours: null },
      line: null,
    },
    {
      state: "artifacts only",
      value: { chats: false, artifacts: true, archivedChatHours: null },
      line: APPLIES,
    },
    {
      state: "chats on",
      value: { chats: true, artifacts: false, archivedChatHours: null },
      line: FOOTNOTE,
    },
    {
      state: "archived chats only",
      value: { chats: false, artifacts: false, archivedChatHours: 168 },
      line: FOOTNOTE,
    },
    {
      state: "artifacts and archived chats",
      value: { chats: false, artifacts: true, archivedChatHours: 4 },
      line: FOOTNOTE,
    },
  ])("draws the line under the groups for $state", async ({ value, line }) => {
    host.items = [storageItem({ ...value, idleTaskDays: null }, 3)];
    renderSection(PERSONAL_SECTION);
    await settled();

    expect(
      screen.queryByText(/Applies on every host/)?.textContent ?? null,
    ).toBe(line);
  });

  it("disables the task window but not the archived one while Chats is off", async () => {
    host.items = [
      storageItem(
        {
          chats: false,
          artifacts: true,
          idleTaskDays: null,
          archivedChatHours: 720,
        },
        3,
      ),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    expect(idleTasksSelect().hasAttribute("disabled")).toBe(false);
    expect(archivedChatsSelect().hasAttribute("disabled")).toBe(false);
  });

  it("disables only the task window while both switches are off", async () => {
    host.items = [
      storageItem(
        {
          chats: false,
          artifacts: false,
          idleTaskDays: null,
          archivedChatHours: 720,
        },
        3,
      ),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    expect(idleTasksSelect().hasAttribute("disabled")).toBe(true);
    expect(archivedChatsSelect().hasAttribute("disabled")).toBe(false);
  });

  it("disables both windows while a write is pending", async () => {
    let finish: () => void = () => undefined;
    host.put = () =>
      new Promise<EnvironmentConfigurationItemWriteResponse>((resolve) => {
        finish = () => resolve({ outcome: "saved", revision: 1 });
      });
    renderSection(PERSONAL_SECTION);
    await settled();

    await userEvent.click(await chatsSwitch());

    await waitFor(() => {
      expect(archivedChatsSelect().hasAttribute("disabled")).toBe(true);
    });
    expect(idleTasksSelect().hasAttribute("disabled")).toBe(true);
    act(() => {
      finish();
    });
    await waitFor(() => {
      expect(archivedChatsSelect().hasAttribute("disabled")).toBe(false);
    });
  });

  it("lists a stored idle window that is not a preset and shows it selected", async () => {
    host.items = [
      storageItem(
        {
          chats: true,
          artifacts: true,
          idleTaskDays: 45,
          archivedChatHours: 720,
        },
        5,
      ),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    expect(idleTasksSelect().textContent).toContain("After 45 days");
  });

  it.each([
    { hours: 36, shown: "After 36 hours" },
    { hours: 48, shown: "After 2 days" },
    { hours: 1, shown: "After 1 hour" },
  ])(
    "shows a stored archived window of $hours hours that is not a preset as $shown",
    async ({ hours, shown }) => {
      host.items = [
        storageItem(
          {
            chats: true,
            artifacts: true,
            idleTaskDays: null,
            archivedChatHours: hours,
          },
          5,
        ),
      ];
      renderSection(PERSONAL_SECTION);
      await settled();

      expect(archivedChatsSelect().textContent).toContain(shown);
    },
  );

  it("renders nothing on a host that does not advertise the item write", async () => {
    renderSection(PERSONAL_SECTION);
    await chatsSwitch();

    // The same host, renegotiated without the write: the section goes, so its
    // absence is the gate's answer and not a read still in flight.
    act(() => {
      recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [
        "environment.list",
        "environment.configuration.items",
      ]);
    });

    await waitFor(() => {
      expect(within(document.body).queryByTestId("storage-policy")).toBeNull();
    });
  });

  it("disables every control for a viewer", async () => {
    host.role = "viewer";
    renderSection(PERSONAL_SECTION);

    const control = await chatsSwitch();
    await waitFor(() => {
      expect(control.hasAttribute("disabled")).toBe(true);
    });
    expect(artifactsSwitch().hasAttribute("disabled")).toBe(true);
    expect(idleTasksSelect().hasAttribute("disabled")).toBe(true);
    expect(archivedChatsSelect().hasAttribute("disabled")).toBe(true);
  });

  it("reads and writes the picked team's environment, not Personal's", async () => {
    host.items = [
      storageItem(
        {
          chats: false,
          artifacts: false,
          idleTaskDays: null,
          archivedChatHours: 720,
        },
        9,
      ),
    ];
    host.teamItems = [
      storageItem(
        {
          chats: true,
          artifacts: false,
          idleTaskDays: 7,
          archivedChatHours: null,
        },
        2,
      ),
    ];
    const pick: EnvironmentPick = { kind: "team", environmentId: TEAM_ENV };
    renderSection(<StoragePolicySection pick={pick} />);
    await settled();
    expect((await chatsSwitch()).getAttribute("aria-checked")).toBe("true");

    await userEvent.click(await chatsSwitch());

    await waitFor(() => {
      expectPut(
        TEAM_ENV,
        {
          chats: false,
          artifacts: false,
          idleTaskDays: 7,
          archivedChatHours: null,
        },
        2,
      );
    });
  });

  it("has no environment to write under a Local pick, so every control is disabled", async () => {
    renderSection(
      <StoragePolicySection
        pick={{ kind: "local", hostId: "host-1", hostName: "Laptop" }}
      />,
    );

    const control = await chatsSwitch();
    expect(control.hasAttribute("disabled")).toBe(true);
    expect(artifactsSwitch().hasAttribute("disabled")).toBe(true);
    expect(idleTasksSelect().hasAttribute("disabled")).toBe(true);
    expect(archivedChatsSelect().hasAttribute("disabled")).toBe(true);
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

    expect(await chatsSwitch()).toBeTruthy();
  });
});

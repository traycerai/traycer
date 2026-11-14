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
import { toast } from "sonner";
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
import type {
  SnapshotPolicyValue,
  StoragePolicyValue,
} from "@/hooks/environment/use-storage-policy";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const PERSONAL_ENV = "env-personal";
const PERSONAL_SECTION = <StoragePolicySection pick={{ kind: "personal" }} />;
const TEAM_ENV = "env-acme";
const PUT = "environment.configuration.items.put";
const SAVE_ERROR = "Couldn't save these settings.";

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
  teamRole: "admin" as EnvironmentDescriptorV11["effectiveRole"],
  items: [] as EnvironmentConfigurationItem[],
  teamItems: [] as EnvironmentConfigurationItem[],
  readFails: false,
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

function snapshotItem(
  value: EnvironmentConfigurationItem["value"],
  revision: number,
): EnvironmentConfigurationItem {
  return configurationItem({
    kind: "snapshot_policy",
    key: "snapshots",
    value,
    revision,
  });
}

function renderSection(ui: ReactNode): void {
  harness = mountTeamPage(poolSource("owner"), {
    "environment.list": () => ({
      environments: [
        descriptor("owner"),
        { ...TEAM_DESCRIPTOR, effectiveRole: host.teamRole },
      ],
    }),
    "environment.configuration.items": (params) => {
      if (host.readFails) throw new Error("read refused");
      return {
        items: params.environmentId === TEAM_ENV ? host.teamItems : host.items,
      };
    },
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
const SNAPSHOT_GROUP = "File edit snapshots";
const SNAPSHOT_DESCRIPTION =
  "Counted from the chat's last activity. Older edits may lose Undo and diffs.";
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

function idleTasksSelect(): HTMLElement {
  return screen.getByRole("combobox", { name: `${IDLE_GROUP}: When` });
}

function archivedChatsSelect(): HTMLElement {
  return screen.getByRole("combobox", { name: `${ARCHIVED_GROUP}: When` });
}

function snapshotsSelect(): HTMLElement {
  return screen.getByRole("combobox", { name: `${SNAPSHOT_GROUP}: When` });
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

function expectSnapshotPut(
  environmentId: string,
  value: SnapshotPolicyValue,
  revision: number | null,
): void {
  expect(harness?.paramsOf(PUT).at(-1)).toEqual({
    environmentId,
    kind: "snapshot_policy",
    key: "snapshots",
    os: null,
    value,
    revision,
  });
}

function heldWriteRefusal(): {
  readonly promise: Promise<EnvironmentConfigurationItemWriteResponse>;
  readonly refuse: () => void;
} {
  let rejectWrite: (error: Error) => void = (error) => {
    throw error;
  };
  const promise = new Promise<EnvironmentConfigurationItemWriteResponse>(
    (_resolve, reject) => {
      rejectWrite = (error) => reject(error);
    },
  );
  return {
    promise,
    refuse: () => rejectWrite(new Error("write refused")),
  };
}

describe("<StoragePolicySection />", () => {
  beforeEach(() => {
    toast.dismiss();
    resetNegotiatedManifests();
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [PUT]);
    host.teamRole = "admin";
    host.items = [];
    host.teamItems = [];
    host.readFails = false;
    host.put = null;
    harness = null;
  });
  afterEach(() => {
    cleanup();
    toast.dismiss();
  });

  it("shows the defaults and the footnote while no storage_policy item is set", async () => {
    renderSection(PERSONAL_SECTION);

    await settled();
    expect((await chatsSwitch()).getAttribute("aria-checked")).toBe("true");
    expect(idleTasksSelect().textContent).toContain(
      "When the disk is getting full",
    );
    expect(archivedChatsSelect().textContent).toContain("After 4 hours");
    expect(screen.getByText(COMES_BACK)).toBeTruthy();
    expect(screen.getByText(APPLIES)).toBeTruthy();
    expect(snapshotsSelect().textContent).toContain("After 7 days");
    const snapshotSelect = snapshotsSelect();
    fireEvent.keyDown(snapshotSelect, { key: "Enter" });
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["After 7 days", "After 30 days", "After 90 days", "Never"]);
    fireEvent.keyDown(snapshotSelect, { key: "Escape" });
  });

  it("creates the item with the whole value and no revision when Chats is switched off", async () => {
    renderSection(PERSONAL_SECTION);
    await settled();

    await userEvent.click(await chatsSwitch());

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        { chats: false, idleTaskDays: null, archivedChatHours: 4 },
        null,
      );
    });
  });

  it("reads a value saved with the retired artifacts field and writes it back without the field", async () => {
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

    expect((await chatsSwitch()).getAttribute("aria-checked")).toBe("true");
    expect(idleTasksSelect().textContent).toContain("After 14 days");
    expect(archivedChatsSelect().textContent).toContain("After 90 days");

    await userEvent.click(await chatsSwitch());

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        { chats: false, idleTaskDays: 14, archivedChatHours: 2160 },
        4,
      );
    });
  });

  it("writes the whole value under the item's revision when a task window is picked", async () => {
    host.items = [
      storageItem(
        { chats: true, idleTaskDays: null, archivedChatHours: 168 },
        6,
      ),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    pickOption(idleTasksSelect(), "After 14 days");

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        { chats: true, idleTaskDays: 14, archivedChatHours: 168 },
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
        { chats: true, idleTaskDays: null, archivedChatHours: null },
        null,
      );
    });
  });

  it("creates the snapshot item from the default with the whole value and no revision", async () => {
    renderSection(PERSONAL_SECTION);
    await settled();
    expect(snapshotsSelect().textContent).toContain("After 7 days");

    pickOption(snapshotsSelect(), "After 30 days");

    await waitFor(() => {
      expectSnapshotPut(PERSONAL_ENV, { quietChatDays: 30 }, null);
    });
  });

  it("writes Never at the snapshot item's revision without writing the storage item", async () => {
    host.items = [
      storageItem({ chats: true, idleTaskDays: null, archivedChatHours: 4 }, 8),
      snapshotItem({ quietChatDays: 90 }, 5),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    pickOption(snapshotsSelect(), "Never");

    await waitFor(() => {
      expectSnapshotPut(PERSONAL_ENV, { quietChatDays: null }, 5);
    });
    expect(harness?.paramsOf(PUT)).toHaveLength(1);
  });

  it("reads an invalid snapshot value as Never and repairs it with a whole value", async () => {
    host.items = [snapshotItem({ quietChatDays: 14 }, 7)];
    renderSection(PERSONAL_SECTION);
    await settled();
    expect(snapshotsSelect().textContent).toContain("Never");

    pickOption(snapshotsSelect(), "After 30 days");

    await waitFor(() => {
      expectSnapshotPut(PERSONAL_ENV, { quietChatDays: 30 }, 7);
    });
  });

  it("drops a refused snapshot write back to its read value and shows the save error", async () => {
    host.items = [snapshotItem({ quietChatDays: 90 }, 4)];
    const write = heldWriteRefusal();
    host.put = () => write.promise;
    renderSection(PERSONAL_SECTION);
    await settled();
    expect(screen.queryByText(SAVE_ERROR)).toBeNull();

    pickOption(snapshotsSelect(), "Never");
    await waitFor(() => {
      expect(snapshotsSelect().textContent).toContain("Never");
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
    });
    act(() => {
      write.refuse();
    });

    expect(await screen.findByText(SAVE_ERROR)).toBeTruthy();
    await waitFor(() => {
      expect(snapshotsSelect().textContent).toContain("After 90 days");
    });
  });

  it("shows the read error and disables the snapshot select when the item read fails", async () => {
    host.readFails = true;
    renderSection(PERSONAL_SECTION);

    expect(await screen.findByText("Couldn't read this setting.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
  });

  it("writes the whole value in hours when After 7 days is picked for Archived chats", async () => {
    renderSection(PERSONAL_SECTION);
    await settled();

    pickOption(archivedChatsSelect(), "After 7 days");

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        { chats: true, idleTaskDays: null, archivedChatHours: 168 },
        null,
      );
    });
  });

  it("drops back to the value it read and toasts when the write is refused", async () => {
    const write = heldWriteRefusal();
    host.put = () => write.promise;
    renderSection(PERSONAL_SECTION);
    await settled();
    const control = await chatsSwitch();
    expect(screen.queryByText(SAVE_ERROR)).toBeNull();

    await userEvent.click(control);
    await waitFor(() => {
      expect(control.getAttribute("aria-checked")).toBe("false");
      expect(control.hasAttribute("disabled")).toBe(true);
    });
    act(() => {
      write.refuse();
    });

    expect(await screen.findByText(SAVE_ERROR)).toBeTruthy();
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
    expect(archivedChatsSelect().textContent).toContain("Never");
    expect(idleTasksSelect().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(APPLIES)).toBeTruthy();
    expect(screen.queryByText(COMES_BACK)).toBeNull();

    pickOption(archivedChatsSelect(), "After 7 days");

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        { chats: false, idleTaskDays: null, archivedChatHours: 168 },
        2,
      );
    });
  });

  it("groups the controls under three headings, with the switches describing themselves alike", async () => {
    renderSection(PERSONAL_SECTION);
    await settled();

    const idle = within(groupOf(IDLE_GROUP));
    expect(idle.getByRole("switch", { name: "Chats" })).toBeTruthy();
    expect(idle.getByRole("combobox")).toBe(idleTasksSelect());
    expect(idle.getAllByText(SWITCH_DESCRIPTION)).toHaveLength(1);
    const archived = within(groupOf(ARCHIVED_GROUP));
    expect(archived.getByRole("combobox")).toBe(archivedChatsSelect());
    expect(archived.queryByRole("switch")).toBeNull();
    const snapshots = within(groupOf(SNAPSHOT_GROUP));
    expect(snapshots.getByRole("combobox")).toBe(snapshotsSelect());
    expect(snapshots.getByText(SNAPSHOT_DESCRIPTION)).toBeTruthy();
  });

  it.each([
    {
      state: "nothing cleanable",
      value: { chats: false, archivedChatHours: null },
      showsChatLine: false,
    },
    {
      state: "chats on",
      value: { chats: true, archivedChatHours: null },
      showsChatLine: true,
    },
    {
      state: "archived chats only",
      value: { chats: false, archivedChatHours: 168 },
      showsChatLine: false,
    },
  ])(
    "draws the environment line under the groups for $state",
    async ({ value, showsChatLine }) => {
      host.items = [storageItem({ ...value, idleTaskDays: null }, 3)];
      renderSection(PERSONAL_SECTION);
      await settled();

      expect(screen.getByText(APPLIES)).toBeTruthy();
      expect(screen.queryByText(COMES_BACK)?.textContent ?? null).toBe(
        showsChatLine ? COMES_BACK : null,
      );
      const snapshotGroup = groupOf(SNAPSHOT_GROUP);
      const environmentNote = screen.getByText(APPLIES);
      expect(snapshotGroup.contains(environmentNote)).toBe(false);
      expect(
        snapshotGroup.compareDocumentPosition(environmentNote) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      if (showsChatLine) {
        const archivedSection = groupOf(ARCHIVED_GROUP);
        const chatNote = screen.getByText(COMES_BACK);
        expect(archivedSection.contains(chatNote)).toBe(false);
        expect(
          archivedSection.compareDocumentPosition(chatNote) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    },
  );

  it("disables only the task window while Chats is off", async () => {
    host.items = [
      storageItem(
        { chats: false, idleTaskDays: null, archivedChatHours: 720 },
        3,
      ),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    expect(idleTasksSelect().hasAttribute("disabled")).toBe(true);
    expect(archivedChatsSelect().hasAttribute("disabled")).toBe(false);
  });

  it("shows the snapshot pending value and spinner while disabling every control", async () => {
    let finish: () => void = () => undefined;
    host.put = () =>
      new Promise<EnvironmentConfigurationItemWriteResponse>((resolve) => {
        finish = () => resolve({ outcome: "saved", revision: 1 });
      });
    renderSection(PERSONAL_SECTION);
    await settled();

    pickOption(snapshotsSelect(), "After 30 days");

    await waitFor(() => {
      expect(snapshotsSelect().textContent).toContain("After 30 days");
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
    });
    expect((await chatsSwitch()).hasAttribute("disabled")).toBe(true);
    expect(idleTasksSelect().hasAttribute("disabled")).toBe(true);
    expect(archivedChatsSelect().hasAttribute("disabled")).toBe(true);
    expect(idleTasksSelect().textContent).toContain(
      "When the disk is getting full",
    );
    expect(archivedChatsSelect().textContent).toContain("After 4 hours");
    expect(
      within(groupOf(SNAPSHOT_GROUP)).getByTestId("storage-policy-saving"),
    ).toBeTruthy();
    expect(
      within(groupOf(IDLE_GROUP)).queryByTestId("storage-policy-saving"),
    ).toBeNull();
    expect(
      within(groupOf(ARCHIVED_GROUP)).queryByTestId("storage-policy-saving"),
    ).toBeNull();
    act(() => {
      finish();
    });
    await waitFor(() => {
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false);
    });
  });

  it("shows the storage pending value while preserving snapshots during a held storage write", async () => {
    let finish: () => void = () => {
      throw new Error("write has not started");
    };
    host.items = [snapshotItem({ quietChatDays: 90 }, 4)];
    host.put = () =>
      new Promise<EnvironmentConfigurationItemWriteResponse>((resolve) => {
        finish = () => resolve({ outcome: "saved", revision: 1 });
      });
    renderSection(PERSONAL_SECTION);
    await settled();

    await userEvent.click(await chatsSwitch());

    await waitFor(() => {
      expect(
        screen
          .getByRole("switch", { name: "Chats" })
          .getAttribute("aria-checked"),
      ).toBe("false");
      expect(snapshotsSelect().textContent).toContain("After 90 days");
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
      expect(idleTasksSelect().hasAttribute("disabled")).toBe(true);
      expect(archivedChatsSelect().hasAttribute("disabled")).toBe(true);
      expect(
        screen.getByRole("switch", { name: "Chats" }).hasAttribute("disabled"),
      ).toBe(true);
      expectPut(
        PERSONAL_ENV,
        { chats: false, idleTaskDays: null, archivedChatHours: 4 },
        null,
      );
    });

    act(() => {
      finish();
    });
    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Chats" }).hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  it("lists a stored idle window that is not a preset and shows it selected", async () => {
    host.items = [
      storageItem({ chats: true, idleTaskDays: 45, archivedChatHours: 720 }, 5),
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
          { chats: true, idleTaskDays: null, archivedChatHours: hours },
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

  it("disables every control after a retired viewer role is decoded, even with a loaded policy", async () => {
    host.teamRole = "viewer";
    host.teamItems = [
      storageItem({ chats: false, idleTaskDays: 14, archivedChatHours: 24 }, 3),
      snapshotItem({ quietChatDays: 30 }, 6),
    ];
    renderSection(
      <StoragePolicySection pick={{ kind: "team", environmentId: TEAM_ENV }} />,
    );

    const control = await chatsSwitch();
    await waitFor(() => {
      expect(control.getAttribute("aria-checked")).toBe("false");
    });
    expect(control.hasAttribute("disabled")).toBe(true);
    expect(idleTasksSelect().hasAttribute("disabled")).toBe(true);
    expect(archivedChatsSelect().hasAttribute("disabled")).toBe(true);
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    await userEvent.click(control);
    expect(harness?.paramsOf(PUT)).toEqual([]);
  });

  it("reads and writes the picked team's environment, not Personal's", async () => {
    host.items = [
      storageItem(
        { chats: false, idleTaskDays: null, archivedChatHours: 720 },
        9,
      ),
    ];
    host.teamItems = [
      storageItem({ chats: true, idleTaskDays: 7, archivedChatHours: null }, 2),
      snapshotItem({ quietChatDays: 30 }, 6),
    ];
    const pick: EnvironmentPick = { kind: "team", environmentId: TEAM_ENV };
    renderSection(<StoragePolicySection pick={pick} />);
    await settled();
    expect((await chatsSwitch()).getAttribute("aria-checked")).toBe("true");

    await userEvent.click(await chatsSwitch());

    await waitFor(() => {
      expectPut(
        TEAM_ENV,
        { chats: false, idleTaskDays: 7, archivedChatHours: null },
        2,
      );
    });

    expect(snapshotsSelect().textContent).toContain("After 30 days");
    pickOption(snapshotsSelect(), "Never");
    await waitFor(() => {
      expectSnapshotPut(TEAM_ENV, { quietChatDays: null }, 6);
    });
  });
});

describe("<StorageSettingsPanel />", () => {
  beforeEach(() => {
    toast.dismiss();
    resetNegotiatedManifests();
    recordNegotiatedHostMethods(mockLocalHostEntry.hostId, [PUT]);
    host.teamRole = "admin";
    host.items = [];
    host.teamItems = [];
    host.readFails = false;
    host.put = null;
    harness = null;
    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: PERSONAL_PICK,
    });
  });
  afterEach(() => {
    cleanup();
    toast.dismiss();
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

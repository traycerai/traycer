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
// The page frame reads the window's host scope; none of these cases is about
// it, and a window with no host reads Personal from the cloud.
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => hostScopeFixture({ host: null });
  return { useHostScope, usePersonalHostScope: useHostScope };
});
vi.mock("@/components/settings/personal/page-chip", () => ({
  PageChip: () => null,
}));

import { useAuthStore } from "@/stores/auth/auth-store";

import { StoragePolicySection } from "@/components/settings/panels/storage-policy-section";
import { StorageSettingsPanel } from "@/components/settings/environment/storage-settings-panel";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import {
  PERSONAL_PICK,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import type {
  SnapshotPolicyValue,
  StoragePolicyValue,
} from "@/hooks/environment/use-storage-policy";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { READ_BOUND_MS } from "@/hooks/environment/team/use-bounded-read";
import * as configurationReadInvalidation from "@/hooks/environment/environment-host-list-key";

const PERSONAL_ENV = "env-personal";
const PERSONAL_SECTION = <StoragePolicySection pick={{ kind: "personal" }} />;
const TEAM_ENV = "env-acme";
const OTHER_TEAM_ENV = "env-globex";
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

const OTHER_TEAM_DESCRIPTOR: EnvironmentDescriptorV11 = {
  ...TEAM_DESCRIPTOR,
  environmentId: OTHER_TEAM_ENV,
  ownerId: "team-2",
  roomId: "room-globex",
  label: "Globex",
  providerHandle: "handle-globex",
};

const host = {
  teamRole: "admin" as EnvironmentDescriptorV11["effectiveRole"],
  items: [] as EnvironmentConfigurationItem[],
  teamItems: [] as EnvironmentConfigurationItem[],
  readFails: false,
  read: null as
    | null
    | ((
        environmentId: string,
      ) => Promise<{ readonly items: EnvironmentConfigurationItem[] }>),
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
        OTHER_TEAM_DESCRIPTOR,
      ],
    }),
    "environment.configuration.items": (params) => {
      if (host.readFails) throw new Error("read refused");
      if (host.read !== null) return host.read(params.environmentId);
      return {
        items: params.environmentId === TEAM_ENV ? host.teamItems : host.items,
      };
    },
    [PUT]: () =>
      host.put === null
        ? Promise.resolve({ outcome: "saved", revision: 1 })
        : host.put(),
  });
  useAuthStore.setState({
    shareableTeams: [
      { teamId: "team-1", slug: "handle-acme", avatarUrl: null },
    ],
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

function writesSettled(): Promise<void> {
  const cache = harness?.queryClient.getMutationCache();
  if (cache === undefined) throw new Error("settings page is not mounted");
  const pending = (): boolean =>
    cache.getAll().some((mutation) => mutation.state.status === "pending");
  if (!pending()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = cache.subscribe(() => {
      if (!pending()) {
        unsubscribe();
        resolve();
      }
    });
  });
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
    host.read = null;
    host.put = null;
    harness = null;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
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
      host.items = [snapshotItem({ quietChatDays: 30 }, 1)];
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
        finish = () => {
          host.items = [
            storageItem(
              { chats: false, idleTaskDays: null, archivedChatHours: 4 },
              1,
            ),
            snapshotItem({ quietChatDays: 90 }, 4),
          ];
          resolve({ outcome: "saved", revision: 1 });
        };
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

  it("holds a saved snapshot selection through the reread and releases it at the saved revision", async () => {
    host.items = [
      storageItem({ chats: true, idleTaskDays: null, archivedChatHours: 4 }, 3),
      snapshotItem({ quietChatDays: 90 }, 4),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    let finishRead: (items: EnvironmentConfigurationItem[]) => void = () => {
      throw new Error("reread has not started");
    };
    let readCalls = 0;
    host.read = () => {
      readCalls += 1;
      return new Promise((resolve) => {
        finishRead = (items) => resolve({ items });
      });
    };
    host.put = () => {
      host.items = [
        storageItem(
          { chats: true, idleTaskDays: null, archivedChatHours: 4 },
          3,
        ),
        snapshotItem({ quietChatDays: 30 }, 5),
      ];
      return Promise.resolve({ outcome: "saved", revision: 5 });
    };

    pickOption(snapshotsSelect(), "After 30 days");
    await waitFor(() => expect(readCalls).toBe(1));
    await waitFor(async () =>
      expect((await chatsSwitch()).hasAttribute("disabled")).toBe(false),
    );
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
    expect(
      within(groupOf(SNAPSHOT_GROUP)).getByTestId("storage-policy-saving"),
    ).toBeTruthy();
    expect((await chatsSwitch()).getAttribute("aria-checked")).toBe("true");
    expect((await chatsSwitch()).hasAttribute("disabled")).toBe(false);

    act(() => finishRead(host.items));
    await waitFor(() =>
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false),
    );
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(screen.queryByTestId("storage-policy-saving")).toBeNull();
  });

  it("holds a saved storage selection through the reread, leaving snapshots enabled", async () => {
    host.items = [
      storageItem({ chats: true, idleTaskDays: null, archivedChatHours: 4 }, 3),
      snapshotItem({ quietChatDays: 90 }, 4),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    let finishRead: (items: EnvironmentConfigurationItem[]) => void = () => {
      throw new Error("reread has not started");
    };
    let readCalls = 0;
    host.read = () => {
      readCalls += 1;
      return new Promise((resolve) => {
        finishRead = (items) => resolve({ items });
      });
    };
    host.put = () => {
      host.items = [
        storageItem(
          { chats: false, idleTaskDays: null, archivedChatHours: 4 },
          5,
        ),
        snapshotItem({ quietChatDays: 90 }, 4),
      ];
      return Promise.resolve({ outcome: "saved", revision: 5 });
    };

    await userEvent.click(await chatsSwitch());
    await waitFor(() => expect(readCalls).toBe(1));
    // Snapshots are enabled again only once the save has settled.
    await waitFor(() =>
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false),
    );
    expect(snapshotsSelect().textContent).toContain("After 90 days");
    expect((await chatsSwitch()).getAttribute("aria-checked")).toBe("false");
    expect((await chatsSwitch()).hasAttribute("disabled")).toBe(true);
    expect(
      within(groupOf(IDLE_GROUP)).getByTestId("storage-policy-saving"),
    ).toBeTruthy();

    act(() => finishRead(host.items));
    await waitFor(async () =>
      expect((await chatsSwitch()).hasAttribute("disabled")).toBe(false),
    );
    expect((await chatsSwitch()).getAttribute("aria-checked")).toBe("false");
  });

  it("keeps a saved snapshot through lower and addressed revisions, then shows a newer foreign value", async () => {
    host.items = [
      storageItem({ chats: true, idleTaskDays: null, archivedChatHours: 4 }, 3),
      snapshotItem({ quietChatDays: 90 }, 4),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    const reads: Array<(items: EnvironmentConfigurationItem[]) => void> = [];
    host.read = () =>
      new Promise((resolve) => {
        reads.push((items) => resolve({ items }));
      });
    host.put = () => {
      host.items = [
        storageItem(
          { chats: true, idleTaskDays: null, archivedChatHours: 4 },
          3,
        ),
        snapshotItem({ quietChatDays: 30 }, 5),
      ];
      return Promise.resolve({ outcome: "saved", revision: 5 });
    };

    pickOption(snapshotsSelect(), "After 30 days");
    await waitFor(() => expect(reads).toHaveLength(1));
    act(() =>
      reads[0]([
        snapshotItem({ quietChatDays: 90 }, 3),
        storageItem(
          { chats: true, idleTaskDays: null, archivedChatHours: 4 },
          3,
        ),
      ]),
    );
    await waitFor(() =>
      expect(
        harness?.queryClient.isFetching({
          predicate: (query) =>
            query.queryKey.includes("environment.configuration.items"),
        }),
      ).toBe(0),
    );
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);

    const addressedRead = harness?.queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey.includes("environment.configuration.items"),
    });
    await waitFor(() => expect(reads).toHaveLength(2));
    act(() =>
      reads[1]([
        snapshotItem({ quietChatDays: 90 }, 4),
        storageItem(
          { chats: true, idleTaskDays: null, archivedChatHours: 4 },
          3,
        ),
      ]),
    );
    await addressedRead;
    await waitFor(() =>
      expect(
        harness?.queryClient.isFetching({
          predicate: (query) =>
            query.queryKey.includes("environment.configuration.items"),
        }),
      ).toBe(0),
    );
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);

    host.items = [
      storageItem({ chats: true, idleTaskDays: null, archivedChatHours: 4 }, 3),
      snapshotItem({ quietChatDays: 90 }, 6),
    ];
    const reread = harness?.queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey.includes("environment.configuration.items"),
    });
    await waitFor(() => expect(reads).toHaveLength(3));
    act(() => reads[2](host.items));
    await reread;
    await waitFor(() =>
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false),
    );
    expect(snapshotsSelect().textContent).toContain("After 90 days");
  });

  it("drops a conflict back to the read value after exercising a saved hold", async () => {
    host.items = [snapshotItem({ quietChatDays: 90 }, 4)];
    renderSection(PERSONAL_SECTION);
    await settled();
    let finishRead: (items: EnvironmentConfigurationItem[]) => void = () => {
      throw new Error("reread has not started");
    };
    let readCalls = 0;
    host.read = () =>
      new Promise((resolve) => {
        readCalls += 1;
        finishRead = (items) => resolve({ items });
      });
    host.put = () => {
      host.items = [snapshotItem({ quietChatDays: 30 }, 5)];
      return Promise.resolve({ outcome: "saved", revision: 5 });
    };
    pickOption(snapshotsSelect(), "After 30 days");
    await waitFor(() => expect(readCalls).toBe(1));
    await waitFor(async () =>
      expect((await chatsSwitch()).hasAttribute("disabled")).toBe(false),
    );
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
    expect(
      within(groupOf(SNAPSHOT_GROUP)).getByTestId("storage-policy-saving"),
    ).toBeTruthy();
    act(() => finishRead(host.items));
    await waitFor(() =>
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false),
    );

    host.read = null;
    host.put = () =>
      Promise.resolve({
        outcome: "conflict",
        current: { revision: 6, changedBy: "Someone", changedAt: 0 },
      });
    pickOption(snapshotsSelect(), "After 90 days");
    await waitFor(() =>
      expect(snapshotsSelect().textContent).toContain("After 30 days"),
    );
    await waitFor(() =>
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false),
    );
  });

  it("keeps a saved snapshot when its refreshed query has no data yet", async () => {
    host.items = [snapshotItem({ quietChatDays: 90 }, 4)];
    renderSection(PERSONAL_SECTION);
    await settled();

    const reads: Array<(items: EnvironmentConfigurationItem[]) => void> = [];
    host.read = () =>
      new Promise((resolve) => {
        reads.push((items) => resolve({ items }));
      });
    host.put = () => {
      host.items = [snapshotItem({ quietChatDays: 30 }, 5)];
      return Promise.resolve({ outcome: "saved", revision: 5 });
    };

    pickOption(snapshotsSelect(), "After 30 days");
    await waitFor(() => expect(reads).toHaveLength(1));
    await waitFor(async () =>
      expect((await chatsSwitch()).hasAttribute("disabled")).toBe(false),
    );

    act(() => {
      void harness?.queryClient.resetQueries({
        predicate: (query) => {
          const methodIndex = query.queryKey.indexOf(
            "environment.configuration.items",
          );
          if (methodIndex < 0) return false;
          const params = query.queryKey[methodIndex + 1];
          return (
            typeof params === "object" &&
            params !== null &&
            "environmentId" in params &&
            params.environmentId === PERSONAL_ENV
          );
        },
      });
    });
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);

    act(() => reads[1](host.items));
    await waitFor(() =>
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false),
    );
  });

  it("expires an unconfirmed create at the read bound and asks the save's own re-read once more", async () => {
    renderSection(PERSONAL_SECTION);
    await settled();
    const invalidateReads = vi.spyOn(
      configurationReadInvalidation,
      "invalidateConfigurationReads",
    );

    let readCalls = 0;
    let readStarted: () => void = () => {
      throw new Error("save reread has not started");
    };
    const saveRereadStarted = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    host.read = () => {
      readCalls += 1;
      if (readCalls === 1) readStarted();
      return Promise.resolve({ items: host.items });
    };
    let finishSave: () => void = () => {
      throw new Error("save has not started");
    };
    host.put = () =>
      new Promise((resolve) => {
        finishSave = () => resolve({ outcome: "saved", revision: 5 });
      });

    pickOption(snapshotsSelect(), "After 30 days");
    await waitFor(() => {
      expect(snapshotsSelect().textContent).toContain("After 30 days");
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      finishSave();
      await saveRereadStarted;
    });
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
    expect(
      within(groupOf(SNAPSHOT_GROUP)).getByTestId("storage-policy-saving"),
    ).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_BOUND_MS - 1);
    });
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(snapshotsSelect().textContent).toContain("After 7 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("storage-policy-saving")).toBeNull();
    expect(readCalls).toBe(2);
    expect(invalidateReads).toHaveBeenCalledTimes(2);
    const [saveInvalidation, expiryInvalidation] = invalidateReads.mock.calls;
    expect(saveInvalidation[1]).toBe(PERSONAL_ENV);
    expect(saveInvalidation[2]).toEqual(["environment.configuration.items"]);
    expect(expiryInvalidation[1]).toBe(saveInvalidation[1]);
    expect(expiryInvalidation[2]).toEqual(saveInvalidation[2]);
  });

  it("keeps a newer hold on the other item when an older hold expires, and ends it at its own bound", async () => {
    host.items = [
      storageItem({ chats: true, idleTaskDays: null, archivedChatHours: 4 }, 3),
      snapshotItem({ quietChatDays: 90 }, 4),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    const finishPuts: Array<(revision: number) => void> = [];
    host.put = () =>
      new Promise((resolve) => {
        finishPuts.push((revision) => resolve({ outcome: "saved", revision }));
      });

    pickOption(archivedChatsSelect(), "After 7 days");
    await waitFor(() => expect(finishPuts).toHaveLength(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      finishPuts[0](5);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(archivedChatsSelect().textContent).toContain("After 7 days");
    expect(archivedChatsSelect().hasAttribute("disabled")).toBe(true);
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_BOUND_MS / 2);
    });
    pickOption(snapshotsSelect(), "After 30 days");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(finishPuts).toHaveLength(2);
    await act(async () => {
      finishPuts[1](6);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_BOUND_MS / 2);
    });
    expect(archivedChatsSelect().textContent).toContain("After 4 hours");
    expect(archivedChatsSelect().hasAttribute("disabled")).toBe(false);
    expect(
      within(groupOf(ARCHIVED_GROUP)).queryByTestId("storage-policy-saving"),
    ).toBeNull();
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
    expect(
      within(groupOf(SNAPSHOT_GROUP)).getByTestId("storage-policy-saving"),
    ).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_BOUND_MS / 2);
    });
    expect(snapshotsSelect().textContent).toContain("After 90 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("storage-policy-saving")).toBeNull();
  });

  it("shows the read value and no hold after a forbidden save", async () => {
    host.items = [
      storageItem({ chats: true, idleTaskDays: null, archivedChatHours: 4 }, 3),
    ];
    host.put = () => Promise.resolve({ outcome: "forbidden" });
    renderSection(PERSONAL_SECTION);
    await settled();

    await userEvent.click(await chatsSwitch());
    await waitFor(() => {
      expect(harness?.paramsOf(PUT)).toHaveLength(1);
      expect(
        harness?.queryClient
          .getMutationCache()
          .getAll()
          .some((mutation) => mutation.state.status === "success"),
      ).toBe(true);
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Chats" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    await waitFor(async () =>
      expect((await chatsSwitch()).hasAttribute("disabled")).toBe(false),
    );
    expect(screen.queryByTestId("storage-policy-saving")).toBeNull();
  });

  it("keeps storage held across a snapshot save and releases each item on its own read", async () => {
    host.items = [
      storageItem({ chats: true, idleTaskDays: null, archivedChatHours: 4 }, 4),
      snapshotItem({ quietChatDays: 90 }, 3),
    ];
    renderSection(PERSONAL_SECTION);
    await settled();

    const reads: Array<(items: EnvironmentConfigurationItem[]) => void> = [];
    host.read = () =>
      new Promise((resolve) => {
        reads.push((items) => resolve({ items }));
      });
    let writes = 0;
    host.put = () => {
      writes += 1;
      return Promise.resolve({
        outcome: "saved",
        revision: writes === 1 ? 5 : 6,
      });
    };

    await userEvent.click(await chatsSwitch());
    await waitFor(() => expect(reads).toHaveLength(1));
    await waitFor(() =>
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false),
    );
    act(() =>
      reads[0]([
        storageItem(
          { chats: true, idleTaskDays: null, archivedChatHours: 4 },
          4,
        ),
        snapshotItem({ quietChatDays: 90 }, 3),
      ]),
    );
    await waitFor(() =>
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false),
    );
    expect((await chatsSwitch()).hasAttribute("disabled")).toBe(true);

    pickOption(snapshotsSelect(), "After 30 days");
    await waitFor(() => expect(reads).toHaveLength(2));
    await waitFor(() =>
      expect(
        harness?.queryClient
          .getMutationCache()
          .getAll()
          .some((mutation) => mutation.state.status === "pending"),
      ).toBe(false),
    );
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
    expect(
      within(groupOf(SNAPSHOT_GROUP)).getByTestId("storage-policy-saving"),
    ).toBeTruthy();
    act(() =>
      reads[1]([
        storageItem(
          { chats: false, idleTaskDays: null, archivedChatHours: 4 },
          4,
        ),
        snapshotItem({ quietChatDays: 30 }, 6),
      ]),
    );
    await waitFor(() =>
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false),
    );
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect((await chatsSwitch()).hasAttribute("disabled")).toBe(true);

    host.items = [
      storageItem(
        { chats: false, idleTaskDays: null, archivedChatHours: 4 },
        5,
      ),
      snapshotItem({ quietChatDays: 30 }, 6),
    ];
    const reread = harness?.queryClient.invalidateQueries({
      predicate: (query) =>
        query.queryKey.includes("environment.configuration.items"),
    });
    await waitFor(() => expect(reads).toHaveLength(3));
    act(() => reads[2](host.items));
    await reread;
    await waitFor(async () =>
      expect((await chatsSwitch()).hasAttribute("disabled")).toBe(false),
    );
    expect((await chatsSwitch()).getAttribute("aria-checked")).toBe("false");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(false);
  });

  it("keeps a hold after a read error and releases it when Retry reads the saved revision", async () => {
    host.items = [snapshotItem({ quietChatDays: 90 }, 4)];
    renderSection(PERSONAL_SECTION);
    await settled();

    host.readFails = true;
    host.put = () => {
      host.items = [snapshotItem({ quietChatDays: 30 }, 5)];
      return Promise.resolve({ outcome: "saved", revision: 5 });
    };
    pickOption(snapshotsSelect(), "After 30 days");
    expect(await screen.findByText("Couldn't read this setting.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
    expect(
      within(groupOf(SNAPSHOT_GROUP)).getByTestId("storage-policy-saving"),
    ).toBeTruthy();

    host.readFails = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false),
    );
    expect(snapshotsSelect().textContent).toContain("After 30 days");
    expect(screen.queryByText("Couldn't read this setting.")).toBeNull();
    expect(screen.queryByTestId("storage-policy-saving")).toBeNull();
  });

  it("cancels the bound reread when a save is confirmed before expiry", async () => {
    host.items = [snapshotItem({ quietChatDays: 90 }, 4)];
    renderSection(PERSONAL_SECTION);
    await settled();

    let reads = 0;
    let finishRead: (items: EnvironmentConfigurationItem[]) => void = () => {
      throw new Error("save reread has not started");
    };
    let finishPut: () => void = () => {
      throw new Error("save has not started");
    };
    let rereadStarted: () => void = () => {
      throw new Error("save reread has not started");
    };
    const reread = new Promise<void>((resolve) => {
      rereadStarted = resolve;
    });
    host.read = () => {
      reads += 1;
      rereadStarted();
      return new Promise((resolve) => {
        finishRead = (items) => resolve({ items });
      });
    };
    host.put = () =>
      new Promise((resolve) => {
        finishPut = () => resolve({ outcome: "saved", revision: 5 });
      });
    pickOption(snapshotsSelect(), "After 30 days");
    await waitFor(() =>
      expect(snapshotsSelect().textContent).toContain("After 30 days"),
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => finishPut());
    await reread;
    await writesSettled();
    await act(async () => {
      finishRead([snapshotItem({ quietChatDays: 30 }, 5)]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(snapshotsSelect().hasAttribute("disabled")).toBe(false);
    expect(snapshotsSelect().textContent).toContain("After 30 days");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_BOUND_MS);
    });
    expect(reads).toBe(1);
  });

  it("does not reread or throw when a held save is unmounted before its bound", async () => {
    renderSection(PERSONAL_SECTION);
    await settled();

    let reads = 0;
    let finishPut: () => void = () => {
      throw new Error("save has not started");
    };
    let rereadStarted: () => void = () => {
      throw new Error("save reread has not started");
    };
    const reread = new Promise<void>((resolve) => {
      rereadStarted = resolve;
    });
    host.put = () =>
      new Promise((resolve) => {
        finishPut = () => resolve({ outcome: "saved", revision: 5 });
      });
    host.read = () => {
      reads += 1;
      rereadStarted();
      return Promise.resolve({ items: host.items });
    };
    const invalidateReads = vi.spyOn(
      configurationReadInvalidation,
      "invalidateConfigurationReads",
    );
    pickOption(snapshotsSelect(), "After 30 days");
    await waitFor(() =>
      expect(snapshotsSelect().textContent).toContain("After 30 days"),
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => finishPut());
    await reread;
    await writesSettled();
    act(() => undefined);
    expect(reads).toBe(1);
    // The cached read has no observer once unmounted, so a stray expiry would
    // show only as an invalidation, not as a host read.
    const invalidationsBeforeUnmount = invalidateReads.mock.calls.length;
    cleanup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_BOUND_MS);
    });
    expect(reads).toBe(1);
    expect(invalidateReads).toHaveBeenCalledTimes(invalidationsBeforeUnmount);
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

  it("keeps saving the policy when the host does not advertise item writes", async () => {
    renderSection(PERSONAL_SECTION);
    await settled();

    act(() => {
      recordNegotiatedHostMethods(mockLocalHostEntry.hostId, []);
    });
    await userEvent.click(await chatsSwitch());

    await waitFor(() => {
      expectPut(
        PERSONAL_ENV,
        { chats: false, idleTaskDays: null, archivedChatHours: 4 },
        null,
      );
    });
  });

  it("gives a Viewer disabled controls and sends no write, even with a loaded policy", async () => {
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

  it.each(["admin", "editor"] as const)(
    "reads and writes the picked team's environment for a team %s, not Personal's",
    async (role) => {
      host.teamRole = role;
      host.items = [
        storageItem(
          { chats: false, idleTaskDays: null, archivedChatHours: 720 },
          9,
        ),
      ];
      host.teamItems = [
        storageItem(
          { chats: true, idleTaskDays: 7, archivedChatHours: null },
          2,
        ),
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
    },
  );
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
    host.read = null;
    host.put = null;
    harness = null;
    useSettingsEnvironmentPickStore.setState({
      pick: null,
      defaultPick: PERSONAL_PICK,
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("starts the section over on each environment pick, so a save in flight stays with its own environment", async () => {
    const reads = new Map([
      [
        PERSONAL_ENV,
        [
          storageItem(
            { chats: false, idleTaskDays: null, archivedChatHours: 24 },
            2,
          ),
          snapshotItem({ quietChatDays: 7 }, 3),
        ],
      ],
      [
        TEAM_ENV,
        [
          storageItem(
            { chats: true, idleTaskDays: null, archivedChatHours: 4 },
            4,
          ),
          snapshotItem({ quietChatDays: 90 }, 4),
        ],
      ],
      [
        OTHER_TEAM_ENV,
        [
          storageItem(
            { chats: true, idleTaskDays: 14, archivedChatHours: 4 },
            5,
          ),
          snapshotItem({ quietChatDays: null }, 6),
        ],
      ],
    ]);
    host.read = (environmentId) =>
      Promise.resolve({ items: reads.get(environmentId) ?? [] });
    host.put = () =>
      new Promise<EnvironmentConfigurationItemWriteResponse>(() => undefined);
    const pickEnvironment = (pick: EnvironmentPick): void => {
      act(() => {
        useSettingsEnvironmentPickStore.setState({ pick });
      });
    };
    const expectFree = async (snapshotWindow: string): Promise<void> => {
      await settled();
      expect(snapshotsSelect().textContent).toContain(snapshotWindow);
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(false);
      expect(screen.queryByTestId("storage-policy-saving")).toBeNull();
    };
    pickEnvironment({ kind: "team", environmentId: TEAM_ENV });
    renderSection(
      <PersonalPageFrame section="storage">
        <StorageSettingsPanel />
      </PersonalPageFrame>,
    );
    await expectFree("After 90 days");

    pickOption(snapshotsSelect(), "After 30 days");
    await waitFor(() => {
      expectSnapshotPut(TEAM_ENV, { quietChatDays: 30 }, 4);
      expect(snapshotsSelect().textContent).toContain("After 30 days");
      expect(snapshotsSelect().hasAttribute("disabled")).toBe(true);
    });
    expect(
      within(groupOf(SNAPSHOT_GROUP)).getByTestId("storage-policy-saving"),
    ).toBeTruthy();

    // Team to team keeps the same frame element, so only a keyed remount
    // starts the section over; a switch through Personal remounts by type.
    pickEnvironment({ kind: "team", environmentId: OTHER_TEAM_ENV });
    await expectFree("Never");
    expect(idleTasksSelect().textContent).toContain("After 14 days");

    pickEnvironment(PERSONAL_PICK);
    await expectFree("After 7 days");
    expect((await chatsSwitch()).getAttribute("aria-checked")).toBe("false");

    pickEnvironment({ kind: "team", environmentId: TEAM_ENV });
    await expectFree("After 90 days");
    expect(harness?.paramsOf(PUT)).toHaveLength(1);
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProfileSyncItem,
  ProfileSyncOverview,
  ProfileSyncProvider,
  ProfileSyncReason,
  ProfileSyncStatus,
} from "@traycer/protocol/host/profile-sync-link-schemas";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { ProfileSyncModalHost } from "@/components/settings/panels/profile-sync/profile-sync-modal-host";
import { useProfileSyncModalStore } from "@/stores/settings/profile-sync-modal-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import type { OpenSettingsModalOpts } from "@/stores/tabs/use-system-tab-modal";

const SOURCE_HOST_ID = "host-source";
const OFFICE_HOST_ID = "host-office";
const PHONE_HOST_ID = "host-phone";
const OFFLINE_HOST_ID = "host-offline";
const REMOVED_HOST_ID = "host-removed";
const UNKNOWN_HOST_ID = "host-unknown";
const OTHER_SOURCE_HOST_ID = "host-other-source";
const SIGN_IN_PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const SYNCED_PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const REMOVED_PROFILE_ID = "44444444-4444-4444-8444-444444444444";

const testState = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
  hosts: [] as HostScopeOption[],
  openSettings: vi.fn<(opts: OpenSettingsModalOpts) => void>(),
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({ hosts: testState.hosts }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null) return null;
    return {
      getActiveHostId: () => hostId,
      getRequestContextUserId: () => "user-1",
      request: (method: string, params: unknown) =>
        testState.request(method, params),
      requestWithSignal: (
        method: string,
        params: unknown,
        _signal: AbortSignal | undefined,
      ) => testState.request(method, params),
    };
  },
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: testState.openSettings,
    openHistory: () => undefined,
    close: () => undefined,
    setSection: () => undefined,
  }),
}));

function hang(): Promise<never> {
  return new Promise(() => undefined);
}

function item(input: {
  readonly providerId: ProfileSyncProvider;
  readonly sourceProfileId: string;
  readonly name: string;
  readonly status: ProfileSyncStatus;
  readonly reason: ProfileSyncReason | null;
}): ProfileSyncItem {
  return {
    providerId: input.providerId,
    sourceProfileId: input.sourceProfileId,
    name: input.name,
    status: input.status,
    reason: input.reason,
  };
}

function overview(input: {
  readonly sourceHostId: string;
  readonly profileCount: number;
  readonly devices: ProfileSyncOverview["devices"];
}): ProfileSyncOverview {
  return {
    sourceHostId: input.sourceHostId,
    profileCount: input.profileCount,
    devices: input.devices,
  };
}

function sourceHost(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: SOURCE_HOST_ID,
    name: "MacBook",
  });
}

function officeHost(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: OFFICE_HOST_ID,
    name: "Office Linux",
  });
}

function phoneHost(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: PHONE_HOST_ID,
    name: "Phone",
  });
}

function offlineHost(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: OFFLINE_HOST_ID,
    name: "Travel laptop",
    health: {
      state: "offline",
      label: "Offline",
      detail: null,
      tone: "idle",
      live: false,
    },
  });
}

function removedHost(): HostScopeOption {
  return hostScopeOptionFixture({
    hostId: REMOVED_HOST_ID,
    name: "Old desktop",
    health: {
      state: "removed",
      label: "Removed",
      detail: null,
      tone: "idle",
      live: false,
    },
  });
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderHost(queryClient: QueryClient): void {
  const tree: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <ProfileSyncModalHost />
    </QueryClientProvider>
  );
  render(tree);
}

async function openDialog(): Promise<HTMLElement> {
  act(() => {
    useProfileSyncModalStore.getState().open(SOURCE_HOST_ID);
  });
  return screen.findByRole("dialog");
}

function answerOverview(data: ProfileSyncOverview): void {
  testState.request.mockImplementation((method) => {
    if (method === "providers.profileSync.overview") {
      return Promise.resolve(data);
    }
    return hang();
  });
}

function collapsedText(element: Element): string {
  return element.textContent.replace(/\s+/g, " ").trim();
}

function emptyOfficeOverview(): ProfileSyncOverview {
  return overview({
    sourceHostId: SOURCE_HOST_ID,
    profileCount: 2,
    devices: [],
  });
}

const NEEDS_USER_ITEMS: readonly ProfileSyncItem[] = [
  item({
    providerId: "claude",
    sourceProfileId: SIGN_IN_PROFILE_ID,
    name: "Needs sign-in",
    status: "sign-in-needed",
    reason: null,
  }),
  item({
    providerId: "codex",
    sourceProfileId: ACCOUNT_PROFILE_ID,
    name: "New account",
    status: "cannot-sync",
    reason: "account-changed",
  }),
];

const REST_ITEMS: readonly ProfileSyncItem[] = [
  item({
    providerId: "grok",
    sourceProfileId: SYNCED_PROFILE_ID,
    name: "Already there",
    status: "synced",
    reason: null,
  }),
  item({
    providerId: "antigravity",
    sourceProfileId: REMOVED_PROFILE_ID,
    name: "Taken off",
    status: "cannot-sync",
    reason: "removed-on-device",
  }),
];

function officeWithItems(): ProfileSyncOverview {
  return overview({
    sourceHostId: SOURCE_HOST_ID,
    profileCount: 4,
    devices: [
      {
        hostId: OFFICE_HOST_ID,
        keepInSync: false,
        items: [...NEEDS_USER_ITEMS, ...REST_ITEMS],
      },
    ],
  });
}

describe("<ProfileSyncModalHost />", () => {
  beforeEach(() => {
    testState.request.mockReset();
    testState.hosts = [sourceHost(), officeHost()];
    testState.openSettings.mockReset();
    useProfileSyncModalStore.getState().close();
    useProvidersFocusStore.getState().clearFocusHarnessId();
    useProvidersFocusStore.getState().clearFocusTab();
  });

  afterEach(() => {
    cleanup();
    useProfileSyncModalStore.getState().close();
    useProvidersFocusStore.getState().clearFocusHarnessId();
    useProvidersFocusStore.getState().clearFocusTab();
  });

  it("shows the Sync profiles header and From <source> · N profiles", async () => {
    answerOverview(
      overview({
        sourceHostId: SOURCE_HOST_ID,
        profileCount: 3,
        devices: [],
      }),
    );
    renderHost(makeQueryClient());
    await openDialog();

    expect(screen.getByRole("heading", { name: "Sync profiles" })).toBeTruthy();
    expect(await screen.findByText("From MacBook · 3 profiles")).toBeTruthy();
  });

  it("reads Not synced yet for a device with no overview entry, with Sync now and an off Keep in sync switch", async () => {
    answerOverview(emptyOfficeOverview());
    renderHost(makeQueryClient());
    await openDialog();

    const office = await screen.findByRole("region", { name: "Office Linux" });
    expect(within(office).getByText("Not synced yet")).toBeTruthy();
    expect(
      within(office).getByRole<HTMLButtonElement>("button", {
        name: "Sync now",
      }),
    ).toBeTruthy();
    const keep = within(office).getByRole<HTMLButtonElement>("switch", {
      name: "Keep Office Linux in sync",
    });
    expect(keep.getAttribute("aria-checked")).toBe("false");
    expect(keep.disabled).toBe(false);
  });

  it("shows need-you rows first without expanding, each with one action, and the rest after Show all N", async () => {
    answerOverview(officeWithItems());
    renderHost(makeQueryClient());
    await openDialog();
    const user = userEvent.setup();

    const office = await screen.findByRole("region", { name: "Office Linux" });
    const summary = within(office).getByText("1 synced").closest("p");
    if (summary === null) throw new Error("expected a device summary");
    expect(collapsedText(summary)).toBe("1 synced · 2 need you · 1 can't sync");

    const rows = within(office).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(collapsedText(rows[0])).toContain("Claude Code · Needs sign-in");
    expect(within(rows[0]).getAllByRole("button")).toHaveLength(1);
    expect(
      within(rows[0]).getByRole<HTMLButtonElement>("button", {
        name: "Sign in on MacBook",
      }),
    ).toBeTruthy();
    expect(collapsedText(rows[1])).toContain("Codex · New account");
    expect(within(rows[1]).getAllByRole("button")).toHaveLength(1);
    expect(
      within(rows[1]).getByRole<HTMLButtonElement>("button", {
        name: "Sync the new account",
      }),
    ).toBeTruthy();
    expect(collapsedText(office)).not.toContain("Grok · Already there");
    expect(collapsedText(office)).not.toContain("Antigravity · Taken off");

    const showAll = within(office).getByRole<HTMLButtonElement>("button", {
      name: "Show all 4",
    });
    expect(showAll.getAttribute("aria-expanded")).toBe("false");
    await user.click(showAll);

    expect(
      within(office)
        .getByRole<HTMLButtonElement>("button", { name: "Show fewer" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(within(office).getAllByRole("listitem")).toHaveLength(4);
    expect(collapsedText(office)).toContain("Grok · Already there");
    expect(collapsedText(office)).toContain("Antigravity · Taken off");
  });

  it("has no Show all button when nothing is hidden", async () => {
    answerOverview(
      overview({
        sourceHostId: SOURCE_HOST_ID,
        profileCount: 2,
        devices: [
          {
            hostId: OFFICE_HOST_ID,
            keepInSync: false,
            items: [...NEEDS_USER_ITEMS],
          },
        ],
      }),
    );
    renderHost(makeQueryClient());
    await openDialog();

    const office = await screen.findByRole("region", { name: "Office Linux" });
    expect(within(office).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(office).queryByRole("button", { name: /Show all/ }),
    ).toBeNull();
  });

  it("renders Sync now only when the device is not kept in sync, and clicking it sends syncNow", async () => {
    testState.hosts = [sourceHost(), officeHost(), phoneHost()];
    answerOverview(
      overview({
        sourceHostId: SOURCE_HOST_ID,
        profileCount: 1,
        devices: [
          {
            hostId: OFFICE_HOST_ID,
            keepInSync: false,
            items: [],
          },
          {
            hostId: PHONE_HOST_ID,
            keepInSync: true,
            items: [],
          },
        ],
      }),
    );
    renderHost(makeQueryClient());
    await openDialog();
    const user = userEvent.setup();

    const office = await screen.findByRole("region", { name: "Office Linux" });
    const phone = screen.getByRole("region", { name: "Phone" });
    expect(
      within(office).getByRole<HTMLButtonElement>("button", {
        name: "Sync now",
      }),
    ).toBeTruthy();
    expect(
      within(phone).queryByRole("button", { name: "Sync now" }),
    ).toBeNull();

    await user.click(
      within(office).getByRole<HTMLButtonElement>("button", {
        name: "Sync now",
      }),
    );
    await waitFor(() => {
      expect(testState.request).toHaveBeenCalledWith(
        "providers.profileSync.syncNow",
        {
          sourceHostId: SOURCE_HOST_ID,
          destinationHostId: OFFICE_HOST_ID,
        },
      );
    });
  });

  it("turns Keep in sync on immediately and hides Sync now while the request is pending", async () => {
    answerOverview(emptyOfficeOverview());
    renderHost(makeQueryClient());
    await openDialog();
    const user = userEvent.setup();

    const office = await screen.findByRole("region", { name: "Office Linux" });
    await user.click(
      within(office).getByRole<HTMLButtonElement>("switch", {
        name: "Keep Office Linux in sync",
      }),
    );

    await waitFor(() => {
      expect(testState.request).toHaveBeenCalledWith(
        "providers.profileSync.setKeepInSync",
        {
          sourceHostId: SOURCE_HOST_ID,
          destinationHostId: OFFICE_HOST_ID,
          enabled: true,
        },
      );
    });
    const keep = within(office).getByRole<HTMLButtonElement>("switch", {
      name: "Keep Office Linux in sync",
    });
    expect(keep.getAttribute("aria-checked")).toBe("true");
    expect(keep.disabled).toBe(true);
    expect(
      within(office).queryByRole("button", { name: "Sync now" }),
    ).toBeNull();
  });

  it("sends acceptAccount for Sync the new account", async () => {
    answerOverview(officeWithItems());
    renderHost(makeQueryClient());
    await openDialog();
    const user = userEvent.setup();

    await screen.findByRole("region", { name: "Office Linux" });
    await user.click(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Sync the new account",
      }),
    );
    await waitFor(() => {
      expect(testState.request).toHaveBeenCalledWith(
        "providers.profileSync.acceptAccount",
        {
          sourceHostId: SOURCE_HOST_ID,
          destinationHostId: OFFICE_HOST_ID,
          providerId: "codex",
          sourceProfileId: ACCOUNT_PROFILE_ID,
        },
      );
    });
  });

  it("opens Providers sign-in for the source profile and closes the dialog", async () => {
    answerOverview(officeWithItems());
    renderHost(makeQueryClient());
    await openDialog();
    const user = userEvent.setup();

    await screen.findByRole("region", { name: "Office Linux" });
    await user.click(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Sign in on MacBook",
      }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    const focus = useProvidersFocusStore.getState();
    expect(focus.focusHostId).toBe(SOURCE_HOST_ID);
    expect(focus.focusProfileId).toBe(SIGN_IN_PROFILE_ID);
    expect(focus.startSignIn).toBe(true);
    expect(testState.openSettings).toHaveBeenCalledWith({
      section: "providers",
      resetToGeneral: false,
      tab: null,
      draft: null,
      hostId: null,
    });
  });

  it("closes with the Close button while a mutation is pending", async () => {
    answerOverview(emptyOfficeOverview());
    renderHost(makeQueryClient());
    await openDialog();
    const user = userEvent.setup();

    const office = await screen.findByRole("region", { name: "Office Linux" });
    await user.click(
      within(office).getByRole<HTMLButtonElement>("button", {
        name: "Sync now",
      }),
    );
    await waitFor(() => {
      expect(
        within(office).getByRole<HTMLButtonElement>("button", {
          name: "Sync now",
        }).disabled,
      ).toBe(true);
    });
    await user.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Close" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useProfileSyncModalStore.getState().sourceHostId).toBeNull();
  });

  it("closes with Escape while a mutation is pending", async () => {
    answerOverview(emptyOfficeOverview());
    renderHost(makeQueryClient());
    await openDialog();
    const user = userEvent.setup();

    const office = await screen.findByRole("region", { name: "Office Linux" });
    await user.click(
      within(office).getByRole<HTMLButtonElement>("button", {
        name: "Sync now",
      }),
    );
    await waitFor(() => {
      expect(
        within(office).getByRole<HTMLButtonElement>("button", {
          name: "Sync now",
        }).disabled,
      ).toBe(true);
    });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useProfileSyncModalStore.getState().sourceHostId).toBeNull();
  });

  it("closes with Done while a mutation is pending", async () => {
    answerOverview(emptyOfficeOverview());
    renderHost(makeQueryClient());
    await openDialog();
    const user = userEvent.setup();

    const office = await screen.findByRole("region", { name: "Office Linux" });
    await user.click(
      within(office).getByRole<HTMLButtonElement>("button", {
        name: "Sync now",
      }),
    );
    await waitFor(() => {
      expect(
        within(office).getByRole<HTMLButtonElement>("button", {
          name: "Sync now",
        }).disabled,
      ).toBe(true);
    });
    await user.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Done" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useProfileSyncModalStore.getState().sourceHostId).toBeNull();
  });

  it("disables only the control that sent the request, and the same control is still disabled after reopen", async () => {
    testState.hosts = [sourceHost(), officeHost(), phoneHost()];
    answerOverview(
      overview({
        sourceHostId: SOURCE_HOST_ID,
        profileCount: 4,
        devices: [
          {
            hostId: OFFICE_HOST_ID,
            keepInSync: false,
            items: [...NEEDS_USER_ITEMS, ...REST_ITEMS],
          },
          {
            hostId: PHONE_HOST_ID,
            keepInSync: false,
            items: [],
          },
        ],
      }),
    );
    renderHost(makeQueryClient());
    await openDialog();
    const user = userEvent.setup();

    const office = await screen.findByRole("region", { name: "Office Linux" });
    const phone = screen.getByRole("region", { name: "Phone" });
    await user.click(
      within(office).getByRole<HTMLButtonElement>("button", {
        name: "Sync now",
      }),
    );
    await waitFor(() => {
      expect(
        within(office).getByRole<HTMLButtonElement>("button", {
          name: "Sync now",
        }).disabled,
      ).toBe(true);
    });
    expect(
      within(office).getByRole<HTMLButtonElement>("switch", {
        name: "Keep Office Linux in sync",
      }).disabled,
    ).toBe(false);
    expect(
      within(office).getByRole<HTMLButtonElement>("button", {
        name: "Sync the new account",
      }).disabled,
    ).toBe(false);
    expect(
      within(phone).getByRole<HTMLButtonElement>("button", { name: "Sync now" })
        .disabled,
    ).toBe(false);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled,
    ).toBe(false);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Close" }).disabled,
    ).toBe(false);

    await user.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Done" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    await openDialog();
    const officeAgain = await screen.findByRole("region", {
      name: "Office Linux",
    });
    await waitFor(() => {
      expect(
        within(officeAgain).getByRole<HTMLButtonElement>("button", {
          name: "Sync now",
        }).disabled,
      ).toBe(true);
    });
    expect(
      within(officeAgain).getByRole<HTMLButtonElement>("switch", {
        name: "Keep Office Linux in sync",
      }).disabled,
    ).toBe(false);
  });

  it("lists offline, omitted-removed, source, and unknown-device rows as specified", async () => {
    testState.hosts = [
      sourceHost(),
      officeHost(),
      offlineHost(),
      removedHost(),
    ];
    answerOverview(
      overview({
        sourceHostId: SOURCE_HOST_ID,
        profileCount: 1,
        devices: [
          {
            hostId: OFFICE_HOST_ID,
            keepInSync: false,
            items: [],
          },
          {
            hostId: UNKNOWN_HOST_ID,
            keepInSync: false,
            items: [],
          },
        ],
      }),
    );
    renderHost(makeQueryClient());
    await openDialog();

    const travel = await screen.findByRole("region", { name: "Travel laptop" });
    expect(
      within(travel).getByText("Device offline · syncs when it connects"),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Old desktop" })).toBeNull();
    expect(screen.queryByRole("region", { name: "MacBook" })).toBeNull();
    expect(screen.getByRole("region", { name: "Unknown device" })).toBeTruthy();
  });

  it("shows the retry sentence when the overview errors with no data", async () => {
    testState.request.mockRejectedValue(
      new HostRpcError({
        code: "RPC_ERROR",
        message: "unreachable",
        requestId: "req-overview",
        method: "providers.profileSync.overview",
        fatalDetails: null,
      }),
    );
    renderHost(makeQueryClient());
    await openDialog();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.getByText(
        "Couldn't reach MacBook right now. This retries on its own.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("tells the user to update Traycer on the source for E_HOST_UNSUPPORTED", async () => {
    testState.request.mockRejectedValue(
      new HostRpcError({
        code: "E_HOST_UNSUPPORTED",
        message: "unsupported",
        requestId: "req-overview",
        method: "providers.profileSync.overview",
        fatalDetails: null,
      }),
    );
    renderHost(makeQueryClient());
    await openDialog();

    expect(
      await screen.findByText("Update Traycer on MacBook to sync profiles."),
    ).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("never renders a device list from another source's answer", async () => {
    testState.hosts = [
      sourceHost(),
      hostScopeOptionFixture({
        hostId: "host-wrong",
        name: "Wrong machine",
      }),
    ];
    testState.request.mockResolvedValue(
      overview({
        sourceHostId: OTHER_SOURCE_HOST_ID,
        profileCount: 9,
        devices: [
          {
            hostId: "host-wrong",
            keepInSync: true,
            items: [
              item({
                providerId: "claude",
                sourceProfileId: "ambient",
                name: "Should not appear",
                status: "synced",
                reason: null,
              }),
            ],
          },
        ],
      }),
    );
    renderHost(makeQueryClient());
    await openDialog();

    expect(
      await screen.findByText(
        "Couldn't reach MacBook right now. This retries on its own.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Wrong machine" })).toBeNull();
    expect(screen.queryByText("Should not appear")).toBeNull();
    expect(screen.queryByText("From Wrong machine")).toBeNull();
  });
});

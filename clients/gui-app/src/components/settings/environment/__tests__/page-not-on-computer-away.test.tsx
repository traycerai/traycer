// A Local pick of a computer this app cannot reach answers every page it lacks
// with "Can't reach {name} from here", never with Update: nothing on it can be
// updated until it is back. A computer that is reachable and merely below the
// minimum version keeps the update. The scope is the real one over a stood-in
// host list, so the status comes from the host's own facts.
vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-client/minimum-host-version")
    >()),
    MINIMUM_HOST_VERSION: "2.0.0",
  }),
);

const harness = vi.hoisted(() => ({
  hosts: [] as HostScopeOption[],
  activeHostId: null as string | null,
  client: null as HostClient<HostRpcRegistry> | null,
  directoryResolved: true,
  directoryFailed: false,
  /** The host lists' own state: still loading, or failed before any row. */
  listsResolved: true,
  listsFailed: false,
  isLoading: false,
  retryLists: vi.fn(),
  /** Whether Host Overview would offer Update now on the picked computer. */
  updateApplies: true,
  startUpdate: vi.fn(),
}));

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: harness.hosts,
        activeHostId: harness.activeHostId,
        directoryResolved: harness.directoryResolved,
        directoryFailed: harness.directoryFailed,
        listsResolved: harness.listsResolved,
        listsFailed: harness.listsFailed,
        isLoading: harness.isLoading,
        retryLists: harness.retryLists,
      }),
  };
});
// The skew action under a below-minimum computer is the real button over this
// update; Host Overview's own Update now is the card's, so it is answered here.
vi.mock("@/hooks/host/use-older-host-update", () => ({
  useOlderHostUpdate: () => ({
    update: harness.startUpdate,
    pending: false,
    remotePending: false,
    failure: null,
  }),
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-provisioning-progress", () => ({
  useHostProvisioningProgress: () => null,
}));
vi.mock(
  "@/components/settings/panels/host-update-now-action",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/settings/panels/host-update-now-action")
    >()),
    useHostUpdateNow: () => ({
      applies: harness.updateApplies,
      action: <button type="button">Host Overview update</button>,
    }),
  }),
);
vi.mock("@/providers/use-runner-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/providers/use-runner-host")>()),
  useRunnerHost: () => ({
    selectionAuthority: {
      activate: () => Promise.resolve({ ok: true as const }),
    },
    hostManagement: null,
  }),
  useRunnerHostOrNull: () => null,
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => null,
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => harness.client,
}));
// The cases through the Settings modal content keep its rail to the two rows
// they click, which call the surface's own section setter; the pick's upkeep
// has its own suite; a cloud page stands in as a marker naming its section.
vi.mock("@/components/settings/settings-sidebar", () => ({
  SettingsSidebar: (props: {
    readonly mode: { readonly onSelect: (section: string) => void };
  }) => (
    <>
      <button type="button" onClick={() => props.mode.onSelect("mcp-servers")}>
        Open MCP Servers
      </button>
      <button type="button" onClick={() => props.mode.onSelect("secrets")}>
        Open Secrets
      </button>
    </>
  ),
}));
vi.mock("@/components/settings/environment-picker", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/settings/environment-picker")
  >()),
  EnvironmentPickUpkeep: () => null,
}));
vi.mock(
  "@/components/settings/environment/configuration-source-boundary",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/settings/environment/configuration-source-boundary")
    >()),
    ConfigurationSourceBoundary: (props: { readonly section: string }) => (
      <div data-testid="cloud-page">{props.section}</div>
    ),
  }),
);
vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  localEntry,
  remoteEntry,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { EnvironmentStatusResponseV14 } from "@traycer/protocol/host/environment-schemas";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { isConcealed } from "@/components/settings/host-scope/concealment-test-helpers";
import { PageOrNotOnComputer } from "@/components/settings/environment/page-not-on-computer";
import { SettingsModalContent } from "@/components/settings/settings-modal-content";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import {
  hostLeaseFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { pickOldHostLocal } from "@/components/settings/__tests__/old-host-pick-fixture";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { HOST_UPDATE_SKEW_COPY } from "@/lib/host/version-skew-copy";
import { recordNegotiatedHostManifest } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { SettingsSectionId } from "@/lib/settings-sections";
import type { ReactNode } from "react";
import { buildOverviewHostFixture } from "@/components/settings/panels/__tests__/host-overview-test-support";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import { queryReadSignal } from "@/components/settings/personal/__tests__/query-read-signal";
import type { HostRpcRegistry } from "@/lib/host";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";

/** A computer whose app is older than the minimum the Settings pages need. */
function belowMinimumEntry(hostId: string): RemoteHostDirectoryEntry {
  const base = remoteEntry(hostId, null);
  return {
    ...base,
    version: "1.5.4",
    remoteStatus: { ...base.remoteStatus, appVersion: "1.5.4" },
  };
}

function listOldHost(overrides: Partial<HostScopeOption>): void {
  harness.hosts = [
    hostScopeOptionFixture({
      hostId: "host-old",
      name: "Old laptop",
      isLocalMachine: false,
      isActive: false,
      ...overrides,
    }),
  ];
}

/** Concealed or absent: the page stays mounted beneath the notice, out of view. */
function expectHiddenFromView(node: Element | null): void {
  expect(node === null || isConcealed(node)).toBe(true);
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function pageElement(section: SettingsSectionId): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <PageOrNotOnComputer section={section}>
        <input data-testid="draft" />
      </PageOrNotOnComputer>
    </QueryClientProvider>
  );
}

function renderSecrets(): void {
  render(pageElement("secrets"));
}

afterEach(() => {
  cleanup();
  queryClient.clear();
  resetNegotiatedManifests();
  useSelectionAuthorityStore.getState().reset();
  useSettingsSectionStore.setState({ section: null });
  harness.hosts = [];
  harness.activeHostId = null;
  harness.client = null;
  harness.directoryResolved = true;
  harness.directoryFailed = false;
  harness.listsResolved = true;
  harness.listsFailed = false;
  harness.isLoading = false;
  harness.updateApplies = true;
  harness.retryLists.mockReset();
  harness.startUpdate.mockReset();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
});

describe("Secrets under a Local pick of an old computer", () => {
  it("shows Can't reach, not Update, when the computer has no connection to this app", () => {
    pickOldHostLocal();
    listOldHost({ connectable: false });

    renderSecrets();

    expect(screen.getByTestId("host-scope-unreachable").textContent).toContain(
      "Can't reach Old laptop from here",
    );
    expectHiddenFromView(screen.queryByTestId("page-not-on-computer-update"));
  });

  it("shows Can't reach, not Update, when the computer is below the minimum version and has no connection", () => {
    pickOldHostLocal();
    listOldHost({
      connectable: false,
      entry: belowMinimumEntry("host-old"),
    });

    renderSecrets();

    expect(screen.getByTestId("host-scope-unreachable").textContent).toContain(
      "Can't reach Old laptop from here",
    );
    expectHiddenFromView(screen.queryByTestId("page-not-on-computer-update"));
  });

  // Secrets has no update to keep (no host update serves it), so the page an
  // update gives is MCP servers.
  it("keeps the update on a page an update gives when the computer is connected and merely below the minimum version", () => {
    pickOldHostLocal();
    listOldHost({
      connectable: true,
      entry: belowMinimumEntry("host-old"),
    });

    render(pageElement("mcp-servers"));

    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expect(
      screen.getByTestId("page-not-on-computer-update").textContent,
    ).toContain("Update Old laptop to use MCP servers.");
    fireEvent.click(
      screen.getByRole("button", { name: HOST_UPDATE_SKEW_COPY.action }),
    );
    expect(harness.startUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("A page an old computer has, under a Local pick that goes out of reach and comes back", () => {
  it("shows only the notice while it is out of reach, and gives back the draft typed before", () => {
    pickOldHostLocal();
    harness.activeHostId = "host-old";
    listOldHost({ connectable: true, isActive: true });
    const view = render(pageElement("providers"));
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    fireEvent.change(screen.getByTestId("draft"), {
      target: { value: "keep this draft" },
    });

    listOldHost({ connectable: false, isActive: true });
    view.rerender(pageElement("providers"));

    expect(screen.getByTestId("host-scope-unreachable").textContent).toContain(
      "Can't reach Old laptop from here",
    );
    expectHiddenFromView(screen.queryByTestId("draft"));

    listOldHost({ connectable: true, isActive: true });
    view.rerender(pageElement("providers"));

    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    expect(screen.getByTestId("draft")).toHaveProperty(
      "value",
      "keep this draft",
    );
  });
});

const WINDOW_HOST = hostScopeOptionFixture({
  hostId: "host-win",
  name: "Window laptop",
  isLocalMachine: true,
  isActive: true,
});

/** The window's host is named and listed, and has answered nothing yet. */
function pickPersonalOnUnansweredWindowHost(): void {
  useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
  harness.hosts = [WINDOW_HOST];
  harness.activeHostId = "host-win";
}

function railLabel(section: SettingsSectionId): string {
  const entry = SETTINGS_SECTIONS.find((item) => item.id === section);
  if (entry === undefined) throw new Error(`no section ${section}`);
  return entry.label;
}

describe("An Environment page under a Personal pick whose window host has not answered", () => {
  it.each([
    "providers",
    "mcp-servers",
    "skills",
    "agent-memories",
    "sandboxes",
    "storage",
  ] as const)(
    "shows %s under its own heading with Connecting, not the page",
    (section) => {
      pickPersonalOnUnansweredWindowHost();

      render(pageElement(section));

      expect(
        screen.getByRole("heading", { name: railLabel(section) }),
      ).toBeTruthy();
      expect(screen.getByTestId("host-scope-connecting").textContent).toContain(
        "Connecting to Window laptop",
      );
      expect(screen.queryByTestId("draft")).toBeNull();
    },
  );

  it("shows Secrets as Connecting, not the cloud page, while the host row the authority names has not arrived", () => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    harness.activeHostId = "host-win";
    harness.listsResolved = false;
    harness.isLoading = true;

    renderSecrets();

    expect(screen.getByTestId("host-scope-connecting")).toBeTruthy();
    expect(screen.queryByTestId("draft")).toBeNull();
  });
});

describe("Personal's Secrets while the window host's row is missing and another computer is listed", () => {
  beforeEach(() => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    harness.activeHostId = "host-win";
    // Not connectable, so a scope reading it would put Personal on the cloud.
    harness.hosts = [
      hostScopeOptionFixture({
        hostId: "host-other",
        name: "Other laptop",
        isLocalMachine: false,
        isActive: false,
        connectable: false,
      }),
    ];
  });

  it.each([
    { lists: "loading", isLoading: true },
    { lists: "neither answered nor loading", isLoading: false },
  ])(
    "waits under its heading while the lists are $lists, rather than read the other computer",
    ({ isLoading }) => {
      harness.listsResolved = false;
      harness.isLoading = isLoading;

      renderSecrets();

      expect(screen.getByRole("heading", { name: "Secrets" })).toBeTruthy();
      expect(screen.getByTestId("host-scope-connecting")).toBeTruthy();
      expect(screen.queryByText(/Other laptop/)).toBeNull();
      expect(screen.queryByTestId("draft")).toBeNull();
    },
  );

  it("offers the lists' retry when they failed, rather than read the other computer", () => {
    harness.listsFailed = true;

    renderSecrets();

    expect(screen.getByTestId("host-scope-lists-failed")).toBeTruthy();
    expect(screen.queryByTestId("draft")).toBeNull();
  });
});

describe("Personal's Providers while the window's host is resolving", () => {
  const REMOTE_WINDOW_HOST = { ...WINDOW_HOST, isLocalMachine: false };
  const REMOTE_ENTRY = remoteEntry(WINDOW_HOST.hostId, null);

  function connectWindowHost(
    readStatus: () =>
      | EnvironmentStatusResponseV14
      | Promise<EnvironmentStatusResponseV14>,
    host: HostScopeOption,
  ): void {
    const entry = host.isLocalMachine
      ? { ...localEntry, hostId: host.hostId, version: "2.0.0" }
      : {
          ...REMOTE_ENTRY,
          version: "2.0.0",
          remoteStatus: { ...REMOTE_ENTRY.remoteStatus, appVersion: "2.0.0" },
        };
    harness.hosts = [{ ...host, connectable: true, entry }];
    harness.client = buildOverviewHostFixture({
      hostId: host.hostId,
      isLocalMachine: host.isLocalMachine,
      hostVersion: "2.0.0",
      overrideHandlers: { "environment.status": readStatus },
    }).client;
  }

  function recordWindowStatusSupport(): void {
    recordNegotiatedHostManifest(WINDOW_HOST.hostId, {
      "environment.status": { major: 1, minor: 3 },
    });
  }

  const REGISTRY_OFFLINE: HostScopeOption["health"] = {
    state: "offline",
    label: "Offline",
    detail: null,
    tone: "idle",
    live: false,
  };

  function listWindowHostWithoutRoute(health: HostScopeOption["health"]): void {
    pickPersonalOnUnansweredWindowHost();
    harness.hosts = [
      { ...WINDOW_HOST, isLocalMachine: false, connectable: false, health },
    ];
  }

  function markDirectoryPending(): void {
    harness.directoryResolved = false;
    harness.listsResolved = false;
    harness.isLoading = true;
  }

  function recordLease(lease: HostLeaseSnapshot): void {
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: WINDOW_HOST.hostId,
      targetHostId: WINDOW_HOST.hostId,
      effectiveHostId: WINDOW_HOST.hostId,
      leases: [lease],
      selectionRevision: 1,
    });
  }

  it.each([WINDOW_HOST.health, REGISTRY_OFFLINE])(
    "waits for the directory with a registry-only $state host, even if another host has a dead lease",
    async (health) => {
      listWindowHostWithoutRoute(health);
      markDirectoryPending();
      recordLease(hostLeaseFixture("host-other", { reason: "offline" }));
      const view = render(pageElement("providers"));

      expect
        .soft(screen.queryByText("Connecting to Window laptop…"))
        .toBeTruthy();
      expect.soft(screen.queryByTestId("draft")).toBeNull();

      harness.directoryResolved = true;
      harness.directoryFailed = true;
      harness.listsResolved = true;
      harness.listsFailed = true;
      harness.isLoading = false;
      view.rerender(pageElement("providers"));

      expect.soft(screen.queryByTestId("draft")).toBeNull();
      expect(screen.getByRole("heading", { name: "Providers" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(harness.retryLists).toHaveBeenCalledTimes(1);

      harness.directoryFailed = false;
      harness.listsFailed = false;
      const readStatus = vi.fn(() => environmentStatusFixture({}));
      connectWindowHost(readStatus, REMOTE_WINDOW_HOST);
      recordWindowStatusSupport();
      view.rerender(pageElement("providers"));

      expect(await screen.findByTestId("draft")).toBeTruthy();
      expect(readStatus).toHaveBeenCalledTimes(1);
    },
  );

  it("uses Personal when the settled directory has no route to the active computer", () => {
    listWindowHostWithoutRoute(WINDOW_HOST.health);

    render(pageElement("providers"));

    expect(screen.getByTestId("draft")).toBeTruthy();
  });

  it("uses Personal while the directory is pending if the client has confirmed the active computer is offline", () => {
    listWindowHostWithoutRoute(REGISTRY_OFFLINE);
    markDirectoryPending();
    recordLease(hostLeaseFixture(WINDOW_HOST.hostId, { reason: "offline" }));

    render(pageElement("providers"));

    expect(screen.getByTestId("draft")).toBeTruthy();
  });

  it("waits through the handshake and first status when a dialable host still has registry Offline", async () => {
    pickPersonalOnUnansweredWindowHost();
    recordLease({
      hostId: WINDOW_HOST.hostId,
      status: "connecting",
      dead: null,
    });
    const statusStarted = Promise.withResolvers<void>();
    const statusReply = Promise.withResolvers<EnvironmentStatusResponseV14>();
    connectWindowHost(
      () => {
        statusStarted.resolve();
        return statusReply.promise;
      },
      { ...REMOTE_WINDOW_HOST, health: REGISTRY_OFFLINE },
    );

    render(pageElement("providers"));

    expect(screen.queryByTestId("draft")).toBeNull();
    expect(screen.getByTestId("host-scope-connecting")).toBeTruthy();
    act(recordWindowStatusSupport);
    await statusStarted.promise;
    expect(screen.queryByTestId("draft")).toBeNull();
    statusReply.resolve(environmentStatusFixture({}));

    expect(await screen.findByTestId("draft")).toBeTruthy();
  });

  it("uses cloud Personal when the authority has confirmed a dialable host is offline", () => {
    pickPersonalOnUnansweredWindowHost();
    recordLease(hostLeaseFixture(WINDOW_HOST.hostId, { reason: "offline" }));
    connectWindowHost(() => environmentStatusFixture({}), {
      ...REMOTE_WINDOW_HOST,
      health: REGISTRY_OFFLINE,
    });

    render(pageElement("providers"));

    expect(screen.getByTestId("draft")).toBeTruthy();
  });

  it.each([
    {
      state: "a synthetic local boot entry",
      host: {
        ...WINDOW_HOST,
        entry: {
          ...localEntry,
          hostId: WINDOW_HOST.hostId,
          websocketUrl: null,
          version: "2.0.0",
          transportDialability: "not-dialable",
        },
      },
      lease: "connecting",
    },
    {
      state: "an expected remote restart",
      host: {
        ...REMOTE_WINDOW_HOST,
        entry: {
          ...REMOTE_ENTRY,
          remoteStatus: {
            ...REMOTE_ENTRY.remoteStatus,
            connectivity: "offline",
            appVersion: "2.0.0",
          },
          version: "2.0.0",
          transportDialability: "not-dialable",
        },
        health: REGISTRY_OFFLINE,
      },
      lease: "restarting-expected",
    },
  ] as const)(
    "keeps the requested section pending through $state",
    async ({ host, lease }) => {
      pickPersonalOnUnansweredWindowHost();
      harness.hosts = [{ ...host, connectable: false }];
      recordLease({ hostId: host.hostId, status: lease, dead: null });
      const view = render(pageElement("providers"));

      expect(screen.queryByTestId("draft")).toBeNull();
      expect(screen.getByTestId("host-scope-connecting")).toBeTruthy();
      const readStatus = vi.fn(() => environmentStatusFixture({}));
      connectWindowHost(readStatus, host);
      act(() => {
        recordLease(hostLeaseFixture(host.hostId, null));
        recordWindowStatusSupport();
      });
      view.rerender(pageElement("providers"));

      expect(await screen.findByTestId("draft")).toBeTruthy();
      expect(readStatus).toHaveBeenCalledTimes(1);
    },
  );

  it("retries a failed initial status on the same computer before mounting Providers", async () => {
    pickPersonalOnUnansweredWindowHost();
    const retryReply = Promise.withResolvers<EnvironmentStatusResponseV14>();
    const readStatus = vi
      .fn(() => retryReply.promise)
      .mockImplementationOnce(() => {
        throw new Error("environment status did not answer");
      });
    connectWindowHost(readStatus, REMOTE_WINDOW_HOST);
    recordWindowStatusSupport();

    render(pageElement("providers"));

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Couldn't read these settings.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Providers" })).toBeTruthy();
    expect(screen.queryByTestId("draft")).toBeNull();
    expect(readStatus).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);

    expect(await screen.findByTestId("host-scope-connecting")).toBeTruthy();
    expect(screen.queryByTestId("draft")).toBeNull();
    retryReply.resolve(environmentStatusFixture({}));

    expect(await screen.findByTestId("draft")).toBeTruthy();
    expect(readStatus).toHaveBeenCalledTimes(2);
  });

  // The window's own computer, booting or stopped: the directory lists it with
  // no address. Secrets is the page whose answer tells the cloud from the
  // computer's own page: this computer serves no Secrets list.
  describe("and is this computer, listed with no route", () => {
    const STARTING: HostLeaseSnapshot = {
      hostId: WINDOW_HOST.hostId,
      status: "connecting",
      dead: null,
    };
    const DEAD = hostLeaseFixture(WINDOW_HOST.hostId, { reason: "offline" });
    const READY = hostLeaseFixture(WINDOW_HOST.hostId, null);

    function listOwnComputerWithoutRoute(): void {
      pickPersonalOnUnansweredWindowHost();
      harness.hosts = [
        {
          ...WINDOW_HOST,
          connectable: false,
          entry: {
            ...localEntry,
            hostId: WINDOW_HOST.hostId,
            websocketUrl: null,
            version: "2.0.0",
            transportDialability: "not-dialable",
          },
        },
      ];
    }

    // The selection authority's snapshot with this computer as its only one:
    // preferred and target keep naming it, and it is the effective computer,
    // the one the host list and its row report as active, only while its lease
    // is not dead.
    function publishOwnLease(lease: HostLeaseSnapshot): void {
      const effectiveHostId = lease.status === "dead" ? null : lease.hostId;
      harness.activeHostId = effectiveHostId;
      harness.hosts = harness.hosts.map((host) => ({
        ...host,
        isActive: host.hostId === effectiveHostId,
      }));
      useSelectionAuthorityStore.getState().applyKernelSnapshot({
        attached: true,
        preferredHostId: WINDOW_HOST.hostId,
        targetHostId: WINDOW_HOST.hostId,
        effectiveHostId,
        leases: [lease],
        selectionRevision: 1,
      });
    }

    function publishToPage(view: RenderResult, lease: HostLeaseSnapshot): void {
      act(() => publishOwnLease(lease));
      view.rerender(pageElement("secrets"));
    }

    function renderStarting(): RenderResult {
      listOwnComputerWithoutRoute();
      publishOwnLease(STARTING);
      return render(pageElement("secrets"));
    }

    function renderDeclaredDead(): RenderResult {
      const view = renderStarting();
      publishToPage(view, DEAD);
      expect(screen.getByTestId("draft")).toBeTruthy();
      return view;
    }

    it("waits under the Secrets heading until the computer is declared dead, then draws the cloud page", () => {
      const view = renderStarting();

      expect(screen.getByRole("heading", { name: "Secrets" })).toBeTruthy();
      expect(
        screen.getByText("Values and logins your agents use."),
      ).toBeTruthy();
      expect(screen.getByTestId("host-scope-connecting").textContent).toContain(
        "Connecting to Window laptop…",
      );
      expect(screen.queryByTestId("draft")).toBeNull();

      publishToPage(view, DEAD);

      expect(screen.getByTestId("draft")).toBeTruthy();
      expect(screen.queryByTestId("host-scope-connecting")).toBeNull();
    });

    it("leaves the cloud page when the authority reads ready before the directory has a route", () => {
      const view = renderDeclaredDead();

      publishToPage(view, READY);

      expect(screen.queryByTestId("draft")).toBeNull();
      expect(screen.getByTestId("host-scope-connecting")).toBeTruthy();
    });

    it("stays on the cloud page while the next start is attempted, until the computer has a route", async () => {
      const statusStarted = Promise.withResolvers<void>();
      const statusReply = Promise.withResolvers<EnvironmentStatusResponseV14>();
      const view = renderDeclaredDead();

      // The failed start's hold lapses and the next attempt begins: the
      // computer is effective again and its lease reads connecting, and
      // nothing about its route has changed.
      publishToPage(view, STARTING);

      expect(screen.queryByTestId("draft")).not.toBeNull();
      expect(screen.queryByTestId("host-scope-connecting")).toBeNull();

      connectWindowHost(() => {
        statusStarted.resolve();
        return statusReply.promise;
      }, WINDOW_HOST);
      act(recordWindowStatusSupport);
      view.rerender(pageElement("secrets"));

      // The route is back: the page is the computer's own again.
      expect(screen.queryByTestId("draft")).toBeNull();
      expect(screen.getByTestId("host-scope-connecting")).toBeTruthy();
      await statusStarted.promise;
      const statusDelivered = queryReadSignal(
        queryClient,
        { method: "environment.status", hostId: WINDOW_HOST.hostId },
        true,
      );
      await act(async () => {
        statusReply.resolve(environmentStatusFixture({}));
        await statusDelivered;
      });

      expect(screen.getByText("Not on Window laptop")).toBeTruthy();
    });

    // The whole modal content, so the page's gate and its frame mount as they
    // do in the app: the gate outlives a section change, the frame under it
    // does not outlive a visit to a page only the cloud serves.
    describe("through the Settings modal, after a look at a cloud page", () => {
      const router = createRouter({
        routeTree: createRootRoute(),
        history: createMemoryHistory({ initialEntries: ["/"] }),
      });

      function ModalOverSectionStore(): ReactNode {
        const section = useSettingsSectionStore((state) => state.section);
        return <SettingsModalContent section={section} />;
      }

      function modalElement(): ReactNode {
        return (
          <QueryClientProvider client={queryClient}>
            <RouterContextProvider router={router}>
              <ModalOverSectionStore />
            </RouterContextProvider>
          </QueryClientProvider>
        );
      }

      function publishToModal(
        view: RenderResult,
        lease: HostLeaseSnapshot,
      ): void {
        act(() => publishOwnLease(lease));
        view.rerender(modalElement());
      }

      function open(name: string): void {
        fireEvent.click(screen.getByRole("button", { name }));
      }

      function expectCloudPage(section: SettingsSectionId): void {
        expect(screen.queryByTestId("cloud-page")?.textContent).toBe(section);
      }

      // Secrets open, the computer declared dead, its next start attempted
      // with no route yet.
      function renderRetryingSecrets(): RenderResult {
        listOwnComputerWithoutRoute();
        publishOwnLease(STARTING);
        useSettingsSectionStore.setState({ section: "secrets" });
        const view = render(modalElement());
        expect(screen.getByTestId("host-scope-connecting")).toBeTruthy();
        publishToModal(view, DEAD);
        expectCloudPage("secrets");
        publishToModal(view, STARTING);
        expectCloudPage("secrets");
        return view;
      }

      it("draws the Secrets page again on return, as its gate decided", () => {
        renderRetryingSecrets();

        open("Open MCP Servers");
        expectCloudPage("mcp-servers");
        open("Open Secrets");

        expectCloudPage("secrets");
        expect(screen.queryByTestId("host-scope-connecting")).toBeNull();
      });

      it("comes back to the computer's own answer when it has a route", async () => {
        const view = renderRetryingSecrets();
        connectWindowHost(() => environmentStatusFixture({}), WINDOW_HOST);
        const statusDelivered = queryReadSignal(
          queryClient,
          { method: "environment.status", hostId: WINDOW_HOST.hostId },
          true,
        );
        act(recordWindowStatusSupport);
        view.rerender(modalElement());
        await act(() => statusDelivered);
        expect(screen.getByText("Not on Window laptop")).toBeTruthy();

        open("Open MCP Servers");
        expectCloudPage("mcp-servers");
        open("Open Secrets");

        expect(screen.getByText("Not on Window laptop")).toBeTruthy();
      });
    });
  });
});

describe("A Local pick whose computer's row is missing while a host list has neither answered nor started loading", () => {
  it("waits with Connecting, never that the computer is unlisted", () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-old", hostName: "Old laptop" },
    });
    harness.listsResolved = false;

    renderSecrets();

    expect(screen.queryByTestId("page-not-on-computer-unlisted")).toBeNull();
    expect(screen.getByTestId("host-scope-connecting").textContent).toContain(
      "Connecting to Old laptop",
    );
  });
});

describe("A page under a pick while the host lists failed before supplying a row", () => {
  beforeEach(() => {
    harness.listsResolved = false;
    harness.listsFailed = true;
  });

  it("answers a Local pick with the list failure and its retry, never that the computer is unlisted", () => {
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-old", hostName: "Old laptop" },
    });

    renderSecrets();

    expect(screen.queryByTestId("page-not-on-computer-unlisted")).toBeNull();
    expect(screen.getByTestId("host-scope-lists-failed").textContent).toContain(
      "Couldn't load your hosts",
    );
    fireEvent.click(screen.getByTestId("host-scope-retry-lists"));
    expect(harness.retryLists).toHaveBeenCalledTimes(1);
  });

  it("answers Personal's Secrets, whose window host row is missing, with the list failure and its retry", () => {
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    harness.activeHostId = "host-win";

    renderSecrets();

    expect(screen.queryByTestId("draft")).toBeNull();
    expect(screen.getByTestId("host-scope-lists-failed")).toBeTruthy();
    fireEvent.click(screen.getByTestId("host-scope-retry-lists"));
    expect(harness.retryLists).toHaveBeenCalledTimes(1);
  });
});

describe("The away notice on a page an old computer lacks", () => {
  it("sits under the section's own heading", () => {
    pickOldHostLocal();
    listOldHost({ connectable: false });

    renderSecrets();

    expect(screen.getByTestId("host-scope-unreachable")).toBeTruthy();
    // The hidden page beneath keeps its own heading; one is in view.
    const shown = screen
      .getAllByRole("heading", { name: "Secrets", hidden: true })
      .filter((heading) => !isConcealed(heading));
    expect(shown).toHaveLength(1);
  });

  it("offers no way back to the active computer, and claims no status above it", () => {
    pickOldHostLocal();
    listOldHost({ connectable: false });

    renderSecrets();

    const notice = screen.getByTestId("host-scope-unreachable");
    expect(screen.queryByTestId("host-scope-return-to-active")).toBeNull();
    expect(notice.textContent).not.toContain(
      "Its status above is from your account, not a live link.",
    );
  });
});

describe("The update line on a page a picked computer lacks", () => {
  const updateLine = (name: string, label: string): string =>
    `Update ${name} to use ${label}.`;

  // The window's own computer, so the scope reaches it and no away notice
  // stands in for the page.
  function listActive(hostId: string, name: string): void {
    harness.activeHostId = hostId;
    harness.hosts = [
      hostScopeOptionFixture({
        hostId,
        name,
        isLocalMachine: false,
        isActive: true,
      }),
    ];
  }

  it("is absent where updating cannot give the page: a current computer without the secrets list", () => {
    recordNegotiatedHostManifest("host-new", {
      "environment.status": { major: 1, minor: 3 },
    });
    useSettingsEnvironmentPickStore.setState({
      pick: { kind: "local", hostId: "host-new", hostName: "New laptop" },
    });
    listActive("host-new", "New laptop");
    harness.updateApplies = true;

    renderSecrets();

    expect(screen.getByText("Not on New laptop")).toBeTruthy();
    expect(screen.queryByText(updateLine("New laptop", "Secrets"))).toBeNull();
    expect(
      within(screen.getByTestId("page-not-on-computer")).queryByRole("button"),
    ).toBeNull();
  });

  it("shows with Host Overview's action on an old computer's MCP servers when an update applies", () => {
    pickOldHostLocal();
    listActive("host-old", "Old laptop");
    harness.updateApplies = true;

    render(pageElement("mcp-servers"));

    expect(
      screen.getByText(updateLine("Old laptop", "MCP servers")),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Host Overview update" }),
    ).toBeTruthy();
  });

  it("is absent on an old computer's MCP servers when no update applies", () => {
    pickOldHostLocal();
    listActive("host-old", "Old laptop");
    harness.updateApplies = false;

    render(pageElement("mcp-servers"));

    expect(screen.getByText("Not on Old laptop")).toBeTruthy();
    expect(
      screen.queryByText(updateLine("Old laptop", "MCP servers")),
    ).toBeNull();
  });

  it("is absent on an old computer's Secrets, which no update gives", () => {
    pickOldHostLocal();
    listActive("host-old", "Old laptop");
    harness.updateApplies = true;

    renderSecrets();

    expect(screen.getByText("Not on Old laptop")).toBeTruthy();
    expect(screen.queryByText(updateLine("Old laptop", "Secrets"))).toBeNull();
  });
});

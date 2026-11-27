// A development computer advertises no `environment.secrets.*`: secrets live in
// the cloud. These tests stage the Environment pages the way the app does, with
// the REAL scope hooks, status derivation, pick store, `PersonalPageFrame`,
// host-list projection (`hostListItemToDirectoryEntry` ->
// `buildHostScopeOptions` -> `deriveHostHealth`) and panels. Only the host
// lists' inputs and the host clients are stood in.
vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
  trackSettingChanged: () => undefined,
}));
vi.mock(
  "@/components/settings/environment/use-hosts-running-configuration",
  () => ({
    useHostsRunningPersonal: () => ({
      hosts: [],
      state: "ready",
      collisions: [],
      retry: () => undefined,
    }),
  }),
);
vi.mock("@/hooks/chats/use-cloud-chat-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/chats/use-cloud-chat-queries")
  >()),
  useCloudChatViewerId: () => "user-me",
}));

// The Environment dropdown reads every computer's status itself, one read per
// computer, through the same named client and under the same query key as the
// Move pages' own read, so a G-addressed request could not be told from the
// page's. It is stood in as "no answers yet", leaving the page's read alone.
vi.mock(
  "@/hooks/environment/use-registered-host-environment-statuses",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/environment/use-registered-host-environment-statuses")
    >()),
    useRegisteredHostEnvironmentStatuses: () => new Map(),
  }),
);

import type { HostOptions } from "@/components/settings/host-scope/use-host-options";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostRpcRegistry } from "@/lib/host";
import type {
  EnvironmentStatusResponseV13,
  SetupScript,
} from "@traycer/protocol/host/environment-schemas";

// What the mocked host lists answer, and which stand-in client each computer
// gets. `options` is built once per change so every hook sees one list.
const world = vi.hoisted(() => ({
  registry: [] as HostListItem[],
  directory: [] as HostDirectoryEntry[],
  leases: [] as HostLeaseSnapshot[],
  activeHostId: null as string | null,
  /** The window's own computer; the active one when unset. */
  localHostId: null as string | null,
  clients: new Map<string, HostClient<HostRpcRegistry>>(),
  options: null as HostOptions | null,
}));

vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const { buildHostScopeOptions } =
    await import("@/components/settings/host-scope/host-scope-model");
  return {
    useHostOptions: (): HostOptions => {
      if (world.options === null) {
        const hosts = buildHostScopeOptions({
          directory: world.directory,
          registry: world.registry,
          localHostId: world.localHostId ?? world.activeHostId,
          activeHostId: world.activeHostId,
          localService: undefined,
          localPlatform: null,
          hasLiveSession: () => false,
          leases: world.leases,
          authorityAttached: true,
          localHostSettingUp: false,
          localHostTerminalRunNote: null,
          sandboxes: null,
          nowMs: Date.now(),
        });
        world.options = hostOptionsFixture({
          hosts,
          activeHostId: world.activeHostId,
        });
      }
      return world.options;
    },
  };
});

// The window's own computer answers through the ambient client; any other
// computer through the client the test gives it. A computer with no entry (an
// away one the scope declined to dial) gets none.
vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: (entry: HostDirectoryEntry | null) =>
    entry === null ? null : (world.clients.get(entry.hostId) ?? null),
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    // Beneath a scoped binding the page's own client; otherwise the window's.
    useHostClient: () => {
      const binding = actual.useHostBinding();
      const effectiveHostId = useSelectionAuthorityStore(
        (state) => state.effectiveHostId,
      );
      if (binding !== null && binding.hostId !== null) {
        return binding.hostClient;
      }
      // The app-wide client follows the selection layer's effective host, as
      // the real hook does; with none selected it is the window's own.
      return binding !== null && effectiveHostId !== null
        ? binding.hostClient.createRequesterForHostId(effectiveHostId)
        : requireTeamHostClient();
    },
  };
});

import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ComponentType, ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hostListItemToDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { RetryableTransportError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  hostIdsOf,
  mountTeamPage,
  requireTeamHostClient,
  resetTeamPageHarness,
  teamHostBoundary,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { buildConfigHostFixture } from "@/components/settings/panels/__tests__/host-config-rpc-test-support";
import { secretRowFixture } from "@/components/settings/secrets/__tests__/secret-row-test-support";
import { hostLeaseFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  useHostScopeFor,
  usePersonalHostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { SettingsPanelForSection } from "@/components/settings/settings-modal-content";
import { AGENT_MEMORIES } from "@/components/settings/panels/agent-memories.definitions";
import { SecretsSettingsPanel } from "@/components/settings/panels/secrets-settings-panel";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const WINDOW_HOST_ID = mockLocalHostEntry.hostId;
const AWAY_HOST_ID = "host-g";
const AWAY_HOST_NAME = "G name";
const PERSONAL_ENV = "env-personal";
const RELAY_BASE_URL = "wss://relay.example.test/attach";
const UPDATE_HOST_TEXT = "Update this host to use your secrets here.";
const AWAY_DETAIL = "No connection is available to this host.";
const SECONDS = 1000;

// Every method a development computer's pages read, and no
// `environment.secrets.*`.
const DEVELOPMENT_MANIFEST = Object.fromEntries(
  [
    "environment.status",
    "environment.list",
    "environment.localOverrides",
    "environment.review",
    "providers.list",
    "config.shell.get",
    "config.shell.set",
    "config.shell.listDetected",
    "config.shell.probe",
    "config.env.list",
    "config.env.set",
    "config.env.delete",
    "host.status",
  ].map((method) => [method, { major: 1, minor: 3 }]),
);

afterEach(() => {
  cleanup();
  resetTeamPageHarness();
  resetNegotiatedManifests();
  useSettingsEnvironmentPickStore.setState({
    pick: null,
    defaultPick: PERSONAL_PICK,
  });
  world.registry = [];
  world.directory = [];
  world.leases = [];
  world.activeHostId = null;
  world.localHostId = null;
  useSelectionAuthorityStore.getState().reset();
  world.clients.clear();
  world.options = null;
});

function listItem(
  hostId: string,
  connectivity: HostListItem["status"]["connectivity"],
): HostListItem {
  return {
    hostId,
    displayName: hostId === AWAY_HOST_ID ? AWAY_HOST_NAME : "window-box",
    platform: "Ubuntu",
    kind: "personal",
    publicKey: `pk-${hostId}`,
    createdAt: "2026-07-01T12:00:00.000Z",
    status: {
      connectivity,
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.4.2",
      // Recent enough that an `offline` verdict is still inside the relay
      // fuse grace: the entry stays dialable though the list shows Offline.
      lastSeenAt: new Date(Date.now() - 60 * SECONDS).toISOString(),
    },
    updatePolicy: "manual",
  };
}

/** The account's two computers: the window's own, and G in `connectivity`. */
function setHostLists(input: {
  readonly awayConnectivity: HostListItem["status"]["connectivity"];
  readonly leases: readonly HostLeaseSnapshot[];
}): void {
  const awayItem = listItem(AWAY_HOST_ID, input.awayConnectivity);
  world.registry = [listItem(WINDOW_HOST_ID, "connectable"), awayItem];
  world.directory = [
    mockLocalHostEntry,
    hostListItemToDirectoryEntry(awayItem, RELAY_BASE_URL),
  ];
  world.leases = [...input.leases];
  world.activeHostId = WINDOW_HOST_ID;
  world.options = null;
}

function recordManifests(): void {
  recordNegotiatedHostManifest(WINDOW_HOST_ID, DEVELOPMENT_MANIFEST);
  recordNegotiatedHostManifest(AWAY_HOST_ID, DEVELOPMENT_MANIFEST);
}

function transportFailure(method: string): RetryableTransportError {
  return new RetryableTransportError({
    replaySafetyFromKey: false,
    code: "RPC_ERROR",
    message: "The relay did not answer.",
    requestId: "req-away",
    method,
    fatalDetails: null,
  });
}

/** What a dead relay dial gives: every request fails before it is sent. */
const AWAY_HANDLERS: MockHandlerMap<HostRpcRegistry> = {
  "environment.status": () => {
    throw transportFailure("environment.status");
  },
  "providers.list": () => {
    throw transportFailure("providers.list");
  },
  "config.shell.get": () => {
    throw transportFailure("config.shell.get");
  },
  "config.env.list": () => {
    throw transportFailure("config.env.list");
  },
  "config.shell.listDetected": () => {
    throw transportFailure("config.shell.listDetected");
  },
  "environment.localOverrides": () => {
    throw transportFailure("environment.localOverrides");
  },
  "environment.review": () => {
    throw transportFailure("environment.review");
  },
};

function personalStatusHandler(
  broker: "moved" | "local",
): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.status": () =>
      environmentStatusFixture({
        principal: { kind: "personal" },
        planes: { records: broker, broker, room: broker },
        consent:
          broker === "moved" ? { acceptedAt: 1, planHash: "plan-1" } : null,
        setup: null,
      }),
    "environment.localOverrides": () => ({ overrides: [] }),
    "environment.review": () => ({
      shownAt: null,
      acknowledgedAt: null,
      evidence: { version: null, at: null },
      entries: [],
    }),
  };
}

/** G once a dial reaches it: valid, minimal answers to what the pages read. */
function reachableAwayClient(
  broker: "moved" | "local",
): HostClient<HostRpcRegistry> {
  return buildConfigHostFixture({
    hostId: AWAY_HOST_ID,
    isLocalMachine: false,
    overrideHandlers: {
      ...personalStatusHandler(broker),
      "providers.list": () => ({ providers: [], native: null }),
    },
  }).client;
}

function awayClient() {
  return buildEnvironmentClient({
    hostId: AWAY_HOST_ID,
    handlers: AWAY_HANDLERS,
  });
}

function localPick(): void {
  useSettingsEnvironmentPickStore.setState({
    pick: { kind: "local", hostId: AWAY_HOST_ID, hostName: AWAY_HOST_NAME },
  });
}

function mountWindowHost(
  handlers: MockHandlerMap<HostRpcRegistry>,
): TeamPageHarness {
  return mountTeamPage(
    { kind: "host" },
    { "environment.list": () => ({ environments: [] }), ...handlers },
  );
}

function pageTree(
  harness: TeamPageHarness,
  section: SettingsSectionId,
  Panel: ComponentType,
): ReactNode {
  return (
    <harness.Wrapper>
      <RunnerHostProvider runnerHost={harness.runnerHost}>
        <TooltipProvider>
          <PersonalPageFrame section={section}>
            <Panel />
          </PersonalPageFrame>
        </TooltipProvider>
      </RunnerHostProvider>
    </harness.Wrapper>
  );
}

interface EnvironmentPage {
  readonly name: string;
  readonly section: SettingsSectionId;
  readonly Panel: ComponentType;
  /** The page's own failure line, which an away computer must not show. */
  readonly ownFailure: string;
  readonly body: () => Promise<HTMLElement>;
}

const PAGES: readonly EnvironmentPage[] = [
  {
    name: "Secrets",
    section: "secrets",
    Panel: SecretsSettingsPanel,
    ownFailure: UPDATE_HOST_TEXT,
    body: () => screen.findByTestId("secrets-page"),
  },
  {
    name: "Providers",
    section: "providers",
    Panel: ProvidersSettingsPanel,
    ownFailure: "Connecting to the remote host…",
    body: () => screen.findByText("No providers reported by the host."),
  },
  {
    name: "Variables & shells",
    section: "shell",
    Panel: ShellSettingsPanel,
    ownFailure: "Couldn't read this host's shell settings.",
    body: () => screen.findByRole("button", { name: "Add a variable" }),
  },
];

/** Personal's directory entry, which names the environment a secrets call addresses. */
const PERSONAL_ENVIRONMENT = {
  environmentId: PERSONAL_ENV,
  ownerKind: "user" as const,
  ownerId: "user-me",
  roomId: "room-personal",
  label: "Personal",
  effectiveRole: "owner" as const,
  kind: "personal" as const,
  hostCount: 1,
  providerHandle: null,
};

/** Fills the Add a secret form with NEW_KEY and saves it. */
async function addSecret(add: HTMLElement): Promise<void> {
  fireEvent.click(add);
  fireEvent.click(await screen.findByTestId("secret-kind-option-api_key"));
  fireEvent.change(await screen.findByTestId("secret-form-name"), {
    target: { value: "NEW_KEY" },
  });
  fireEvent.change(screen.getByTestId("secret-form-hosts"), {
    target: { value: "api.example.com" },
  });
  fireEvent.change(screen.getByTestId("secret-form-value"), {
    target: { value: "sk-typed-value" },
  });
  fireEvent.click(screen.getByTestId("secret-form-continue"));
  fireEvent.click(await screen.findByTestId("secret-save"));
}

describe("Personal pick, window computer moved to Personal: Secrets lists and saves Personal's secrets", () => {
  it("shows the real page, not the update line, and reads and writes Personal's environment", async () => {
    world.activeHostId = WINDOW_HOST_ID;
    world.registry = [listItem(WINDOW_HOST_ID, "connectable")];
    world.directory = [mockLocalHostEntry];
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    recordManifests();
    const harness = mountWindowHost({
      ...personalStatusHandler("moved"),
      "environment.list": () => ({ environments: [PERSONAL_ENVIRONMENT] }),
      "environment.secrets.list": () => ({
        secrets: [secretRowFixture({})],
        removed: [],
      }),
      "environment.secrets.versions": () => ({
        versions: [],
        removal: null,
      }),
      "environment.secrets.rotation": () => ({
        rotation: null,
        lastVerify: null,
      }),
      "environment.secrets.create": () => ({
        outcome: "created" as const,
        secret: secretRowFixture({ secretId: "sec-2", name: "NEW_KEY" }),
      }),
    });
    render(pageTree(harness, "secrets", SecretsSettingsPanel));

    expect(await screen.findByTestId("secrets-page")).not.toBeNull();
    expect(screen.queryByText(UPDATE_HOST_TEXT)).toBeNull();
    const add = await screen.findByRole("button", { name: "Add a secret" });
    await waitFor(() => {
      expect(harness.paramsOf("environment.secrets.list")).toEqual([
        { environmentId: PERSONAL_ENV },
      ]);
    });

    await addSecret(add);

    await waitFor(() => {
      expect(harness.paramsOf("environment.secrets.create")).toHaveLength(1);
    });
    expect(harness.paramsOf("environment.secrets.create")).toEqual([
      expect.objectContaining({
        environmentId: PERSONAL_ENV,
        name: "NEW_KEY",
      }),
    ]);
  });
});

describe("Local pick of a computer the HOSTS list shows offline", () => {
  it.each(PAGES)(
    "$name shows the away notice, not its own failure, and its page once the computer is back",
    async (page) => {
      recordManifests();
      localPick();
      // G offline inside the relay fuse grace: still dialable, listed Offline.
      setHostLists({ awayConnectivity: "offline", leases: [] });
      const away = awayClient();
      world.clients.set(AWAY_HOST_ID, away.client);
      const harness = mountWindowHost(personalStatusHandler("moved"));
      const { rerender } = render(pageTree(harness, page.section, page.Panel));

      const notice = await screen.findByTestId("host-scope-unreachable");
      expect(
        within(notice).getByText(`Can't reach ${AWAY_HOST_NAME} from here`),
      ).not.toBeNull();
      expect(within(notice).getByText(AWAY_DETAIL)).not.toBeNull();
      expect(screen.queryByText(page.ownFailure)).toBeNull();
      // Nothing dialled the away computer to find that out.
      expect(away.messenger.calls).toEqual([]);

      // G returns. Secrets' status is Personal with its secrets already
      // moved, so the page reads Personal's environment in the cloud.
      setHostLists({ awayConnectivity: "connectable", leases: [] });
      world.clients.set(AWAY_HOST_ID, reachableAwayClient("moved"));
      rerender(pageTree(harness, page.section, page.Panel));

      expect(await page.body()).not.toBeNull();
      expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    },
  );

  it("Secrets on a Local pick whose secrets moved reads and saves Personal's environment, not the computer's", async () => {
    recordManifests();
    localPick();
    setHostLists({ awayConnectivity: "connectable", leases: [] });
    // G's own client and the cloud stand-in (the window harness) are
    // distinct: a secrets call that reached G's client would be a call to
    // the computer's own, unmoved, environment.
    const reachable = buildEnvironmentClient({
      hostId: AWAY_HOST_ID,
      handlers: personalStatusHandler("moved"),
    });
    world.clients.set(AWAY_HOST_ID, reachable.client);
    const harness = mountWindowHost({
      ...personalStatusHandler("moved"),
      "environment.list": () => ({ environments: [PERSONAL_ENVIRONMENT] }),
      "environment.secrets.list": () => ({
        secrets: [secretRowFixture({})],
        removed: [],
      }),
      "environment.secrets.versions": () => ({
        versions: [],
        removal: null,
      }),
      "environment.secrets.rotation": () => ({
        rotation: null,
        lastVerify: null,
      }),
      "environment.secrets.create": () => ({
        outcome: "created" as const,
        secret: secretRowFixture({ secretId: "sec-2", name: "NEW_KEY" }),
      }),
    });
    render(pageTree(harness, "secrets", SecretsSettingsPanel));

    const add = await screen.findByRole("button", { name: "Add a secret" });
    await waitFor(() => {
      expect(harness.paramsOf("environment.secrets.list")).toEqual([
        { environmentId: PERSONAL_ENV },
      ]);
    });

    await addSecret(add);

    await waitFor(() => {
      expect(harness.paramsOf("environment.secrets.create")).toHaveLength(1);
    });
    expect(harness.paramsOf("environment.secrets.create")).toEqual([
      expect.objectContaining({
        environmentId: PERSONAL_ENV,
        name: "NEW_KEY",
      }),
    ]);
    expect(
      reachable.messenger.calls.filter((call) =>
        call.method.startsWith("environment.secrets."),
      ),
    ).toEqual([]);
  });

  it("a ready lease from another surface reopens the page", async () => {
    recordManifests();
    localPick();
    // The registry still says offline-in-grace; a dial made elsewhere is up.
    setHostLists({
      awayConnectivity: "offline",
      leases: [hostLeaseFixture(AWAY_HOST_ID, null)],
    });
    world.clients.set(AWAY_HOST_ID, reachableAwayClient("moved"));
    const harness = mountWindowHost(personalStatusHandler("moved"));
    const shell = PAGES.find((page) => page.section === "shell");
    if (shell === undefined) throw new Error("no Variables & shells page");
    render(pageTree(harness, shell.section, shell.Panel));

    expect(await shell.body()).not.toBeNull();
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
  });

  it("a caller that does not read a listed-offline computer as away still dials it", () => {
    recordManifests();
    setHostLists({ awayConnectivity: "offline", leases: [] });
    world.clients.set(AWAY_HOST_ID, reachableAwayClient("moved"));
    const harness = mountWindowHost(personalStatusHandler("moved"));
    const { result } = renderHook(
      () =>
        useHostScopeFor({
          scopedHostId: AWAY_HOST_ID,
          setScopedHostId: () => undefined,
          defaultsToFirstHost: true,
          offlineReadsAway: false,
        }),
      {
        wrapper: (props) => (
          <harness.Wrapper>
            <RunnerHostProvider runnerHost={harness.runnerHost}>
              {props.children}
            </RunnerHostProvider>
          </harness.Wrapper>
        ),
      },
    );

    expect(result.current.hostId).toBe(AWAY_HOST_ID);
    expect(result.current.host?.health.state).toBe("offline");
    expect(result.current.status).toBe("ready");
    expect(result.current.client).not.toBeNull();
  });

  it("keeps the update line for a Local pick whose secrets have not moved", async () => {
    recordManifests();
    localPick();
    setHostLists({ awayConnectivity: "connectable", leases: [] });
    const reachable = buildEnvironmentClient({
      hostId: AWAY_HOST_ID,
      handlers: personalStatusHandler("local"),
    });
    world.clients.set(AWAY_HOST_ID, reachable.client);
    const harness = mountWindowHost(personalStatusHandler("moved"));
    render(pageTree(harness, "secrets", SecretsSettingsPanel));

    await waitFor(() => {
      expect(
        reachable.messenger.calls.some(
          (call) => call.method === "environment.status",
        ),
      ).toBe(true);
    });
    expect((await screen.findByTestId("secrets-update-host")).textContent).toBe(
      UPDATE_HOST_TEXT,
    );
    expect(screen.queryByTestId("secrets-page")).toBeNull();
    expect(harness.paramsOf("environment.secrets.list")).toEqual([]);
    expect(
      reachable.messenger.calls.some(
        (call) => call.method === "environment.secrets.list",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pages mounted the way Settings mounts them (`SettingsPanelForSection`), for
// the regions that read a host beneath the Local pick's binding.
// ---------------------------------------------------------------------------

const REGION_MANIFEST = {
  ...DEVELOPMENT_MANIFEST,
  ...Object.fromEntries(
    [
      "environment.agentDefinitions.list",
      "environment.agentDefinitions.put",
      "environment.agentDefinitions.delete",
      "config.browser.get",
      "config.browser.set",
      "config.agentMemories.get",
      "config.agentMemories.set",
      "environment.setup.get",
      "environment.setup.put",
      "environment.setup.attempts",
      "environment.setup.retry",
    ].map((method) => [method, { major: 1, minor: 3 }]),
  ),
};

function recordRegionManifests(): void {
  recordNegotiatedHostManifest(WINDOW_HOST_ID, REGION_MANIFEST);
  recordNegotiatedHostManifest(AWAY_HOST_ID, REGION_MANIFEST);
}

function settingsPage(
  harness: TeamPageHarness,
  section: SettingsSectionId,
): ReactNode {
  return (
    <harness.Wrapper>
      <RunnerHostProvider runnerHost={harness.runnerHost}>
        <TooltipProvider>
          <SettingsPanelForSection section={section} />
        </TooltipProvider>
      </RunnerHostProvider>
    </harness.Wrapper>
  );
}

/** The requests a client's messenger recorded for methods starting `prefix`. */
function sentTo(
  messenger: { readonly calls: ReadonlyArray<{ readonly method: string }> },
  prefix: string,
): string[] {
  return messenger.calls
    .map((call) => call.method)
    .filter((method) => method.startsWith(prefix));
}

function expectAwayNotice(): void {
  const notice = screen.getByTestId("host-scope-unreachable");
  expect(
    within(notice).getByText(`Can't reach ${AWAY_HOST_NAME} from here`),
  ).not.toBeNull();
  expect(within(notice).getByText(AWAY_DETAIL)).not.toBeNull();
}

/**
 * Names G in the harness's host directory, so a request the page addresses to
 * G through the named client (`resolveNamedHostClient`, what
 * `useHostClientForHostId(G)` returns) reaches the harness messenger, which
 * records the host each request names. Without a row the named client for G
 * routes nowhere.
 */
function nameAwayHostInHarnessDirectory(): void {
  const directory = teamHostBoundary.directory;
  const entry = world.directory.find(
    (candidate) => candidate.hostId === AWAY_HOST_ID,
  );
  if (directory === null || entry === undefined) {
    throw new Error("mount the window harness and set the host lists first");
  }
  const findInHarness = directory.findById.bind(directory);
  vi.spyOn(directory, "findById").mockImplementation((hostId) =>
    hostId === AWAY_HOST_ID ? entry : findInHarness(hostId),
  );
}

/** What the real scope reports for the picked computer, for a test to await. */
function ScopeStatusProbe(): ReactNode {
  return (
    <span data-testid="scope-status">{usePersonalHostScope().status}</span>
  );
}

/** `settingsPage` beside a probe of the scope the page itself reads. */
function probedSettingsPage(
  harness: TeamPageHarness,
  section: SettingsSectionId,
): ReactNode {
  return (
    <harness.Wrapper>
      <RunnerHostProvider runnerHost={harness.runnerHost}>
        <TooltipProvider>
          <ScopeStatusProbe />
          <SettingsPanelForSection section={section} />
        </TooltipProvider>
      </RunnerHostProvider>
    </harness.Wrapper>
  );
}

/** A computer that has not moved: the Move offer is what its page shows. */
const NOT_MOVED_STATUS = environmentStatusFixture({
  principal: null,
  planes: { records: "local", broker: "local", room: "local" },
  consent: null,
  setup: null,
});

/**
 * G's cached answer when the person last looked: a move under way, or one that
 * stopped. `setup.stage`/`state` decide it (`hostSettingsCardState`).
 */
const MOVE_IN_PROGRESS_CASES: ReadonlyArray<{
  readonly name: string;
  readonly line: string;
  readonly testId: string;
  readonly status: EnvironmentStatusResponseV13;
  /** Longer than the status read's poll lane for this state. */
  readonly pollWaitMs: number;
}> = [
  {
    name: "A move running",
    line: "the move's progress",
    testId: "host-settings-card-progress",
    status: environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
      consent: null,
      setup: { stage: "moving_settings", state: "running" },
    }),
    pollWaitMs: 3000,
  },
  {
    name: "A move stopped",
    line: "the stopped move",
    testId: "host-settings-card-move-stopped",
    status: environmentStatusFixture({
      principal: null,
      planes: { records: "local", broker: "local", room: "local" },
      consent: null,
      setup: { stage: "moving_settings", state: "stalled" },
    }),
    pollWaitMs: 6500,
  },
];

const MOVE_PAGES: ReadonlyArray<{
  readonly name: string;
  readonly section: SettingsSectionId;
}> = [
  { name: "MCP servers", section: "mcp-servers" },
  { name: "Skills", section: "skills" },
  { name: "Sandboxes", section: "sandboxes" },
  { name: "Storage", section: "storage" },
];

describe("Local pick of a computer listed offline: the Move offer pages", () => {
  it.each(MOVE_PAGES)(
    "$name shows the away notice and no Move offer, dials nothing, and offers the move once the computer is back",
    async (page) => {
      recordRegionManifests();
      localPick();
      setHostLists({ awayConnectivity: "offline", leases: [] });
      const away = awayClient();
      world.clients.set(AWAY_HOST_ID, away.client);
      const harness = mountWindowHost({
        "environment.status": () => NOT_MOVED_STATUS,
      });
      nameAwayHostInHarnessDirectory();
      const { rerender } = render(settingsPage(harness, page.section));

      await screen.findByTestId("host-scope-unreachable");
      expectAwayNotice();
      expect(screen.queryByTestId("local-move-page-move")).toBeNull();
      expect(screen.queryByTestId("local-move-page")).toBeNull();
      // The status read the page would send to G through the named client
      // never went out.
      expect(hostIdsOf(harness, "environment.status")).not.toContain(
        AWAY_HOST_ID,
      );

      // G returns and answers its status: not moved.
      setHostLists({ awayConnectivity: "connectable", leases: [] });
      world.clients.set(
        AWAY_HOST_ID,
        buildEnvironmentClient({
          hostId: AWAY_HOST_ID,
          handlers: { "environment.status": () => NOT_MOVED_STATUS },
        }).client,
      );
      rerender(settingsPage(harness, page.section));

      expect(await screen.findByTestId("local-move-page-move")).not.toBeNull();
      expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
      await waitFor(() => {
        expect(hostIdsOf(harness, "environment.status")).toContain(
          AWAY_HOST_ID,
        );
      });
    },
  );

  it.each(MOVE_IN_PROGRESS_CASES)(
    "$name: Skills keeps showing $line when the computer goes away, and sends it no further request",
    async (move) => {
      recordRegionManifests();
      localPick();
      setHostLists({ awayConnectivity: "connectable", leases: [] });
      world.clients.set(
        AWAY_HOST_ID,
        buildEnvironmentClient({
          hostId: AWAY_HOST_ID,
          handlers: { "environment.status": () => move.status },
        }).client,
      );
      const harness = mountWindowHost({
        "environment.status": () => move.status,
      });
      nameAwayHostInHarnessDirectory();
      const { rerender } = render(probedSettingsPage(harness, "skills"));

      const line = await screen.findByTestId(move.testId);
      expect(screen.queryByTestId("local-move-page-move")).toBeNull();
      // G's status is being polled while it is reachable.
      await waitFor(
        () => {
          expect(
            hostIdsOf(harness, "environment.status").filter(
              (hostId) => hostId === AWAY_HOST_ID,
            ).length,
          ).toBeGreaterThanOrEqual(2);
        },
        { timeout: move.pollWaitMs },
      );

      // G drops off the HOSTS list, inside the relay grace.
      setHostLists({ awayConnectivity: "offline", leases: [] });
      world.clients.set(AWAY_HOST_ID, awayClient().client);
      rerender(probedSettingsPage(harness, "skills"));
      await waitFor(() => {
        expect(screen.getByTestId("scope-status").textContent).toBe(
          "unreachable",
        );
      });
      const sentAtFlip = hostIdsOf(harness, "environment.status").filter(
        (hostId) => hostId === AWAY_HOST_ID,
      ).length;

      // The cached answer stays; the away notice does not replace it.
      expect(screen.getByTestId(move.testId)).not.toBeNull();
      expect(screen.getByTestId(move.testId).textContent).toBe(
        line.textContent,
      );
      expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
      // Longer than the status read's poll lane: a read still enabled would
      // have fired by now.
      await new Promise((resolve) => setTimeout(resolve, move.pollWaitMs));
      expect(
        hostIdsOf(harness, "environment.status").filter(
          (hostId) => hostId === AWAY_HOST_ID,
        ).length,
      ).toBe(sentAtFlip);
      expect(screen.getByTestId(move.testId)).not.toBeNull();
      expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    },
    30_000,
  );
});

/** The window's own computer is the active host, and G is the picked one. */
function setActiveAwayHostLists(input: {
  readonly awayConnectivity: HostListItem["status"]["connectivity"];
  readonly leases: readonly HostLeaseSnapshot[];
}): void {
  setHostLists(input);
  world.localHostId = WINDOW_HOST_ID;
  world.activeHostId = AWAY_HOST_ID;
  world.options = null;
  // The ambient requester follows the effective host, which is G itself.
  useSelectionAuthorityStore.setState({ effectiveHostId: AWAY_HOST_ID });
}

const DEFINITION = { name: "reviewer", text: "Review the diff.", revision: 3 };

describe("Local pick naming the window's active computer, listed offline: regions that read the ambient host", () => {
  it("Agents ▸ Definitions shows the away notice, sends nothing to that computer, and renders once the computer is back", async () => {
    recordRegionManifests();
    localPick();
    setActiveAwayHostLists({ awayConnectivity: "offline", leases: [] });
    const harness = mountWindowHost({
      "environment.agentDefinitions.list": () => ({
        definitions: [DEFINITION],
      }),
    });
    nameAwayHostInHarnessDirectory();
    const { rerender } = render(settingsPage(harness, "agents"));

    await userEvent.click(await screen.findByTestId("agents-tab-definitions"));
    const panel = await screen.findByRole("tabpanel");
    await within(panel).findByTestId("host-scope-unreachable");
    expect(within(panel).queryByTestId("agent-definitions")).toBeNull();
    expect(within(panel).queryByText("No agent definitions yet.")).toBeNull();
    expect(hostIdsOf(harness, "environment.agentDefinitions.list")).toEqual([]);

    setActiveAwayHostLists({ awayConnectivity: "connectable", leases: [] });
    rerender(settingsPage(harness, "agents"));

    expect(await screen.findByTestId("agent-definitions")).not.toBeNull();
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    await waitFor(() => {
      expect(hostIdsOf(harness, "environment.agentDefinitions.list")).toContain(
        AWAY_HOST_ID,
      );
    });
  });

  it("Permissions ▸ Browser shows the away notice, sends nothing to that computer, and renders once the computer is back", async () => {
    recordRegionManifests();
    localPick();
    setActiveAwayHostLists({ awayConnectivity: "offline", leases: [] });
    const harness = mountWindowHost({
      "config.browser.get": () => ({ agentAccess: true }),
      "config.browser.set": (request) => ({
        agentAccess: request.agentAccess,
      }),
    });
    nameAwayHostInHarnessDirectory();
    const { rerender } = render(settingsPage(harness, "permissions"));

    await userEvent.click(await screen.findByTestId("permissions-tab-browser"));
    const panel = await screen.findByRole("tabpanel");
    await within(panel).findByTestId("host-scope-unreachable");
    expect(
      within(panel).queryByTestId("settings-browser-agent-access"),
    ).toBeNull();
    expect(hostIdsOf(harness, "config.browser.get")).toEqual([]);

    setActiveAwayHostLists({ awayConnectivity: "connectable", leases: [] });
    rerender(settingsPage(harness, "permissions"));

    expect(
      await screen.findByTestId("settings-browser-agent-access"),
    ).not.toBeNull();
    expect(screen.queryByTestId("host-scope-unreachable")).toBeNull();
    await waitFor(() => {
      expect(hostIdsOf(harness, "config.browser.get")).toContain(AWAY_HOST_ID);
    });
  });
});

const MEMORIES_SWITCH = AGENT_MEMORIES.definitions.traycerMemories.label;

function memoriesHandlers(
  environmentId: string,
): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.status": () => environmentStatusFixture({}),
    "config.agentMemories.get": () => ({
      enabled: false,
      revision: 5,
      environmentId,
    }),
    "config.agentMemories.set": (request) => ({
      enabled: request.enabled,
      state: "saved" as const,
      revision: 6,
      environmentId,
      uploadId: null,
    }),
  };
}

describe("Local pick of a computer that is not the window's: Memories", () => {
  it("reads and writes the picked computer, not the window's", async () => {
    recordRegionManifests();
    localPick();
    setHostLists({ awayConnectivity: "connectable", leases: [] });
    const picked = buildEnvironmentClient({
      hostId: AWAY_HOST_ID,
      handlers: memoriesHandlers("env-g"),
    });
    world.clients.set(AWAY_HOST_ID, picked.client);
    const harness = mountWindowHost(memoriesHandlers("env-window"));
    render(settingsPage(harness, "agent-memories"));

    const toggle = await screen.findByRole("switch", { name: MEMORIES_SWITCH });
    await waitFor(() => {
      expect(sentTo(picked.messenger, "config.agentMemories.get")).not.toEqual(
        [],
      );
    });
    expect(sentTo(harness.messenger, "config.agentMemories")).toEqual([]);

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(sentTo(picked.messenger, "config.agentMemories.set")).toEqual([
        "config.agentMemories.set",
      ]);
    });
    expect(sentTo(harness.messenger, "config.agentMemories")).toEqual([]);
  });

  it("shows the away notice, and sends neither computer a memories request, when the picked one is listed offline", async () => {
    recordRegionManifests();
    localPick();
    setHostLists({ awayConnectivity: "offline", leases: [] });
    const away = awayClient();
    world.clients.set(AWAY_HOST_ID, away.client);
    const harness = mountWindowHost(memoriesHandlers("env-window"));
    render(settingsPage(harness, "agent-memories"));

    await screen.findByTestId("host-scope-unreachable");
    expectAwayNotice();
    expect(screen.queryByRole("switch", { name: MEMORIES_SWITCH })).toBeNull();
    expect(sentTo(away.messenger, "config.agentMemories")).toEqual([]);
    expect(sentTo(harness.messenger, "config.agentMemories")).toEqual([]);
  });
});

const MAC_SCRIPT: SetupScript = {
  os: "macos",
  text: "brew bundle",
  revision: 4,
};

function setupHandlers(): MockHandlerMap<HostRpcRegistry> {
  return {
    "environment.status": () => environmentStatusFixture({}),
    "environment.setup.get": () => ({ scripts: [MAC_SCRIPT] }),
    "environment.setup.attempts": () => ({ attempts: [] }),
    "environment.setup.put": () => ({
      outcome: "saved" as const,
      revision: 5,
    }),
  };
}

describe("Local pick of a computer that is not the window's: Machine setup", () => {
  it("reads and saves the picked computer's setup script, not the window's", async () => {
    recordRegionManifests();
    localPick();
    setHostLists({ awayConnectivity: "connectable", leases: [] });
    const picked = buildEnvironmentClient({
      hostId: AWAY_HOST_ID,
      handlers: setupHandlers(),
    });
    world.clients.set(AWAY_HOST_ID, picked.client);
    const harness = mountWindowHost(setupHandlers());
    render(settingsPage(harness, "machine-setup"));

    const field = await screen.findByRole("textbox", {
      name: "macOS setup script",
    });
    await waitFor(() => {
      expect(sentTo(picked.messenger, "environment.setup.get")).not.toEqual([]);
      expect(
        sentTo(picked.messenger, "environment.setup.attempts"),
      ).not.toEqual([]);
    });
    expect(sentTo(harness.messenger, "environment.setup")).toEqual([]);

    fireEvent.change(field, { target: { value: "brew bundle --global" } });
    fireEvent.click(
      within(screen.getByTestId("setup-scripts")).getByRole("button", {
        name: "Save",
      }),
    );

    await waitFor(() => {
      expect(sentTo(picked.messenger, "environment.setup.put")).toEqual([
        "environment.setup.put",
      ]);
    });
    expect(sentTo(harness.messenger, "environment.setup")).toEqual([]);
  });

  it("shows the away notice, and sends neither computer a setup request, when the picked one is listed offline", async () => {
    recordRegionManifests();
    localPick();
    setHostLists({ awayConnectivity: "offline", leases: [] });
    const away = awayClient();
    world.clients.set(AWAY_HOST_ID, away.client);
    const harness = mountWindowHost(setupHandlers());
    render(settingsPage(harness, "machine-setup"));

    await screen.findByTestId("host-scope-unreachable");
    expectAwayNotice();
    expect(screen.queryByTestId("setup-scripts")).toBeNull();
    expect(sentTo(away.messenger, "environment.setup")).toEqual([]);
    expect(sentTo(harness.messenger, "environment.setup")).toEqual([]);
  });
});

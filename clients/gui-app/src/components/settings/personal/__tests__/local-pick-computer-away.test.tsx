// A development computer advertises no `environment.secrets.*`: secrets live in
// the cloud. These tests stage the Environment pages the way the app does, with
// the REAL scope hooks, status derivation, pick store, `PersonalPageFrame`,
// host-list projection (`hostListItemToDirectoryEntry` ->
// `buildHostScopeOptions` -> `deriveHostHealth`) and panels. Only the host
// lists' inputs and the host clients are stood in.
vi.mock("@/lib/analytics", () => ({
  Analytics: { getInstance: () => ({ track: () => undefined }) },
  AnalyticsEvent: { HostSelected: "HostSelected" },
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

import type { HostOptions } from "@/components/settings/host-scope/use-host-options";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostLeaseSnapshot } from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostRpcRegistry } from "@/lib/host";

// What the mocked host lists answer, and which stand-in client each computer
// gets. `options` is built once per change so every hook sees one list.
const world = vi.hoisted(() => ({
  registry: [] as HostListItem[],
  directory: [] as HostDirectoryEntry[],
  leases: [] as HostLeaseSnapshot[],
  activeHostId: null as string | null,
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
          localHostId: world.activeHostId,
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
      return binding !== null && binding.hostId !== null
        ? binding.hostClient
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
  mountTeamPage,
  requireTeamHostClient,
  resetTeamPageHarness,
  type TeamPageHarness,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import { buildConfigHostFixture } from "@/components/settings/panels/__tests__/host-config-rpc-test-support";
import { secretRowFixture } from "@/components/settings/secrets/__tests__/secret-row-test-support";
import { hostLeaseFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { useHostScopeFor } from "@/components/settings/host-scope/use-host-scope";
import { PersonalPageFrame } from "@/components/settings/personal/personal-page-frame";
import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
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

describe("Personal pick, window computer moved to Personal: Secrets lists and saves Personal's secrets", () => {
  it("shows the real page, not the update line, and reads and writes Personal's environment", async () => {
    world.activeHostId = WINDOW_HOST_ID;
    world.registry = [listItem(WINDOW_HOST_ID, "connectable")];
    world.directory = [mockLocalHostEntry];
    useSettingsEnvironmentPickStore.setState({ pick: PERSONAL_PICK });
    recordManifests();
    const harness = mountWindowHost({
      ...personalStatusHandler("moved"),
      "environment.list": () => ({
        environments: [
          {
            environmentId: PERSONAL_ENV,
            ownerKind: "user" as const,
            ownerId: "user-me",
            roomId: "room-personal",
            label: "Personal",
            effectiveRole: "owner" as const,
            kind: "personal" as const,
            hostCount: 1,
            providerHandle: null,
          },
        ],
      }),
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

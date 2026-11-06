// Same boundaries as `host-overview-tabs.test.tsx`: the scoped stream binding,
// `useHostScope` and `@/lib/host`'s `useHostBinding` are mocked so the page
// renders without a host runtime, and everything below the page is real.
vi.mock("@/components/settings/host-scope/use-scoped-stream-binding", () => ({
  useScopedStreamBinding: () => null,
}));

const scopeOverrides = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

interface HostBindingMock {
  readonly hostClient: unknown;
  readonly directory: {
    readonly getLocalEntry: () => { readonly hostId: string } | null;
    readonly list: () => Promise<readonly []>;
    readonly onChange: (listener: () => void) => {
      readonly dispose: () => void;
    };
  };
}
const hostBindingMock = vi.hoisted((): { current: HostBindingMock | null } => ({
  current: null,
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  },
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HostInstallRecord } from "@traycer/protocol/config/installation-records";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { HostGetInstallationInfoResponseV11 } from "@traycer/protocol/host/maintenance/index";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  CliInstallManifestSnapshot,
  IHostManagement,
} from "@traycer-clients/shared/platform/runner-host";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { HostSettingsPanel } from "@/components/settings/panels/host-settings-panel";
import { formatSettingsDate } from "@/lib/settings/settings-date";
import {
  buildOverviewHostFixture,
  buildOverviewManagement,
  selectHostOverviewTab,
  type OverviewHostFixture,
} from "@/components/settings/panels/__tests__/host-overview-test-support";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  armSettingsOpenIntent,
  resetSettingsOpenIntentForTests,
} from "@/stores/tabs/settings-open-intent-store";

const OVERVIEW_METHODS = [
  "host.status",
  "host.identity.get",
  "host.identity.set",
  "host.getInstallationInfo",
  "host.restart",
  "host.doctor",
  "host.update.check",
  "host.update.install",
  "diagnostics.logs.tail",
] as const;

const SERVICE_METHODS = [
  "host.service.status",
  "host.service.register",
  "host.service.deregister",
] as const;

const HOST_ID = "8f14e45fceea167a5a36dedd4bea2543c9a2";
const HOST_NAME = "Build Box";
const NOW_MS = Date.parse("2026-09-24T12:00:00Z");
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

const UPGRADE_COMMAND = "brew upgrade traycer";

function registryItem(overrides: Partial<HostListItem>): HostListItem {
  return {
    hostId: HOST_ID,
    displayName: null,
    platform: "darwin-arm64",
    kind: "personal",
    publicKey: "pk",
    createdAt: "2026-03-03T12:00:00Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: "1.5.0",
      lastSeenAt: null,
    },
    updatePolicy: "manual",
    ...overrides,
  };
}

function healthLive(live: boolean): HostScopeOption["health"] {
  return { ...hostScopeOptionFixture({ hostId: HOST_ID }).health, live };
}

function cliManifest(
  withUpgrade: boolean,
): Promise<CliInstallManifestSnapshot> {
  return Promise.resolve({
    version: "1.4.0",
    installedAt: "2026-09-01T00:00:00Z",
    binaryPath: "/opt/homebrew/bin/traycer",
    source: "homebrew",
    pendingUpgrade: null,
    packageManagerUpgrade: withUpgrade
      ? {
          source: "homebrew",
          installedVersion: "1.3.0",
          bundledVersion: "1.4.0",
          upgradeCommand: UPGRADE_COMMAND,
          recordedAt: "2026-09-20T00:00:00Z",
        }
      : null,
  });
}

function installRecord(
  version: string,
  runtimeVersion: string | null,
): HostInstallRecord {
  return {
    installId: "install-1",
    version,
    runtimeVersion,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-08-10T00:00:00Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-08-10T00:00:00Z",
    signatureKeyId: "key-1",
    sizeBytes: 1024,
    executablePath: `/tmp/traycer/${version}/host`,
    executableSha256: "b".repeat(64),
  };
}

function managed(
  record: HostInstallRecord,
): HostGetInstallationInfoResponseV11 {
  return {
    status: "managed",
    installRecord: record,
    stagedRecord: null,
    cliManifest: null,
  };
}

interface Mounted {
  readonly queryClient: QueryClient;
}

/** Mounts the page against whatever `scopeOverrides` / `hostBindingMock` say. */
function mount(management: IHostManagement | null): Mounted {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
    ...(management === null ? {} : { hostManagement: management }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return { queryClient };
}

function bindingWith(fixture: OverviewHostFixture): HostBindingMock {
  return {
    hostClient: fixture.client,
    directory: {
      getLocalEntry: () => null,
      list: () => Promise.resolve([]),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

interface ReadyOptions {
  readonly isLocalMachine: boolean;
  readonly item: HostListItem | null;
  readonly live: boolean;
  readonly fixture: OverviewHostFixture;
  readonly methods: readonly string[];
}

/** A reachable host: a ready scope over a real in-memory client. */
function setReadyScope(options: ReadyOptions): void {
  recordNegotiatedHostMethods(HOST_ID, options.methods);
  hostBindingMock.current = bindingWith(options.fixture);
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: HOST_ID,
      name: HOST_NAME,
      isLocalMachine: options.isLocalMachine,
      registered: true,
      connectable: true,
      isActive: true,
      item: options.item,
      health: healthLive(options.live),
    }),
    hostId: HOST_ID,
    status: "ready",
    client: options.fixture.client,
    nowMs: NOW_MS,
  };
}

/** A host with no route: unreachable or connecting, and no client. */
function setRoutelessScope(options: {
  readonly status: "unreachable" | "connecting";
  readonly isLocalMachine: boolean;
  readonly item: HostListItem | null;
}): void {
  hostBindingMock.current = null;
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId: HOST_ID,
      name: HOST_NAME,
      isLocalMachine: options.isLocalMachine,
      registered: true,
      connectable: false,
      item: options.item,
      health: healthLive(false),
    }),
    hostId: HOST_ID,
    status: options.status,
    client: null,
    nowMs: NOW_MS,
  };
}

function fixtureFor(
  isLocalMachine: boolean,
  overrides: Parameters<typeof buildOverviewHostFixture>[0]["overrideHandlers"],
  installation: HostGetInstallationInfoResponseV11 | undefined,
): OverviewHostFixture {
  return buildOverviewHostFixture({
    hostId: HOST_ID,
    isLocalMachine,
    effectiveName: HOST_NAME,
    installation,
    overrideHandlers: overrides,
  });
}

/**
 * A clipboard whose writes the test can read. jsdom has none, and the copy
 * buttons write through `navigator.clipboard.writeText`.
 */
function stubClipboard(): ClipboardWriteMock {
  const writeText = vi.fn((_value: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

type ClipboardWriteMock = Mock<(value: string) => Promise<void>>;

function installationPane(): HTMLElement {
  return screen.getByTestId("host-overview-tab-panel-installation");
}

function installationDetails(): HTMLDetailsElement {
  const details = within(installationPane()).getByTestId(
    "host-overview-installation-details",
  );
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("expected the Installation details disclosure");
  }
  return details;
}

/** Closed `<details>` content stays in the DOM, but a role query skips it. */
function openInstallationDetails(): HTMLDetailsElement {
  const details = installationDetails();
  details.open = true;
  return details;
}

const initialInnerWidth = window.innerWidth;
const initialClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

afterEach(() => {
  cleanup();
  if (initialClipboard === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", initialClipboard);
  }
  resetNegotiatedManifests();
  resetSettingsOpenIntentForTests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
  window.innerWidth = initialInnerWidth;
});

describe("Overview ▸ Installation — About this host", () => {
  it("shows only the account date and the unseen line, and copies the full host id from Details", async () => {
    const item = registryItem({});
    setReadyScope({
      isLocalMachine: false,
      item,
      live: true,
      fixture: fixtureFor(false, undefined, undefined),
      methods: [...OVERVIEW_METHODS, ...SERVICE_METHODS],
    });
    mount(null);
    await selectHostOverviewTab("installation");

    const about = within(installationPane()).getByTestId("host-overview-about");
    const added = formatSettingsDate(Date.parse(item.createdAt), false);
    expect(
      within(about).getByTestId("host-overview-about-added").textContent,
    ).toBe(added);
    expect(
      within(about).getByTestId("host-overview-about-last-seen").textContent,
    ).toBe("Not seen since it was added");
    expect(
      within(about).queryByTestId("host-overview-about-host-id"),
    ).toBeNull();
    expect(
      within(about).queryByTestId("host-overview-about-version"),
    ).toBeNull();
    expect(
      within(about).queryByTestId("host-overview-about-platform"),
    ).toBeNull();

    const details = openInstallationDetails();
    const hostId = within(details).getByTestId("host-overview-about-host-id");
    expect(hostId.textContent).toBe("8f14e45f…c9a2");
    const writeText = stubClipboard();
    fireEvent.click(
      within(details).getByRole("button", { name: "Copy host ID" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(HOST_ID);
    });
  });

  it("shows one build version line when the running version and the registry version agree", async () => {
    setReadyScope({
      isLocalMachine: false,
      item: registryItem({}),
      live: true,
      fixture: fixtureFor(
        false,
        undefined,
        managed(installRecord("1.5.0", "1.5.0")),
      ),
      methods: [...OVERVIEW_METHODS, ...SERVICE_METHODS],
    });
    mount(null);
    await selectHostOverviewTab("installation");

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-about-platform").textContent,
      ).toBe("macOS · from this host now");
      expect(
        screen.getByTestId("settings-host-install-version").textContent,
      ).toBe("v1.5.0 · from this host now");
      expect(screen.queryByTestId("host-overview-about-version")).toBeNull();
    });
    expect(
      screen.getByTestId("host-overview-about-architecture").textContent,
    ).toBe("arm64 · from this host now");
    expect(
      within(screen.getByTestId("host-overview-install-record")).queryByTestId(
        "settings-host-install-version",
      ),
    ).toBeNull();
  });

  it("shows the running version and the registry version when they differ", async () => {
    setReadyScope({
      isLocalMachine: false,
      item: registryItem({
        status: {
          ...registryItem({}).status,
          appVersion: "1.4.2",
          lastSeenAt: new Date(NOW_MS - THREE_HOURS_MS).toISOString(),
        },
      }),
      live: true,
      fixture: fixtureFor(
        false,
        undefined,
        managed(installRecord("1.5.0", "1.5.0")),
      ),
      methods: [...OVERVIEW_METHODS, ...SERVICE_METHODS],
    });
    mount(null);
    await selectHostOverviewTab("installation");

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-about-platform").textContent,
      ).toBe("macOS · from this host now");
      expect(
        screen.getByTestId("settings-host-install-version").textContent,
      ).toBe("v1.5.0 · from this host now");
    });
    const reported = screen.getByTestId("host-overview-about-version");
    expect(reported.textContent).toBe("v1.4.2 · last account report, 3h ago");
    expect(reported.closest("dd")?.previousElementSibling?.textContent).toBe(
      "Last reported version",
    );
    expect(screen.queryByTestId("settings-host-install-build")).toBeNull();
  });

  it("reveals the full host ID to a keyboard: focusing its copy button opens the tooltip", async () => {
    setReadyScope({
      isLocalMachine: false,
      item: registryItem({}),
      live: true,
      fixture: fixtureFor(false, undefined, undefined),
      methods: [...OVERVIEW_METHODS, ...SERVICE_METHODS],
    });
    mount(null);
    await selectHostOverviewTab("installation");

    const details = openInstallationDetails();
    expect(screen.queryByRole("tooltip")).toBeNull();
    // The copy button is the row's one focusable stop; focus alone, no
    // pointer, has to be enough to read the value the row shows shortened.
    fireEvent.focus(
      within(details).getByRole("button", { name: "Copy host ID" }),
    );

    expect((await screen.findByRole("tooltip")).textContent).toBe(HOST_ID);
  });

  it("shows offline last-seen time only in the header, not About or the notice", async () => {
    setRoutelessScope({
      status: "unreachable",
      isLocalMachine: false,
      item: registryItem({
        status: {
          ...registryItem({}).status,
          lastSeenAt: new Date(NOW_MS - THREE_HOURS_MS).toISOString(),
        },
      }),
    });
    const host = scopeOverrides.current.host;
    if (typeof host !== "object" || host === null) {
      throw new Error("expected the selected host fixture");
    }
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: {
        ...host,
        health: {
          state: "offline",
          label: "Offline",
          detail: "last seen 3h ago",
          tone: "idle",
          live: false,
        },
      },
    };
    mount(null);
    await selectHostOverviewTab("installation");

    expect(screen.getByTestId("host-identity-health").textContent).toBe(
      "Offline",
    );
    expect(screen.getAllByText(/last seen/i)).toHaveLength(1);
    const about = within(installationPane()).getByTestId("host-overview-about");
    expect(
      within(about).queryByTestId("host-overview-about-last-seen"),
    ).toBeNull();
    const notices = screen.getByTestId("host-overview-notices");
    expect(within(notices).queryByText(/last seen/i)).toBeNull();
    expect(screen.getByTestId("host-overview-about-platform").textContent).toBe(
      "macOS · last account report, 3h ago",
    );
    expect(
      screen.getByTestId("host-overview-about-architecture").textContent,
    ).toBe("arm64 · last account report, 3h ago");
  });

  it("still reads when the host cannot be reached, and collapses a host that never checked in", async () => {
    const unseen = registryItem({
      platform: null,
      status: {
        ...registryItem({}).status,
        appVersion: null,
        lastSeenAt: null,
      },
    });
    setRoutelessScope({
      status: "unreachable",
      isLocalMachine: false,
      item: unseen,
    });
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId: HOST_ID,
        name: HOST_NAME,
        isLocalMachine: false,
        registered: true,
        connectable: false,
        item: unseen,
        health: healthLive(false),
        version: null,
      }),
    };
    mount(null);
    await selectHostOverviewTab("installation");

    const about = within(installationPane()).getByTestId("host-overview-about");
    expect(
      within(about).getByTestId("host-overview-about-last-seen").textContent,
    ).toBe("Not seen since it was added");
    expect(
      within(about).queryByTestId("host-overview-about-host-id"),
    ).toBeNull();
    expect(
      within(about).queryByTestId("host-overview-about-version"),
    ).toBeNull();
    expect(
      within(about).queryByTestId("host-overview-about-platform"),
    ).toBeNull();

    const details = installationDetails();
    expect(
      within(details).getByTestId("host-overview-about-host-id").textContent,
    ).toBe("8f14e45f…c9a2");
    expect(
      within(details).getByTestId("host-overview-about-version").textContent,
    ).toBe("No version received by the account");
    expect(
      within(details).queryByTestId("host-overview-about-platform"),
    ).toBeNull();
    expect(
      within(details).queryByTestId("host-overview-about-architecture"),
    ).toBeNull();
    expect(
      within(details).queryByTestId("settings-host-install-version"),
    ).toBeNull();
  });

  it("still reads while the host is connecting, beside the loading shape", async () => {
    setRoutelessScope({
      status: "connecting",
      isLocalMachine: false,
      item: registryItem({}),
    });
    mount(null);
    await selectHostOverviewTab("installation");

    const pane = installationPane();
    expect(within(pane).getByTestId("host-overview-about")).not.toBeNull();
    expect(within(pane).getByTestId("host-scope-connecting")).not.toBeNull();
    expect(
      within(pane).queryByTestId("host-overview-install-record"),
    ).toBeNull();
    expect(within(pane).queryByTestId("host-overview-service")).toBeNull();
  });

  it("is absent for a host the account has no record of", async () => {
    setReadyScope({
      isLocalMachine: false,
      item: null,
      live: true,
      fixture: fixtureFor(false, undefined, undefined),
      methods: [...OVERVIEW_METHODS, ...SERVICE_METHODS],
    });
    mount(null);
    await selectHostOverviewTab("installation");

    // The reachable line renders, so the absence is not a blank tab.
    await waitFor(() => {
      expect(
        within(installationPane()).getByTestId(
          "host-overview-installation-empty",
        ).textContent,
      ).toBe(
        "Running from a checkout or unpacked tree · no installation record",
      );
    });
    expect(screen.queryByTestId("host-overview-about")).toBeNull();
    expect(screen.queryByTestId("host-overview-install-record")).toBeNull();
  });
});

describe("Overview ▸ Installation — Install record, open with no click", () => {
  function readyRemote(
    overrides: Parameters<typeof fixtureFor>[1],
    installation: HostGetInstallationInfoResponseV11 | undefined,
    methods: readonly string[],
  ): void {
    setReadyScope({
      isLocalMachine: false,
      item: registryItem({}),
      live: true,
      fixture: fixtureFor(false, overrides, installation),
      methods,
    });
  }

  it("says it is reading while the read is pending", async () => {
    readyRemote(
      { "host.getInstallationInfo": () => new Promise<never>(() => undefined) },
      undefined,
      [...OVERVIEW_METHODS, ...SERVICE_METHODS],
    );
    mount(null);
    await selectHostOverviewTab("installation");

    expect(screen.queryByTestId("host-overview-install-record")).toBeNull();
    expect(
      (await screen.findByTestId("host-overview-installation-empty"))
        .textContent,
    ).toBe("Reading install record…");
    expect(
      screen.queryByRole("button", { name: /Installation details/i }),
    ).toBeNull();
  });

  it("says an unmanaged host has no record, once the read has answered", async () => {
    readyRemote(undefined, { status: "unmanaged" }, [
      ...OVERVIEW_METHODS,
      ...SERVICE_METHODS,
    ]);
    mount(null);
    await selectHostOverviewTab("installation");

    await waitFor(() => {
      expect(
        screen.getByTestId("host-overview-installation-empty").textContent,
      ).toBe(
        "Running from a checkout or unpacked tree · no installation record",
      );
    });
    expect(screen.queryByTestId("host-overview-install-record")).toBeNull();
    expect(
      screen.getByTestId("host-overview-installation-empty").textContent,
    ).not.toContain(HOST_NAME);
  });

  it("names a FAILED read as unreadable, never as an unmanaged host", async () => {
    readyRemote(
      {
        "host.getInstallationInfo": () =>
          Promise.reject(new Error("transport down")),
      },
      undefined,
      [...OVERVIEW_METHODS, ...SERVICE_METHODS],
    );
    mount(null);
    await selectHostOverviewTab("installation");

    const notice = await screen.findByTestId(
      "host-overview-installation-unreadable",
    );
    expect(notice.textContent).toContain(
      `Couldn't read ${HOST_NAME}'s installation record.`,
    );
    expect(screen.queryByTestId("host-overview-installation-empty")).toBeNull();
  });

  it("says a host without host.getInstallationInfo does not support it, and reads nothing", async () => {
    readyRemote(undefined, undefined, [
      ...OVERVIEW_METHODS.filter((m) => m !== "host.getInstallationInfo"),
      ...SERVICE_METHODS,
    ]);
    mount(null);
    await selectHostOverviewTab("installation");

    const notice = await screen.findByTestId(
      "host-overview-installation-degraded",
    );
    expect(notice.textContent).toContain(
      `${HOST_NAME} is running a version that doesn't support this yet. Update it and this comes back on its own.`,
    );
    const group = screen.getByTestId("host-overview-install-record");
    expect(
      within(group).queryByTestId("settings-host-install-version"),
    ).toBeNull();
    expect(
      within(group).queryByTestId("settings-host-install-build"),
    ).toBeNull();
    await waitFor(() => {
      expect(
        screen.getByTestId("settings-host-install-version").textContent,
      ).toBe("v1.5.0 · from this host now");
    });
    expect(
      screen.queryByTestId("host-overview-installation-unsupported"),
    ).toBeNull();
  });

  it("says one update sentence, not two degraded notices, when neither read is supported", async () => {
    readyRemote(
      undefined,
      undefined,
      OVERVIEW_METHODS.filter((m) => m !== "host.getInstallationInfo"),
    );
    mount(null);
    await selectHostOverviewTab("installation");

    const line = await screen.findByTestId(
      "host-overview-installation-unsupported",
    );
    expect(line.textContent).toBe(
      `Update ${HOST_NAME} to see its activity here.`,
    );
    expect(
      screen.queryByTestId("host-overview-installation-degraded"),
    ).toBeNull();
    expect(screen.queryByTestId("host-overview-service-degraded")).toBeNull();
  });

  it("shows the running version, and a Build only when it differs from it", async () => {
    readyRemote(undefined, managed(installRecord("20260924-stamp", "1.5.0")), [
      ...OVERVIEW_METHODS,
      ...SERVICE_METHODS,
    ]);
    mount(null);
    await selectHostOverviewTab("installation");

    const record = await screen.findByTestId("host-overview-install-record");
    await waitFor(() => {
      expect(
        within(record).getByTestId("settings-host-install-build").textContent,
      ).toBe("20260924-stamp");
      expect(
        screen.getByTestId("settings-host-install-version").textContent,
      ).toBe("v1.5.0 · from this host now");
      expect(screen.queryByTestId("host-overview-about-version")).toBeNull();
    });
    expect(
      within(record).queryByTestId("settings-host-install-version"),
    ).toBeNull();
    expect(
      within(record).getByTestId("settings-host-verification").textContent,
    ).toMatch(/^Verified /);
  });

  it("shows no Build when the record's version IS what runs", async () => {
    readyRemote(undefined, managed(installRecord("1.5.0", "1.5.0")), [
      ...OVERVIEW_METHODS,
      ...SERVICE_METHODS,
    ]);
    mount(null);
    await selectHostOverviewTab("installation");

    const record = await screen.findByTestId("host-overview-install-record");
    await waitFor(() => {
      expect(
        screen.getByTestId("settings-host-install-version").textContent,
      ).toBe("v1.5.0 · from this host now");
    });
    expect(
      within(record).queryByTestId("settings-host-install-build"),
    ).toBeNull();
    expect(
      within(record).queryByTestId("settings-host-install-version"),
    ).toBeNull();
    expect(screen.queryByTestId("host-overview-about-version")).toBeNull();
  });

  it("shortens the SHA-256 and keeps the whole digest on the tooltip and the copy button", async () => {
    readyRemote(undefined, managed(installRecord("1.5.0", null)), [
      ...OVERVIEW_METHODS,
      ...SERVICE_METHODS,
    ]);
    mount(null);
    await selectHostOverviewTab("installation");

    const sha = await screen.findByTestId("settings-host-install-sha256");
    expect(sha.textContent).toBe("aaaaaaaa…aaaa");
    const writeText = stubClipboard();
    fireEvent.click(screen.getByRole("button", { name: "Copy SHA-256" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("a".repeat(64));
    });
  });
});

describe("Overview ▸ Installation — OS service group", () => {
  it("renders the registration, its manifest line and both repair verbs", async () => {
    setReadyScope({
      isLocalMachine: false,
      item: registryItem({}),
      live: true,
      fixture: fixtureFor(false, undefined, undefined),
      methods: [...OVERVIEW_METHODS, ...SERVICE_METHODS],
    });
    mount(null);
    await selectHostOverviewTab("installation");

    const service = await screen.findByTestId("host-overview-service");
    expect(service.textContent).toContain("OS service");
    await waitFor(() => {
      expect(
        within(openInstallationDetails()).getByTestId(
          "host-overview-service-manifest",
        ).textContent,
      ).toBe("ai.traycer.host · /tmp/ai.traycer.host.plist");
    });
    expect(
      within(service).queryByTestId("host-overview-service-manifest"),
    ).toBeNull();
    expect(
      within(service).getByTestId("host-overview-service-description")
        .textContent,
    ).not.toBe("");
    expect(
      within(service).getByTestId("host-overview-service-register"),
    ).not.toBeNull();
    expect(
      within(service).getByTestId("host-overview-service-deregister"),
    ).not.toBeNull();
  });

  it("replaces the group's contents with the unsupported sentence when host.service.status is not negotiated", async () => {
    setReadyScope({
      isLocalMachine: false,
      item: registryItem({}),
      live: true,
      fixture: fixtureFor(false, undefined, undefined),
      methods: [...OVERVIEW_METHODS],
    });
    mount(null);
    await selectHostOverviewTab("installation");

    const service = await screen.findByTestId("host-overview-service");
    expect(
      within(service).getByTestId("host-overview-service-degraded").textContent,
    ).toContain(
      `${HOST_NAME} is running a version that doesn't support this yet. Update it and this comes back on its own.`,
    );
    expect(
      within(service).queryByTestId("host-overview-service-description"),
    ).toBeNull();
    expect(
      within(service).queryByTestId("host-overview-service-register"),
    ).toBeNull();
    expect(
      within(service).queryByTestId("host-overview-service-deregister"),
    ).toBeNull();
    expect(
      within(installationDetails()).queryByTestId(
        "host-overview-service-manifest",
      ),
    ).toBeNull();
  });
});

describe("Overview ▸ Installation — the command-line tools dot follows the CLI manifest query", () => {
  function readyLocal(): void {
    setReadyScope({
      isLocalMachine: true,
      item: registryItem({}),
      live: true,
      fixture: fixtureFor(true, undefined, undefined),
      methods: [...OVERVIEW_METHODS, ...SERVICE_METHODS],
    });
  }

  it("shows the dot and the group together, and drops BOTH when a refetch finds the tools current", async () => {
    let withUpgrade = true;
    const manifestRead = vi.fn(() => cliManifest(withUpgrade));
    const management = buildOverviewManagement({ cliManifest: manifestRead });
    readyLocal();
    const { queryClient } = mount(management);
    await selectHostOverviewTab("installation");

    const trigger = screen.getByTestId("host-overview-tab-installation");
    const dot = await within(trigger).findByTestId(
      "host-overview-installation-dot",
    );
    expect(dot.textContent).toBe(" (command-line tools need an upgrade)");
    const group = await within(installationPane()).findByTestId(
      "host-overview-command-line-tools",
    );
    expect(group.textContent).toContain("Command-line tools");
    expect(
      within(group).getByTestId("settings-host-package-manager-upgrade-command")
        .textContent,
    ).toBe(UPGRADE_COMMAND);
    expect(
      within(group).getByRole("button", { name: "Copy upgrade command" }),
    ).not.toBeNull();
    // ONE query serves both readers: the dot and the group share a cache
    // entry, so mounting both did not read the manifest twice.
    expect(manifestRead).toHaveBeenCalledTimes(1);

    withUpgrade = false;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ["runner.host.cliManifest"],
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("host-overview-installation-dot")).toBeNull();
    });
    expect(screen.queryByTestId("host-overview-command-line-tools")).toBeNull();
    expect(manifestRead).toHaveBeenCalledTimes(2);
  });

  it("shows neither dot nor group while the manifest records no upgrade", async () => {
    const manifestRead = vi.fn(() => cliManifest(false));
    readyLocal();
    mount(buildOverviewManagement({ cliManifest: manifestRead }));
    await selectHostOverviewTab("installation");

    await waitFor(() => {
      expect(manifestRead).toHaveBeenCalled();
    });
    await screen.findByTestId("host-overview-service");
    expect(screen.queryByTestId("host-overview-installation-dot")).toBeNull();
    expect(screen.queryByTestId("host-overview-command-line-tools")).toBeNull();
  });

  it("gives a remote host neither, and never reads the manifest, even when this machine's bridge holds an upgrade", async () => {
    const manifestRead = vi.fn(() => cliManifest(true));
    setReadyScope({
      isLocalMachine: false,
      item: registryItem({}),
      live: true,
      fixture: fixtureFor(false, undefined, undefined),
      methods: [...OVERVIEW_METHODS, ...SERVICE_METHODS],
    });
    mount(buildOverviewManagement({ cliManifest: manifestRead }));
    await selectHostOverviewTab("installation");

    // The tab has rendered its host groups, so the absences are not "not yet".
    await screen.findByTestId("host-overview-service");
    expect(screen.queryByTestId("host-overview-installation-dot")).toBeNull();
    expect(screen.queryByTestId("host-overview-command-line-tools")).toBeNull();
    expect(manifestRead).not.toHaveBeenCalled();
  });

  it("keeps the group on this computer's stopped host: it is a bridge fact, not a host read", async () => {
    setRoutelessScope({
      status: "unreachable",
      isLocalMachine: true,
      item: registryItem({}),
    });
    mount(
      buildOverviewManagement({ cliManifest: vi.fn(() => cliManifest(true)) }),
    );
    await selectHostOverviewTab("installation");

    expect(
      await within(installationPane()).findByTestId(
        "host-overview-command-line-tools",
      ),
    ).not.toBeNull();
    expect(
      within(screen.getByTestId("host-overview-tab-installation")).getByTestId(
        "host-overview-installation-dot",
      ),
    ).not.toBeNull();
  });

  it("on a phone, rides the Installation option of the section select and its trigger once selected", async () => {
    window.innerWidth = 500;
    readyLocal();
    armSettingsOpenIntent({
      section: "host",
      resetToGeneral: false,
      tab: "installation",
      draft: null,
      hostId: null,
    });
    mount(
      buildOverviewManagement({ cliManifest: vi.fn(() => cliManifest(true)) }),
    );

    const select = await screen.findByRole("combobox", { name: "Section" });
    // Selected: the value shown in the trigger carries the dot.
    expect(
      await within(select).findByTestId("host-overview-installation-dot"),
    ).not.toBeNull();

    await userEvent.setup().click(select);
    const option = await screen.findByRole("option", { name: /Installation/ });
    expect(
      within(option).getByTestId("host-overview-installation-dot"),
    ).not.toBeNull();
    // Only the Installation option carries it.
    const others = screen
      .getAllByRole("option")
      .filter((candidate) => candidate !== option);
    for (const other of others) {
      expect(
        within(other).queryByTestId("host-overview-installation-dot"),
      ).toBeNull();
    }
  });
});

describe("Overview ▸ Installation — a host restarting to finish an update", () => {
  const RESTARTING: HostScopeOption["health"] = {
    state: "restarting",
    label: "Restarting…",
    detail: "Expected restart — reconnecting.",
    tone: "idle",
    live: false,
  };

  /** Asserts the Restarting state's shape. */
  function expectRestartingShape(): void {
    const pane = installationPane();
    expect(within(pane).getByTestId("host-scope-connecting")).not.toBeNull();
    expect(within(pane).getByTestId("host-overview-about")).not.toBeNull();
    expect(
      within(pane).queryByTestId("host-overview-installation-needs-connection"),
    ).toBeNull();
    expect(
      within(pane).queryByTestId("host-overview-install-record"),
    ).toBeNull();
    expect(within(pane).queryByTestId("host-overview-service")).toBeNull();
  }

  it("waits in the loading shape, not the needs-a-connection line, while the scope has no route", async () => {
    setRoutelessScope({
      status: "unreachable",
      isLocalMachine: false,
      item: registryItem({}),
    });
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId: HOST_ID,
        name: HOST_NAME,
        isLocalMachine: false,
        registered: true,
        connectable: false,
        item: registryItem({}),
        health: RESTARTING,
      }),
    };
    mount(null);
    await selectHostOverviewTab("installation");

    expectRestartingShape();
  });

  it("waits in the loading shape, not stale host groups, while the scope still reads ready", async () => {
    setReadyScope({
      isLocalMachine: false,
      item: registryItem({}),
      live: false,
      fixture: fixtureFor(false, undefined, undefined),
      methods: [...OVERVIEW_METHODS, ...SERVICE_METHODS],
    });
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId: HOST_ID,
        name: HOST_NAME,
        isLocalMachine: false,
        registered: true,
        connectable: true,
        isActive: true,
        item: registryItem({}),
        health: RESTARTING,
      }),
    };
    mount(null);
    await selectHostOverviewTab("installation");

    expectRestartingShape();
  });
});

describe("Overview ▸ Installation — when the host can't answer", () => {
  it("says the install record and OS service need a connection, and shows neither", async () => {
    setRoutelessScope({
      status: "unreachable",
      isLocalMachine: false,
      item: registryItem({}),
    });
    mount(null);
    await selectHostOverviewTab("installation");

    const pane = installationPane();
    expect(
      within(pane).getByTestId("host-overview-installation-needs-connection")
        .textContent,
    ).toBe(
      `The install record and OS service are read from ${HOST_NAME}, so they need a connection.`,
    );
    expect(
      within(pane).queryByTestId("host-overview-install-record"),
    ).toBeNull();
    expect(within(pane).queryByTestId("host-overview-service")).toBeNull();
    expect(within(pane).queryByTestId("host-scope-connecting")).toBeNull();
  });

  it("keeps Remove from account live for an unreachable registered host, and it opens its confirmation", async () => {
    setRoutelessScope({
      status: "unreachable",
      isLocalMachine: false,
      item: registryItem({}),
    });
    mount(null);
    await selectHostOverviewTab("installation");

    const danger = within(installationPane()).getByTestId("host-danger-zone");
    const remove = within(danger).getByRole<HTMLButtonElement>("button", {
      name: "Remove from account",
    });
    expect(remove.disabled).toBe(false);

    fireEvent.click(remove);
    const dialog = await screen.findByTestId("confirm-destructive-dialog");
    expect(dialog.textContent).toContain(
      `Remove ${HOST_NAME} from this account?`,
    );
  });

  it("keeps Remove Traycer available on this computer's stopped host", async () => {
    setRoutelessScope({
      status: "unreachable",
      isLocalMachine: true,
      item: registryItem({}),
    });
    mount(buildOverviewManagement({}));
    await selectHostOverviewTab("installation");

    const danger = within(installationPane()).getByTestId("host-danger-zone");
    const remove = await within(danger).findByRole<HTMLButtonElement>(
      "button",
      {
        name: "Remove Traycer",
      },
    );
    expect(remove.disabled).toBe(false);
    expect(
      within(installationPane()).queryByTestId("host-overview-install-record"),
    ).toBeNull();
  });
});

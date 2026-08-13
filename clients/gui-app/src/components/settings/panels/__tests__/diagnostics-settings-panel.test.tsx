import type { HostScope } from "@/components/settings/host-scope/use-host-scope";

// The panel is host-scoped now (log levels / logs are fields of the selected
// host's own config), so it reads `useHostScope`. Mock at that boundary:
// these suites render the panel bare, without the host runtime and query
// providers the real hook needs.
// `Partial<HostScope>`, not `Record<string, unknown>`: the keys these helpers
// set (`host`, `hostId`, `hostLabel`, `status`, `client`) have to stay checked
// against the real scope. Untyped, a renamed `HostScope` field would leave
// these suites compiling and quietly asserting against fixture defaults
// instead of the scope they meant to install. The `import type` is erased, so
// it is safe inside a hoisted factory.
const scopeOverrides = vi.hoisted((): { current: Partial<HostScope> } => ({
  current: {},
}));
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostScope: () => hostScopeFixture(scopeOverrides.current),
  };
});

// `useScopedHostBinding` and the panel's own direct `useHostBinding()?.hostClient`
// reads go through this module. Mocked wholesale rather than standing up a
// real `<HostRuntimeProvider>` - see `providers-settings-panel.test.tsx` and
// `provider-mcp-tab.test.tsx` for the same partial-object pattern.
const hostBindingMock = vi.hoisted(
  (): { current: { readonly hostClient: unknown } | null } => ({
    current: null,
  }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostBinding: () => hostBindingMock.current };
});

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { LogLevel } from "@traycer/protocol/config/log-level";
import type { DiagnosticsLogDescriptor } from "@traycer/protocol/host/diagnostics/index";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { DiagnosticsSettingsPanel } from "@/components/settings/panels/diagnostics-settings-panel";
import {
  ALL_CONFIG_RPC_METHODS,
  CONFIG_LOG_LEVEL_METHODS,
  DIAGNOSTICS_LOG_METHODS,
  buildConfigHostFixture,
  type ConfigHostFixture,
  type DiagnosticsLogFixtureEntry,
} from "@/components/settings/panels/__tests__/host-config-rpc-test-support";
import type {
  LogLevelScope,
  LogLevelsBridge,
  LogLevelsSnapshot,
} from "@/lib/desktop-log-levels";
import type {
  DesktopSupportBridge,
  DesktopSupportLogTailResult,
  DesktopSupportLogTarget,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

interface GlobalWithRunnerHost {
  runnerHost:
    | {
        readonly platform: {
          readonly logLevels: LogLevelsBridge | undefined;
        };
      }
    | undefined;
}

const globalWithRunnerHost = globalThis as typeof globalThis &
  GlobalWithRunnerHost;

function defaultSnapshot(): LogLevelsSnapshot {
  return {
    desktopLogLevel: "info",
    cliLogLevel: "info",
    hostLogLevel: "info",
  };
}

function scopeField(scope: LogLevelScope): keyof LogLevelsSnapshot {
  switch (scope) {
    case "desktop":
      return "desktopLogLevel";
    case "cli":
      return "cliLogLevel";
    case "host":
      return "hostLogLevel";
  }
}

interface LogLevelsBridgeMocks {
  readonly bridge: LogLevelsBridge;
  readonly getMock: Mock<() => Promise<LogLevelsSnapshot>>;
  readonly setMock: Mock<
    (scope: LogLevelScope, level: LogLevel) => Promise<LogLevelsSnapshot>
  >;
  readonly getSnapshot: () => LogLevelsSnapshot;
}

function installLogLevelsBridge(
  initial: LogLevelsSnapshot,
): LogLevelsBridgeMocks {
  let snapshot = initial;
  const getMock = vi.fn(() => Promise.resolve(snapshot));
  const setMock = vi.fn((scope: LogLevelScope, level: LogLevel) => {
    snapshot = {
      ...snapshot,
      [scopeField(scope)]: level,
    };
    return Promise.resolve(snapshot);
  });
  const bridge: LogLevelsBridge = {
    get: getMock,
    set: setMock,
  };
  globalWithRunnerHost.runnerHost = {
    platform: { logLevels: bridge },
  };
  return {
    bridge,
    getMock,
    setMock,
    getSnapshot: () => snapshot,
  };
}

interface HeldLogLevelsBridgeMocks extends LogLevelsBridgeMocks {
  readonly flushNextSet: () => void;
}

/**
 * Same as installLogLevelsBridge, but each set() stays pending until
 * flushNextSet() so callers can assert in-flight disable state during reset.
 */
function installHeldLogLevelsBridge(
  initial: LogLevelsSnapshot,
): HeldLogLevelsBridgeMocks {
  let snapshot = initial;
  const pendingFlushes: Array<() => void> = [];
  const getMock = vi.fn(() => Promise.resolve(snapshot));
  const setMock = vi.fn(
    (scope: LogLevelScope, level: LogLevel) =>
      new Promise<LogLevelsSnapshot>((resolve) => {
        pendingFlushes.push(() => {
          snapshot = {
            ...snapshot,
            [scopeField(scope)]: level,
          };
          resolve(snapshot);
        });
      }),
  );
  const bridge: LogLevelsBridge = {
    get: getMock,
    set: setMock,
  };
  globalWithRunnerHost.runnerHost = {
    platform: { logLevels: bridge },
  };
  return {
    bridge,
    getMock,
    setMock,
    getSnapshot: () => snapshot,
    flushNextSet: () => {
      const next = pendingFlushes.shift();
      if (next === undefined) {
        throw new Error("No pending log-levels set() to flush");
      }
      next();
    },
  };
}

function clearLogLevelsBridge(): void {
  globalWithRunnerHost.runnerHost = undefined;
}

function readySupportSnapshot(): DesktopSupportSnapshot {
  return {
    appName: "Traycer",
    appVersion: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    user: { status: "signed-out", userName: null, email: null },
    versions: { electron: "1", chrome: "1", node: "1" },
    host: { status: "ready", version: "1", pid: 1, hostId: "host-1" },
    // Only the desktop row is sourced from the support snapshot now - a
    // host's own logs come from `diagnostics.logs.list` over RPC.
    logs: [
      {
        target: "desktop",
        label: "Desktop app",
        path: "/tmp/desktop.log",
      },
    ],
    links: [],
    supportEmail: "support@traycer.ai",
    privateDeliveryAvailable: true,
  };
}

function makeSupportBridge(overrides: {
  readonly getSnapshot?: DesktopSupportBridge["getSnapshot"];
  readonly tailLog?: DesktopSupportBridge["tailLog"];
  readonly revealLog?: DesktopSupportBridge["revealLog"];
}): DesktopSupportBridge {
  return {
    getSnapshot:
      overrides.getSnapshot ?? (() => Promise.resolve(readySupportSnapshot())),
    revealLog:
      overrides.revealLog ??
      ((target) => Promise.resolve({ target, path: `/tmp/${target}.log` })),
    submitReport: vi.fn(() =>
      Promise.resolve({
        status: "delivered" as const,
        reportId: "report-1",
      }),
    ),
    tailLog:
      overrides.tailLog ??
      ((input) =>
        Promise.resolve<DesktopSupportLogTailResult>({
          target: input.target,
          path: `/tmp/${input.target}.log`,
          lines: [`line-one-${input.target}`, `line-two-${input.target}`],
          truncated: false,
        })),
    freezeEvidence: () => Promise.resolve({ reportId: "report-1" }),
    discardFrozenEvidence: () => Promise.resolve(),
    readFrozenLogTail: (input) =>
      Promise.resolve<DesktopSupportLogTailResult>({
        target: input.target,
        path: `/tmp/${input.target}.log`,
        lines: [],
        truncated: false,
      }),
    saveDiagnosticBundle: () => Promise.resolve({ path: "/tmp/bundle.json" }),
    getFingerprintOccurrence: () => Promise.resolve(null),
    buildPublicDraft: () =>
      Promise.resolve({
        template: "bug_report.yml",
        title: "",
        fields: {
          "what-happened": "",
          version: "",
          os: "",
          component: "",
          repro: "",
        },
        truncated: false,
      }),
  };
}

function makeHost(support: DesktopSupportBridge | null): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    hostManagement: null,
    hostTray: null,
    support,
  });
}

/**
 * Renders the panel with NO host RPC client bound (default scope: local,
 * connectable, `following`, `client: null` per `hostScopeFixture`'s default -
 * see its own note on why panel suites never prove that pairing). Used for
 * the cases that are genuinely independent of the host's own RPC: both
 * bridges absent, or only the support bridge present.
 */
function renderPanelWithoutRpc(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <DiagnosticsSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

/**
 * This computer's host, unable to answer for itself: `localConfigFallbackReason`
 * is non-null, so the panel falls back to the local log-levels/support bridges
 * instead of the RPC path. Covers BOTH reasons for a local host - stopped
 * (`connectable: false`, the default) or a connectable host whose recorded
 * manifest omits `config.logLevels.get` ("host-outdated").
 */
function renderPanelStoppedLocal(options: {
  readonly support: DesktopSupportBridge | null;
  readonly connectable?: boolean;
  /** Recorded via `recordNegotiatedHostMethods` when given; omitted otherwise (no handshake yet). */
  readonly methods?: readonly string[];
}): QueryClient {
  const hostId = "host-a";
  if (options.methods !== undefined) {
    recordNegotiatedHostMethods(hostId, options.methods);
  }
  const connectable = options.connectable ?? false;
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId,
      name: "host-a",
      isLocalMachine: true,
      connectable,
    }),
    hostId,
    hostLabel: "host-a",
    status: connectable ? "ready" : "unreachable",
  };
  return renderPanelWithoutRpc(makeHost(options.support));
}

/**
 * Renders the panel with a real `HostClient` bound as the scoped host's RPC
 * transport (`config.logLevels.*` / `diagnostics.logs.*`) - the production
 * path for every reachable host, local or remote.
 */
function renderPanelOverRpc(options: {
  readonly support: DesktopSupportBridge | null;
  readonly hostId?: string;
  readonly isLocalMachine?: boolean;
  readonly hostName?: string;
  readonly logLevels?: { cliLogLevel: LogLevel; hostLogLevel: LogLevel };
  readonly diagnosticsLogs?: readonly DiagnosticsLogFixtureEntry[];
  /**
   * Recorded via `recordNegotiatedHostMethods`. Defaults to the full
   * log-level+diagnostics families; pass `null` to record NOTHING for this
   * host id — the "no handshake yet" tri-state, distinct from a
   * recorded-but-empty manifest.
   */
  readonly methods?: readonly string[] | null;
  readonly overrideHandlers?: Parameters<
    typeof buildConfigHostFixture
  >[0]["overrideHandlers"];
}): { readonly fixture: ConfigHostFixture; readonly queryClient: QueryClient } {
  const hostId = options.hostId ?? "host-a";
  const isLocalMachine = options.isLocalMachine ?? true;
  const fixture = buildConfigHostFixture({
    hostId,
    isLocalMachine,
    logLevels: options.logLevels,
    diagnosticsLogs: options.diagnosticsLogs,
    overrideHandlers: options.overrideHandlers,
  });
  if (options.methods !== null) {
    recordNegotiatedHostMethods(
      hostId,
      options.methods ?? [
        ...CONFIG_LOG_LEVEL_METHODS,
        ...DIAGNOSTICS_LOG_METHODS,
      ],
    );
  }

  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId,
      name: options.hostName ?? hostId,
      isLocalMachine,
      connectable: true,
    }),
    hostId,
    hostLabel: options.hostName ?? hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = { hostClient: fixture.client };

  const queryClient = renderPanelWithoutRpc(makeHost(options.support));
  return { fixture, queryClient };
}

async function openLogLevelSelect(scope: LogLevelScope): Promise<HTMLElement> {
  const trigger = await waitFor(() => {
    const element = screen.getByTestId(`settings-log-level-${scope}`);
    if (element.hasAttribute("disabled")) {
      throw new Error(`Log level select for ${scope} still disabled`);
    }
    return element;
  });
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(trigger);
  return trigger;
}

async function chooseLogLevelOption(label: string): Promise<void> {
  const option = await screen.findByRole("option", { name: label });
  fireEvent.pointerUp(option);
  fireEvent.click(option);
}

describe("<DiagnosticsSettingsPanel />", () => {
  const writeTextMock = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    clearLogLevelsBridge();
    writeTextMock.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    cleanup();
    clearLogLevelsBridge();
    scopeOverrides.current = {};
    hostBindingMock.current = null;
    resetNegotiatedManifests();
  });

  it("renders the full page for a remote host: desktop row, memory, host cli/host rows, and the host's own log entries", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      hostId: "host-remote",
      isLocalMachine: false,
      hostName: "Remote Box",
      support: makeSupportBridge({}),
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
      diagnosticsLogs: [
        { target: "host", label: "Host", path: "/var/host.log", lines: ["h1"] },
        { target: "cli", label: "CLI", path: "/var/cli.log", lines: ["c1"] },
      ],
    });

    expect(
      await screen.findByTestId("settings-log-level-desktop"),
    ).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Memory" })).toBeTruthy();

    expect(await screen.findByText("Desktop app")).toBeTruthy();
    expect(await screen.findByText("Host")).toBeTruthy();
    expect(await screen.findByText("CLI")).toBeTruthy();

    // The old local-only gate is gone entirely - not just hidden for this
    // scope.
    expect(screen.queryByTestId("requires-local-host-notice")).toBeNull();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
  });

  it("shows independent unavailable states when both bridges are absent", () => {
    renderPanelWithoutRpc(makeHost(null));

    expect(screen.getByRole("heading", { name: "Log detail" })).toBeTruthy();
    expect(
      screen.getByText(
        "Log level controls are only available on the desktop app.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("settings-log-level-desktop")).toBeNull();

    expect(
      screen.getByRole("heading", { name: "Recent logs · Last 100 lines" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Recent logs are only available on the desktop app."),
    ).toBeTruthy();
    expect(screen.queryByTestId("diagnostics-log-toggle-desktop")).toBeNull();
  });

  it("keeps Recent logs usable when only the log-levels bridge is absent", async () => {
    renderPanelWithoutRpc(makeHost(makeSupportBridge({})));

    expect(
      screen.getByText(
        "Log level controls are only available on the desktop app.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("settings-log-level-desktop")).toBeNull();

    expect(
      await screen.findByRole("heading", {
        name: "Recent logs · Last 100 lines",
      }),
    ).toBeTruthy();
    expect(await screen.findByText("Desktop app")).toBeTruthy();
    expect(
      screen.queryByText("Recent logs are only available on the desktop app."),
    ).toBeNull();
  });

  it("keeps Log detail usable when only the support bridge is absent", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    expect(
      await screen.findByRole("heading", { name: "Log detail" }),
    ).toBeTruthy();
    expect(screen.getByTestId("settings-log-level-desktop")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();

    expect(
      screen.getByRole("heading", { name: "Recent logs · Last 100 lines" }),
    ).toBeTruthy();
    // The support bridge is absent, so there is no desktop-app entry - but the
    // host is still reachable over RPC, so its (empty) log list still answers
    // rather than falling back to the desktop-only unavailable copy.
    expect(await screen.findByText("No log files on host-a.")).toBeTruthy();
    expect(screen.queryByTestId("diagnostics-log-toggle-desktop")).toBeNull();
  });

  it("renders the Log detail group with the three scope selectors", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    expect(
      await screen.findByRole("heading", { name: "Log detail" }),
    ).toBeTruthy();
    expect(screen.getByTestId("settings-log-level-desktop")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();
    expect(screen.getByText("App log level")).toBeTruthy();
    expect(screen.getByText("CLI log level")).toBeTruthy();
    expect(screen.getByText("Host log level")).toBeTruthy();
  });

  it("hides the non-default reminder when all levels are Info", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    await screen.findByTestId("settings-log-level-desktop");
    await screen.findByTestId("settings-log-level-cli");
    expect(screen.queryByTestId("diagnostics-log-detail-reminder")).toBeNull();
    expect(screen.queryByTestId("diagnostics-reset-log-levels")).toBeNull();
  });

  it("shows the reminder after raising one level, then resets all non-default scopes to Info", async () => {
    const { setMock } = installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    await screen.findByTestId("settings-log-level-desktop");
    expect(screen.queryByTestId("diagnostics-log-detail-reminder")).toBeNull();

    await openLogLevelSelect("desktop");
    await chooseLogLevelOption("Debug");

    await waitFor(() => {
      expect(setMock).toHaveBeenCalledWith("desktop", "debug");
    });
    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /One or more levels differ from Info for troubleshooting/,
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("diagnostics-reset-log-levels"));

    await waitFor(() => {
      expect(setMock).toHaveBeenCalledWith("desktop", "info");
    });
    // Only the desktop scope was non-default, so reset mutates once.
    expect(
      setMock.mock.calls.filter(
        (call) => call[0] === "desktop" && call[1] === "info",
      ),
    ).toHaveLength(1);
    await waitFor(() => {
      expect(
        screen.queryByTestId("diagnostics-log-detail-reminder"),
      ).toBeNull();
    });
  });

  it("resets every non-default scope when multiple levels are elevated, including the host-RPC cli/host rows", async () => {
    const { setMock } = installLogLevelsBridge({
      desktopLogLevel: "debug",
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
    const { fixture } = renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "warn", hostLogLevel: "info" },
    });

    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("diagnostics-reset-log-levels"));

    await waitFor(() => {
      expect(setMock).toHaveBeenCalledTimes(1);
    });
    expect(setMock).toHaveBeenCalledWith("desktop", "info");
    // The cli scope went out as a REAL config.logLevels.set RPC to the scoped
    // host's client, not the desktop bridge.
    await waitFor(() => {
      expect(fixture.setLogLevelCalls).toContainEqual({
        scope: "cli",
        level: "info",
      });
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("diagnostics-log-detail-reminder"),
      ).toBeNull();
    });
  });

  it("disables all three log-level selects while Reset all to Info is in flight", async () => {
    const held = installHeldLogLevelsBridge({
      desktopLogLevel: "debug",
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();

    // Wait until the selects have finished their initial load (enabled).
    await waitFor(() => {
      expect(
        screen
          .getByTestId("settings-log-level-desktop")
          .hasAttribute("disabled"),
      ).toBe(false);
    });

    fireEvent.click(screen.getByTestId("diagnostics-reset-log-levels"));

    await waitFor(() => {
      expect(held.setMock).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.getByTestId("settings-log-level-desktop").hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByTestId("settings-log-level-cli").hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByTestId("settings-log-level-host").hasAttribute("disabled"),
    ).toBe(true);

    held.flushNextSet();

    await waitFor(() => {
      expect(
        screen
          .getByTestId("settings-log-level-desktop")
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(
      screen.getByTestId("settings-log-level-cli").hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen.getByTestId("settings-log-level-host").hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByTestId("diagnostics-log-detail-reminder")).toBeNull();
  });

  it("restores focus to the log-detail wrapper when Reset all removes the reminder", async () => {
    // When the reminder (and its Reset button) unmounts, focus must move to
    // the tabIndex=-1 content wrapper - not drop to <body>.
    const { setMock } = installLogLevelsBridge({
      desktopLogLevel: "debug",
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    const resetButton = await screen.findByTestId(
      "diagnostics-reset-log-levels",
    );
    resetButton.focus();
    expect(document.activeElement).toBe(resetButton);

    fireEvent.click(resetButton);

    await waitFor(() => {
      expect(setMock).toHaveBeenCalledWith("desktop", "info");
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("diagnostics-log-detail-reminder"),
      ).toBeNull();
    });

    const desktopTrigger = screen.getByTestId("settings-log-level-desktop");
    const focusTarget = desktopTrigger.closest("[tabindex='-1']");
    expect(focusTarget instanceof HTMLElement).toBe(true);
    if (!(focusTarget instanceof HTMLElement)) return;
    expect(focusTarget.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(focusTarget);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("preserves the select trigger focus when a row change removes the reminder", async () => {
    const { setMock } = installLogLevelsBridge({
      desktopLogLevel: "debug",
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();

    const desktopTrigger = await openLogLevelSelect("desktop");
    await chooseLogLevelOption("Info (default)");

    await waitFor(() => {
      expect(setMock).toHaveBeenCalledWith("desktop", "info");
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("diagnostics-log-detail-reminder"),
      ).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(desktopTrigger);
    });
  });

  it("does not duplicate the per-scope toast for a single-scope reset failure", async () => {
    const snapshot: LogLevelsSnapshot = {
      desktopLogLevel: "debug",
      cliLogLevel: "info",
      hostLogLevel: "info",
    };
    const setMock = vi.fn(() =>
      Promise.reject<LogLevelsSnapshot>(new Error("desktop set failed")),
    );
    globalWithRunnerHost.runnerHost = {
      platform: {
        logLevels: {
          get: vi.fn(() => Promise.resolve(snapshot)),
          set: setMock,
        },
      },
    };

    vi.mocked(toast.error).mockClear();
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    fireEvent.click(await screen.findByTestId("diagnostics-reset-log-levels"));

    await waitFor(() => {
      expect(setMock).toHaveBeenCalledWith("desktop", "info");
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't update log level",
        expect.objectContaining({ description: "desktop set failed" }),
      );
    });
    expect(toast.error).not.toHaveBeenCalledWith(
      "Couldn't reset 1 of 1 log level",
    );
  });

  it("continues resetting remaining scopes after one set() fails and toasts the aggregate", async () => {
    // Reset-all must attempt EVERY non-default scope even if an earlier one
    // rejects - previously a single outer try/catch stopped the loop early.
    let snapshot: LogLevelsSnapshot = {
      desktopLogLevel: "debug",
      cliLogLevel: "warn",
      hostLogLevel: "info",
    };
    const getMock = vi.fn(() => Promise.resolve(snapshot));
    const setMock = vi.fn((scope: LogLevelScope, level: LogLevel) => {
      if (scope === "desktop") {
        return Promise.reject(new Error("desktop set failed"));
      }
      snapshot = {
        ...snapshot,
        [scopeField(scope)]: level,
      };
      return Promise.resolve(snapshot);
    });
    const bridge: LogLevelsBridge = {
      get: getMock,
      set: setMock,
    };
    globalWithRunnerHost.runnerHost = {
      platform: { logLevels: bridge },
    };

    vi.mocked(toast.error).mockClear();
    const { fixture } = renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "warn", hostLogLevel: "error" },
    });

    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("diagnostics-reset-log-levels"));

    // desktop goes through the bridge (fails); cli/host go through the RPC
    // client (succeed) - one bridge call, two RPC calls.
    await waitFor(() => {
      expect(setMock).toHaveBeenCalledTimes(1);
    });
    expect(setMock).toHaveBeenCalledWith("desktop", "info");
    await waitFor(() => {
      expect(fixture.setLogLevelCalls).toHaveLength(2);
    });
    expect(fixture.setLogLevelCalls).toContainEqual({
      scope: "cli",
      level: "info",
    });
    expect(fixture.setLogLevelCalls).toContainEqual({
      scope: "host",
      level: "info",
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't reset 1 of 3 log levels",
      );
    });

    // Failed desktop scope stays elevated - reminder remains visible.
    expect(screen.getByTestId("diagnostics-log-detail-reminder")).toBeTruthy();
    expect(snapshot.desktopLogLevel).toBe("debug");
    expect(fixture.getLogLevels()).toEqual({
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
  });

  it("loads recent logs, expands tail output, copies, and reveals a log file", async () => {
    installLogLevelsBridge(defaultSnapshot());
    const revealLog = vi.fn((target: DesktopSupportLogTarget) =>
      Promise.resolve({ target, path: `/tmp/${target}.log` }),
    );
    const tailLog = vi.fn(
      (input: {
        readonly target: DesktopSupportLogTarget;
        readonly tailLines: number;
      }) =>
        Promise.resolve<DesktopSupportLogTailResult>({
          target: input.target,
          path: `/tmp/${input.target}.log`,
          lines: ["alpha", "beta"],
          truncated: false,
        }),
    );
    const support = makeSupportBridge({ revealLog, tailLog });
    renderPanelOverRpc({
      support,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    expect(
      await screen.findByRole("heading", {
        name: "Recent logs · Last 100 lines",
      }),
    ).toBeTruthy();
    expect(await screen.findByText("Desktop app")).toBeTruthy();
    const logList = screen.getByTestId("diagnostics-log-list");
    expect(logList.className).toContain("min-h-0");
    expect(logList.className).toContain("max-h-full");
    expect(logList.className).toContain("overflow-y-auto");
    expect(logList.className).not.toContain("flex-1");

    // Copy is only present while expanded.
    expect(
      screen.queryByRole("button", { name: "Copy Desktop app log" }),
    ).toBeNull();

    fireEvent.click(screen.getByTestId("diagnostics-log-toggle-desktop"));

    const output = await screen.findByTestId("diagnostics-log-output-desktop");
    await waitFor(() => {
      expect(output.textContent).toContain("alpha");
      expect(output.textContent).toContain("beta");
    });
    expect(tailLog).toHaveBeenCalledWith({
      target: "desktop",
      tailLines: 100,
    });

    const copyButton = screen.getByRole("button", {
      name: "Copy Desktop app log",
    });
    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("alpha\nbeta");
    });

    const entryRoot = screen.queryByTestId("diagnostics-log-entry-desktop");
    expect(entryRoot instanceof HTMLElement).toBe(true);
    if (!(entryRoot instanceof HTMLElement)) return;
    fireEvent.click(within(entryRoot).getByRole("button", { name: "Reveal" }));
    await waitFor(() => {
      expect(revealLog).toHaveBeenCalledWith("desktop");
    });
  });

  it("reads a host's own log over diagnostics.logs.tail with Copy path instead of Reveal", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      support: makeSupportBridge({}),
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
      diagnosticsLogs: [
        {
          target: "host",
          label: "Host",
          path: "/var/host.log",
          lines: ["host-line-one", "host-line-two"],
        },
      ],
    });

    expect(await screen.findByText("Host")).toBeTruthy();
    const entryRoot = screen.getByTestId("diagnostics-log-entry-host");
    expect(
      within(entryRoot).queryByRole("button", { name: "Reveal" }),
    ).toBeNull();
    expect(
      within(entryRoot).getByRole("button", { name: "Copy Host path" }),
    ).toBeTruthy();

    fireEvent.click(
      within(entryRoot).getByTestId("diagnostics-log-toggle-host"),
    );
    const output = await screen.findByTestId("diagnostics-log-output-host");
    await waitFor(() => {
      expect(output.textContent).toContain("host-line-one");
    });
  });

  it("shows a loading state while the host's diagnostics.logs.list RPC is pending", async () => {
    let resolveList: (value: {
      logs: DiagnosticsLogDescriptor[];
    }) => void = () => undefined;
    renderPanelOverRpc({
      support: makeSupportBridge({}),
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
      overrideHandlers: {
        "diagnostics.logs.list": () =>
          new Promise((resolve) => {
            resolveList = resolve;
          }),
      },
    });

    expect(await screen.findByText("Loading logs…")).toBeTruthy();
    resolveList({ logs: [] });
    expect(await screen.findByText("No log files on host-a.")).toBeTruthy();
  });

  it("shows an error state when the host's diagnostics.logs.list RPC fails", async () => {
    renderPanelOverRpc({
      support: makeSupportBridge({}),
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
      overrideHandlers: {
        "diagnostics.logs.list": () => {
          throw new Error("boom");
        },
      },
    });

    expect(await screen.findByText("Couldn't load log details.")).toBeTruthy();
  });

  it("shows an empty state naming the host when the RPC host has no log files", async () => {
    renderPanelOverRpc({
      hostId: "host-a",
      hostName: "Host A",
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
      diagnosticsLogs: [],
    });

    expect(await screen.findByText("No log files on Host A.")).toBeTruthy();
    expect(screen.queryByTestId("diagnostics-log-toggle-host")).toBeNull();
  });

  it("shows the unsupported notice for a REMOTE old host, without crashing, while the app-scoped rows keep working", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      hostId: "host-old",
      hostName: "Old Box",
      isLocalMachine: false,
      support: makeSupportBridge({}),
      // Handshaked WITHOUT the config/diagnostics families.
      methods: ["host.status"],
    });

    const notice = await screen.findByTestId("host-config-unsupported-notice");
    expect(notice.textContent).toContain("running an older version");
    expect(screen.queryByTestId("settings-log-level-cli")).toBeNull();
    expect(screen.queryByTestId("settings-log-level-host")).toBeNull();

    // App-scoped rows are unaffected by the host's version.
    expect(screen.getByTestId("settings-log-level-desktop")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Memory" })).toBeTruthy();
    // A remote host has no local truth to fall back to.
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
  });

  it('host-stopped: reads and writes cli/host log levels through the bridge, with data-reason="host-stopped"', async () => {
    const { setMock } = installLogLevelsBridge({
      desktopLogLevel: "info",
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
    renderPanelStoppedLocal({
      support: makeSupportBridge({}),
      connectable: false,
    });

    const notice = await screen.findByTestId("local-config-fallback-notice");
    expect(notice.getAttribute("data-reason")).toBe("host-stopped");
    expect(screen.getByTestId("settings-log-level-desktop")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();

    await openLogLevelSelect("host");
    await chooseLogLevelOption("Debug");

    // The write actually reached the local bridge, not an RPC handler - the
    // bridge is machine-user-global, so cli/host share the same `set()` the
    // desktop row uses.
    await waitFor(() => {
      expect(setMock).toHaveBeenCalledWith("host", "debug");
    });
  });

  // The widened case: a RUNNING, connectable local host whose handshake did
  // not carry `config.logLevels.get` (the fleet-update window) still gets a
  // working, bridge-backed page instead of the capability notice.
  it('host-outdated: a connectable local host with an old manifest still uses the bridge, with data-reason="host-outdated"', async () => {
    const { setMock } = installLogLevelsBridge({
      desktopLogLevel: "info",
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
    renderPanelStoppedLocal({
      support: makeSupportBridge({}),
      connectable: true,
      methods: ["host.status"], // handshaked WITHOUT config.logLevels.get
    });

    const notice = await screen.findByTestId("local-config-fallback-notice");
    expect(notice.getAttribute("data-reason")).toBe("host-outdated");
    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();

    await openLogLevelSelect("cli");
    await chooseLogLevelOption("Debug");

    await waitFor(() => {
      expect(setMock).toHaveBeenCalledWith("cli", "debug");
    });
  });

  // The tri-state guard: a local, CONNECTABLE host with no recorded manifest
  // at all ("not dialled yet", not "unsupported") must take the RPC path, not
  // the bridge — collapsing the tri-state to a boolean would divert it here
  // permanently, before its own first RPC ever produced an answer.
  it("does not fall back for a connectable local host with no handshake recorded yet", async () => {
    renderPanelOverRpc({
      hostId: "host-a",
      isLocalMachine: true,
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
      methods: null,
    });

    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();
  });
});

// The negotiated-manifest registry never clears a stale `false` answer on its
// own - `useHostCapabilityProbe` is what re-dials a parked host so a page that
// promises "update the host and this fills in on its own" can keep that
// promise. These pins prove the probe actually dispatched (not merely that
// the panel changed state for some other reason), then prove the RPC path
// resumes once a fresh handshake and a bumped incarnation land.
describe("<DiagnosticsSettingsPanel /> capability-probe self-heal", () => {
  const writeTextMock = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    clearLogLevelsBridge();
    writeTextMock.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });
  });

  afterEach(() => {
    cleanup();
    clearLogLevelsBridge();
    scopeOverrides.current = {};
    hostBindingMock.current = null;
    resetNegotiatedManifests();
  });

  it("remote host: probes host.status while parked, then resumes the RPC cli/host rows once the host re-handshakes with the config/diagnostics families", async () => {
    installLogLevelsBridge(defaultSnapshot());
    const hostId = "host-old";
    const fixture = buildConfigHostFixture({
      hostId,
      isLocalMachine: false,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
      diagnosticsLogs: [],
    });
    // Handshaked WITHOUT the config/diagnostics families - parks the panel on
    // the unsupported notice.
    recordNegotiatedHostMethods(hostId, ["host.status"]);

    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId,
        name: "Old Box",
        isLocalMachine: false,
        connectable: true,
        version: "1.5.0",
      }),
      hostId,
      hostLabel: "Old Box",
      status: "ready",
      client: fixture.client,
    };
    hostBindingMock.current = { hostClient: fixture.client };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={makeHost(makeSupportBridge({}))}>
          <DiagnosticsSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByTestId("host-config-unsupported-notice"),
    ).toBeTruthy();

    // Non-vacuity discriminator: without the probe wired up, nothing would
    // ever call host.status while parked.
    await waitFor(() => {
      expect(fixture.hostStatusCalls()).toBeGreaterThan(0);
    });
    const callsWhileParked = fixture.hostStatusCalls();

    // Bump ONLY the incarnation, manifest still unhealed: this is the leg
    // `cacheKeyIdentity` protects - a re-dial driven purely by the host's
    // version changing, still while parked. Without a cache key keyed on the
    // incarnation, this rerender would reuse the already-fetched query and
    // never ask again.
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId,
        name: "Old Box",
        isLocalMachine: false,
        connectable: true,
        version: "1.5.1",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={makeHost(makeSupportBridge({}))}>
          <DiagnosticsSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(fixture.hostStatusCalls()).toBeGreaterThan(callsWhileParked);
    });

    // Now simulate the host updating in place: a fresh handshake carries the
    // config/diagnostics families, and the host's own incarnation bumps again.
    recordNegotiatedHostMethods(hostId, ALL_CONFIG_RPC_METHODS);
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId,
        name: "Old Box",
        isLocalMachine: false,
        connectable: true,
        version: "1.6.0",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={makeHost(makeSupportBridge({}))}>
          <DiagnosticsSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();
  });

  it("local, connectable, outdated host: probes host.status while parked on the bridge, then resumes the RPC cli/host rows once the host re-handshakes", async () => {
    installLogLevelsBridge({
      desktopLogLevel: "info",
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
    const hostId = "host-a";
    const fixture = buildConfigHostFixture({
      hostId,
      isLocalMachine: true,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
      diagnosticsLogs: [],
    });
    // Handshaked WITHOUT the log-levels family - the fleet-update window.
    recordNegotiatedHostMethods(hostId, ["host.status"]);

    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId,
        name: "host-a",
        isLocalMachine: true,
        connectable: true,
        version: "1.5.0",
      }),
      hostId,
      hostLabel: "host-a",
      status: "ready",
      client: fixture.client,
    };
    hostBindingMock.current = { hostClient: fixture.client };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={makeHost(makeSupportBridge({}))}>
          <DiagnosticsSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    const notice = await screen.findByTestId("local-config-fallback-notice");
    expect(notice.getAttribute("data-reason")).toBe("host-outdated");
    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();

    // Non-vacuity discriminator: the probe dispatched over the scoped client
    // even though the panel itself is reading/writing through the bridge.
    await waitFor(() => {
      expect(fixture.hostStatusCalls()).toBeGreaterThan(0);
    });
    const callsWhileParked = fixture.hostStatusCalls();

    // Bump ONLY the incarnation, manifest still unhealed: this is the leg
    // `cacheKeyIdentity` protects - a re-dial driven purely by the host's
    // version changing, still while parked.
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId,
        name: "host-a",
        isLocalMachine: true,
        connectable: true,
        version: "1.5.1",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={makeHost(makeSupportBridge({}))}>
          <DiagnosticsSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(fixture.hostStatusCalls()).toBeGreaterThan(callsWhileParked);
    });

    recordNegotiatedHostMethods(hostId, ALL_CONFIG_RPC_METHODS);
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId,
        name: "host-a",
        isLocalMachine: true,
        connectable: true,
        version: "1.6.0",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={makeHost(makeSupportBridge({}))}>
          <DiagnosticsSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
    });
    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();
  });
});

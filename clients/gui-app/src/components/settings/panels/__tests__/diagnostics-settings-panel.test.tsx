import "../../../../../__tests__/test-browser-apis";
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
import { DiagnosticsSettingsPanel } from "@/components/settings/panels/diagnostics-settings-panel";
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
    logs: [
      {
        target: "desktop",
        label: "Desktop app",
        path: "/tmp/desktop.log",
      },
      {
        target: "host",
        label: "Host",
        path: "/tmp/host.log",
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

function renderPanel(host: IRunnerHost): QueryClient {
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
  });

  it("shows independent unavailable states when both bridges are absent", () => {
    renderPanel(makeHost(null));

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
    renderPanel(makeHost(makeSupportBridge({})));

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
    renderPanel(makeHost(null));

    expect(
      await screen.findByRole("heading", { name: "Log detail" }),
    ).toBeTruthy();
    expect(screen.getByTestId("settings-log-level-desktop")).toBeTruthy();
    expect(screen.getByTestId("settings-log-level-cli")).toBeTruthy();
    expect(screen.getByTestId("settings-log-level-host")).toBeTruthy();

    expect(
      screen.getByRole("heading", { name: "Recent logs · Last 100 lines" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Recent logs are only available on the desktop app."),
    ).toBeTruthy();
    expect(screen.queryByTestId("diagnostics-log-toggle-desktop")).toBeNull();
  });

  it("renders the Log detail group with the three scope selectors", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanel(makeHost(null));

    expect(
      await screen.findByRole("heading", { name: "Log detail" }),
    ).toBeTruthy();
    expect(screen.getByTestId("settings-log-level-desktop")).toBeTruthy();
    expect(screen.getByTestId("settings-log-level-cli")).toBeTruthy();
    expect(screen.getByTestId("settings-log-level-host")).toBeTruthy();
    expect(screen.getByText("App log level")).toBeTruthy();
    expect(screen.getByText("CLI log level")).toBeTruthy();
    expect(screen.getByText("Host log level")).toBeTruthy();
  });

  it("hides the non-default reminder when all levels are Info", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanel(makeHost(null));

    await screen.findByTestId("settings-log-level-desktop");
    expect(screen.queryByTestId("diagnostics-log-detail-reminder")).toBeNull();
    expect(screen.queryByTestId("diagnostics-reset-log-levels")).toBeNull();
  });

  it("shows the reminder after raising one level, then resets all non-default scopes to Info", async () => {
    const { setMock } = installLogLevelsBridge(defaultSnapshot());
    renderPanel(makeHost(null));

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

  it("resets every non-default scope when multiple levels are elevated", async () => {
    const { setMock } = installLogLevelsBridge({
      desktopLogLevel: "debug",
      cliLogLevel: "warn",
      hostLogLevel: "info",
    });
    renderPanel(makeHost(null));

    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("diagnostics-reset-log-levels"));

    await waitFor(() => {
      expect(setMock).toHaveBeenCalledTimes(2);
    });
    expect(setMock).toHaveBeenNthCalledWith(1, "desktop", "info");
    expect(setMock).toHaveBeenNthCalledWith(2, "cli", "info");
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
    renderPanel(makeHost(null));

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
    renderPanel(makeHost(null));

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
    renderPanel(makeHost(null));

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
    renderPanel(makeHost(null));

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
      hostLogLevel: "error",
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
    renderPanel(makeHost(null));

    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("diagnostics-reset-log-levels"));

    await waitFor(() => {
      expect(setMock).toHaveBeenCalledTimes(3);
    });
    expect(setMock).toHaveBeenNthCalledWith(1, "desktop", "info");
    expect(setMock).toHaveBeenNthCalledWith(2, "cli", "info");
    expect(setMock).toHaveBeenNthCalledWith(3, "host", "info");

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't reset 1 of 3 log levels",
      );
    });

    // Failed desktop scope stays elevated - reminder remains visible.
    expect(screen.getByTestId("diagnostics-log-detail-reminder")).toBeTruthy();
    expect(snapshot.desktopLogLevel).toBe("debug");
    expect(snapshot.cliLogLevel).toBe("info");
    expect(snapshot.hostLogLevel).toBe("info");
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
    renderPanel(makeHost(support));

    expect(
      await screen.findByRole("heading", {
        name: "Recent logs · Last 100 lines",
      }),
    ).toBeTruthy();
    expect(await screen.findByText("Desktop app")).toBeTruthy();
    expect(screen.getByText("Host")).toBeTruthy();
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

  it("shows a loading state while the support snapshot is pending", async () => {
    installLogLevelsBridge(defaultSnapshot());
    let resolveSnapshot: (value: DesktopSupportSnapshot) => void = () =>
      undefined;
    const support = makeSupportBridge({
      getSnapshot: () =>
        new Promise<DesktopSupportSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        }),
    });
    renderPanel(makeHost(support));

    expect(await screen.findByText("Loading logs…")).toBeTruthy();
    resolveSnapshot(readySupportSnapshot());
    expect(await screen.findByText("Desktop app")).toBeTruthy();
  });

  it("shows an error state when the support snapshot fails", async () => {
    installLogLevelsBridge(defaultSnapshot());
    const support = makeSupportBridge({
      getSnapshot: () => Promise.reject(new Error("boom")),
    });
    renderPanel(makeHost(support));

    expect(await screen.findByText("Couldn't load log details.")).toBeTruthy();
  });

  it("shows an empty state when the support snapshot has no log files", async () => {
    installLogLevelsBridge(defaultSnapshot());
    const support = makeSupportBridge({
      getSnapshot: () =>
        Promise.resolve({
          ...readySupportSnapshot(),
          logs: [],
        }),
    });
    renderPanel(makeHost(support));

    expect(await screen.findByText("No log files found.")).toBeTruthy();
    expect(screen.queryByTestId("diagnostics-log-toggle-desktop")).toBeNull();
  });
});

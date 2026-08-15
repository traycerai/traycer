import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDiagnosticsSettingsPanel } from "@/components/settings/panels/app-diagnostics-settings-panel";
import {
  chooseLogLevelOption,
  clearRunnerHostBridges,
  defaultSnapshot,
  installCustomLogLevelsBridge,
  installHeapSnapshotBridge,
  installHeldLogLevelsBridge,
  installLogLevelsBridge,
  makeHost,
  makeSupportBridge,
  openLogLevelSelect,
  readySupportSnapshot,
} from "@/components/settings/panels/__tests__/diagnostics-test-support";
import type {
  DesktopSupportBridge,
  DesktopSupportLogTailResult,
  DesktopSupportLogTarget,
  DesktopSupportSnapshot,
} from "@/lib/windows/types";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { toast } from "sonner";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  },
}));

/**
 * Application -> Diagnostics: the app's own log verbosity, log tail and heap.
 *
 * No host scope anywhere in this file, and that absence is the point. The three
 * surfaces here used to render on the host-scoped page, where every one of them
 * was drawn once per host in the account while describing a single window. The
 * pin that keeps that from coming back is the panel's own shape — it takes no
 * scope, mocks no `useHostScope`, and stands up no `HostClient`. If any of that
 * becomes necessary to render this page, something host-varying has moved back
 * onto it.
 */
function renderPanel(host: IRunnerHost): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={host}>
        <AppDiagnosticsSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("<AppDiagnosticsSettingsPanel />", () => {
  const writeTextMock = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    clearRunnerHostBridges();
    writeTextMock.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });
  });

  afterEach(() => {
    cleanup();
    clearRunnerHostBridges();
  });

  it("renders the app's three surfaces: the App log level row, Memory, and the Desktop Log entry", async () => {
    installLogLevelsBridge(defaultSnapshot());
    installHeapSnapshotBridge(() => Promise.resolve(null));
    renderPanel(makeHost(makeSupportBridge({})));

    expect(
      await screen.findByTestId("settings-log-level-desktop"),
    ).toBeTruthy();
    expect(screen.getByText("App log level")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Memory" })).toBeTruthy();
    expect(
      screen.getByTestId("diagnostics-capture-heap-snapshot"),
    ).toBeTruthy();
    expect(await screen.findByText("Desktop Log")).toBeTruthy();
  });

  it("carries no host-scoped rows or logs, whatever the bridges return", async () => {
    // The whole reason this page exists. `readySupportSnapshot` includes the
    // `host` entry the real bridge always returns, so this asserts the page
    // FILTERS to its own log rather than simply having nothing else to show.
    installLogLevelsBridge(defaultSnapshot());
    renderPanel(makeHost(makeSupportBridge({})));

    expect(await screen.findByText("Desktop Log")).toBeTruthy();
    expect(screen.queryByTestId("settings-log-level-cli")).toBeNull();
    expect(screen.queryByTestId("settings-log-level-host")).toBeNull();
    expect(screen.queryByText("CLI log level")).toBeNull();
    expect(screen.queryByText("Host log level")).toBeNull();
    expect(screen.queryByText("Host Log")).toBeNull();
    expect(screen.queryByTestId("diagnostics-log-entry-host")).toBeNull();
  });

  it("states each unavailable surface independently when both bridges are absent", () => {
    renderPanel(makeHost(null));

    expect(screen.getByRole("heading", { name: "Log detail" })).toBeTruthy();
    expect(
      screen.getByText(
        "Log level controls are only available on the desktop app.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("settings-log-level-desktop")).toBeNull();

    expect(screen.getByRole("heading", { name: "Memory" })).toBeTruthy();
    expect(
      screen.getByText(
        "Memory snapshots are only available on the desktop app.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("diagnostics-capture-heap-snapshot"),
    ).toBeNull();

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

    expect(await screen.findByText("Desktop Log")).toBeTruthy();
    expect(
      screen.queryByText("Recent logs are only available on the desktop app."),
    ).toBeNull();
  });

  it("keeps Log detail usable when only the support bridge is absent", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanel(makeHost(null));

    expect(
      await screen.findByTestId("settings-log-level-desktop"),
    ).toBeTruthy();
    expect(
      screen.getByText("Recent logs are only available on the desktop app."),
    ).toBeTruthy();
  });

  it("loads the log tail, copies it, and reveals the file", async () => {
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
    renderPanel(makeHost(makeSupportBridge({ revealLog, tailLog })));

    expect(
      await screen.findByRole("heading", {
        name: "Recent logs · Last 100 lines",
      }),
    ).toBeTruthy();
    expect(await screen.findByText("Desktop Log")).toBeTruthy();
    const logList = screen.getByTestId("diagnostics-log-list");
    expect(logList.className).toContain("min-h-0");
    expect(logList.className).toContain("max-h-full");
    expect(logList.className).toContain("overflow-y-auto");
    expect(logList.className).not.toContain("flex-1");

    // Copy is only present while expanded.
    expect(
      screen.queryByRole("button", { name: "Copy Desktop Log log" }),
    ).toBeNull();

    fireEvent.click(screen.getByTestId("diagnostics-log-toggle-desktop"));

    const output = await screen.findByTestId("diagnostics-log-output-desktop");
    await waitFor(() => {
      expect(output.textContent).toContain("alpha");
      expect(output.textContent).toContain("beta");
    });
    expect(tailLog).toHaveBeenCalledWith({ target: "desktop", tailLines: 100 });
    // Only the app's own log was ever tailed - the snapshot's `host` entry is
    // not this page's to read.
    expect(
      tailLog.mock.calls.filter((call) => call[0].target !== "desktop"),
    ).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Copy Desktop Log log" }),
    );
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("alpha\nbeta");
    });

    const entryRoot = screen.getByTestId("diagnostics-log-entry-desktop");
    fireEvent.click(within(entryRoot).getByRole("button", { name: "Reveal" }));
    await waitFor(() => {
      expect(revealLog).toHaveBeenCalledWith("desktop");
    });
  });

  it("says so rather than rendering an empty card when the snapshot has no app log", async () => {
    installLogLevelsBridge(defaultSnapshot());
    const snapshot: DesktopSupportSnapshot = {
      ...readySupportSnapshot(),
      logs: [{ target: "host", label: "Host Log", path: "/tmp/host.log" }],
    };
    const support: DesktopSupportBridge = makeSupportBridge({
      getSnapshot: () => Promise.resolve(snapshot),
    });
    renderPanel(makeHost(support));

    expect(await screen.findByText("No app log file found.")).toBeTruthy();
    expect(screen.queryByText("Host Log")).toBeNull();
  });

  it("shows the loading state, then the failure state, for the snapshot read", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanel(
      makeHost(
        makeSupportBridge({
          getSnapshot: () => Promise.reject(new Error("boom")),
        }),
      ),
    );

    expect(screen.getByText("Loading logs…")).toBeTruthy();
    expect(await screen.findByText("Couldn't load log details.")).toBeTruthy();
  });

  it("shows the reminder after raising the app level, then resets it to Info", async () => {
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

    fireEvent.click(screen.getByTestId("diagnostics-reset-log-levels"));

    await waitFor(() => {
      expect(setMock).toHaveBeenCalledWith("desktop", "info");
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("diagnostics-log-detail-reminder"),
      ).toBeNull();
    });
  });

  it("disables the select while Reset all to Info is in flight", async () => {
    const held = installHeldLogLevelsBridge({
      desktopLogLevel: "debug",
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
    renderPanel(makeHost(null));

    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();
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

    held.flushNextSet();

    await waitFor(() => {
      expect(
        screen
          .getByTestId("settings-log-level-desktop")
          .hasAttribute("disabled"),
      ).toBe(false);
    });
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

    const focusTarget = screen
      .getByTestId("settings-log-level-desktop")
      .closest("[tabindex='-1']");
    expect(focusTarget instanceof HTMLElement).toBe(true);
    expect(document.activeElement).toBe(focusTarget);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("does not add an aggregate toast when the only elevated scope fails to reset", async () => {
    // With one control, the transport's own toast already said it - a second
    // line would double-report a single failure.
    const setMock = vi.fn(() =>
      Promise.reject(new Error("desktop set failed")),
    );
    installCustomLogLevelsBridge({
      get: vi.fn(() =>
        Promise.resolve({
          desktopLogLevel: "debug" as const,
          cliLogLevel: "info" as const,
          hostLogLevel: "info" as const,
        }),
      ),
      set: setMock,
    });

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
      expect.stringContaining("Couldn't reset"),
    );
  });

  it("captures a heap snapshot and offers its path for copying", async () => {
    installLogLevelsBridge(defaultSnapshot());
    const takeHeapSnapshot = vi.fn(() =>
      Promise.resolve<string | null>("/tmp/heap-1.heapsnapshot"),
    );
    installHeapSnapshotBridge(takeHeapSnapshot);
    renderPanel(makeHost(makeSupportBridge({})));

    const button = await screen.findByTestId(
      "diagnostics-capture-heap-snapshot",
    );
    expect(screen.queryByTestId("diagnostics-heap-snapshot-path")).toBeNull();
    fireEvent.click(button);

    await waitFor(() => {
      expect(takeHeapSnapshot).toHaveBeenCalled();
    });
    const path = await screen.findByTestId("diagnostics-heap-snapshot-path");
    expect(path.textContent).toBe("/tmp/heap-1.heapsnapshot");
  });
});

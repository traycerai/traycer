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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLevel } from "@traycer/protocol/config/log-level";
import type {
  ConfigLogLevelsResponse,
  ConfigLogLevelsSetRequest,
  ConfigLogLevelsSetResponse,
} from "@traycer/protocol/host/config/index";
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
import {
  chooseLogLevelOption,
  clearRunnerHostBridges,
  defaultSnapshot,
  installLogLevelsBridge,
  makeHost,
  makeSupportBridge,
  openLogLevelSelect,
} from "@/components/settings/panels/__tests__/diagnostics-test-support";
import type { DesktopSupportBridge } from "@/lib/windows/types";
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

interface HeldLogLevels {
  readonly handlers: {
    // The GET contract's own type: the SET response aliases the same schema
    // today, but naming each keeps this fixture honest if they diverge.
    readonly "config.logLevels.get": () => ConfigLogLevelsResponse;
    readonly "config.logLevels.set": (
      request: ConfigLogLevelsSetRequest,
    ) => Promise<ConfigLogLevelsSetResponse>;
  };
  readonly pendingCount: () => number;
  readonly flushNext: () => void;
}

/**
 * A `config.logLevels.set` that stays pending until flushed, over its own
 * `get`.
 *
 * The RPC-path counterpart of the bridge's `installHeldLogLevelsBridge`, which
 * this page no longer reaches: with `desktop` gone, every write here is an RPC,
 * so holding one in flight has to be done at the handler.
 *
 * It owns BOTH halves deliberately. Overriding `set` alone leaves the fixture's
 * `get` answering from state the override never mutates, so the invalidating
 * re-read after a flush hands back the level the reset just cleared — and the
 * reminder this asserts on never goes away.
 */
function heldLogLevels(initial: ConfigLogLevelsSetResponse): HeldLogLevels {
  const pending: Array<() => void> = [];
  let levels = initial;
  return {
    handlers: {
      "config.logLevels.get": () => ({ ...levels }),
      "config.logLevels.set": (request) =>
        new Promise<ConfigLogLevelsSetResponse>((resolve) => {
          pending.push(() => {
            levels =
              request.scope === "cli"
                ? { ...levels, cliLogLevel: request.level }
                : { ...levels, hostLogLevel: request.level };
            resolve({ ...levels });
          });
        }),
    },
    pendingCount: () => pending.length,
    flushNext: () => {
      const next = pending.shift();
      if (next === undefined) {
        throw new Error("No pending config.logLevels.set to flush");
      }
      next();
    },
  };
}

describe("<DiagnosticsSettingsPanel />", () => {
  const writeTextMock = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    clearRunnerHostBridges();
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
    clearRunnerHostBridges();
    scopeOverrides.current = {};
    hostBindingMock.current = null;
    resetNegotiatedManifests();
  });

  it("renders the full page for a remote host: cli/host rows and the host's own log entries", async () => {
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

    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();
    expect(await screen.findByText("Host")).toBeTruthy();
    expect(await screen.findByText("CLI")).toBeTruthy();

    // The old local-only gate is gone entirely - not just hidden for this
    // scope.
    expect(screen.queryByTestId("requires-local-host-notice")).toBeNull();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
  });

  it("carries nothing app-scoped, even with both desktop bridges installed", async () => {
    // The split, pinned from this side. The log-levels bridge IS installed and
    // the support snapshot DOES carry its `desktop` entry, so each absence
    // below is this page declining to render something available to it rather
    // than something it could not have shown.
    installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      support: makeSupportBridge({}),
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
      diagnosticsLogs: [
        { target: "host", label: "Host", path: "/var/host.log", lines: ["h1"] },
      ],
    });

    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(screen.queryByTestId("settings-log-level-desktop")).toBeNull();
    expect(screen.queryByText("App log level")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Memory" })).toBeNull();
    expect(
      screen.queryByTestId("diagnostics-capture-heap-snapshot"),
    ).toBeNull();
    expect(screen.queryByTestId("diagnostics-log-entry-desktop")).toBeNull();
    expect(screen.queryByText("Desktop Log")).toBeNull();
  });

  it("keeps Log detail usable when the support bridge is absent", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    expect(
      await screen.findByRole("heading", { name: "Log detail" }),
    ).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();

    expect(
      screen.getByRole("heading", { name: "Recent logs · Last 100 lines" }),
    ).toBeTruthy();
    // The support bridge is irrelevant on this page now - the host is reachable
    // over RPC, so its (empty) log list answers for itself.
    expect(await screen.findByText("No log files on host-a.")).toBeTruthy();
  });

  it("renders the Log detail group with the two host scope selectors", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    expect(
      await screen.findByRole("heading", { name: "Log detail" }),
    ).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();
    expect(screen.getByText("CLI log level")).toBeTruthy();
    expect(screen.getByText("Host log level")).toBeTruthy();
  });

  it("hides the non-default reminder when all levels are Info", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    await screen.findByTestId("settings-log-level-cli");
    await screen.findByTestId("settings-log-level-host");
    expect(screen.queryByTestId("diagnostics-log-detail-reminder")).toBeNull();
    expect(screen.queryByTestId("diagnostics-reset-log-levels")).toBeNull();
  });

  it("shows the reminder after raising one level, then resets the non-default scope to Info", async () => {
    const { fixture } = renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "info", hostLogLevel: "info" },
    });

    await screen.findByTestId("settings-log-level-cli");
    expect(screen.queryByTestId("diagnostics-log-detail-reminder")).toBeNull();

    await openLogLevelSelect("cli");
    await chooseLogLevelOption("Debug");

    await waitFor(() => {
      expect(fixture.setLogLevelCalls).toContainEqual({
        scope: "cli",
        level: "debug",
      });
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
      expect(fixture.setLogLevelCalls).toContainEqual({
        scope: "cli",
        level: "info",
      });
    });
    // Only cli was non-default, so the reset writes exactly one scope - `host`
    // was already Info and must not be written back over the wire.
    expect(
      fixture.setLogLevelCalls.filter((call) => call.scope === "host"),
    ).toHaveLength(0);
    await waitFor(() => {
      expect(
        screen.queryByTestId("diagnostics-log-detail-reminder"),
      ).toBeNull();
    });
  });

  it("resets every non-default scope over the host's own config RPC", async () => {
    const { fixture } = renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "warn", hostLogLevel: "error" },
    });

    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("diagnostics-reset-log-levels"));

    // Both went out as REAL config.logLevels.set RPCs to the scoped host's
    // client. Nothing on this page writes the local bridge any more.
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
      expect(
        screen.queryByTestId("diagnostics-log-detail-reminder"),
      ).toBeNull();
    });
    expect(fixture.getLogLevels()).toEqual({
      cliLogLevel: "info",
      hostLogLevel: "info",
    });
  });

  it("disables both log-level selects while Reset all to Info is in flight", async () => {
    const held = heldLogLevels({ cliLogLevel: "debug", hostLogLevel: "info" });
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "debug", hostLogLevel: "info" },
      overrideHandlers: held.handlers,
    });

    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();

    // Wait until the selects have finished their initial load (enabled).
    await waitFor(() => {
      expect(
        screen.getByTestId("settings-log-level-cli").hasAttribute("disabled"),
      ).toBe(false);
    });

    fireEvent.click(screen.getByTestId("diagnostics-reset-log-levels"));

    await waitFor(() => {
      expect(held.pendingCount()).toBe(1);
    });
    expect(
      screen.getByTestId("settings-log-level-cli").hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByTestId("settings-log-level-host").hasAttribute("disabled"),
    ).toBe(true);

    held.flushNext();

    await waitFor(() => {
      expect(
        screen.getByTestId("settings-log-level-cli").hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(
      screen.getByTestId("settings-log-level-host").hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByTestId("diagnostics-log-detail-reminder")).toBeNull();
  });

  it("restores focus to the log-detail wrapper when Reset all removes the reminder", async () => {
    // When the reminder (and its Reset button) unmounts, focus must move to
    // the tabIndex=-1 content wrapper - not drop to <body>.
    const { fixture } = renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "debug", hostLogLevel: "info" },
    });

    const resetButton = await screen.findByTestId(
      "diagnostics-reset-log-levels",
    );
    resetButton.focus();
    expect(document.activeElement).toBe(resetButton);

    fireEvent.click(resetButton);

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

    const focusTarget = screen
      .getByTestId("settings-log-level-cli")
      .closest("[tabindex='-1']");
    expect(focusTarget instanceof HTMLElement).toBe(true);
    if (!(focusTarget instanceof HTMLElement)) return;
    expect(focusTarget.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(focusTarget);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("preserves the select trigger focus when a row change removes the reminder", async () => {
    const { fixture } = renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "debug", hostLogLevel: "info" },
    });

    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();

    const cliTrigger = await openLogLevelSelect("cli");
    await chooseLogLevelOption("Info (default)");

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
    await waitFor(() => {
      expect(document.activeElement).toBe(cliTrigger);
    });
  });

  it("does not add an aggregate toast for a single-scope reset failure", async () => {
    const attempted: Array<string> = [];
    vi.mocked(toast.error).mockClear();
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "debug", hostLogLevel: "info" },
      overrideHandlers: {
        "config.logLevels.set": (request) => {
          attempted.push(request.scope);
          throw new Error("cli set failed");
        },
      },
    });

    fireEvent.click(await screen.findByTestId("diagnostics-reset-log-levels"));

    // The write was attempted and rejected - this is the failing path, not a
    // reset that quietly had nothing to do.
    await waitFor(() => {
      expect(attempted).toEqual(["cli"]);
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    // With one control, the mutation's own host-error toast already said it -
    // an aggregate line would double-report a single failure. The message is
    // NOT pinned: `toastFromHostError` maps host error codes to their own copy,
    // and this test is about the second toast that must not exist.
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining("Couldn't reset"),
    );
    // The level stayed elevated, so the reminder is still up.
    expect(screen.getByTestId("diagnostics-log-detail-reminder")).toBeTruthy();
  });

  it("continues resetting remaining scopes after one set() fails and toasts the aggregate", async () => {
    // Reset-all must attempt EVERY non-default scope even if an earlier one
    // rejects - previously a single outer try/catch stopped the loop early.
    const attempted: Array<{ scope: string; level: LogLevel }> = [];
    vi.mocked(toast.error).mockClear();
    renderPanelOverRpc({
      support: null,
      logLevels: { cliLogLevel: "warn", hostLogLevel: "error" },
      overrideHandlers: {
        "config.logLevels.set": (request) => {
          attempted.push({ scope: request.scope, level: request.level });
          if (request.scope === "cli") throw new Error("cli set failed");
          return { cliLogLevel: "warn", hostLogLevel: request.level };
        },
      },
    });

    expect(
      await screen.findByTestId("diagnostics-log-detail-reminder"),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("diagnostics-reset-log-levels"));

    // `host` is only reached if the loop kept going past `cli`'s rejection.
    await waitFor(() => {
      expect(attempted).toHaveLength(2);
    });
    expect(attempted).toContainEqual({ scope: "cli", level: "info" });
    expect(attempted).toContainEqual({ scope: "host", level: "info" });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Couldn't reset 1 of 2 log levels",
      );
    });

    // The failed cli scope stays elevated - reminder remains visible.
    expect(screen.getByTestId("diagnostics-log-detail-reminder")).toBeTruthy();
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

  it("states a REMOTE old host's version once, and drops the Log detail card rather than titling an empty one", async () => {
    installLogLevelsBridge(defaultSnapshot());
    renderPanelOverRpc({
      hostId: "host-old",
      hostName: "Old Box",
      isLocalMachine: false,
      support: makeSupportBridge({}),
      // Handshaked WITHOUT the config/diagnostics families.
      methods: ["host.status"],
    });

    const notices = await screen.findAllByTestId(
      "host-config-unsupported-notice",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toContain("running an older version");
    expect(screen.queryByTestId("settings-log-level-cli")).toBeNull();
    expect(screen.queryByTestId("settings-log-level-host")).toBeNull();

    // The logs region's notice covers "logs and log levels", so Log detail has
    // nothing left to say - and a titled card with an empty body is worse than
    // no card. This is the branch that made `LogDetailGroup` return null.
    expect(screen.queryByRole("heading", { name: "Log detail" })).toBeNull();
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
    expect(await screen.findByTestId("settings-log-level-cli")).toBeTruthy();
    expect(await screen.findByTestId("settings-log-level-host")).toBeTruthy();
    expect(screen.queryByTestId("settings-log-level-desktop")).toBeNull();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();

    // The bridge snapshot carries `desktop` and `host`; only the host half
    // belongs on this page.
    expect(await screen.findByText("Host Log")).toBeTruthy();
    expect(screen.queryByText("Desktop Log")).toBeNull();

    await openLogLevelSelect("host");
    await chooseLogLevelOption("Debug");

    // The write actually reached the local bridge, not an RPC handler - the
    // bridge is machine-user-global, so cli/host share one `set()`.
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

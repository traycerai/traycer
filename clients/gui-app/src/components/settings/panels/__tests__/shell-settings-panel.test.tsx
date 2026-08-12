// The panel is host-scoped now (shell config / log levels are fields of the
// selected host's own config), so it reads `useHostScope`. Mock at that
// boundary: these suites render the panel bare, without the host runtime and
// query providers the real hook needs.
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

// `useScopedHostBinding` (and the panel's own direct `useHostBinding()?.hostClient`
// reads) go through this module. Panel suites mock it wholesale rather than
// standing up a real `<HostRuntimeProvider>` - see `providers-settings-panel.test.tsx`
// and `provider-mcp-tab.test.tsx` for the same partial-object pattern.
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
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IRunnerHost,
  TraycerShellConfigSetInput,
} from "@traycer-clients/shared/platform/runner-host";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import {
  ALL_CONFIG_RPC_METHODS,
  CONFIG_SHELL_METHODS,
  buildConfigHostFixture,
  type ConfigHostFixture,
} from "@/components/settings/panels/__tests__/host-config-rpc-test-support";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  hostBindingMock.current = null;
});

// A non-login program: its family default is no flags, so switching to it must
// swap the flags row away from the login shell's "-i -l".
const CAT = {
  name: "cat",
  path: "/bin/cat",
  isDefault: false,
  source: "detected" as const,
  missing: false,
};

const SAVED_FLASH_MS = 1600;

/**
 * The panel over the config RPC path - the production path for every
 * reachable host, local or remote. Wires a real `HostClient` (over an
 * in-memory messenger delegating to a `MockTraycerCli`) as the SCOPED host's
 * client, so writes exercise the real `useHostQuery`/`useHostMutation` wiring
 * rather than a bridge stub.
 */
function renderShellPanelOverRpc(options: {
  readonly configure?: (cli: MockTraycerCli) => void;
  /** Supply the CLI when a handler override needs to close over it. */
  readonly cli?: MockTraycerCli;
  /** Replaces individual RPC handlers - e.g. to hold one write pending. */
  readonly overrideHandlers?: MockHandlerMap<HostRpcRegistry>;
  readonly hostId?: string;
  readonly isLocalMachine?: boolean;
  readonly connectable?: boolean;
  /**
   * Recorded via `recordNegotiatedHostMethods`. Defaults to the full shell
   * family (a host that has handshaked and supports everything); pass `null`
   * to record NOTHING for this host id — the "no handshake yet" tri-state,
   * distinct from a recorded-but-empty manifest.
   */
  readonly methods?: readonly string[] | null;
}): ConfigHostFixture {
  const hostId = options.hostId ?? "host-a";
  const isLocalMachine = options.isLocalMachine ?? true;
  const cli = options.cli ?? new MockTraycerCli();
  options.configure?.(cli);
  const fixture = buildConfigHostFixture({
    hostId,
    isLocalMachine,
    cli,
    overrideHandlers: options.overrideHandlers,
  });
  if (options.methods !== null) {
    recordNegotiatedHostMethods(
      hostId,
      options.methods ?? CONFIG_SHELL_METHODS,
    );
  }

  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine,
      connectable: options.connectable ?? true,
    }),
    hostId,
    status: "ready",
    client: fixture.client,
  };
  hostBindingMock.current = { hostClient: fixture.client };

  const runnerHost: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <ShellSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return fixture;
}

/**
 * This computer's host, unable to answer for itself: the panel falls back to
 * the CLI bridge. Covers BOTH `localConfigFallbackReason` outcomes for a local
 * host - `connectable: false` ("host-stopped", the default) or a connectable
 * host whose recorded manifest omits `config.shell.get` ("host-outdated").
 */
function renderShellPanelStoppedLocal(options: {
  readonly configure: (cli: MockTraycerCli) => void;
  readonly connectable?: boolean;
  /** Recorded via `recordNegotiatedHostMethods` when given; omitted otherwise (no handshake yet). */
  readonly methods?: readonly string[];
}): MockTraycerCli {
  const hostId = "host-a";
  const cli = new MockTraycerCli();
  options.configure(cli);
  if (options.methods !== undefined) {
    recordNegotiatedHostMethods(hostId, options.methods);
  }
  const connectable = options.connectable ?? false;
  scopeOverrides.current = {
    host: hostScopeOptionFixture({
      hostId,
      isLocalMachine: true,
      connectable,
    }),
    hostId,
    status: connectable ? "ready" : "unreachable",
  };
  const runnerHost: IRunnerHost = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: cli,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <ShellSettingsPanel />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
  return cli;
}

// Kept as a thin wrapper so the existing hierarchy/flags-row suites below stay
// unchanged apart from the transport underneath them.
function renderPanel(configure: (cli: MockTraycerCli) => void): MockTraycerCli {
  const fixture = renderShellPanelOverRpc({ configure });
  return fixture.cli;
}

function statusTexts(): string[] {
  return screen.getAllByRole("status").map((node) => node.textContent);
}

describe("<ShellSettingsPanel /> hierarchy", () => {
  it("labels the two cards with scope tags and puts the effective command first", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });

    const preview = await screen.findByLabelText("Effective shell command");
    const terminalCard = screen.getByTestId("terminal-shell-settings");
    const envCard = screen.getByTestId("host-environment-settings");

    expect(
      within(terminalCard).getByRole("heading", {
        name: "Terminal shell · New terminals",
      }),
    ).toBeTruthy();
    expect(
      within(envCard).getByRole("heading", {
        name: "Host environment · After restart",
      }),
    ).toBeTruthy();

    // Cards do not repeat their external labels as internal headings, and the
    // pre-redesign "Environment variables" / bare "Shell" card titles are gone.
    expect(
      within(terminalCard).queryByRole("heading", { name: "Shell" }),
    ).toBeNull();
    expect(
      within(envCard).queryByRole("heading", {
        name: "Environment variables",
      }),
    ).toBeNull();

    const programLabel = within(terminalCard).getByText("Shell program");
    expect(
      preview.compareDocumentPosition(programLabel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(preview).getByText("effective command")).toBeTruthy();
    expect(within(preview).getByText("/bin/zsh")).toBeTruthy();
    expect(within(preview).getByText("-i -l")).toBeTruthy();
  });

  it("does not reserve a persistent visible Saved footer or status line", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });

    await screen.findByText("Startup flags for zsh");

    // Pre-redesign SaveStatus always painted a visible "Saved" chip in the
    // card footers. Idle chrome must stay quiet.
    expect(screen.queryByText(/^Saved$/)).toBeNull();
    expect(screen.queryByText(/^Saving…$/)).toBeNull();
    expect(screen.queryByTestId("settings-shell-saving-spinner")).toBeNull();
    expect(
      screen.queryByTestId("settings-shell-program-saving-spinner"),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-shell-flags-saving-spinner"),
    ).toBeNull();
    expect(
      screen.queryByTestId("settings-shell-environment-saving-spinner"),
    ).toBeNull();

    const statuses = screen.getAllByRole("status");
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(status.getAttribute("aria-live")).toBe("polite");
      expect(status.classList.contains("sr-only")).toBe(true);
      expect(status.textContent).toBe("");
    }
  });

  it("announces transient saving/saved feedback beside the changed control", async () => {
    // Real timers only: waitFor + fake timers race easily, and the deferred
    // CLI mutation already gives a stable pending window.
    // Gate holds the mutation in pending; setFinished resolves only after the
    // full shellConfigSet (gate + originalSet) completes — not merely after
    // the gate opens.
    let releaseGate: (() => void) | null = null;
    const setGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let resolveSetFinished: (() => void) | null = null;
    const setFinished = new Promise<void>((resolve) => {
      resolveSetFinished = resolve;
    });

    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
      const originalSet = cli.shellConfigSet.bind(cli);
      cli.shellConfigSet = async (
        input: TraycerShellConfigSetInput,
      ): Promise<void> => {
        await setGate;
        try {
          await originalSet(input);
        } finally {
          resolveSetFinished?.();
        }
      };
    });

    await screen.findByText("Startup flags for zsh");

    // Live regions mount at the terminal group root (program first, flags
    // second), outside the config-dependent skeleton/content branch.
    const terminalGroup = screen.getByTestId("terminal-shell-settings");
    const terminalStatuses = within(terminalGroup).getAllByRole("status");
    expect(terminalStatuses.length).toBe(2);
    const flagsStatus = terminalStatuses[1];
    expect(flagsStatus.textContent).toBe("");

    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    await waitFor(() => {
      expect(
        screen.getByTestId("settings-shell-flags-saving-spinner"),
      ).toBeTruthy();
      // Same DOM node as idle; only text changes (fails if status remounts).
      expect(flagsStatus.textContent).toBe("Startup flags saving");
    });
    expect(
      within(screen.getByTestId("terminal-shell-settings")).getAllByRole(
        "status",
      )[1],
    ).toBe(flagsStatus);
    expect(
      screen.queryByTestId("settings-shell-program-saving-spinner"),
    ).toBeNull();
    // No permanent visible Saved/Saving label during the transient path either.
    expect(screen.queryByText(/^Saved$/)).toBeNull();
    expect(screen.queryByText(/^Saving…$/)).toBeNull();

    await act(async () => {
      releaseGate?.();
      await setFinished;
    });

    // Re-query the second group-root status so remounts are distinguished
    // from sync races on the captured reference.
    await waitFor(() => {
      expect(
        screen.queryByTestId("settings-shell-flags-saving-spinner"),
      ).toBeNull();
      const liveStatus = within(
        screen.getByTestId("terminal-shell-settings"),
      ).getAllByRole("status")[1];
      expect(liveStatus.textContent).toBe("Startup flags saved");
      expect(liveStatus).toBe(flagsStatus);
    });

    await waitFor(
      () => {
        const liveStatus = within(
          screen.getByTestId("terminal-shell-settings"),
        ).getAllByRole("status")[1];
        expect(liveStatus.textContent).toBe("");
        expect(liveStatus).toBe(flagsStatus);
        expect(statusTexts().every((text) => text === "")).toBe(true);
      },
      { timeout: SAVED_FLASH_MS + 1000 },
    );
  });
});

describe("<ShellSettingsPanel /> flags row", () => {
  it("names the flags row after the shell and shows the profile helper for a login shell", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });
    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.getByText(/loads your full shell profile/)).toBeTruthy();
  });

  it("swaps the flags row to the newly-selected shell (label + helper + chips)", async () => {
    renderPanel((cli) => {
      // Synthesised so the picker trigger reads "System default" (unambiguous
      // to target), while the flags row still names the resolved login shell.
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
      cli.detectedShells = [
        {
          name: "zsh",
          path: "/bin/zsh",
          isDefault: true,
          source: "detected",
          missing: false,
        },
        CAT,
      ];
    });

    // Starts on the login shell: profile helper present, flag chips shown.
    await screen.findByText("Startup flags for zsh");
    expect(screen.getByText(/loads your full shell profile/)).toBeTruthy();
    expect(screen.getByText("-i")).toBeTruthy();

    // Open the picker (its trigger reads "System default") and select cat.
    const trigger = screen.getByText("System default").closest("button");
    if (trigger === null) throw new Error("no picker trigger");
    fireEvent.click(trigger);
    const catRow = screen
      .getAllByRole("option")
      .find((row) => row.textContent.includes("/bin/cat"));
    if (catRow === undefined) throw new Error("no /bin/cat row");
    fireEvent.click(catRow);

    // The flags row follows the selection: label names cat, the profile helper
    // is replaced by the plain launch helper, and the login flags are gone.
    expect(await screen.findByText("Startup flags for cat")).toBeTruthy();
    expect(
      screen.getByText("Passed to cat each time a terminal opens."),
    ).toBeTruthy();
    expect(screen.queryByText(/loads your full shell profile/)).toBeNull();
    expect(await screen.findByText("No flags")).toBeTruthy();
  });

  it("keeps the System default row checked when editing flags on it", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"],
        synthesised: true,
      };
    });

    await screen.findByText("Startup flags for zsh");
    // The trigger reads "System default" — the auto state is active.
    expect(screen.getByText("System default")).toBeTruthy();

    // Add a flag chip via the "＋ flag" affordance. (Exact name: the
    // "Restore default flags" button also contains "flag".)
    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    // The new flag persists to the login shell's entry, but the selection stays
    // on the system default: the trigger still reads "System default".
    expect(await screen.findByText("-x")).toBeTruthy();
    expect(screen.getByText("System default")).toBeTruthy();
    expect(screen.getByText("Startup flags for zsh")).toBeTruthy();
  });

  // Restore stays on the flags row and is gated by `disabled`: predictable
  // placement, enabled exactly while the visible flags deviate from the
  // selected shell's family default.
  it("disables Restore default flags when the flags match the family default", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i", "-l"], // == family default for a login shell
        synthesised: true,
      };
    });
    await screen.findByText("Startup flags for zsh");
    const restore = screen.getByRole("button", {
      name: "Restore default flags",
    });
    expect(restore.hasAttribute("disabled")).toBe(true);
  });

  it("enables Restore default flags on a deviation and restores on click", async () => {
    renderPanel((cli) => {
      cli.shellConfig = {
        path: "/bin/zsh",
        args: ["-i"], // deviates from the -i -l family default
        synthesised: false,
      };
      cli.shellEntries = [{ path: "/bin/zsh", args: ["-i"] }];
    });

    // Wait for the config to load (the button renders immediately but stays
    // disabled until then), then it's enabled because the flags deviate.
    await screen.findByText("Startup flags for zsh");
    const restore = screen.getByRole("button", {
      name: "Restore default flags",
    });
    expect(restore.hasAttribute("disabled")).toBe(false);
    fireEvent.click(restore);

    // Flags return to the family default; the button stays rendered but is
    // disabled again.
    expect(await screen.findByText("-l")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Restore default flags" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

describe("<ShellSettingsPanel /> remote host over RPC", () => {
  it("renders the full editor for a remote, connectable host and writes go out as config.shell.* RPCs to that host's client", async () => {
    const fixture = renderShellPanelOverRpc({
      hostId: "host-remote",
      isLocalMachine: false,
      configure: (cli) => {
        cli.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
      },
    });

    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.getByTestId("terminal-shell-settings")).toBeTruthy();
    expect(screen.getByTestId("host-environment-settings")).toBeTruthy();
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();

    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("-x")).toBeTruthy();
    });
    // The write actually reached this host's mock CLI-backed handler — the
    // config.shell.set RPC delegates to it, so a value change here proves the
    // request was dispatched (and answered) rather than merely rendered.
    expect(fixture.cli.shellConfig.args).toContain("-x");
  });

  it("hides the native Browse affordance for a remote host (typed-path degrade)", async () => {
    renderShellPanelOverRpc({
      hostId: "host-remote",
      isLocalMachine: false,
      configure: (cli) => {
        cli.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
      },
    });

    const trigger = (await screen.findByText("System default")).closest(
      "button",
    );
    if (trigger === null) throw new Error("no picker trigger");
    fireEvent.click(trigger);

    expect(await screen.findByLabelText("Add a shell by path")).toBeTruthy();
    expect(screen.queryByText("Browse…")).toBeNull();
  });
});

describe("<ShellSettingsPanel /> host-config-unsupported degrade", () => {
  it("shows the unsupported notice, without crashing, for a REMOTE host handshaked without config.shell.get", async () => {
    renderShellPanelOverRpc({
      hostId: "host-old",
      isLocalMachine: false,
      // Handshaked WITHOUT the shell family — an old host.
      methods: ["host.status"],
      configure: (cli) => {
        cli.shellConfig = { path: "/bin/zsh", args: [], synthesised: true };
      },
    });

    const notice = await screen.findByTestId("host-config-unsupported-notice");
    expect(notice.textContent).toContain("running an older version");
    expect(screen.queryByTestId("terminal-shell-settings")).toBeNull();
    expect(screen.queryByText("Startup flags for zsh")).toBeNull();
    // A remote host has no local truth to fall back to — it never takes the
    // bridge notice, only the capability one.
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
  });
});

describe("<ShellSettingsPanel /> local host falls back to the CLI bridge", () => {
  it('host-stopped: reads and writes through the CLI bridge, with data-reason="host-stopped"', async () => {
    const cli = renderShellPanelStoppedLocal({
      configure: (cli) => {
        cli.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
      },
      connectable: false,
    });

    const notice = await screen.findByTestId("local-config-fallback-notice");
    expect(notice.getAttribute("data-reason")).toBe("host-stopped");
    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();

    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    // The write actually reached the local CLI bridge, not an RPC handler.
    await waitFor(() => {
      expect(cli.shellConfig.args).toContain("-x");
    });
    expect(await screen.findByText("-x")).toBeTruthy();
  });

  // The widened case: a RUNNING, connectable local host whose handshake did
  // not carry `config.shell.get` (the fleet-update window — the app updated
  // before the host it manages) still gets a working, bridge-backed page
  // instead of the capability notice.
  it('host-outdated: a connectable local host with an old manifest still uses the bridge, with data-reason="host-outdated"', async () => {
    const cli = renderShellPanelStoppedLocal({
      configure: (cli) => {
        cli.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
      },
      connectable: true,
      methods: ["host.status"], // handshaked WITHOUT config.shell.get
    });

    const notice = await screen.findByTestId("local-config-fallback-notice");
    expect(notice.getAttribute("data-reason")).toBe("host-outdated");
    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();

    const addFlag = screen.getByRole("button", { name: "＋ flag" });
    fireEvent.click(addFlag);
    const flagInput = screen.getByRole("textbox", { name: "New shell flag" });
    fireEvent.change(flagInput, { target: { value: "-x" } });
    fireEvent.keyDown(flagInput, { key: "Enter" });

    await waitFor(() => {
      expect(cli.shellConfig.args).toContain("-x");
    });
    expect(await screen.findByText("-x")).toBeTruthy();
  });

  // The tri-state guard: a local, CONNECTABLE host with no recorded manifest
  // at all ("not dialled yet", not "unsupported") must take the RPC path, not
  // the bridge — collapsing the tri-state to a boolean would divert it here
  // permanently, before its own first RPC ever produced an answer.
  it("does not fall back for a connectable local host with no handshake recorded yet", async () => {
    const fixture = renderShellPanelOverRpc({
      hostId: "host-a",
      isLocalMachine: true,
      connectable: true,
      methods: null,
      configure: (cli) => {
        cli.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
      },
    });

    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();
    // Loaded from the RPC-backed fixture client, not the bridge.
    expect(fixture.cli.shellConfig.path).toBe("/bin/zsh");
  });
});

// The negotiated-manifest registry never clears a stale `false` answer on its
// own - `useHostCapabilityProbe` is what re-dials a parked host so a page that
// promises "update the host and this fills in on its own" can keep that
// promise. These pins prove the probe actually dispatched (not merely that
// the panel changed state for some other reason), then prove the RPC path
// resumes once a fresh handshake and a bumped incarnation land.
describe("<ShellSettingsPanel /> capability-probe self-heal", () => {
  it("remote host: probes host.status while parked, then resumes the RPC editor once the host re-handshakes with the shell family", async () => {
    const hostId = "host-old";
    const cli = new MockTraycerCli();
    cli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    const fixture = buildConfigHostFixture({
      hostId,
      isLocalMachine: false,
      cli,
    });
    // Handshaked WITHOUT the shell family - parks the panel on the unsupported notice.
    recordNegotiatedHostMethods(hostId, ["host.status"]);

    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId,
        isLocalMachine: false,
        connectable: true,
        version: "1.5.0",
      }),
      hostId,
      status: "ready",
      client: fixture.client,
    };
    hostBindingMock.current = { hostClient: fixture.client };

    const runnerHost: IRunnerHost = new MockRunnerHost({
      signInUrl: "https://example.invalid/signin",
      authnBaseUrl: "https://example.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
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
        isLocalMachine: false,
        connectable: true,
        version: "1.5.1",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(fixture.hostStatusCalls()).toBeGreaterThan(callsWhileParked);
    });

    // Now simulate the host updating in place: a fresh handshake carries the
    // shell family, and the host's own incarnation bumps again.
    recordNegotiatedHostMethods(hostId, ALL_CONFIG_RPC_METHODS);
    scopeOverrides.current = {
      ...scopeOverrides.current,
      host: hostScopeOptionFixture({
        hostId,
        isLocalMachine: false,
        connectable: true,
        version: "1.6.0",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();
    expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
  });

  it("local, connectable, outdated host: probes host.status while parked on the bridge, then resumes the RPC editor once the host re-handshakes", async () => {
    const hostId = "host-a";
    const bridgeCli = new MockTraycerCli();
    bridgeCli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    const rpcCli = new MockTraycerCli();
    rpcCli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    // Backs the probe's client (and the eventual RPC editor) - independent of
    // the local bridge's own MockTraycerCli, since a "host-outdated" host
    // reads/writes through the bridge until it heals.
    const fixture = buildConfigHostFixture({
      hostId,
      isLocalMachine: true,
      cli: rpcCli,
    });
    // Handshaked WITHOUT the shell family - the fleet-update window.
    recordNegotiatedHostMethods(hostId, ["host.status"]);

    scopeOverrides.current = {
      host: hostScopeOptionFixture({
        hostId,
        isLocalMachine: true,
        connectable: true,
        version: "1.5.0",
      }),
      hostId,
      status: "ready",
      client: fixture.client,
    };
    hostBindingMock.current = { hostClient: fixture.client };

    const runnerHost: IRunnerHost = new MockRunnerHost({
      signInUrl: "https://example.invalid/signin",
      authnBaseUrl: "https://example.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: bridgeCli,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    const notice = await screen.findByTestId("local-config-fallback-notice");
    expect(notice.getAttribute("data-reason")).toBe("host-outdated");
    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();

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
        isLocalMachine: true,
        connectable: true,
        version: "1.5.1",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
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
        isLocalMachine: true,
        connectable: true,
        version: "1.6.0",
      }),
    };
    rerender(
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <ShellSettingsPanel />
        </RunnerHostProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("local-config-fallback-notice")).toBeNull();
    });
    expect(screen.queryByTestId("host-config-unsupported-notice")).toBeNull();
    expect(await screen.findByText("Startup flags for zsh")).toBeTruthy();
  });
});

describe("<ShellSettingsPanel /> env rename survives unmount", () => {
  /**
   * The rename is ONE operation, and this pins the property the repair rests
   * on: both writes live inside a single `mutationFn`, so neither half is
   * carried by a per-`mutate` callback.
   *
   * The discriminating instant is the SET being in flight when the panel goes
   * away - not the delete. In the defective shape (`setEnv(..., { onSuccess:
   * () => deleteEnv(old) })`) a set that resolves while still mounted fires
   * its callback normally and the delete goes out, so holding the DELETE
   * pending proves nothing: both shapes pass. Hold the SET across the unmount
   * and the shapes separate - TanStack drops the per-`mutate` callbacks of an
   * observer that is gone, so the defective shape never dispatches the delete
   * and the rename leaves TWO live variables, while the repaired one completes
   * inside its own `mutationFn`.
   */
  it("drops the old key when the set is still in flight as the panel unmounts", async () => {
    const cli = new MockTraycerCli();
    cli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    cli.envOverrides = [{ key: "OLD_NAME", value: "keep-me" }];

    let releaseSet: (() => void) | null = null;
    const setInFlight = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    let setDispatched: (() => void) | null = null;
    const setReached = new Promise<void>((resolve) => {
      setDispatched = resolve;
    });

    renderShellPanelOverRpc({
      cli,
      overrideHandlers: {
        "config.env.set": async (request) => {
          setDispatched?.();
          await setInFlight;
          await cli.envOverrideSet(request);
          return { key: request.key, value: request.value };
        },
      },
    });

    const nameInput = await screen.findByRole("textbox", {
      name: "Name for OLD_NAME",
    });
    fireEvent.change(nameInput, { target: { value: "NEW_NAME" } });
    // Blur directly: the row commits in `onBlur`, and Enter only gets there by
    // calling `.blur()` on the focused element - which jsdom no-ops when the
    // input was never focused, so a keyDown alone commits nothing.
    fireEvent.blur(nameInput);

    // The rename is genuinely airborne before the panel goes away; without
    // this the unmount could precede the request and prove nothing.
    await act(async () => {
      await setReached;
    });

    cleanup();

    await act(async () => {
      releaseSet?.();
      await Promise.resolve();
    });

    // Terminal state of the store the host will read: renamed, not duplicated.
    // BOTH halves in one condition. The set writes NEW_NAME before the delete
    // runs, so waiting on NEW_NAME alone awaits an intermediate state and the
    // follow-up assertion could fail a CORRECT implementation the moment the
    // delete lands a microtask later.
    await waitFor(() => {
      const keys = cli.envOverrides.map((row) => row.key);
      expect(keys).toContain("NEW_NAME");
      expect(keys).not.toContain("OLD_NAME");
    });
  });

  /**
   * The SAME property on the stopped-local fallback. The bridge speaks IPC
   * rather than host RPC, which tempted a comment claiming it had "no
   * cross-observer boundary to lose the delete at" - but the boundary that
   * loses the second half is the OBSERVER, not the transport, so a delete
   * chained onto the set's per-`mutate` callback was dropped here exactly as
   * it was on the RPC path. This is the user-facing path for a host that is
   * stopped or predates the config methods, so it needs its own pin.
   */
  it("drops the old key on the bridge fallback when the set is still in flight as the panel unmounts", async () => {
    let releaseSet: (() => void) | null = null;
    const setInFlight = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    let setDispatched: (() => void) | null = null;
    const setReached = new Promise<void>((resolve) => {
      setDispatched = resolve;
    });

    const cli = renderShellPanelStoppedLocal({
      configure: (target) => {
        target.shellConfig = {
          path: "/bin/zsh",
          args: ["-i", "-l"],
          synthesised: true,
        };
        target.envOverrides = [{ key: "OLD_NAME", value: "keep-me" }];
        const originalSet = target.envOverrideSet.bind(target);
        target.envOverrideSet = async (input): Promise<void> => {
          setDispatched?.();
          await setInFlight;
          await originalSet(input);
        };
      },
    });

    expect(
      await screen.findByTestId("local-config-fallback-notice"),
    ).toBeTruthy();
    const nameInput = await screen.findByRole("textbox", {
      name: "Name for OLD_NAME",
    });
    fireEvent.change(nameInput, { target: { value: "NEW_NAME" } });
    fireEvent.blur(nameInput);

    await act(async () => {
      await setReached;
    });

    cleanup();

    await act(async () => {
      releaseSet?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      const keys = cli.envOverrides.map((row) => row.key);
      expect(keys).toContain("NEW_NAME");
      expect(keys).not.toContain("OLD_NAME");
    });
  });
});

describe("<ShellSettingsPanel /> partially failed rename refreshes the editor", () => {
  /**
   * A rename is two writes, so it has a THIRD outcome besides success and
   * failure: the set lands and the delete rejects, leaving both keys on the
   * host. Invalidating only in `onSuccess` skips that path entirely, so the
   * editor keeps rendering the pre-rename list over a config the host will
   * actually read. Both controllers invalidate on SETTLEMENT for this reason.
   */
  it("shows the new key after the delete half fails, on the RPC path", async () => {
    const cli = new MockTraycerCli();
    cli.shellConfig = {
      path: "/bin/zsh",
      args: ["-i", "-l"],
      synthesised: true,
    };
    cli.envOverrides = [{ key: "OLD_NAME", value: "keep-me" }];

    renderShellPanelOverRpc({
      cli,
      overrideHandlers: {
        "config.env.delete": () =>
          Promise.reject(new Error("delete refused by the host")),
      },
    });

    const nameInput = await screen.findByRole("textbox", {
      name: "Name for OLD_NAME",
    });
    fireEvent.change(nameInput, { target: { value: "NEW_NAME" } });
    fireEvent.blur(nameInput);

    // The set landed, so the store holds BOTH keys; the editor must refetch
    // and show that rather than sitting on its pre-rename snapshot.
    expect(
      await screen.findByRole("textbox", { name: "Name for NEW_NAME" }),
    ).toBeTruthy();
    expect(cli.envOverrides.map((row) => row.key)).toContain("OLD_NAME");
  });

  // NOTE: there is deliberately no bridge-path twin of this test. One was
  // written and PROVED VACUOUS - it passed with the invalidation reverted to
  // `onSuccess`-only, because something else on that path refreshes the list
  // before the assertion runs. The bridge controller still invalidates on
  // settlement, for symmetry with the RPC twin above and because the failure
  // mode is identical; it is simply not pinned here rather than pinned by a
  // test that cannot fail. Do not re-add one in this shape.
});

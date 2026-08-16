import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalLaunchPanel } from "@/components/home/composer/terminal-launch-panel";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";
import { modLabel } from "@/lib/keybindings/platform";

const panelMocks = vi.hoisted(() => ({
  providers: [
    { providerId: "claude-code", terminalAgentArgs: "--from-settings" },
  ],
  // S11 coverage (see the new "forwards a non-null hostId..." test below):
  // records every argument these mocks receive so a test can assert the
  // panel's `hostId` prop actually reaches the launch host's client, the
  // `providers.list` read, and the picker - not just that SOME client/host
  // was used.
  hostClientCalls: [] as (string | null)[],
  providersListClients: [] as (string | null)[],
  pickerProps: [] as {
    readonly createProfileHostId: string | null;
    readonly runTargetHostId: string | null;
  }[],
}));

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: (props: {
    readonly createProfileHostId: string | null;
    readonly runTargetHostId: string | null;
  }) => {
    panelMocks.pickerProps.push({
      createProfileHostId: props.createProfileHostId,
      runTargetHostId: props.runTargetHostId,
    });
    return (
      <button type="button" aria-label="Harness picker">
        Claude
      </button>
    );
  },
}));

vi.mock("@/components/home/pickers/agent-mode-toggle", () => ({
  AgentModeToggle: () => (
    <button type="button" aria-label="Agent mode">
      Regular
    </button>
  ),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    data: { providers: panelMocks.providers },
  }),
  useProvidersListForClient: (client: string | null) => {
    panelMocks.providersListClients.push(client);
    return { data: { providers: panelMocks.providers } };
  },
}));

// The panel now resolves its launch host's client via
// `useHostClientForHostId(hostId)` (previously `useProvidersList()` read the
// app-wide default unconditionally) - that hook needs a
// `<HostRuntimeProvider>` this bare-render suite doesn't set up. Returning
// `hostId` itself as the sentinel "client" (mirroring the picker's own
// intent-RPC suite) lets a test assert WHICH host's client reached
// `useProvidersListForClient` without needing a real `HostClient`.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    panelMocks.hostClientCalls.push(hostId);
    return hostId;
  },
}));

function makeToolbarStore() {
  const store = createComposerToolbarStore({
    seedKey: "test",
    values: {
      permission: "supervised",
      selection: { harnessId: "claude", modelSlug: "", profileId: null },
      reasoning: "",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: true,
    hostId: "host-a",
  });
  // The Start gate reads the selected harness's runtime `modes` from the
  // catalog, so seed a loaded catalog where `claude` is TUI-capable - otherwise
  // Start stays disabled.
  store.getState().setCatalog({
    hostId: "host-a",
    harnesses: [
      {
        id: "claude",
        label: "Claude Code",
        enabled: true,
        available: true,
        error: null,
        modes: ["gui", "tui"],
        requiresApiKey: false,
        supportedPermissionModes: [
          "supervised",
          "auto_accept_edits",
          "full_access",
        ],
        availabilityPending: false,
      },
    ],
    modelsHarnessId: "claude",
    models: [],
    modelsLoaded: true,
    tuiOnly: true,
  });
  return store;
}

function makeGuiOnlyToolbarStore() {
  const store = createComposerToolbarStore({
    seedKey: "test",
    values: {
      permission: "supervised",
      selection: { harnessId: "traycer", modelSlug: "", profileId: null },
      reasoning: "",
      serviceTier: "",
    },
    onSettingsChange: null,
    tuiOnly: true,
    hostId: "host-a",
  });
  // A GUI-only harness cannot back a terminal agent. The Start gate follows
  // the runtime `modes` advertised by the host.
  store.getState().setCatalog({
    hostId: "host-a",
    harnesses: [
      {
        id: "traycer",
        label: "Traycer",
        enabled: true,
        available: true,
        error: null,
        modes: ["gui"],
        requiresApiKey: false,
        supportedPermissionModes: ["supervised", "full_access"],
        availabilityPending: false,
      },
    ],
    modelsHarnessId: "traycer",
    models: [],
    modelsLoaded: true,
    tuiOnly: true,
  });
  return store;
}

function renderPanel(onStart: (launch: TerminalAgentLaunch) => void) {
  return render(
    <TerminalLaunchPanel
      store={makeToolbarStore()}
      pending={false}
      disabledHint={null}
      hostId={null}
      onStart={onStart}
    />,
  );
}

describe("<TerminalLaunchPanel /> terminal-agent args handoff", () => {
  beforeEach(() => {
    panelMocks.providers = [
      { providerId: "claude-code", terminalAgentArgs: "--from-settings" },
    ];
    panelMocks.hostClientCalls.length = 0;
    panelMocks.providersListClients.length = 0;
    panelMocks.pickerProps.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the Start button visibly filled inside dialogs", () => {
    renderPanel(vi.fn());

    const start = screen.getByRole("button", { name: "Start agent" });
    expect(start.getAttribute("data-variant")).toBe("secondary");
    expect(start.className).toContain(
      "in-data-[slot=dialog-content]:bg-input/60",
    );
  });

  it("prefills Settings args but sends null when the field is untouched", () => {
    const onStart = vi.fn();
    renderPanel(onStart);

    const input = screen.getByLabelText<HTMLInputElement>(
      "Terminal interface CLI arguments",
    );
    expect(input.value).toBe("--from-settings");

    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessId: "claude",
        terminalAgentArgs: null,
      }),
    );
  });

  it("sends an explicit empty-string override after the field is edited", () => {
    const onStart = vi.fn();
    renderPanel(onStart);

    fireEvent.change(
      screen.getByLabelText("Terminal interface CLI arguments"),
      {
        target: { value: "" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalAgentArgs: "",
      }),
    );
  });

  it("sends edited non-empty args verbatim", () => {
    const onStart = vi.fn();
    renderPanel(onStart);

    fireEvent.change(
      screen.getByLabelText("Terminal interface CLI arguments"),
      {
        target: { value: "--dangerously-skip-permissions" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalAgentArgs: "--dangerously-skip-permissions",
      }),
    );
  });

  it("starts the agent with Cmd+Enter from anywhere on the surface", () => {
    const onStart = vi.fn();
    renderPanel(onStart);

    const startButton = screen.getByRole("button", { name: "Start agent" });
    expect(startButton.textContent).toContain(modLabel());
    expect(startButton.textContent).toContain("↵");

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ harnessId: "claude" }),
    );
  });

  it("blocks Start for a GUI-only harness", () => {
    const onStart = vi.fn();
    render(
      <TooltipProvider>
        <TerminalLaunchPanel
          store={makeGuiOnlyToolbarStore()}
          pending={false}
          disabledHint={null}
          hostId={null}
          onStart={onStart}
        />
      </TooltipProvider>,
    );

    const start = screen.getByRole("button", { name: "Start agent" });
    expect(start.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(start);
    expect(onStart).not.toHaveBeenCalled();
  });

  // S11 coverage: a regression back to the app-wide default host would leave
  // `useHostClientForHostId`, `providers.list`, and the picker all pinned to
  // `null` regardless of the `hostId` prop - this asserts the non-null host
  // actually threads through every one of them, not just that the panel
  // renders without crashing.
  it("forwards a non-null hostId to the launch host's client, the providers.list read, and the picker's createProfileHostId/runTargetHostId", () => {
    render(
      <TerminalLaunchPanel
        store={makeToolbarStore()}
        pending={false}
        disabledHint={null}
        hostId="host-b"
        onStart={vi.fn()}
      />,
    );

    expect(panelMocks.hostClientCalls).toContain("host-b");
    expect(panelMocks.hostClientCalls).not.toContain(null);
    expect(panelMocks.providersListClients.at(-1)).toBe("host-b");
    expect(panelMocks.pickerProps.at(-1)).toEqual({
      createProfileHostId: "host-b",
      runTargetHostId: "host-b",
    });
  });
});

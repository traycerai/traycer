import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalLaunchPanel } from "@/components/home/composer/terminal-launch-panel";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TerminalAgentLaunch } from "@/components/home/hooks/use-landing-composer-actions";

const panelMocks = vi.hoisted(() => ({
  providers: [
    { providerId: "claude-code", terminalAgentArgs: "--from-settings" },
  ],
}));

vi.mock("@/components/home/pickers/harness-model-picker", () => ({
  HarnessModelPicker: () => (
    <button type="button" aria-label="Harness picker">
      Claude
    </button>
  ),
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
}));

function makeToolbarStore() {
  const store = createComposerToolbarStore({
    seedKey: "test",
    values: {
      permission: "supervised",
      selection: { harnessId: "claude", modelSlug: "", profileId: null },
      reasoning: "",
      serviceTier: "",
      agentMode: "regular",
    },
    onSettingsChange: null,
    tuiOnly: true,
  });
  // The Start gate reads the selected harness's runtime `modes` from the
  // catalog, so seed a loaded catalog where `claude` is TUI-capable - otherwise
  // Start stays disabled.
  store.getState().setCatalog({
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
      agentMode: "regular",
    },
    onSettingsChange: null,
    tuiOnly: true,
  });
  // A GUI-only harness cannot back a terminal agent. The Start gate follows
  // the runtime `modes` advertised by the host.
  store.getState().setCatalog({
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
      onStart={onStart}
    />,
  );
}

describe("<TerminalLaunchPanel /> terminal-agent args handoff", () => {
  beforeEach(() => {
    panelMocks.providers = [
      { providerId: "claude-code", terminalAgentArgs: "--from-settings" },
    ];
  });

  afterEach(() => {
    cleanup();
  });

  it("prefills Settings args but sends null when the field is untouched", () => {
    const onStart = vi.fn();
    renderPanel(onStart);

    const input = screen.getByLabelText<HTMLInputElement>(
      "Terminal agent CLI arguments",
    );
    expect(input.value).toBe("--from-settings");

    fireEvent.click(
      screen.getByRole("button", { name: "Start terminal agent" }),
    );

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

    fireEvent.change(screen.getByLabelText("Terminal agent CLI arguments"), {
      target: { value: "" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Start terminal agent" }),
    );

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalAgentArgs: "",
      }),
    );
  });

  it("sends edited non-empty args verbatim", () => {
    const onStart = vi.fn();
    renderPanel(onStart);

    fireEvent.change(screen.getByLabelText("Terminal agent CLI arguments"), {
      target: { value: "--dangerously-skip-permissions" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Start terminal agent" }),
    );

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalAgentArgs: "--dangerously-skip-permissions",
      }),
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
          onStart={onStart}
        />
      </TooltipProvider>,
    );

    const start = screen.getByRole("button", { name: "Start terminal agent" });
    expect(start.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(start);
    expect(onStart).not.toHaveBeenCalled();
  });
});

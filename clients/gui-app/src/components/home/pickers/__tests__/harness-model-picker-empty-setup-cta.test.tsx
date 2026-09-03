import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { ModelRowsState } from "../harness-model-picker-empty";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
}));

vi.mock("@/hooks/providers/use-landing-provider-terminal-login", () => ({
  useLandingProviderStartTerminalLogin: () => ({
    start: mocks.start,
    isPending: false,
  }),
}));

// Mirrors the fixture shape in `harness-model-picker-empty-report-issue.test.tsx`
// (kept local rather than imported since that file does not export it).
function harnessEntry(
  overrides: Partial<GuiHarnessCatalogEntry>,
): GuiHarnessCatalogEntry {
  return {
    id: "claude",
    label: "Claude",
    enabled: true,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    supportedPermissionModes: ["full_access"],
    availabilityPending: false,
    models: [],
    modelsLoading: false,
    modelsError: null,
    ...overrides,
  };
}

// The `providers.list` row for `providerId`, carrying a `loginCapability` that
// declares terminal-login support - this is what gates the setup CTA now,
// not the guidance table alone (see `resolveProviderTerminalSetup`).
function terminalLoginCapableState(
  providerId: ProviderId,
  oauthArgs: ReadonlyArray<string>,
): ProviderCliState {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "unauthenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: {
      oauthArgs: [...oauthArgs],
      token: null,
      codePaste: null,
      terminalLogin: {},
    },
    availabilityPending: false,
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"],
      mcp: null,
      plugins: null,
      skills: null,
      modelProviders: null,
    },
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
  };
}

function catalogErrorFor(message: string): HostRpcError {
  return new HostRpcError({
    code: "RPC_ERROR",
    message,
    requestId: "req-1",
    method: "agent.gui.listModels",
    fatalDetails: null,
  });
}

describe("<ModelRowsState /> provider setup CTA (reasonix)", () => {
  afterEach(() => {
    cleanup();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
      reportIssueDraftId: 0,
    });
    mocks.start.mockClear();
  });

  it("renders the setup CTA for a reasonix entry with the signed-out modelsError: steps + manual command, no button, no report-issue action", () => {
    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    const provider = harnessEntry({
      id: "reasonix",
      label: "Reasonix",
      modelsError: catalogErrorFor(providerSignedOutMessage("reasonix")),
    });
    render(
      ModelRowsState({
        catalogLoading: false,
        catalogError: false,
        hostUnavailableLabel: null,
        hasQuery: false,
        activeProvider: provider,
        activeProviderState: terminalLoginCapableState("reasonix", ["setup"]),
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
        terminalLoginSurface: null,
        runTargetHostId: null,
        onClosePicker: () => undefined,
      }),
    );

    expect(screen.getByText("Set up Reasonix")).toBeDefined();
    expect(
      screen.getByText(
        "Reasonix keeps provider API keys in its own store, not in your shell environment.",
      ),
    ).toBeDefined();
    const code = screen.getByText("reasonix setup", { selector: "code" });
    expect(code).toBeDefined();
    expect(
      screen.getByText(
        "Choose “Set up in terminal” from a chat's model picker or the start page's. It opens Reasonix's setup wizard on the host that composer runs on.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Paste your provider API key when asked (DeepSeek by default).",
      ),
    ).toBeDefined();
    expect(screen.getByText("Refresh this list.")).toBeDefined();

    // No button of any kind - not "Open Settings" (the CTA no longer writes
    // the focus store or takes a click handler), and not "Report issue"
    // (reportIssueAvailable is true here, so its absence is the CTA's own
    // doing, not the feature being globally off).
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the host reason row and report-issue action for a reasonix entry with a DIFFERENT error message", () => {
    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    const provider = harnessEntry({
      id: "reasonix",
      label: "Reasonix",
      modelsError: catalogErrorFor("spawn failed: ENOENT"),
    });
    render(
      ModelRowsState({
        catalogLoading: false,
        catalogError: false,
        hostUnavailableLabel: null,
        hasQuery: false,
        activeProvider: provider,
        activeProviderState: terminalLoginCapableState("reasonix", ["setup"]),
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
        terminalLoginSurface: null,
        runTargetHostId: null,
        onClosePicker: () => undefined,
      }),
    );

    expect(screen.queryByText("Set up Reasonix")).toBeNull();
    screen.getByRole("option", { name: "spawn failed: ENOENT" });
    expect(screen.getByRole("button", { name: "Report issue" })).toBeDefined();
  });

  it("keeps the old host reason row for a non-guidance provider (claude) even with the signed-out message", () => {
    const provider = harnessEntry({
      id: "claude",
      label: "Claude",
      modelsError: catalogErrorFor(providerSignedOutMessage("claude-code")),
    });
    render(
      ModelRowsState({
        catalogLoading: false,
        catalogError: false,
        hostUnavailableLabel: null,
        hasQuery: false,
        activeProvider: provider,
        // claude-code signs in headlessly - no `providers.list` row would
        // ever declare it terminal-login capable.
        activeProviderState: null,
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
        terminalLoginSurface: null,
        runTargetHostId: null,
        onClosePicker: () => undefined,
      }),
    );

    expect(screen.queryByText(/^Set up /)).toBeNull();
    screen.getByRole("option", {
      name: providerSignedOutMessage("claude-code"),
    });
  });

  it("renders the setup guidance (steps + manual command, no button) for reasonix even though the providers.list row has not resolved yet (activeProviderState: null) - capability-absent now preserves the override instead of hiding it", () => {
    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    const provider = harnessEntry({
      id: "reasonix",
      label: "Reasonix",
      modelsError: catalogErrorFor(providerSignedOutMessage("reasonix")),
    });
    render(
      ModelRowsState({
        catalogLoading: false,
        catalogError: false,
        hostUnavailableLabel: null,
        hasQuery: false,
        activeProvider: provider,
        activeProviderState: null,
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
        // A landing surface IS available here, to prove the button's absence
        // comes from `canStartTerminal: false` (the host never declared the
        // capability), not merely from having nowhere to open a terminal.
        terminalLoginSurface: {
          kind: "landing",
          resolveLandingPageId: () => "draft-1",
        },
        runTargetHostId: null,
        onClosePicker: () => undefined,
      }),
    );

    expect(screen.getByText("Set up Reasonix")).toBeDefined();
    expect(
      screen.getByText(
        "Reasonix keeps provider API keys in its own store, not in your shell environment.",
      ),
    ).toBeDefined();
    const code = screen.getByText("reasonix setup", { selector: "code" });
    expect(code).toBeDefined();
    // "unsupported-host" placement: the post-action steps alone, never the
    // no-surface sentence naming a button this host cannot draw.
    const steps = screen.getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual([
      "Paste your provider API key when asked (DeepSeek by default).",
      "Refresh this list.",
    ]);
    expect(
      screen.queryByText(
        "Choose “Set up in terminal” from a chat's model picker or the start page's. It opens Reasonix's setup wizard on the host that composer runs on.",
      ),
    ).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("renders the terminal action and post-action steps when a landing terminalLoginSurface is provided", () => {
    const provider = harnessEntry({
      id: "reasonix",
      label: "Reasonix",
      modelsError: catalogErrorFor(providerSignedOutMessage("reasonix")),
    });
    const onClosePicker = vi.fn();
    render(
      ModelRowsState({
        catalogLoading: false,
        catalogError: false,
        hostUnavailableLabel: null,
        hasQuery: false,
        activeProvider: provider,
        activeProviderState: terminalLoginCapableState("reasonix", ["setup"]),
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
        terminalLoginSurface: {
          kind: "landing",
          resolveLandingPageId: () => "draft-1",
        },
        runTargetHostId: null,
        onClosePicker,
      }),
    );

    const button = screen.getByRole("button", { name: /Set up in terminal/ });
    expect(button).toBeDefined();
    // With the terminal action present the step list is just the post-action
    // steps - it no longer opens with the no-surface sentence naming where the
    // button lives, since the button is right here.
    const steps = screen.getAllByRole("listitem");
    expect(steps[0]?.textContent).toContain(
      "Paste your provider API key when asked",
    );
    expect(
      screen.queryByText(
        "Choose “Set up in terminal” from a chat's model picker or the start page's. It opens Reasonix's setup wizard on the host that composer runs on.",
      ),
    ).toBeNull();

    expect(mocks.start).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onClosePicker).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("resolves the landing page id via resolveLandingPageId() BEFORE calling start, and passes the resolved id through to it", () => {
    const provider = harnessEntry({
      id: "reasonix",
      label: "Reasonix",
      modelsError: catalogErrorFor(providerSignedOutMessage("reasonix")),
    });
    const resolveLandingPageId = vi.fn(() => "resolved-draft-7");
    const onClosePicker = vi.fn();
    render(
      ModelRowsState({
        catalogLoading: false,
        catalogError: false,
        hostUnavailableLabel: null,
        hasQuery: false,
        activeProvider: provider,
        activeProviderState: terminalLoginCapableState("reasonix", ["setup"]),
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
        terminalLoginSurface: { kind: "landing", resolveLandingPageId },
        runTargetHostId: null,
        onClosePicker,
      }),
    );

    expect(resolveLandingPageId).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Set up in terminal/ }));

    expect(resolveLandingPageId).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    // The resolver's return - not the surface literal, not a stale id - is
    // exactly what reaches `start`, which is what the landing hook opens the
    // panel with (see `useLandingProviderStartTerminalLogin`'s own tests).
    expect(mocks.start).toHaveBeenCalledWith("resolved-draft-7");
    // And it ran BEFORE start, per `LandingSetupTerminalButton`'s ordering:
    // the draft has to be bound before the host can be asked to open a
    // terminal against it.
    const resolveOrder = resolveLandingPageId.mock.invocationCallOrder[0];
    const startOrder = mocks.start.mock.invocationCallOrder[0];
    expect(resolveOrder).toBeDefined();
    expect(startOrder).toBeDefined();
    expect(resolveOrder).toBeLessThan(startOrder);
  });

  it("with no terminalLoginSurface, renders no button and leads with the guidance's noSurfaceStep", () => {
    const provider = harnessEntry({
      id: "reasonix",
      label: "Reasonix",
      modelsError: catalogErrorFor(providerSignedOutMessage("reasonix")),
    });
    render(
      ModelRowsState({
        catalogLoading: false,
        catalogError: false,
        hostUnavailableLabel: null,
        hasQuery: false,
        activeProvider: provider,
        activeProviderState: terminalLoginCapableState("reasonix", ["setup"]),
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
        terminalLoginSurface: null,
        runTargetHostId: null,
        onClosePicker: () => undefined,
      }),
    );

    expect(
      screen.queryByRole("button", { name: /Set up in terminal/ }),
    ).toBeNull();
    const steps = screen.getAllByRole("listitem");
    expect(steps[0]?.textContent).toBe(
      "Choose “Set up in terminal” from a chat's model picker or the start page's. It opens Reasonix's setup wizard on the host that composer runs on.",
    );
  });

  it("renders the default 'Sign in from a terminal' CTA for copilot (capability present, no guidance override)", () => {
    const provider = harnessEntry({
      id: "copilot",
      label: "Copilot",
      modelsError: catalogErrorFor(providerSignedOutMessage("copilot")),
    });
    const onClosePicker = vi.fn();
    render(
      ModelRowsState({
        catalogLoading: false,
        catalogError: false,
        hostUnavailableLabel: null,
        hasQuery: false,
        activeProvider: provider,
        activeProviderState: terminalLoginCapableState("copilot", ["login"]),
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
        terminalLoginSurface: {
          kind: "landing",
          resolveLandingPageId: () => "draft-1",
        },
        runTargetHostId: null,
        onClosePicker,
      }),
    );

    const button = screen.getByRole("button", {
      name: /Sign in from a terminal/,
    });
    expect(button).toBeDefined();
    // Copilot has no manual-command override - `manualCommand: null` - so the
    // "Installed the CLI yourself?" line must not render for it.
    expect(screen.queryByText(/Installed the CLI yourself\?/)).toBeNull();

    expect(mocks.start).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onClosePicker).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it("renders the plain host reason row, not the setup CTA, for copilot with capability absent (no guidance override to fall back on)", () => {
    const provider = harnessEntry({
      id: "copilot",
      label: "Copilot",
      modelsError: catalogErrorFor(providerSignedOutMessage("copilot")),
    });
    render(
      ModelRowsState({
        catalogLoading: false,
        catalogError: false,
        hostUnavailableLabel: null,
        hasQuery: false,
        activeProvider: provider,
        activeProviderState: null,
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
        terminalLoginSurface: {
          kind: "landing",
          resolveLandingPageId: () => "draft-1",
        },
        runTargetHostId: null,
        onClosePicker: () => undefined,
      }),
    );

    expect(screen.queryByText(/^Set up /)).toBeNull();
    screen.getByRole("option", { name: providerSignedOutMessage("copilot") });
  });
});

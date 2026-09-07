import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { ModelRowsState } from "../harness-model-picker-empty";

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
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
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
        "From a chat, choose “Set up in terminal” in the banner above the composer. It opens Reasonix's setup wizard on the host this composer runs on.",
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
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
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
        rowsCount: 0,
        onOpenProviderSettings: () => undefined,
      }),
    );

    expect(screen.queryByText(/^Set up /)).toBeNull();
    screen.getByRole("option", {
      name: providerSignedOutMessage("claude-code"),
    });
  });
});

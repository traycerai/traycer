import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
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
    useProvidersFocusStore.getState().clearFocusHarnessId();
  });

  it("renders the setup CTA for a reasonix entry with the signed-out modelsError, with an Open Settings button and no report-issue action", () => {
    const onOpenProviderSettings = () => undefined;
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
        onOpenProviderSettings,
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
        "Paste your provider API key when asked (DeepSeek by default).",
      ),
    ).toBeDefined();
    expect(screen.getByText("Refresh this list.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(useProvidersFocusStore.getState().focusHarnessId).toBe("reasonix");
  });

  it("keeps the host reason row and report-issue action for a reasonix entry with a DIFFERENT error message", () => {
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

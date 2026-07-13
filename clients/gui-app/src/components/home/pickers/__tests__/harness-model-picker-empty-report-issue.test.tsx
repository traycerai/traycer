import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type { GuiHarnessCatalogEntry } from "@/hooks/harnesses/use-gui-harness-catalog";
import { ModelRowsState } from "../harness-model-picker-empty";

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

function renderRowsState(
  props: Omit<Parameters<typeof ModelRowsState>[0], "onOpenProviderSettings">,
): void {
  render(
    <TooltipProvider>
      {ModelRowsState({ ...props, onOpenProviderSettings: () => undefined })}
    </TooltipProvider>,
  );
}

describe("<ModelRowsState /> catalog and model failure report actions", () => {
  afterEach(() => {
    cleanup();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
      reportIssueDraftId: 0,
    });
  });

  it("hides the report action on catalog error when capability is unavailable", () => {
    renderRowsState({
      catalogLoading: false,
      catalogError: true,
      hasQuery: false,
      activeProvider: null,
      rowsCount: 0,
    });

    screen.getByRole("option", { name: "Couldn't load providers" });
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("reports only fixed generic context for a catalog load failure", () => {
    renderRowsState({
      catalogLoading: false,
      catalogError: true,
      hasQuery: false,
      activeProvider: null,
      rowsCount: 0,
    });

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Couldn't load providers",
        message: "The harness/provider catalog could not be loaded.",
        code: null,
        source: "Model picker",
      },
    });
  });

  it("keeps the report button outside the disabled option row so it stays independently accessible", () => {
    renderRowsState({
      catalogLoading: false,
      catalogError: true,
      hasQuery: false,
      activeProvider: null,
      rowsCount: 0,
    });

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    const reportButton = screen.getByRole("button", { name: "Report issue" });

    // A `role="option"` element's descendants are flattened/disabled by
    // assistive tech, so the action must not be nested inside the
    // `aria-disabled="true"` option row - only a sibling of it.
    expect(reportButton.closest('[role="option"]')).toBeNull();
    expect(reportButton.closest('[aria-disabled="true"]')).toBeNull();
    expect(reportButton.hasAttribute("disabled")).toBe(false);
    // The option row itself is still present, describing the same failure.
    expect(
      screen.getByRole("option", { name: "Couldn't load providers" }),
    ).toBeTruthy();
  });

  it("reports only fixed generic context for a selected-provider model load failure, never the raw host message", () => {
    const provider = harnessEntry({
      modelsError: new HostRpcError({
        code: "RPC_ERROR",
        message: "secret-token-should-never-render /Users/hostile/path",
        requestId: "req-1",
        method: "agent.gui.listModels",
        fatalDetails: null,
      }),
    });
    renderRowsState({
      catalogLoading: false,
      catalogError: false,
      hasQuery: false,
      activeProvider: provider,
      rowsCount: 0,
    });

    // The raw host reason is still shown to the user inline (existing UX) -
    // only the report context must stay generic.
    screen.getByRole("option", {
      name: "secret-token-should-never-render /Users/hostile/path",
    });
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Couldn't load models",
        message: "Models for the selected provider could not be loaded.",
        code: null,
        source: "Model picker",
      },
    });
    const context = useDesktopDialogStore.getState().reportIssueContext;
    expect(JSON.stringify(context)).not.toContain("secret-token");
    expect(JSON.stringify(context)).not.toContain("/Users/hostile/path");
  });

  it("does not surface a report action for benign empty/no-model states", () => {
    renderRowsState({
      catalogLoading: false,
      catalogError: false,
      hasQuery: false,
      activeProvider: null,
      rowsCount: 0,
    });
    screen.getByRole("option", { name: "No models available" });
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    cleanup();
    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    renderRowsState({
      catalogLoading: true,
      catalogError: false,
      hasQuery: false,
      activeProvider: null,
      rowsCount: 0,
    });
    screen.getByRole("option", { name: "Loading models" });
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("does not surface a report action for the missing-API-key CTA", () => {
    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    const provider = harnessEntry({
      available: false,
      requiresApiKey: true,
    });
    renderRowsState({
      catalogLoading: false,
      catalogError: false,
      hasQuery: false,
      activeProvider: provider,
      rowsCount: 0,
    });

    screen.getByRole("button", { name: "Add API key" });
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });
});

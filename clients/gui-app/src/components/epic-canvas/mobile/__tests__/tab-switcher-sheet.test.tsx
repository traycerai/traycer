import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabSwitcherSheet } from "@/components/epic-canvas/mobile/tab-switcher-sheet";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";

const mobileState = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => mobileState.value,
  isMobileViewport: () => mobileState.value,
}));

// The category bodies pull the epic projection / host queries; this test covers
// the shell + tabs + persistence, so stub the lists to markers.
vi.mock("@/components/epic-canvas/mobile/switcher-agents-list", () => ({
  SwitcherAgentsList: () => <div data-testid="mock-agents-list" />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-terminals-list", () => ({
  SwitcherTerminalsList: () => <div data-testid="mock-terminals-list" />,
}));
vi.mock("@/components/epic-canvas/mobile/switcher-artifacts-list", () => ({
  SwitcherArtifactsList: () => <div data-testid="mock-artifacts-list" />,
}));

const TAB_ID = "tab-switcher-test";
const CATEGORY_NAMES = [
  "Agents",
  "Artifacts",
  "File Tree",
  "Git Diff",
  "Terminals",
];

function renderSheet(open: boolean, onOpenChange: (open: boolean) => void) {
  return render(
    <TabSwitcherSheet
      epicId="epic-1"
      tabId={TAB_ID}
      open={open}
      onOpenChange={onOpenChange}
    />,
  );
}

describe("<TabSwitcherSheet />", () => {
  beforeEach(() => {
    mobileState.value = true;
    // Reset the shared left-panel store so category selection never leaks.
    useLeftPanelStore.setState({ activePanelIdByTabId: {} });
  });
  afterEach(cleanup);

  it("renders exactly the five curated category tabs when open on mobile", () => {
    renderSheet(true, () => {});
    for (const name of CATEGORY_NAMES) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(screen.getAllByRole("tab")).toHaveLength(5);
  });

  it("defaults to the Agents category and shows its body", () => {
    renderSheet(true, () => {});
    expect(screen.getByTestId("mock-agents-list")).toBeTruthy();
  });

  it("persists a category selection to the left-panel store and swaps the body", async () => {
    const user = userEvent.setup();
    renderSheet(true, () => {});
    await user.click(screen.getByRole("tab", { name: "Artifacts" }));
    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "artifacts",
    );
    expect(screen.getByTestId("mock-artifacts-list")).toBeTruthy();
  });

  it("renders nothing when closed (controlled open prop)", () => {
    renderSheet(false, () => {});
    expect(screen.queryByTestId("mobile-tab-switcher-sheet")).toBeNull();
  });

  it("renders nothing on desktop even when asked to open", () => {
    mobileState.value = false;
    renderSheet(true, () => {});
    expect(screen.queryByTestId("mobile-tab-switcher-sheet")).toBeNull();
  });
});

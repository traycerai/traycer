import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabSwitcherSheet } from "@/components/epic-canvas/mobile/tab-switcher-sheet";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicArtifactRef,
  EpicCanvasTileRef,
  TilePane,
  WorkspaceFileRef,
} from "@/stores/epics/canvas/types";

// Source of the mobile-shell hit-slop CSS the sheet imports (via
// `data-mobile-shell-touch-scope`), read so the root-fix invariant - the slop
// `::after` must never paint - is asserted against the real rule; jsdom can't
// compute a coarse-pointer pseudo-element. Vitest's cwd is the gui-app root.
const touchTargetsCss = readFileSync(
  join(
    process.cwd(),
    "src/components/layout/shell/mobile-shell-touch-targets.css",
  ),
  "utf8",
);

const mobileState = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => mobileState.value,
  isMobileViewport: () => mobileState.value,
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
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
vi.mock("@/components/epic-canvas/mobile/switcher-panel-embed", () => ({
  SwitcherPanelEmbed: () => <div data-testid="mock-panel-embed" />,
}));

const TAB_ID = "tab-switcher-test";
const CATEGORY_NAMES = [
  "Chats",
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

  it("labels the chats category 'Chats' and renders the active tab as an underline, not a box", () => {
    renderSheet(true, () => {});
    const active = screen.getByRole("tab", { name: "Chats" });
    expect(active.getAttribute("data-state")).toBe("active");
    // The base `data-active:bg-*` fill is neutralised, so the active line tab
    // never paints a solid fill behind the label.
    expect(active.className).toContain("data-active:bg-transparent");
    // The visible active indicator is a collision-free `::before` underline. The
    // trigger's single `::after` is claimed by the mobile touch hit-slop, so
    // ui/tabs' `after:bg-foreground` indicator legitimately stays in the class
    // list (the shared touch CSS neutralises its paint) and is NOT re-overridden
    // here - re-adding `after:bg-transparent` would be a redundant second
    // mechanism.
    expect(active.className).toContain("after:bg-foreground");
    expect(active.className).toContain("before:bg-foreground");
    expect(active.className).toContain("data-active:before:opacity-100");
  });

  it("forces the mobile touch hit-slop ::after transparent so a merged indicator can't box the tab", () => {
    // Root fix (mobile-shell-touch-targets.css): the hit-slop shares each
    // trigger's single `::after`; without a transparent background it merges with
    // ui/tabs' `after:bg-foreground` active indicator and paints a full-cover,
    // near-white box over the label on touch (coarse-pointer) devices.
    expect(touchTargetsCss).toMatch(
      /tabs-trigger"\]\)::after\s*\{[^}]*background:\s*transparent/,
    );
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

function artifactRef(id: string, instanceId: string): EpicArtifactRef {
  return { id, instanceId, type: "spec", name: id, hostId: "host-A" };
}

function workspaceFileRef(id: string, instanceId: string): WorkspaceFileRef {
  return {
    id,
    instanceId,
    type: "workspace-file",
    name: id,
    hostId: "host-A",
    workspacePath: "/ws",
    filePath: id,
  };
}

function seedCanvas(
  tilesByInstanceId: Record<string, EpicCanvasTileRef>,
  activeTabId: string,
): void {
  const root: TilePane = {
    kind: "pane",
    id: "pane-A",
    tabInstanceIds: Object.keys(tilesByInstanceId),
    activeTabId,
    previewTabId: null,
    activationHistory: [activeTabId],
  };
  useEpicCanvasStore.setState({
    tabsById: { [TAB_ID]: { tabId: TAB_ID, epicId: "epic-1", name: "Epic 1" } },
    canvasByTabId: {
      [TAB_ID]: {
        root,
        activePaneId: "pane-A",
        tilesByInstanceId,
        sizesByGroupId: {},
      },
    },
  });
}

describe("<TabSwitcherSheet /> close-on-open", () => {
  beforeEach(() => {
    mobileState.value = true;
    useLeftPanelStore.setState({ activePanelIdByTabId: {} });
  });
  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("closes when a file-tree/git-diff tap lands an embed-originated tile", () => {
    const tiles = {
      "inst-1": artifactRef("a1", "inst-1"),
      "inst-2": workspaceFileRef("f1", "inst-2"),
    };
    seedCanvas(tiles, "inst-1");
    const onOpenChange = vi.fn();
    renderSheet(true, onOpenChange);
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => seedCanvas(tiles, "inst-2")); // shown tile -> workspace-file
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open when a background chat/artifact open changes the shown tile", () => {
    const tiles = {
      "inst-1": artifactRef("a1", "inst-1"),
      "inst-2": artifactRef("a2", "inst-2"),
    };
    seedCanvas(tiles, "inst-1");
    const onOpenChange = vi.fn();
    renderSheet(true, onOpenChange);
    // A background handoff/remote-delete lands a non-embed tile as shown.
    act(() => seedCanvas(tiles, "inst-2"));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("stays open when only the category changes (no tile opened)", async () => {
    const user = userEvent.setup();
    seedCanvas({ "inst-1": artifactRef("a1", "inst-1") }, "inst-1");
    const onOpenChange = vi.fn();
    renderSheet(true, onOpenChange);
    await user.click(screen.getByRole("tab", { name: "Git Diff" }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

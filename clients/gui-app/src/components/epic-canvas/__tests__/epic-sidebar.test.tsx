import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EpicLeftPanelRail } from "@/components/epic-canvas/sidebar/epic-sidebar-rail";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import type {
  EpicCanvasDropPreview,
  EpicCanvasLeftPanelRailDragData,
} from "@/components/epic-canvas/dnd/dnd";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  DEFAULT_LEFT_PANEL_ID,
  moveLeftPanelGroup,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";

interface CapturedDroppableInput {
  readonly id: string;
  readonly data: unknown;
}

interface TestState {
  droppableInputs: CapturedDroppableInput[];
  activeArtifactId: string | null;
  activeArtifact: { readonly kind: "spec" } | null;
}

const testState = vi.hoisted<TestState>(() => ({
  droppableInputs: [],
  activeArtifactId: null,
  activeArtifact: null,
}));

vi.mock("@dnd-kit/core", () => ({
  useDroppable: (input: CapturedDroppableInput) => {
    testState.droppableInputs.push(input);
    return {
      setNodeRef: () => undefined,
      isOver: false,
    };
  },
  useDraggable: () => ({
    setNodeRef: () => undefined,
    listeners: undefined,
    attributes: {},
    isDragging: false,
  }),
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useActiveEpicArtifactId: () => testState.activeArtifactId,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: () => testState.activeArtifact,
}));

const EPIC_ID = "epic-sidebar-test";
const TAB_ID = "epic-sidebar-tab";

function resetLeftPanelStore(): void {
  window.localStorage.clear();
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    mainCollapsedByTabId: {},
    panelSectionCollapsedByPanelId: {},
    commentsPanelRevealedByTabId: {},
    localRootCreatePendingByEpicPanel: {},
    acknowledgedRootCreatePendingByEpicPanel: {},
  });
}

function resetDndStore(): void {
  useEpicDndStore.getState().dragEnded();
}

function setRailDragState(
  source: EpicCanvasLeftPanelRailDragData,
  preview: EpicCanvasDropPreview,
): void {
  useEpicDndStore.setState({ activeSource: source, dropPreview: preview });
}

function resetTestState(): void {
  testState.droppableInputs = [];
  testState.activeArtifactId = null;
  testState.activeArtifact = null;
}

describe("<EpicLeftPanelRail />", () => {
  beforeEach(() => {
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
  });

  afterEach(() => {
    cleanup();
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
  });

  it("renders default registry panels and registers rail icon and background drop targets", () => {
    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    // Chats and Artifacts share one rail icon (combined-by-default group);
    // the primary panel id (chats) drives the rail test id.
    expect(screen.getByTestId("epic-rail-chats")).not.toBeNull();
    expect(screen.queryByTestId("epic-rail-artifacts")).toBeNull();
    expect(screen.getByTestId("epic-rail-terminals")).not.toBeNull();
    expect(screen.getByTestId("epic-rail-git-diff")).not.toBeNull();
    expect(screen.getByTestId("epic-rail-file-tree")).not.toBeNull();
    expect(screen.getByTestId("epic-rail-sharing")).not.toBeNull();
    expect(screen.queryByTestId("epic-rail-comments")).toBeNull();

    expect(
      testState.droppableInputs.find((input) =>
        input.id.startsWith("left-panel-rail-extraction-target:"),
      ),
    ).toBeUndefined();
    expect(
      testState.droppableInputs.find(
        (input) => input.id === `left-panel-rail-list-target:${EPIC_ID}`,
      ),
    ).not.toBeUndefined();
    expect(
      testState.droppableInputs.find(
        (input) => input.id === "left-panel-rail-target:chats",
      ),
    ).not.toBeUndefined();
  });

  it("switches inactive rail icons and toggles collapse on the active group", () => {
    useLeftPanelStore.getState().setMainCollapsed(TAB_ID, true);
    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    fireEvent.click(screen.getByTestId("epic-rail-terminals"));

    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "terminals",
    );
    expect(useLeftPanelStore.getState().isMainCollapsed(TAB_ID)).toBe(false);

    fireEvent.click(screen.getByTestId("epic-rail-terminals"));

    expect(useLeftPanelStore.getState().isMainCollapsed(TAB_ID)).toBe(true);
  });

  it("uses a bottom indicator instead of a filled tile for the active horizontal rail icon", () => {
    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="horizontal"
      />,
    );

    const activeRailButton = screen.getByTestId("epic-rail-chats");

    expect(activeRailButton.className).toContain("hover:bg-transparent");
    expect(activeRailButton.className).not.toContain("bg-accent");
    expect(activeRailButton.innerHTML).toContain("bottom-0");
  });

  it("renders comments only after reveal with an active commentable artifact", () => {
    testState.activeArtifactId = "artifact-1";
    testState.activeArtifact = { kind: "spec" };
    useLeftPanelStore.getState().revealCommentsPanel(TAB_ID);

    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    expect(screen.getByTestId("epic-rail-comments")).not.toBeNull();
  });

  it("shows the rail extraction slot for section-origin drops on rail background", () => {
    useLeftPanelStore
      .getState()
      .applyPanelGroups(
        moveLeftPanelGroup(
          useLeftPanelStore.getState().getPanelGroups(),
          "artifacts",
          DEFAULT_LEFT_PANEL_ID,
          "combine",
        ),
      );
    setRailDragState(
      {
        kind: "left-panel-rail-item",
        panelId: "artifacts",
        origin: "panel-section",
      },
      { kind: "left-panel-rail-list" },
    );

    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    expect(screen.getByTestId("epic-rail-panel-drop-slot")).not.toBeNull();
    expect(
      screen
        .getByTestId("epic-sidebar-rail")
        .lastElementChild?.getAttribute("data-testid"),
    ).toBe("epic-rail-panel-drop-slot");
  });

  it("renders one canonical rail boundary for equivalent before and after drops", () => {
    setRailDragState(
      {
        kind: "left-panel-rail-item",
        panelId: "sharing",
        origin: "rail",
      },
      {
        kind: "left-panel-rail",
        panelId: "terminals",
        position: "after",
      },
    );

    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    expect(screen.getAllByTestId("epic-rail-panel-drop-line")).toHaveLength(1);
    expect(screen.queryByTestId("epic-rail-panel-drop-slot")).toBeNull();
    expect(
      Array.from(screen.getByTestId("epic-sidebar-rail").children).map(
        (element) => element.getAttribute("data-testid"),
      ),
    ).toEqual([
      "epic-rail-chats",
      "epic-rail-terminals",
      "epic-rail-panel-drop-line",
      "epic-rail-git-diff",
      "epic-rail-pull-requests",
      "epic-rail-file-tree",
      "epic-rail-sharing",
    ]);
  });
});

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
import {
  prPresenceScopeKey,
  usePrPresenceStore,
} from "@/stores/epics/pr-presence-store";

interface CapturedDroppableInput {
  readonly id: string;
  readonly data: unknown;
}

interface TestState {
  droppableInputs: CapturedDroppableInput[];
  draggableInputs: CapturedDroppableInput[];
  activeArtifactId: string | null;
  activeArtifact: { readonly kind: "spec" } | null;
}

const testState = vi.hoisted<TestState>(() => ({
  droppableInputs: [],
  draggableInputs: [],
  activeArtifactId: null,
  activeArtifact: null,
}));

const tileNavigationMocks = vi.hoisted(() => ({
  openTileInEpic: vi.fn(),
  openTileInTab: vi.fn(),
  openTilePreviewInEpic: vi.fn(),
  openTilePreviewInTab: vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => tileNavigationMocks,
}));

vi.mock("@dnd-kit/core", () => ({
  useDroppable: (input: CapturedDroppableInput) => {
    testState.droppableInputs.push(input);
    return {
      setNodeRef: () => undefined,
      isOver: false,
    };
  },
  useDraggable: (input: CapturedDroppableInput) => {
    testState.draggableInputs.push(input);
    return {
      setNodeRef: () => undefined,
      listeners: undefined,
      attributes: {},
      isDragging: false,
    };
  },
}));

vi.mock("@/stores/epics/canvas/store", () => ({
  useActiveEpicArtifactId: () => testState.activeArtifactId,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: () => testState.activeArtifact,
}));

// The rail and panel hosts read PR presence under the CANVAS host - the Epic
// session's - which is the key `pr-panel-body.tsx` records it under. This
// suite used to seed the app-wide read instead; after the readers were
// re-pointed that mock would have been stranded (installed, never read) and
// the PR rail item would have silently vanished from every assertion below,
// which is exactly the producer/consumer split the re-point fixed.
vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => HOST_ID,
}));

const EPIC_ID = "epic-sidebar-test";
const TAB_ID = "epic-sidebar-tab";
const HOST_ID = "epic-sidebar-host";

function resetLeftPanelStore(): void {
  window.localStorage.clear();
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    panelGroups: DEFAULT_LEFT_PANEL_GROUPS,
    mainCollapsedByTabId: {},
    panelSectionCollapsedByPanelId: {},
    commentsPanelRevealedByTabId: {},
    panelVisibilityOverrideById: {},
    localRootCreatePendingByEpicPanel: {},
    acknowledgedRootCreatePendingByEpicPanel: {},
  });
}

/**
 * The Pull Requests panel is presence-gated, so the rail only carries its icon
 * once this epic has observed a PR. Rail-geometry tests want the full default
 * complement of groups, so they seed presence; the gate itself is covered
 * separately below.
 */
function setPullRequestPresence(hasPullRequests: boolean): void {
  usePrPresenceStore.setState({
    hasItemsByScopeKey: hasPullRequests
      ? { [prPresenceScopeKey(HOST_ID, EPIC_ID)]: true }
      : {},
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
  testState.draggableInputs = [];
  testState.activeArtifactId = null;
  testState.activeArtifact = null;
  tileNavigationMocks.openTileInEpic.mockClear();
}

describe("<EpicLeftPanelRail />", () => {
  beforeEach(() => {
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
    setPullRequestPresence(true);
  });

  afterEach(() => {
    cleanup();
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
    setPullRequestPresence(false);
  });

  it("does not open the graph when another rail entry is activated", () => {
    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    fireEvent.click(screen.getByTestId("epic-rail-terminals"));

    expect(tileNavigationMocks.openTileInEpic).not.toHaveBeenCalled();
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
        (input) =>
          input.id === `left-panel-rail-list-target:${EPIC_ID}:pane:${TAB_ID}`,
      ),
    ).not.toBeUndefined();
    expect(
      testState.droppableInputs.find(
        (input) => input.id === `left-panel-rail-target:chats:pane:${TAB_ID}`,
      ),
    ).not.toBeUndefined();
  });

  it("namespaces duplicate Epic rail registrations by view tab", () => {
    render(
      <>
        <EpicLeftPanelRail
          epicId={EPIC_ID}
          tabId="pane-a"
          orientation="vertical"
        />
        <EpicLeftPanelRail
          epicId={EPIC_ID}
          tabId="pane-b"
          orientation="vertical"
        />
      </>,
    );

    const ids = [
      ...testState.droppableInputs.map((input) => input.id),
      ...testState.draggableInputs.map((input) => input.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.endsWith(":pane:pane-a"))).toBe(true);
    expect(ids.some((id) => id.endsWith(":pane:pane-b"))).toBe(true);
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
        viewTabId: TAB_ID,
        panelId: "artifacts",
        origin: "panel-section",
      },
      { kind: "left-panel-rail-list", viewTabId: TAB_ID },
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
        viewTabId: TAB_ID,
        panelId: "sharing",
        origin: "rail",
      },
      {
        kind: "left-panel-rail",
        viewTabId: TAB_ID,
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

  describe("Pull Requests presence gate", () => {
    function renderRail() {
      return render(
        <EpicLeftPanelRail
          epicId={EPIC_ID}
          tabId={TAB_ID}
          orientation="vertical"
        />,
      );
    }

    it("keeps the rail icon while the epic has a PR", () => {
      renderRail();

      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();
    });

    it("drops the rail icon for an epic with no PRs", () => {
      setPullRequestPresence(false);
      renderRail();

      expect(screen.queryByTestId("epic-rail-pull-requests")).toBeNull();
      // The gate must not disturb its neighbours in the rail.
      expect(screen.getByTestId("epic-rail-git-diff")).not.toBeNull();
      expect(screen.getByTestId("epic-rail-file-tree")).not.toBeNull();
    });

    it("keeps the rail icon for a PR-less epic the user checked on", () => {
      setPullRequestPresence(false);
      useLeftPanelStore
        .getState()
        .setPanelVisibilityOverride("pull-requests", true);
      renderRail();

      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();
    });

    it("drops the rail icon for a populated epic the user unchecked", () => {
      useLeftPanelStore
        .getState()
        .setPanelVisibilityOverride("pull-requests", false);
      renderRail();

      expect(screen.queryByTestId("epic-rail-pull-requests")).toBeNull();
    });

    it("scopes presence to the active host", () => {
      // A baseline recorded under a different host must not reveal the panel
      // here - PR discovery is per (hostId, epicId).
      usePrPresenceStore.setState({
        hasItemsByScopeKey: {
          [prPresenceScopeKey("some-other-host", EPIC_ID)]: true,
        },
      });
      renderRail();

      expect(screen.queryByTestId("epic-rail-pull-requests")).toBeNull();
    });
  });
  describe("presence still reveals a gated panel", () => {
    function renderRail() {
      return render(
        <EpicLeftPanelRail
          epicId={EPIC_ID}
          tabId={TAB_ID}
          orientation="vertical"
        />,
      );
    }

    it("adds the Pull Requests icon the moment a PR is discovered", () => {
      setPullRequestPresence(false);
      renderRail();
      expect(screen.queryByTestId("epic-rail-pull-requests")).toBeNull();

      act(() => {
        setPullRequestPresence(true);
      });

      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();
    });

    it("adds the Comments icon the moment the panel is revealed", () => {
      testState.activeArtifactId = "artifact-1";
      testState.activeArtifact = { kind: "spec" };
      renderRail();
      expect(screen.queryByTestId("epic-rail-comments")).toBeNull();

      act(() => {
        useLeftPanelStore.getState().revealCommentsPanel(TAB_ID);
      });

      expect(screen.getByTestId("epic-rail-comments")).not.toBeNull();
    });

    it("keeps a panel the user switched off hidden when presence arrives", () => {
      // The whole point of the override: an explicit "off" outranks the
      // presence gate, in both directions and at any later moment.
      setPullRequestPresence(false);
      useLeftPanelStore
        .getState()
        .setPanelVisibilityOverride("pull-requests", false);
      useLeftPanelStore
        .getState()
        .setPanelVisibilityOverride("comments", false);
      testState.activeArtifactId = "artifact-1";
      testState.activeArtifact = { kind: "spec" };
      renderRail();

      act(() => {
        setPullRequestPresence(true);
        useLeftPanelStore.getState().revealCommentsPanel(TAB_ID);
      });

      expect(screen.queryByTestId("epic-rail-pull-requests")).toBeNull();
      expect(screen.queryByTestId("epic-rail-comments")).toBeNull();
    });

    it("resumes following presence once the override is cleared", () => {
      setPullRequestPresence(true);
      useLeftPanelStore
        .getState()
        .setPanelVisibilityOverride("pull-requests", false);
      renderRail();
      expect(screen.queryByTestId("epic-rail-pull-requests")).toBeNull();

      act(() => {
        useLeftPanelStore.getState().clearPanelVisibilityOverrides();
      });

      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();
    });
  });

  describe("rail context menu", () => {
    function renderRail() {
      return render(
        <EpicLeftPanelRail
          epicId={EPIC_ID}
          tabId={TAB_ID}
          orientation="vertical"
        />,
      );
    }

    function openRailMenu(): void {
      fireEvent.contextMenu(screen.getByTestId("epic-sidebar-rail"));
    }

    it("lists every panel with its current visibility", () => {
      testState.activeArtifactId = "artifact-1";
      testState.activeArtifact = { kind: "spec" };
      renderRail();
      openRailMenu();

      // Every panel in the registry is offered, not just the gated ones - the
      // menu is the only place a hidden panel can be found again.
      expect(
        screen
          .getAllByRole("menuitemcheckbox")
          .map((item) => item.textContent.replace(/No PRs yet|Needs.*/, "")),
      ).toEqual([
        "Agents",
        "Terminals",
        "Artifacts",
        "Git Diff",
        "Pull Requests",
        "File Tree",
        "Sharing",
        "Comments",
      ]);
      // Checked state mirrors the rail: PRs are present, comments are not yet
      // revealed.
      expect(
        screen
          .getByTestId("epic-rail-toggle-pull-requests")
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        screen
          .getByTestId("epic-rail-toggle-comments")
          .getAttribute("aria-checked"),
      ).toBe("false");
    });

    it("hides a panel when its item is unchecked", () => {
      renderRail();
      openRailMenu();

      fireEvent.click(screen.getByTestId("epic-rail-toggle-terminals"));

      expect(useLeftPanelStore.getState().panelVisibilityOverrideById).toEqual({
        terminals: false,
      });
      expect(screen.queryByTestId("epic-rail-terminals")).toBeNull();
    });

    it("reveals a presence-gated panel when its item is checked", () => {
      setPullRequestPresence(false);
      renderRail();
      expect(screen.queryByTestId("epic-rail-pull-requests")).toBeNull();

      openRailMenu();
      fireEvent.click(screen.getByTestId("epic-rail-toggle-pull-requests"));

      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();
    });

    it("stores nothing when the checked value already matches the panel's rule", () => {
      renderRail();
      openRailMenu();

      // Re-checking an already-visible panel must not freeze today's answer:
      // Pull Requests has to keep following PR discovery. Selecting closes the
      // menu, so the second toggle needs it reopened.
      fireEvent.click(screen.getByTestId("epic-rail-toggle-pull-requests"));
      openRailMenu();
      fireEvent.click(screen.getByTestId("epic-rail-toggle-pull-requests"));

      expect(useLeftPanelStore.getState().panelVisibilityOverrideById).toEqual(
        {},
      );
    });

    it("offers a direct hide for the icon that was right-clicked", () => {
      renderRail();

      fireEvent.contextMenu(screen.getByTestId("epic-rail-terminals"));
      fireEvent.click(screen.getByTestId("epic-rail-hide-pointed-panel"));

      expect(useLeftPanelStore.getState().panelVisibilityOverrideById).toEqual({
        terminals: false,
      });
    });

    it("omits the direct hide when the empty rail was right-clicked", () => {
      renderRail();
      openRailMenu();

      expect(screen.queryByTestId("epic-rail-hide-pointed-panel")).toBeNull();
    });

    it("targets the icon under the pointer, not the last one right-clicked", () => {
      renderRail();

      fireEvent.contextMenu(screen.getByTestId("epic-rail-terminals"));
      expect(
        screen.getByTestId("epic-rail-hide-pointed-panel").textContent,
      ).toBe("Hide 'Terminals'");

      // Rail background next: the capture-phase reset has to clear the panel
      // the previous right-click recorded.
      openRailMenu();
      expect(screen.queryByTestId("epic-rail-hide-pointed-panel")).toBeNull();
    });

    it("resets every override at once", () => {
      useLeftPanelStore.getState().setPanelVisibilityOverride("sharing", false);
      useLeftPanelStore.getState().setPanelVisibilityOverride("comments", true);
      renderRail();
      openRailMenu();

      fireEvent.click(screen.getByTestId("epic-rail-reset-panel-visibility"));

      expect(useLeftPanelStore.getState().panelVisibilityOverrideById).toEqual(
        {},
      );
    });

    it("omits the reset item while nothing is overridden", () => {
      renderRail();
      openRailMenu();

      expect(
        screen.queryByTestId("epic-rail-reset-panel-visibility"),
      ).toBeNull();
    });

    it("refuses to hide the last visible panel", () => {
      for (const panelId of [
        "terminals",
        "artifacts",
        "git-diff",
        "pull-requests",
        "file-tree",
        "sharing",
      ] as const) {
        useLeftPanelStore.getState().setPanelVisibilityOverride(panelId, false);
      }
      renderRail();
      openRailMenu();

      // Agents is all that is left; the body always renders some panel, so an
      // empty rail would leave nothing to click back with.
      const lastItem = screen.getByTestId("epic-rail-toggle-chats");
      expect(lastItem.getAttribute("data-disabled")).not.toBeNull();
      expect(screen.queryByTestId("epic-rail-hide-pointed-panel")).toBeNull();

      fireEvent.click(lastItem);
      expect(
        useLeftPanelStore.getState().panelVisibilityOverrideById.chats,
      ).toBeUndefined();
    });

    it("highlights the fallback icon when the active panel is hidden", () => {
      useLeftPanelStore.getState().setActivePanelId(TAB_ID, "sharing");
      useLeftPanelStore.getState().setPanelVisibilityOverride("sharing", false);
      renderRail();

      // The body falls back to Agents, so the rail must mark Agents - not sit
      // with no icon current at all.
      expect(
        screen.getByTestId("epic-rail-chats").getAttribute("aria-current"),
      ).toBe("true");
    });
  });
});

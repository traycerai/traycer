import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Rail tooltips are HoverCards: with motion left on, closing one keeps its
// content mounted (opacity 0) through a real requestAnimationFrame-driven
// exit, which the suppression test below is not about (hover-card.test.tsx's
// own precedent for this same mock).
vi.mock("@/lib/animation/use-motion-enabled", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/animation/use-motion-enabled")>();
  return { ...actual, useMotionEnabled: () => false };
});
import {
  EpicLeftPanelHost,
  EpicLeftPanelLoadingHost,
} from "@/components/epic-canvas/sidebar/epic-sidebar";
import { EpicLeftPanelRail } from "@/components/epic-canvas/sidebar/epic-sidebar-rail";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import type {
  EpicCanvasDropPreview,
  EpicCanvasLeftPanelRailDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { type PanelVisibilityOverrideById } from "@/lib/left-panel-ids";
import {
  applyRail,
  currentLayoutArrangement,
  setRailVisibilityOverride,
} from "@/lib/layout/rail-view";
import { panelVisibilityOverridesFromValues } from "@/lib/layout/rail";
import {
  moveRailPanelBeside,
  stackRailPanels,
  unstackRail,
} from "@/lib/layout/layout-arrangement";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import {
  prPresenceScopeKey,
  usePrPresenceStore,
} from "@/stores/epics/pr-presence-store";
import {
  tabSurfaceKey,
  useSurfaceHostSelectionStore,
} from "@/stores/host/surface-host-selection-store";
import { SidebarProvider } from "@/components/ui/sidebar";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import { useSidebarRailWidthStore } from "@/stores/epics/sidebar-rail-width-store";

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

const browserPanelState = vi.hoisted(() => ({
  value: {
    lifecycle: "live" as const,
    items: [],
    errorMessage: null,
    retry: vi.fn(),
    closeTab: vi.fn(() => Promise.resolve()),
  },
}));

const browserCanvasState = vi.hoisted(() => ({
  prepareOpenTileInTabFocusTarget: vi.fn(),
  prepareSetActiveTileTabFocusTarget: vi.fn(),
}));

const tileNavigationMocks = vi.hoisted(() => ({
  openTile: vi.fn(),
}));
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => tileNavigationMocks,
}));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
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
  };
});

vi.mock("@/stores/epics/canvas/store", () => ({
  useActiveEpicArtifactId: () => testState.activeArtifactId,
  useEpicCanvasStore: (
    selector: (state: typeof browserCanvasState) => unknown,
  ) => selector(browserCanvasState),
  findOpenArtifactInTab: () => null,
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useBrowserSessionsContext: () => browserPanelState.value,
}));
// The panel reads the narrowed inventory selector, not the context above.
vi.mock("@/components/epic-canvas/renderers/use-browser-sessions", () => ({
  useBrowserSessionsInventory: () => ({
    items: browserPanelState.value.items,
    lifecycle: browserPanelState.value.lifecycle,
    errorMessage: browserPanelState.value.errorMessage,
    retry: browserPanelState.value.retry,
    closeTab: browserPanelState.value.closeTab,
  }),
}));
vi.mock("@/components/epic-canvas/renderers/browser-sessions-provider", () => ({
  BrowserSessionsHostProvider: (props: { readonly children: ReactNode }) =>
    props.children,
  BrowserSessionsHostBoundary: (props: { readonly children: ReactNode }) =>
    props.children,
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation:
    () => (_epicId: string, _tabId: string, prepare: () => unknown) =>
      prepare(),
}));

vi.mock("@/components/epic-canvas/sidebar/epic-terminal-sidebar", () => ({
  TerminalsPanelActions: () => null,
  TerminalsPanelBody: () => <div data-testid="epic-test-terminals-body" />,
}));

vi.mock("@/components/epic-canvas/pr/pr-panel-body", () => ({
  PrPanelBody: () => <div data-testid="epic-test-pr-body" />,
}));
vi.mock("@/components/epic-canvas/git-diff/git-diff-panel-body-live", () => ({
  GitDiffPanelBodyLive: () => <div data-testid="epic-test-git-diff-body" />,
}));

vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-artifact-tree", () => ({
  ArtifactReadLifecycleBridge: () => null,
  ArtifactTreePanelBody: () => null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: () => testState.activeArtifact,
  useEpicChatRecords: () => [],
  useEpicArtifactRecords: () => [],
  useAncestorIds: () => [],
  useRootIds: () => [],
  useEpicPermissionRole: () => "owner",
  useEpicConnectionStatus: () => "open",
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
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostDirectoryEntryForHostId: () => ({ label: "Test host" }),
  useHostClientForHostId: () => null,
}));

const EPIC_ID = "epic-sidebar-test";
const TAB_ID = "epic-sidebar-tab";
const PINNED_HOST_ID = "epic-sidebar-pinned-host";

// One client for the file's lifetime - a fresh one per render strands
// observers on the old one.
const testQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 0 },
    mutations: { retry: false },
  },
});
const HOST_ID = "epic-sidebar-host";

function resetLeftPanelStore(): void {
  window.localStorage.clear();
  useSurfaceHostSelectionStore.setState({ selections: {} });
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLeftPanelStore.setState({
    activePanelIdByTabId: {},
    mainCollapsedByTabId: {},
    panelSectionCollapsedByPanelId: {},
    panelSectionWeightsByPanelId: {},
    commentsPanelRevealedByTabId: {},
    localRootCreatePendingByEpicPanel: {},
    acknowledgedRootCreatePendingByEpicPanel: {},
  });
}

/** The rail's show/hide, which lives in the layout store now (one region each). */
function visibilityOverrides(): PanelVisibilityOverrideById {
  const state = useLayoutStore.getState();
  return panelVisibilityOverridesFromValues(
    effectiveLayoutValues(state.basePreset, state.overrides),
  );
}

/**
 * The Pull Requests panel is presence-gated, so the rail only carries its icon
 * once this epic has observed a PR. Rail-geometry tests want the full default
 * complement of panels, so they seed presence; the gate itself is covered
 * separately below.
 */
function setPullRequestPresenceForHost(
  hostId: string,
  hasPullRequests: boolean,
): void {
  usePrPresenceStore.setState({
    hasItemsByScopeKey: hasPullRequests
      ? { [prPresenceScopeKey(hostId, EPIC_ID)]: true }
      : {},
  });
}

function setPullRequestPresence(hasPullRequests: boolean): void {
  setPullRequestPresenceForHost(HOST_ID, hasPullRequests);
}

function pinPullRequestsTo(hostId: string): void {
  useSurfaceHostSelectionStore
    .getState()
    .setSelection(tabSurfaceKey("pull-requests", TAB_ID), hostId);
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
  tileNavigationMocks.openTile.mockClear();
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

    expect(tileNavigationMocks.openTile).not.toHaveBeenCalled();
  });

  it("renders default registry panels and registers rail icon and background drop targets", () => {
    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    // The shipped pair (Agents + Artifacts) draws as ONE group icon (G3): the
    // top panel's own button stands for both, and there is no separate
    // "epic-rail-artifacts" button while it is grouped.
    expect(screen.getByTestId("epic-rail-chats")).not.toBeNull();
    expect(screen.queryByTestId("epic-rail-artifacts")).toBeNull();
    expect(screen.getByTestId("epic-rail-terminals")).not.toBeNull();
    expect(screen.getByTestId("epic-rail-browsers")).not.toBeNull();
    expect(screen.getByTestId("epic-rail-git-diff")).not.toBeNull();
    expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();
    expect(screen.getByTestId("epic-rail-file-tree")).not.toBeNull();
    expect(screen.getByTestId("epic-rail-sharing")).not.toBeNull();
    expect(screen.queryByTestId("epic-rail-comments")).toBeNull();

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

  it("computes a combine cue from the MODEL's full stack, not from how many members are drawn (L-170, L-181)", () => {
    // Build a 4-member stack, then hide every member but Chats: it draws as a
    // LONE icon (no capsule at all), though the model still holds all four.
    // Reading the drawn shape instead of the model would offer a join this
    // stack cannot take.
    act(() => {
      let arrangement = currentLayoutArrangement();
      arrangement = stackRailPanels(
        arrangement,
        "terminals",
        "artifacts",
        "stack",
      );
      arrangement = stackRailPanels(
        arrangement,
        "browsers",
        "artifacts",
        "stack",
      );
      applyRail(arrangement.rail);
      setRailVisibilityOverride("artifacts", false);
      setRailVisibilityOverride("terminals", false);
      setRailVisibilityOverride("browsers", false);
    });

    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );
    expect(screen.queryAllByTestId("epic-rail-stack")).toHaveLength(0);

    act(() => {
      useEpicDndStore.getState().canvasDragStarted(
        {
          kind: "left-panel-rail-item",
          viewTabId: TAB_ID,
          panelId: "sharing",
          origin: "rail",
        },
        null,
      );
      useEpicDndStore.getState().dropPreviewChanged({
        kind: "left-panel-rail",
        viewTabId: TAB_ID,
        panelId: "chats",
        position: "combine",
      });
    });

    expect(screen.getByTestId("epic-rail-chats").className).toContain(
      "ring-destructive",
    );
    expect(screen.getByTestId("epic-rail-chats").className).not.toContain(
      "ring-primary",
    );
  });

  it("draws the shipped rail as eight direct children - the chats/artifacts capsule plus seven icons - with no dividers", () => {
    // "Every panel available": comments needs its own reveal + a commentable
    // artifact, same as `revealCommentsPanel` below.
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

    const rail = screen.getByTestId("epic-sidebar-rail");
    // The shipped pair (chats + artifacts) draws as ONE capsule (L-166,
    // L-167), so the rail's direct children are eight rather than nine: the
    // capsule and the remaining seven panels.
    expect(
      Array.from(rail.children).map((child) =>
        child.getAttribute("data-testid"),
      ),
    ).toEqual([
      "epic-rail-stack",
      "epic-rail-terminals",
      "epic-rail-browsers",
      "epic-rail-git-diff",
      "epic-rail-pull-requests",
      "epic-rail-file-tree",
      "epic-rail-sharing",
      "epic-rail-comments",
    ]);
    // The shipped rail (`DEFAULT_RAIL`) carries no divider entries - the
    // rail's own `gap-1` is the only spacing between icons, and no button
    // adds a margin of its own on top of it.
    expect(screen.queryAllByTestId("epic-rail-divider")).toHaveLength(0);
    expect(rail.className).toContain("gap-1");
    for (const child of Array.from(rail.children)) {
      expect(child.className).not.toMatch(/\bm[xytrbl]?-\d/);
    }
    // The capsule holds exactly the shipped pair, and draws ONE button for
    // it - the top's; Artifacts (the bottom, G3) draws none of its own.
    const stack = screen.getByTestId("epic-rail-stack");
    expect(stack.getAttribute("data-rail-stack")).toBe(
      "stack:railAgents+railArtifacts",
    );
    expect(
      Array.from(stack.querySelectorAll("button")).map((button) =>
        button.getAttribute("data-testid"),
      ),
    ).toEqual(["epic-rail-chats"]);
    expect(screen.queryByTestId("epic-rail-artifacts")).toBeNull();
    // The group's button carries every member's name (G3), not just the top
    // panel's own title.
    expect(
      screen.getByTestId("epic-rail-chats").getAttribute("aria-label"),
    ).toBe("Agents · Artifacts");
  });

  it("labels, counts and lights a 3-member stack's one icon for every member (L-181)", () => {
    act(() => {
      applyRail(
        stackRailPanels(
          currentLayoutArrangement(),
          "terminals",
          "artifacts",
          "stack",
        ).rail,
      );
    });
    useLeftPanelStore.getState().setActivePanelId(TAB_ID, "terminals");
    useLayoutEditorStore.getState().beginSession({
      entry: "pointer",
      source: "direct_ui",
      startedAt: 0,
      origin: { kind: "tab" },
    });

    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    expect(screen.queryAllByTestId("epic-rail-stack")).toHaveLength(1);
    const stack = screen.getByTestId("epic-rail-stack");
    expect(stack.getAttribute("data-rail-stack")).toBe(
      "stack:railAgents+railArtifacts+railTerminals",
    );
    expect(
      Array.from(stack.querySelectorAll("button")).map((button) =>
        button.getAttribute("data-testid"),
      ),
    ).toEqual(["epic-rail-chats"]);
    expect(
      screen.getByTestId("epic-rail-chats").getAttribute("aria-label"),
    ).toBe("Agents · Artifacts · Terminals");
    // Lit for Terminals - a non-top member - being the displayed panel.
    expect(
      screen.getByTestId("epic-rail-chats").getAttribute("aria-current"),
    ).toBe("true");
    // The count badge draws only while the editor is customizing this rail.
    expect(screen.getByTestId("epic-rail-stack-count").textContent).toBe("3");

    useLayoutEditorStore.getState().endSession();
  });

  // A stack's one icon answers a click as a lone panel's would: open the
  // stack when it is not showing, collapse the column when it is.
  it("opens its top panel's icon when neither member is showing", () => {
    useLeftPanelStore.getState().setActivePanelId(TAB_ID, "terminals");
    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    fireEvent.click(screen.getByTestId("epic-rail-chats"));

    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe("chats");
  });

  it("collapses the column when only a member that is NOT displayed is collapsed", () => {
    // Agents is displayed and open; Artifacts, collapsed, is a choice the
    // column already shows. The click used to re-open Artifacts (and make it
    // active) instead, one collapsed section per click, so the column
    // collapsed only once none was left.
    useLeftPanelStore.getState().togglePanelSectionCollapsed("artifacts");
    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    fireEvent.click(screen.getByTestId("epic-rail-chats"));

    expect(useLeftPanelStore.getState().isMainCollapsed(TAB_ID)).toBe(true);
    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe("chats");
    expect(
      useLeftPanelStore.getState().panelSectionCollapsedByPanelId.artifacts,
    ).toBe(true);
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

  it("switches inactive rail icons and toggles collapse on the active panel", () => {
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

  it("collapses on a click of the LIT icon, even when the active panel is hidden (R5R-09)", () => {
    // The rail lights whatever the body fell back to, so the click handler has
    // to compare against THAT and not against `activePanelId`. It used to take
    // the "switch panels" branch here, so the first click did nothing visible
    // and only the second collapsed the column.
    useLeftPanelStore.getState().setActivePanelId(TAB_ID, "chats");
    act(() => {
      setRailVisibilityOverride("chats", false);
    });
    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    // Agents is hidden, so the body and the rail both fall back to Artifacts.
    expect(screen.queryByTestId("epic-rail-chats")).toBeNull();
    expect(
      screen.getByTestId("epic-rail-artifacts").getAttribute("aria-current"),
    ).toBe("true");

    fireEvent.click(screen.getByTestId("epic-rail-artifacts"));

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

  it("shows the rail drop slot for a section-origin drop on rail background", () => {
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
    // The chats/artifacts capsule draws as ONE child (L-166, L-167), so the
    // canonical boundary line lands between the capsule and pull-requests'
    // neighbours rather than between two loose chats/artifacts icons.
    expect(
      Array.from(screen.getByTestId("epic-sidebar-rail").children).map(
        (element) => element.getAttribute("data-testid"),
      ),
    ).toEqual([
      "epic-rail-stack",
      "epic-rail-terminals",
      "epic-rail-panel-drop-line",
      "epic-rail-browsers",
      "epic-rail-git-diff",
      "epic-rail-pull-requests",
      "epic-rail-file-tree",
      "epic-rail-sharing",
    ]);
  });

  it("rings the combine target with the primary ring, not the old accent fill", () => {
    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    act(() => {
      useEpicDndStore.getState().canvasDragStarted(
        {
          kind: "left-panel-rail-item",
          viewTabId: TAB_ID,
          panelId: "sharing",
          origin: "rail",
        },
        null,
      );
      useEpicDndStore.getState().dropPreviewChanged({
        kind: "left-panel-rail",
        viewTabId: TAB_ID,
        panelId: "git-diff",
        position: "combine",
      });
    });

    const target = screen.getByTestId("epic-rail-git-diff");
    expect(target.className).toContain("ring-primary");
    expect(target.className.split(/\s+/)).not.toContain("bg-accent");
    expect(screen.getByTestId("epic-rail-terminals").className).not.toContain(
      "ring-primary",
    );
    expect(screen.getByTestId("epic-rail-sharing").className).not.toContain(
      "ring-primary",
    );

    act(() => {
      useEpicDndStore.getState().dropPreviewChanged({
        kind: "left-panel-rail",
        viewTabId: TAB_ID,
        panelId: "git-diff",
        position: "before",
      });
    });

    expect(screen.getByTestId("epic-rail-git-diff").className).not.toContain(
      "ring-primary",
    );
  });

  it("suppresses every rail tooltip while any drag is in flight, not just the source's own", () => {
    // Real timers: closing a HoverCard unmounts its content on a real
    // `setTimeout` once its (possibly zero-length) exit transition ends, so
    // the suppressed tooltip below needs one flushed to leave the DOM.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <EpicLeftPanelRail
          epicId={EPIC_ID}
          tabId={TAB_ID}
          orientation="vertical"
        />,
      );
      const terminalsButton = screen.getByTestId("epic-rail-terminals");

      fireEvent.focus(terminalsButton);
      expect(screen.getByRole("tooltip")).toBeTruthy();

      // "sharing" is the drag source, not "terminals" - which stays focused
      // throughout. The fix disables every rail tooltip for the duration of
      // ANY drag, not only the source icon's, so this already-open tooltip
      // is suppressed too.
      act(() => {
        useEpicDndStore.getState().canvasDragStarted(
          {
            kind: "left-panel-rail-item",
            viewTabId: TAB_ID,
            panelId: "sharing",
            origin: "rail",
          },
          null,
        );
      });
      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(screen.queryByRole("tooltip")).toBeNull();

      act(() => {
        useEpicDndStore.getState().dragEnded();
      });
      fireEvent.focus(terminalsButton);
      expect(screen.getByRole("tooltip")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands a rail label to the neighbouring icon's at once: the rail's icons share one HoverCardGroup", () => {
    // The rail is its own group (`epic-sidebar-rail.tsx`): the first label waits
    // for intent and the next icon's replaces it with no wait, so a sweep along
    // the rail reads one icon after another rather than a delay per icon.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <EpicLeftPanelRail
          epicId={EPIC_ID}
          tabId={TAB_ID}
          orientation="vertical"
        />,
      );
      const first = screen.getByTestId("epic-rail-terminals");
      const neighbour = screen.getByTestId("epic-rail-sharing");
      const settle = (ms: number) => {
        act(() => {
          vi.advanceTimersByTime(ms);
        });
      };
      const labels = (): ReadonlyArray<string> =>
        [...document.querySelectorAll('[data-slot="hover-card-content"]')].map(
          (label) => label.textContent,
        );

      fireEvent.pointerEnter(first, { pointerType: "mouse" });
      fireEvent.mouseEnter(first);
      settle(499);
      expect(labels()).toEqual([]);
      settle(1);
      expect(labels()).toEqual([first.getAttribute("aria-label")]);

      fireEvent.mouseLeave(first);
      fireEvent.pointerEnter(neighbour, { pointerType: "mouse" });
      fireEvent.mouseEnter(neighbour);
      // Two acts: the group closes the label before in an effect the
      // arriving label's own effect sets up, a scheduler task later.
      settle(1);
      settle(1);
      expect(labels()).toEqual([neighbour.getAttribute("aria-label")]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses the column even when the ACTIVE member's own section is collapsed", () => {
    // A stack draws every member at once, so which one is "active" is not on
    // screen; the lit icon toggles the column whatever the sections say
    // (VS Code's rule) and the next click brings the column back as it was.
    useLeftPanelStore.getState().togglePanelSectionCollapsed("chats");
    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    fireEvent.click(screen.getByTestId("epic-rail-chats"));

    expect(useLeftPanelStore.getState().isMainCollapsed(TAB_ID)).toBe(true);
    expect(
      useLeftPanelStore.getState().panelSectionCollapsedByPanelId.chats,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("epic-rail-chats"));

    expect(useLeftPanelStore.getState().isMainCollapsed(TAB_ID)).toBe(false);
    expect(
      useLeftPanelStore.getState().panelSectionCollapsedByPanelId.chats,
    ).toBe(true);
  });

  it("opens a stack on a member that is already open, changing no section", () => {
    useLeftPanelStore.getState().setActivePanelId(TAB_ID, "terminals");
    useLeftPanelStore.getState().togglePanelSectionCollapsed("chats");
    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    fireEvent.click(screen.getByTestId("epic-rail-chats"));

    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "artifacts",
    );
    expect(
      useLeftPanelStore.getState().panelSectionCollapsedByPanelId.chats,
    ).toBe(true);
  });

  /**
   * A divider is a spacer the user adds to the rail (L-155): at rest it draws
   * as the rail's own gap and nothing more, and it becomes a handle only for
   * the rail the user is actually customizing (L-109, R3-06). The shipped
   * rail carries none, so most of these seed one first.
   */
  describe("dividers", () => {
    function renderRail(paneVisible: boolean) {
      return render(
        <PaneVisibilityContext value={paneVisible}>
          <EpicLeftPanelRail
            epicId={EPIC_ID}
            tabId={TAB_ID}
            orientation="vertical"
          />
        </PaneVisibilityContext>,
      );
    }

    function seedRailWithDivider(): void {
      const rail = currentLayoutArrangement().rail;
      applyRail([
        ...rail.slice(0, 3),
        { kind: "divider", id: "divider:1" },
        ...rail.slice(3),
      ]);
    }

    afterEach(() => {
      useLayoutEditorStore.getState().endSession();
    });

    it("draws an added divider as a plain resting spacer outside a session", () => {
      seedRailWithDivider();

      renderRail(true);

      const dividers = screen.getAllByTestId("epic-rail-divider");
      expect(dividers).toHaveLength(1);
      expect(dividers[0].hasAttribute("data-rail-divider-resting")).toBe(true);
      expect(dividers[0].getAttribute("data-layout-draggable")).toBeNull();
    });

    it("becomes a draggable rail member while this pane is being customized", () => {
      seedRailWithDivider();
      useLayoutEditorStore.getState().beginSession({
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      });

      renderRail(true);

      const dividers = screen.getAllByTestId("epic-rail-divider");
      expect(dividers.length).toBeGreaterThan(0);
      for (const element of dividers) {
        expect(element.getAttribute("data-layout-draggable")).toBe("1");
        expect(element.getAttribute("data-layout-group")).toBe("rail");
        expect(element.getAttribute("data-layout-member")).toMatch(/^divider:/);
        expect(element.hasAttribute("data-rail-divider-resting")).toBe(false);
      }
    });

    it("marks nothing draggable in a hidden pane's rail during a session", () => {
      seedRailWithDivider();
      useLayoutEditorStore.getState().beginSession({
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      });

      renderRail(false);

      expect(
        screen
          .getByTestId("epic-sidebar-rail")
          .querySelectorAll("[data-layout-draggable]"),
      ).toHaveLength(0);
      // The divider is still drawn - just as the same resting spacer it is
      // outside a session, never omitted.
      for (const divider of screen.getAllByTestId("epic-rail-divider")) {
        expect(divider.hasAttribute("data-rail-divider-resting")).toBe(true);
      }
    });
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
      setRailVisibilityOverride("pull-requests", true);
      renderRail();

      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();
    });

    it("drops the rail icon for a populated epic the user unchecked", () => {
      setRailVisibilityOverride("pull-requests", false);
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
      setRailVisibilityOverride("pull-requests", false);
      setRailVisibilityOverride("comments", false);
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
      setRailVisibilityOverride("pull-requests", false);
      renderRail();
      expect(screen.queryByTestId("epic-rail-pull-requests")).toBeNull();

      act(() => {
        setRailVisibilityOverride("pull-requests", null);
      });

      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();
    });
  });

  describe("host-pinned Pull Requests availability", () => {
    function renderLiveHost(): void {
      render(
        <SidebarProvider>
          <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} />
        </SidebarProvider>,
      );
    }

    function renderLoadingHost(): void {
      render(
        <SidebarProvider>
          <EpicLeftPanelLoadingHost epicId={EPIC_ID} tabId={TAB_ID} />
        </SidebarProvider>,
      );
    }

    function renderRail(): void {
      render(
        <EpicLeftPanelRail
          epicId={EPIC_ID}
          tabId={TAB_ID}
          orientation="vertical"
        />,
      );
    }

    it("uses the persisted B pin for live, loading and rail availability", () => {
      pinPullRequestsTo(PINNED_HOST_ID);
      setPullRequestPresenceForHost(PINNED_HOST_ID, true);
      useLeftPanelStore.getState().setActivePanelId(TAB_ID, "pull-requests");

      renderLiveHost();
      expect(
        screen.getByTestId("epic-sidebar").getAttribute("data-left-panel-id"),
      ).toBe("pull-requests");

      cleanup();
      renderLoadingHost();
      expect(
        screen.getByTestId("epic-sidebar").getAttribute("data-left-panel-id"),
      ).toBe("pull-requests");

      cleanup();
      renderRail();
      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();
    });

    it("follows canvas host A when unpinned and ignores B-only presence", () => {
      setPullRequestPresenceForHost(PINNED_HOST_ID, true);
      renderRail();
      expect(screen.queryByTestId("epic-rail-pull-requests")).toBeNull();

      act(() => {
        setPullRequestPresenceForHost(HOST_ID, true);
      });

      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();
    });

    it("retains an active PR panel across A-to-B selection until B is observed", () => {
      setPullRequestPresenceForHost(HOST_ID, true);
      useLeftPanelStore.getState().setActivePanelId(TAB_ID, "pull-requests");
      const rendered = render(
        <EpicLeftPanelRail
          epicId={EPIC_ID}
          tabId={TAB_ID}
          orientation="vertical"
        />,
      );

      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();

      act(() => {
        pinPullRequestsTo(PINNED_HOST_ID);
        usePrPresenceStore.setState({ hasItemsByScopeKey: {} });
      });

      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();

      act(() => {
        useLeftPanelStore.getState().setActivePanelId(TAB_ID, "chats");
      });
      expect(screen.queryByTestId("epic-rail-pull-requests")).toBeNull();

      act(() => {
        setPullRequestPresenceForHost(PINNED_HOST_ID, true);
      });
      expect(screen.getByTestId("epic-rail-pull-requests")).not.toBeNull();

      act(() => {
        setRailVisibilityOverride("pull-requests", false);
      });
      expect(screen.queryByTestId("epic-rail-pull-requests")).toBeNull();

      rendered.unmount();
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
        "Browsers",
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

      expect(visibilityOverrides()).toEqual({
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

      expect(visibilityOverrides()).toEqual({});
    });

    it("offers a direct hide for the icon that was right-clicked", () => {
      renderRail();

      fireEvent.contextMenu(screen.getByTestId("epic-rail-terminals"));
      fireEvent.click(screen.getByTestId("epic-rail-hide-pointed-panel"));

      expect(visibilityOverrides()).toEqual({
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

    it("offers one Unstack per member for a stack's icon, dissolving one member on click (L-181)", () => {
      renderRail();

      fireEvent.contextMenu(screen.getByTestId("epic-rail-chats"));
      expect(screen.getByTestId("epic-rail-unstack-chats").textContent).toBe(
        "Unstack 'Agents'",
      );
      expect(
        screen.getByTestId("epic-rail-unstack-artifacts").textContent,
      ).toBe("Unstack 'Artifacts'");

      fireEvent.click(screen.getByTestId("epic-rail-unstack-artifacts"));

      expect(screen.queryAllByTestId("epic-rail-stack")).toHaveLength(0);
      expect(screen.getByTestId("epic-rail-chats")).not.toBeNull();
      expect(screen.getByTestId("epic-rail-artifacts")).not.toBeNull();
    });

    it("offers Unstack for every member of a 3-stack, right-clicked from its one icon", () => {
      act(() => {
        applyRail(
          stackRailPanels(
            currentLayoutArrangement(),
            "terminals",
            "artifacts",
            "stack",
          ).rail,
        );
      });
      renderRail();

      fireEvent.contextMenu(screen.getByTestId("epic-rail-chats"));

      expect(screen.getByTestId("epic-rail-unstack-chats").textContent).toBe(
        "Unstack 'Agents'",
      );
      expect(
        screen.getByTestId("epic-rail-unstack-artifacts").textContent,
      ).toBe("Unstack 'Artifacts'");
      expect(
        screen.getByTestId("epic-rail-unstack-terminals").textContent,
      ).toBe("Unstack 'Terminals'");
    });

    it("omits Unstack for a rail icon that is not in a stack", () => {
      renderRail();

      fireEvent.contextMenu(screen.getByTestId("epic-rail-terminals"));

      expect(screen.queryByTestId("epic-rail-unstack-terminals")).toBeNull();
    });

    it("refuses to hide the last visible panel", () => {
      for (const panelId of [
        "terminals",
        "browsers",
        "artifacts",
        "git-diff",
        "pull-requests",
        "file-tree",
        "sharing",
      ] as const) {
        setRailVisibilityOverride(panelId, false);
      }
      renderRail();
      openRailMenu();

      // Agents is all that is left; the body always renders some panel, so an
      // empty rail would leave nothing to click back with.
      const lastItem = screen.getByTestId("epic-rail-toggle-chats");
      expect(lastItem.getAttribute("data-disabled")).not.toBeNull();
      expect(screen.queryByTestId("epic-rail-hide-pointed-panel")).toBeNull();

      fireEvent.click(lastItem);
      expect(visibilityOverrides().chats).toBeUndefined();
    });

    it("highlights the fallback icon when the active panel is hidden", () => {
      useLeftPanelStore.getState().setActivePanelId(TAB_ID, "sharing");
      setRailVisibilityOverride("sharing", false);
      renderRail();

      // The body falls back to Agents, so the rail must mark Agents - not sit
      // with no icon current at all.
      expect(
        screen.getByTestId("epic-rail-chats").getAttribute("aria-current"),
      ).toBe("true");
    });
  });
});

/**
 * The sidebar body draws the one panel the rail says is active, and it draws
 * it WHOLE (L-157, R5R-01).
 *
 * Per-panel section collapse belongs to a stacked member only (L-166), and the
 * case that forced that is an upgrade rather than a gesture: a user who collapsed Artifacts while it was
 * stacked under Chats had `{artifacts: true}` written to localStorage, which
 * was harmless while a sibling took the space. With one panel in the body a
 * honoured flag is a title row over an empty column, and the rail cannot clear
 * it - clicking the lit icon collapses the whole main panel instead.
 */
describe("the displayed panel is never collapsed (L-157)", () => {
  beforeEach(() => {
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
    setPullRequestPresence(false);
  });

  afterEach(() => {
    cleanup();
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
  });

  function renderHost(): void {
    render(
      <QueryClientProvider client={testQueryClient}>
        <SidebarProvider>
          <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} />
        </SidebarProvider>
      </QueryClientProvider>,
    );
  }

  it("draws the body for a LONE panel a persisted collapse flag names", async () => {
    // Collapse belongs to a stacked pair and to nothing else (L-157, L-166):
    // a flag left in a record by a pair the user has since taken apart must be
    // inert rather than obeyed, or the whole column is empty with no way back
    // to it from the rail.
    window.localStorage.setItem(
      persistKey(STORE_KEYS.leftPanel),
      JSON.stringify({
        state: {
          activePanelIdByTabId: { [TAB_ID]: "terminals" },
          panelSectionCollapsedByPanelId: { terminals: true },
        },
        version: 3,
      }),
    );
    await useLeftPanelStore.persist.rehydrate();
    renderHost();

    // The body itself, not just its title row: a collapsed section rendered
    // the header alone, with nothing under it.
    expect(screen.getByTestId("epic-test-terminals-body")).toBeTruthy();
    expect(
      screen.getByTestId("epic-left-panel-section-terminals").children.length,
    ).toBeGreaterThan(1);
  });
});

/**
 * A stacked pair shares the body as two sections with a resize handle
 * between them; a lone panel is the one section above (L-166). This describes
 * the split the stacked shape draws, and that the same rail with its link
 * removed collapses back to the lone, uncollapsible shape.
 *
 * Terminals with Browsers rather than the shipped Agents-with-Artifacts pair,
 * because those two panels' bodies render without an epic session - the same
 * reason every other host case in this file activates Terminals. The join is
 * made the way the inspector's row action makes it, with the panel BELOW as
 * the source, so Terminals stays above Browsers and nothing is reordered
 * (L-170).
 */
describe("a stacked pair vs a lone panel in the body (L-166)", () => {
  beforeEach(() => {
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
    setPullRequestPresence(false);
  });

  afterEach(() => {
    cleanup();
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
  });

  function renderHost(): void {
    render(
      <QueryClientProvider client={testQueryClient}>
        <SidebarProvider>
          <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} />
        </SidebarProvider>
      </QueryClientProvider>,
    );
  }

  function sectionIds(): ReadonlyArray<string | null> {
    return Array.from(
      screen
        .getByTestId("epic-sidebar")
        .querySelectorAll("[data-left-panel-section-id]"),
    ).map((section) => section.getAttribute("data-left-panel-section-id"));
  }

  it("draws two sections with a handle for a stack and one uncollapsible section otherwise", () => {
    useLeftPanelStore.getState().setActivePanelId(TAB_ID, "terminals");
    act(() => {
      applyRail(
        stackRailPanels(
          currentLayoutArrangement(),
          "browsers",
          "terminals",
          "stack",
        ).rail,
      );
    });
    renderHost();

    expect(sectionIds()).toEqual(["terminals", "browsers"]);
    expect(screen.getByTestId("split-resize-handle")).not.toBeNull();
    // Each half of the pair gets its own collapse control, because each has a
    // partner to hand its space to.
    expect(
      screen.getByRole("button", { name: "Collapse Terminals" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Collapse Browsers" }),
    ).not.toBeNull();

    cleanup();
    // The link taken out: the same active panel now stands alone, with no
    // partner to share the handle - or the collapse - with (L-157).
    act(() => {
      applyRail(
        unstackRail(
          currentLayoutArrangement(),
          "stack:railTerminals+railBrowsers",
        ).rail,
      );
    });
    renderHost();

    expect(sectionIds()).toEqual(["terminals"]);
    expect(screen.queryByTestId("split-resize-handle")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Collapse /u })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Expand /u })).toBeNull();
  });

  it("offers no collapse to the last expanded member of a pair (L-170)", () => {
    useLeftPanelStore.getState().setActivePanelId(TAB_ID, "terminals");
    act(() => {
      applyRail(
        stackRailPanels(
          currentLayoutArrangement(),
          "browsers",
          "terminals",
          "stack",
        ).rail,
      );
    });
    renderHost();

    fireEvent.click(screen.getByRole("button", { name: "Collapse Browsers" }));

    // Collapsing the other one too would leave two title rows over an empty
    // column, which is the promise "a collapsed section hands its space to
    // its partner" could not keep. The control is not offered rather than
    // offered and refused.
    expect(
      screen.queryByRole("button", { name: "Collapse Terminals" }),
    ).toBeNull();
    // The collapsed one keeps its control, because that control is its Expand.
    expect(
      screen.getByRole("button", { name: "Expand Browsers" }),
    ).not.toBeNull();
  });

  it("hands a collapsed section's space to its partner", () => {
    useLeftPanelStore.getState().setActivePanelId(TAB_ID, "terminals");
    act(() => {
      applyRail(
        stackRailPanels(
          currentLayoutArrangement(),
          "browsers",
          "terminals",
          "stack",
        ).rail,
      );
    });
    renderHost();

    fireEvent.click(screen.getByRole("button", { name: "Collapse Browsers" }));

    // Both sections are still drawn - the collapsed one as its header alone,
    // and the partner still with its body - so the column is never empty.
    expect(sectionIds()).toEqual(["terminals", "browsers"]);
    expect(
      screen.getByTestId("epic-left-panel-section-browsers").className,
    ).toContain("flex-none");
    expect(
      screen.getByTestId("epic-left-panel-section-terminals").className,
    ).toContain("flex-1");
    // No handle: there is nothing left to split.
    expect(screen.queryByTestId("split-resize-handle")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand Browsers" }),
    ).not.toBeNull();
  });

  describe("a stack of three", () => {
    // Terminals, Browsers and Git diff rather than the shipped pair's
    // members: like the pair above, their bodies render without an epic
    // session.
    function stackThree(): void {
      useLeftPanelStore.getState().setActivePanelId(TAB_ID, "terminals");
      act(() => {
        applyRail(
          stackRailPanels(
            currentLayoutArrangement(),
            "browsers",
            "terminals",
            "stack",
          ).rail,
        );
      });
      act(() => {
        applyRail(
          stackRailPanels(
            currentLayoutArrangement(),
            "git-diff",
            "terminals",
            "stack",
          ).rail,
        );
      });
    }

    function collapse(...panelIds: ReadonlyArray<string>): void {
      useLeftPanelStore.setState({
        panelSectionCollapsedByPanelId: Object.fromEntries(
          panelIds.map((panelId) => [panelId, true]),
        ),
      });
    }

    function flexGrowOf(panelId: string): number {
      const child = screen
        .getByTestId(`epic-left-panel-section-${panelId}`)
        .closest<HTMLElement>("[data-split-child]");
      if (child === null) throw new Error(`no split child for ${panelId}`);
      return Number(child.style.flexGrow);
    }

    it("keeps the handle and the stored split between the open members when one collapses", () => {
      stackThree();
      useLeftPanelStore.setState({
        panelSectionWeightsByPanelId: {
          terminals: 30,
          browsers: 70,
          "git-diff": 50,
        },
      });
      collapse("git-diff");
      renderHost();

      expect(sectionIds()).toEqual(["terminals", "browsers", "git-diff"]);
      expect(screen.getAllByTestId("split-resize-handle")).toHaveLength(1);
      expect(flexGrowOf("terminals")).toBeCloseTo(0.3);
      expect(flexGrowOf("browsers")).toBeCloseTo(0.7);
      expect(
        screen.getByRole("button", { name: "Expand Git Diff" }),
      ).not.toBeNull();
    });

    it("keeps a collapsed member's header actions reachable while its body is hidden", () => {
      stackThree();
      collapse("git-diff");
      renderHost();

      expect(screen.queryByTestId("epic-test-git-diff-body")).toBeNull();
      // The header is all a collapsed member draws, so it is the only way to
      // the panel's own actions until the user expands it again.
      expect(
        screen.getByRole("button", { name: "More Git Diff actions" }),
      ).not.toBeNull();
    });

    it("splits the open members around a collapsed one in the middle, which keeps its header", () => {
      stackThree();
      collapse("browsers");
      renderHost();

      expect(sectionIds()).toEqual(["terminals", "browsers", "git-diff"]);
      expect(screen.getAllByTestId("split-resize-handle")).toHaveLength(1);
      expect(
        screen.getByRole("button", { name: "Expand Browsers" }),
      ).not.toBeNull();
      expect(screen.getByTestId("epic-test-terminals-body")).not.toBeNull();
      expect(screen.getByTestId("epic-test-git-diff-body")).not.toBeNull();
    });

    it("opens a member of the pair left behind when the only expanded one leaves the stack", () => {
      stackThree();
      collapse("terminals", "browsers");
      act(() => {
        setRailVisibilityOverride("git-diff", false);
      });
      renderHost();

      expect(sectionIds()).toEqual(["terminals", "browsers"]);
      // Two bare headers over an empty column is the state this must not draw.
      const flexNone = ["terminals", "browsers"].filter((panelId) =>
        screen
          .getByTestId(`epic-left-panel-section-${panelId}`)
          .className.includes("flex-none"),
      );
      expect(flexNone).toHaveLength(1);
    });
  });

  it("registers the body droppable at the stack's TOP panel, not the active member, and draws the join/full/same drop cue (L-181, L-182)", () => {
    // Browsers is active, but Terminals is the top of the stack (L-181): the
    // body is one drop target for the whole stack, so it is Terminals the
    // droppable names, whichever member the user is looking at.
    useLeftPanelStore.getState().setActivePanelId(TAB_ID, "browsers");
    act(() => {
      applyRail(
        stackRailPanels(
          currentLayoutArrangement(),
          "browsers",
          "terminals",
          "stack",
        ).rail,
      );
    });
    renderHost();

    expect(
      testState.droppableInputs.find(
        (input) =>
          typeof input.data === "object" &&
          input.data !== null &&
          "kind" in input.data &&
          input.data.kind === "left-panel-body",
      )?.data,
    ).toEqual({
      kind: "left-panel-body",
      viewTabId: TAB_ID,
      panelId: "terminals",
    });

    const dragSource: EpicCanvasLeftPanelRailDragData = {
      kind: "left-panel-rail-item",
      viewTabId: TAB_ID,
      panelId: "git-diff",
      origin: "rail",
    };
    const combineOnTop: EpicCanvasDropPreview = {
      kind: "left-panel-rail",
      viewTabId: TAB_ID,
      panelId: "terminals",
      position: "combine",
    };

    // A join joining the stack draws "join".
    act(() => {
      setRailDragState(dragSource, combineOnTop);
    });
    expect(
      screen
        .getByTestId("epic-sidebar")
        .querySelector("[data-body-drop-cue]")
        ?.getAttribute("data-body-drop-cue"),
    ).toBe("join");

    // A preview aimed at some other panel draws nothing.
    act(() => {
      setRailDragState(dragSource, {
        kind: "left-panel-rail",
        viewTabId: TAB_ID,
        panelId: "git-diff",
        position: "before",
      });
    });
    expect(
      screen.getByTestId("epic-sidebar").querySelector("[data-body-drop-cue]"),
    ).toBeNull();

    // A member of the stack itself is already there: "same" draws nothing.
    act(() => {
      setRailDragState(
        {
          kind: "left-panel-rail-item",
          viewTabId: TAB_ID,
          panelId: "browsers",
          origin: "panel-section",
        },
        combineOnTop,
      );
    });
    expect(
      screen.getByTestId("epic-sidebar").querySelector("[data-body-drop-cue]"),
    ).toBeNull();

    // Grown to the max (terminals+browsers+git-diff+pull-requests): a FIFTH
    // panel's join now draws "full" instead.
    act(() => {
      applyRail(
        stackRailPanels(
          currentLayoutArrangement(),
          "git-diff",
          "terminals",
          "stack",
        ).rail,
      );
      applyRail(
        stackRailPanels(
          currentLayoutArrangement(),
          "pull-requests",
          "terminals",
          "stack",
        ).rail,
      );
    });
    act(() => {
      setRailDragState(
        {
          kind: "left-panel-rail-item",
          viewTabId: TAB_ID,
          panelId: "file-tree",
          origin: "rail",
        },
        combineOnTop,
      );
    });
    expect(
      screen
        .getByTestId("epic-sidebar")
        .querySelector("[data-body-drop-cue]")
        ?.getAttribute("data-body-drop-cue"),
    ).toBe("full");
  });
});

describe("Browsers panel registration", () => {
  beforeEach(() => {
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
    setPullRequestPresence(false);
    browserPanelState.value = {
      lifecycle: "live",
      items: [],
      errorMessage: null,
      retry: vi.fn(),
      closeTab: vi.fn(() => Promise.resolve()),
    };
    browserCanvasState.prepareOpenTileInTabFocusTarget.mockReset();
    browserCanvasState.prepareSetActiveTileTabFocusTarget.mockReset();
  });

  afterEach(() => {
    cleanup();
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
    setPullRequestPresence(false);
  });

  it("activates the registered browser body and keeps sibling panel mechanics", () => {
    useLeftPanelStore.getState().setActivePanelId(TAB_ID, "terminals");

    // The browsers body reaches Query through its add action, so this panel
    // cannot mount without a client - unlike the siblings it is compared to.
    render(
      <QueryClientProvider client={testQueryClient}>
        <EpicLeftPanelRail
          epicId={EPIC_ID}
          tabId={TAB_ID}
          orientation="vertical"
        />
        <SidebarProvider>
          <EpicLeftPanelHost epicId={EPIC_ID} tabId={TAB_ID} />
        </SidebarProvider>
      </QueryClientProvider>,
    );

    const rail = screen.getByTestId("epic-sidebar-rail");
    const railIds = Array.from(rail.children).map((child) =>
      child.getAttribute("data-testid"),
    );
    // The chats/artifacts capsule draws as one direct child of the rail
    // (L-166, L-167), not two loose icons.
    expect(railIds).toEqual([
      "epic-rail-stack",
      "epic-rail-terminals",
      "epic-rail-browsers",
      "epic-rail-git-diff",
      "epic-rail-file-tree",
      "epic-rail-sharing",
    ]);
    expect(
      screen.getByTestId("epic-sidebar").getAttribute("data-left-panel-id"),
    ).toBe("terminals");
    expect(screen.getByTestId("epic-test-terminals-body")).toBeTruthy();

    fireEvent.click(screen.getByTestId("epic-rail-browsers"));

    expect(useLeftPanelStore.getState().getActivePanelId(TAB_ID)).toBe(
      "browsers",
    );
    expect(
      screen.getByTestId("epic-sidebar").getAttribute("data-left-panel-id"),
    ).toBe("browsers");
    expect(screen.getByTestId("epic-browsers-panel-empty")).toBeTruthy();

    // Dragging Browsers before Terminals reorders the flat rail directly -
    // both are lone panels, so there is no group for either to leave or join.
    act(() => {
      applyRail(
        moveRailPanelBeside(currentLayoutArrangement(), {
          sourcePanelId: "browsers",
          targetPanelId: "terminals",
          placeAfter: false,
          carry: "panel",
        }).rail,
      );
    });
    const reorderedRailIds = Array.from(
      screen.getByTestId("epic-sidebar-rail").children,
    ).map((child) => child.getAttribute("data-testid"));
    expect(reorderedRailIds.indexOf("epic-rail-browsers")).toBeLessThan(
      reorderedRailIds.indexOf("epic-rail-terminals"),
    );
  });
});

describe("the horizontal rail's reported natural width (bug #1)", () => {
  const RAIL_PADDING_PX = 16;

  /**
   * The rail measures the span of its laid-out children plus its own padding.
   * jsdom does no layout, so both are stubbed: every child of the rail lays
   * out over `spanPx`, and the rail is padded 8px a side.
   */
  function stubRailLayout(spanPx: number): () => void {
    const rects = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function stubbedRect(this: Element) {
        return this.parentElement?.getAttribute("data-testid") ===
          "epic-sidebar-rail"
          ? new DOMRect(10, 0, spanPx, 40)
          : new DOMRect(0, 0, 0, 0);
      });
    // Tailwind's `px-2` is not in jsdom's stylesheet, so the same padding is
    // written as a rule `getComputedStyle` does read.
    const padding = document.createElement("style");
    padding.textContent =
      '[data-testid="epic-sidebar-rail"] { padding-left: 8px; padding-right: 8px; }';
    document.head.append(padding);
    return () => {
      rects.mockRestore();
      padding.remove();
    };
  }

  function reportedWidth(): number | undefined {
    return useSidebarRailWidthStore.getState().naturalWidthPxByTabId[TAB_ID];
  }

  function renderHorizontalRail(): RenderResult {
    return render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="horizontal"
      />,
    );
  }

  let restoreLayout: (() => void) | null = null;

  beforeEach(() => {
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
    setPullRequestPresence(true);
    useSidebarRailWidthStore.setState({ naturalWidthPxByTabId: {} });
  });

  afterEach(() => {
    cleanup();
    resetLeftPanelStore();
    resetDndStore();
    resetTestState();
    setPullRequestPresence(false);
    useSidebarRailWidthStore.setState({ naturalWidthPxByTabId: {} });
    restoreLayout?.();
    restoreLayout = null;
  });

  it("reports the children's span, not the width the rail was stretched to", () => {
    restoreLayout = stubRailLayout(250);
    // A `w-full` scroller's scrollWidth and clientWidth never drop below its
    // own width, so a 500px sidebar used to lock a 500px minimum.
    for (const property of ["scrollWidth", "clientWidth"]) {
      Object.defineProperty(HTMLElement.prototype, property, {
        configurable: true,
        get(this: HTMLElement) {
          return this.getAttribute("data-testid") === "epic-sidebar-rail"
            ? 500
            : 0;
        },
      });
    }
    try {
      renderHorizontalRail();

      expect(reportedWidth()).toBe(250 + RAIL_PADDING_PX);
    } finally {
      for (const property of ["scrollWidth", "clientWidth"]) {
        Object.defineProperty(HTMLElement.prototype, property, {
          configurable: true,
          get: () => 0,
        });
      }
    }
  });

  it("reports nothing for the collapsed vertical rail", () => {
    restoreLayout = stubRailLayout(344);

    render(
      <EpicLeftPanelRail
        epicId={EPIC_ID}
        tabId={TAB_ID}
        orientation="vertical"
      />,
    );

    expect(reportedWidth()).toBeUndefined();
  });

  it("publishes the span of its children plus its padding under the tab id once mounted horizontally, and clears it on unmount", () => {
    restoreLayout = stubRailLayout(344);

    const view = renderHorizontalRail();
    expect(reportedWidth()).toBe(344 + RAIL_PADDING_PX);

    view.unmount();

    expect(reportedWidth()).toBeUndefined();
  });

  it("re-measures once the rail's own item list changes", () => {
    restoreLayout = stubRailLayout(344);
    renderHorizontalRail();
    expect(reportedWidth()).toBe(344 + RAIL_PADDING_PX);

    // A narrower rail (one fewer icon) laying out over a SMALLER span: the
    // effect has to re-measure rather than keep the value from first mount.
    restoreLayout();
    restoreLayout = stubRailLayout(300);
    act(() => {
      setRailVisibilityOverride("sharing", false);
    });

    expect(reportedWidth()).toBe(300 + RAIL_PADDING_PX);
  });
});

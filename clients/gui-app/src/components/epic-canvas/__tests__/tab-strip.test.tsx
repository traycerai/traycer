import "../../../../__tests__/test-browser-apis";

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabStrip } from "@/components/epic-canvas/canvas/tab-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasTileRef,
  EpicNodeRef,
  SplitDirection,
} from "@/stores/epics/canvas/types";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";

interface CapturedDraggableInput {
  readonly id: string;
  readonly data: unknown;
}

interface CapturedDroppableInput {
  readonly id: string;
  readonly data: unknown;
}

interface TabStripTestState {
  draggableInputs: CapturedDraggableInput[];
  droppableInputs: CapturedDroppableInput[];
}

const testState = vi.hoisted((): TabStripTestState => ({
  draggableInputs: [],
  droppableInputs: [],
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: (input: CapturedDraggableInput) => {
    testState.draggableInputs.push(input);
    return {
      setNodeRef: () => undefined,
      listeners: undefined,
      isDragging: false,
    };
  },
  useDroppable: (input: CapturedDroppableInput) => {
    testState.droppableInputs.push(input);
    return {
      setNodeRef: () => undefined,
    };
  },
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicTabDisplayTitle: (node: { readonly name: string }) => node.name,
  useEpicLiveArtifactTitleGenerating: () => false,
}));

// TabItem resolves the tab's bound-host client for terminal renames; these
// tests render outside a <HostRuntimeProvider>, so stub the host seam.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: () => undefined }),
}));

const VIEW_TAB_ID = "view-tab-1";

const TAB: EpicNodeRef = {
  id: "workspace-file:host-A:/repo:a.md",
  instanceId: "inst-tab-a",
  type: "workspace-file",
  name: "a.md",
  hostId: "host-A",
  workspacePath: "/repo",
  filePath: "a.md",
};

const ARTIFACT_TAB: EpicNodeRef = {
  id: "spec-1",
  instanceId: "inst-spec-1",
  type: "spec",
  name: "Architecture",
  hostId: "host-A",
};

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

// TabItem reads its active/preview/globally-active state from the canvas store
// (via `useTabActivation`), not from props, so seed a tab whose lone group has
// `TAB` as the active + preview tab.
function seedActivePreviewTab(tab: EpicCanvasTileRef): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: {
        tabId: VIEW_TAB_ID,
        epicId: "epic-1",
        name: "Epic 1",
      },
    },
    canvasByTabId: {
      [VIEW_TAB_ID]: {
        activePaneId: "group-1",
        root: {
          kind: "pane",
          id: "group-1",
          tabInstanceIds: [tab.instanceId],
          activeTabId: tab.instanceId,
          previewTabId: tab.instanceId,
          activationHistory: [tab.instanceId],
        },
        tilesByInstanceId: { [tab.instanceId]: tab },
        sizesByGroupId: {},
      },
    },
  });
}

function renderTabStrip(input: {
  readonly onClose: (groupId: string, tabId: string) => void;
  readonly onPromotePreview: (groupId: string) => void;
  readonly onOpenBlankTab: (groupId: string) => void;
  readonly onSplit:
    ((groupId: string, direction: SplitDirection) => void) | undefined;
}) {
  renderTabStripForTab(TAB, input);
}

function renderTabStripForTab(
  tab: EpicCanvasTileRef,
  input: {
    readonly onClose: (groupId: string, tabId: string) => void;
    readonly onPromotePreview: (groupId: string) => void;
    readonly onOpenBlankTab: (groupId: string) => void;
    readonly onSplit:
      ((groupId: string, direction: SplitDirection) => void) | undefined;
  },
) {
  seedActivePreviewTab(tab);
  const queryClient = createQueryClient();
  const onSplit = input.onSplit === undefined ? () => undefined : input.onSplit;
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <TabStrip
          epicId="epic-1"
          tabId={VIEW_TAB_ID}
          groupId="group-1"
          tabs={[tab]}
          activeTabId={tab.instanceId}
          onSelectTab={() => undefined}
          onCloseTab={input.onClose}
          onPromotePreview={input.onPromotePreview}
          onSplit={onSplit}
          onCloseGroup={() => undefined}
          onOpenBlankTab={input.onOpenBlankTab}
          canRenameTabs
          menuHandlers={{
            onClose: () => undefined,
            onCloseOthers: () => undefined,
            onCloseRight: () => undefined,
            onCloseAll: () => undefined,
            onSplit: () => undefined,
            onRevealInSidebar: () => undefined,
            onRename: () => undefined,
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("<TabStrip />", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    testState.draggableInputs = [];
    testState.droppableInputs = [];
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("renders preview tabs with an overlaid close button that does not reserve flex space", () => {
    const onClose = vi.fn();
    renderTabStrip({
      onClose,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    const tab = screen.getByRole("tab", { name: /a\.md/ });
    expect(tab.getAttribute("data-preview")).toBe("true");
    expect(tab.querySelector(".italic")).toBeTruthy();

    const closeButton = screen.getByRole("button", { name: "Close a.md" });
    expect(closeButton.className).toContain("absolute");
    expect(closeButton.className).not.toContain("ml-1");

    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledWith("group-1", TAB.instanceId);
  });

  it("promotes preview tabs on double click", () => {
    const onPromotePreview = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.doubleClick(screen.getByRole("tab", { name: /a\.md/ }));

    expect(onPromotePreview).toHaveBeenCalledWith("group-1");
  });

  it("copies the absolute file path from a workspace-file tab context menu", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.contextMenu(screen.getByTestId(`tab-item-${TAB.instanceId}`));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy File Path" }));

    expect(writeText).toHaveBeenCalledWith("/repo/a.md");
  });

  it("does not offer the file-path action for non-file tabs", () => {
    renderTabStripForTab(ARTIFACT_TAB, {
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.contextMenu(
      screen.getByTestId(`tab-item-${ARTIFACT_TAB.instanceId}`),
    );

    expect(
      screen.queryByRole("menuitem", { name: "Copy File Path" }),
    ).toBeNull();
  });

  it("opens a blank tab when the empty strip area is double-clicked", () => {
    const onOpenBlankTab = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab,
      onSplit: undefined,
    });

    // Double-clicking the strip-end container itself (not a tab) opens a blank.
    fireEvent.doubleClick(screen.getByTestId("tab-strip-end"));

    expect(onOpenBlankTab).toHaveBeenCalledWith("group-1");
  });

  it("maps vertical wheel movement to horizontal scroll when task tabs overflow", () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    const scroller = screen.getByTestId("tab-strip-end");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 400 },
    });

    fireEvent.wheel(scroller, { deltaY: 80, deltaMode: 0 });

    expect(scroller.scrollLeft).toBe(80);
  });

  it("does not open a blank tab when an existing tab is double-clicked", () => {
    const onOpenBlankTab = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab,
      onSplit: undefined,
    });

    // The guard (target === currentTarget) keeps tab double-clicks from
    // bubbling into a blank-tab open.
    fireEvent.doubleClick(screen.getByRole("tab", { name: /a\.md/ }));

    expect(onOpenBlankTab).not.toHaveBeenCalled();
  });

  it("splits right by default and down when Shift is held for the click", () => {
    const onSplit = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit,
    });

    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    fireEvent.click(splitButton);
    fireEvent.click(splitButton, { shiftKey: true });

    expect(onSplit).toHaveBeenNthCalledWith(1, "group-1", "horizontal");
    expect(onSplit).toHaveBeenNthCalledWith(2, "group-1", "vertical");
  });

  it("shows the down-split affordance when focus arrives with Shift held", () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    fireEvent.focus(splitButton);

    expect(splitButton.getAttribute("aria-label")).toBe("Split group down");
    expect(splitButton.getAttribute("data-split-direction")).toBe("vertical");
  });

  it("keeps the default affordance while neither hovered nor focused", () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });

    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    expect(splitButton.getAttribute("data-split-direction")).toBe("horizontal");
  });

  it("updates the split affordance and tooltip while Shift is held", async () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    fireEvent.focus(splitButton);

    expect(splitButton.getAttribute("aria-label")).toBe("Split group right");
    expect(splitButton.getAttribute("data-split-direction")).toBe("horizontal");
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Shift+click to split down");
    expect(tooltip.querySelector('[data-slot="kbd"]')).not.toBeNull();

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });

    expect(splitButton.getAttribute("aria-label")).toBe("Split group down");
    expect(splitButton.getAttribute("data-split-direction")).toBe("vertical");
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Release Shift to split right",
    );
  });

  it("shows repository hierarchy in Git bundle titles and structured tooltips", async () => {
    const gitTab = makeGitBundleDiffTile({
      hostId: "host-A",
      runningDir: "/worktrees/right-click-context-menu/traycer",
      bundleGroup: "changes",
      repositoryContext: {
        workspaceLabel: "traycer-internal",
        repositoryLabel: "traycer",
      },
    });
    renderTabStripForTab(gitTab, {
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    const title = screen.getByTestId(`tab-title-${gitTab.instanceId}`);
    expect(title.textContent).toBe("traycer-internal › traycer · Changes");

    fireEvent.focus(title);

    const tooltips = await screen.findAllByTestId(
      `git-diff-tab-tooltip-${gitTab.instanceId}`,
    );
    const tooltip = within(tooltips[0]);
    expect(tooltip.getByTestId("git-diff-tooltip-workspace").textContent).toBe(
      "Workspacetraycer-internal",
    );
    expect(tooltip.getByTestId("git-diff-tooltip-repository").textContent).toBe(
      "Repositorytraycer",
    );
    expect(tooltip.getByTestId("git-diff-tooltip-scope").textContent).toBe(
      "DiffChanges",
    );
    expect(tooltip.getByTestId("git-diff-tooltip-path").textContent).toBe(
      "Path/worktrees/right-click-context-menu/traycer",
    );
  });
});

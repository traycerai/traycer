import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabStrip } from "@/components/epic-canvas/canvas/tab-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";

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

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

// TabItem reads its active/preview/globally-active state from the canvas store
// (via `useTabActivation`), not from props, so seed a tab whose lone group has
// `TAB` as the active + preview tab.
function seedActivePreviewTab(): void {
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
          tabInstanceIds: [TAB.instanceId],
          activeTabId: TAB.instanceId,
          previewTabId: TAB.instanceId,
          activationHistory: [TAB.instanceId],
        },
        tilesByInstanceId: { [TAB.instanceId]: TAB },
        sizesByGroupId: {},
      },
    },
  });
}

function renderTabStrip(input: {
  readonly onClose: (groupId: string, tabId: string) => void;
  readonly onPromotePreview: (groupId: string) => void;
  readonly onOpenBlankTab: (groupId: string) => void;
}) {
  seedActivePreviewTab();
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TabStrip
          epicId="epic-1"
          tabId={VIEW_TAB_ID}
          groupId="group-1"
          tabs={[TAB]}
          activeTabId={TAB.instanceId}
          onSelectTab={() => undefined}
          onCloseTab={input.onClose}
          onPromotePreview={input.onPromotePreview}
          onSplitRight={() => undefined}
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
    });

    fireEvent.doubleClick(screen.getByRole("tab", { name: /a\.md/ }));

    expect(onPromotePreview).toHaveBeenCalledWith("group-1");
  });

  it("opens a blank tab when the empty strip area is double-clicked", () => {
    const onOpenBlankTab = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab,
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
    });

    // The guard (target === currentTarget) keeps tab double-clicks from
    // bubbling into a blank-tab open.
    fireEvent.doubleClick(screen.getByRole("tab", { name: /a\.md/ }));

    expect(onOpenBlankTab).not.toHaveBeenCalled();
  });
});

import "../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { TabGroupView } from "@/components/epic-canvas/canvas/tab-group-view";
import { paneActivationDeferProps } from "@/components/epic-canvas/pane-activation";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef, TilePane } from "@/stores/epics/canvas/types";

const VIEW_TAB_ID = "view-tab-1";

interface TestState {
  readonly mounts: Map<string, number>;
  readonly unmounts: Map<string, number>;
  readonly deferredClicks: Map<string, number>;
  readonly deferredRemovalClicks: Map<string, number>;
  readonly closeAutoFocusGuards: Map<string, (event: Event) => void>;
}

const testState = vi.hoisted((): TestState => ({
  mounts: new Map(),
  unmounts: new Map(),
  deferredClicks: new Map(),
  deferredRemovalClicks: new Map(),
  closeAutoFocusGuards: new Map(),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    setNodeRef: () => undefined,
    listeners: undefined,
    isDragging: false,
  }),
  useDroppable: () => ({ setNodeRef: () => undefined }),
}));

// The rename hook pulls in the open-epic handle + host mutation hooks, which
// this render-focused test does not provide. Stub it to a no-op so TabGroupView
// mounts without a HostRuntimeProvider / EpicSessionProvider.
vi.mock("@/components/epic-canvas/canvas/use-rename-canvas-tab", () => ({
  useRenameCanvasTab: () => () => undefined,
}));

// TabItem resolves the tab's bound-host client for terminal renames; these
// tests render outside a <HostRuntimeProvider>, so stub the host seam.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: () => undefined }),
}));

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: (id: string) => ({ id }),
  useEpicTabDisplayTitle: (node: { readonly name: string }) => node.name,
  useEpicLiveArtifactTitleGenerating: () => false,
  useEpicPermissionRole: () => "owner",
  useEpicSnapshotLoaded: () => true,
  useMaybeEpicTuiAgentHarnessId: () => null,
  useRegisteredEpicActiveAgentIds: () => new Set<string>(),
}));

vi.mock("@/components/epic-canvas/renderers/epic-node-tile", async () => {
  const React = await import("react");
  const { usePaneCloseAutoFocusGuard } =
    await import("@/components/epic-tabs/pane-visibility-context");
  function MockTile(props: { readonly id: string }) {
    const closeAutoFocusGuard = usePaneCloseAutoFocusGuard(undefined);
    React.useEffect(() => {
      testState.mounts.set(props.id, (testState.mounts.get(props.id) ?? 0) + 1);
      testState.closeAutoFocusGuards.set(props.id, closeAutoFocusGuard);
      return () => {
        testState.unmounts.set(
          props.id,
          (testState.unmounts.get(props.id) ?? 0) + 1,
        );
        testState.closeAutoFocusGuards.delete(props.id);
      };
    }, [closeAutoFocusGuard, props.id]);

    return (
      <div data-testid={`tile-${props.id}`}>
        <button
          type="button"
          {...paneActivationDeferProps}
          data-testid={`deferred-activation-${props.id}`}
          onClick={() => {
            testState.deferredClicks.set(
              props.id,
              (testState.deferredClicks.get(props.id) ?? 0) + 1,
            );
          }}
        >
          Deferred action
        </button>
        <button
          type="button"
          {...paneActivationDeferProps}
          data-testid={`deferred-removal-${props.id}`}
          onClick={(event) => {
            testState.deferredRemovalClicks.set(
              props.id,
              (testState.deferredRemovalClicks.get(props.id) ?? 0) + 1,
            );
            event.currentTarget.remove();
          }}
        >
          Deferred action that replaces itself
        </button>
      </div>
    );
  }

  return {
    EpicNodeTile: ({ node }: { readonly node: EpicCanvasTileRef }) => (
      <MockTile id={node.id} />
    ),
  };
});

const TERMINAL_AGENT: EpicCanvasTileRef = {
  id: "agent-1",
  instanceId: "inst-agent-1",
  type: "terminal-agent",
  name: "Codex",
  hostId: "host-A",
};

const SPEC: EpicCanvasTileRef = {
  id: "spec-1",
  instanceId: "inst-spec-1",
  type: "spec",
  name: "Spec",
  hostId: "host-A",
};

function specTab(n: number): EpicCanvasTileRef {
  return {
    id: `spec-${n}`,
    instanceId: `inst-spec-${n}`,
    type: "spec",
    name: `Spec ${n}`,
    hostId: "host-A",
  };
}

function pane(
  tabs: ReadonlyArray<EpicCanvasTileRef>,
  activeTabId: string,
): TilePane {
  return {
    kind: "pane",
    id: "group-1",
    tabInstanceIds: tabs.map((tab) => tab.instanceId),
    activeTabId,
    previewTabId: null,
    activationHistory: [activeTabId],
  };
}

// TabGroupView resolves its tab payloads via `usePaneTabRefs(tabId, pane)`,
// which reads `canvasByTabId[tabId].tilesByInstanceId`. Seed that so the pane's
// instanceIds resolve to the given refs.
function seedCanvas(
  tabs: ReadonlyArray<EpicCanvasTileRef>,
  activeTabId: string,
): void {
  seedCanvasWithActivePane(tabs, activeTabId, "group-1");
}

function seedCanvasWithActivePane(
  tabs: ReadonlyArray<EpicCanvasTileRef>,
  activeTabId: string,
  activePaneId: string,
): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: { tabId: VIEW_TAB_ID, epicId: "epic-1", name: "Epic 1" },
    },
    canvasByTabId: {
      [VIEW_TAB_ID]: {
        activePaneId,
        root: pane(tabs, activeTabId),
        tilesByInstanceId: Object.fromEntries(
          tabs.map((tab) => [tab.instanceId, tab]),
        ),
        sizesByGroupId: {},
      },
    },
  });
}

function groupView(
  tabs: ReadonlyArray<EpicCanvasTileRef>,
  activeTabId: string,
  paneVisible: boolean,
): ReactNode {
  return (
    <TooltipProvider>
      <PaneVisibilityContext.Provider value={paneVisible}>
        <TabGroupView
          epicId="epic-1"
          tabId={VIEW_TAB_ID}
          pane={pane(tabs, activeTabId)}
        />
      </PaneVisibilityContext.Provider>
    </TooltipProvider>
  );
}

describe("<TabGroupView />", () => {
  afterEach(() => {
    cleanup();
    testState.mounts.clear();
    testState.unmounts.clear();
    testState.deferredClicks.clear();
    testState.deferredRemovalClicks.clear();
    testState.closeAutoFocusGuards.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("keeps terminal-agent tiles mounted when another tab is selected", async () => {
    const tabs = [TERMINAL_AGENT, SPEC];
    seedCanvas(tabs, TERMINAL_AGENT.instanceId);
    const { rerender } = render(
      groupView(tabs, TERMINAL_AGENT.instanceId, true),
    );

    await waitFor(() => {
      expect(testState.mounts.get("agent-1")).toBe(1);
    });

    seedCanvas(tabs, SPEC.instanceId);
    rerender(groupView(tabs, SPEC.instanceId, true));

    expect(testState.mounts.get("agent-1")).toBe(1);
    expect(testState.unmounts.get("agent-1")).toBeUndefined();
  });

  it("defers pane activation until after activation-safe child clicks run", async () => {
    const tabs = [SPEC];
    seedCanvasWithActivePane(tabs, SPEC.instanceId, "other-group");
    render(groupView(tabs, SPEC.instanceId, true));

    await waitFor(() => {
      expect(testState.mounts.get(SPEC.id)).toBe(1);
    });

    const deferredButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Deferred action",
    });

    fireEvent.pointerDown(deferredButton);

    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
    ).toBe("other-group");

    fireEvent.click(deferredButton);

    expect(testState.deferredClicks.get(SPEC.id)).toBe(1);
    await waitFor(() => {
      expect(
        useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
      ).toBe("group-1");
    });
  });

  it("activates after a deferred child removes itself during its click action", async () => {
    const tabs = [SPEC];
    seedCanvasWithActivePane(tabs, SPEC.instanceId, "other-group");
    render(groupView(tabs, SPEC.instanceId, true));

    await waitFor(() => {
      expect(testState.mounts.get(SPEC.id)).toBe(1);
    });

    const deferredButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Deferred action that replaces itself",
    });

    fireEvent.pointerDown(deferredButton);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
    ).toBe("other-group");

    fireEvent.click(deferredButton);

    expect(testState.deferredRemovalClicks.get(SPEC.id)).toBe(1);
    expect(deferredButton.isConnected).toBe(false);
    await waitFor(() => {
      expect(
        useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
      ).toBe("group-1");
    });
  });

  it("gives keyboard focus ownership to the inactive inner pane", async () => {
    const tabs = [SPEC];
    seedCanvasWithActivePane(tabs, SPEC.instanceId, "other-group");
    render(groupView(tabs, SPEC.instanceId, true));

    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Deferred action",
    });
    button.focus();

    await waitFor(() => {
      expect(
        useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
      ).toBe("group-1");
    });
    expect(document.activeElement).toBe(button);
  });

  it("prevents close-autofocus from bouncing ownership to an inactive inner pane", async () => {
    const tabs = [SPEC];
    seedCanvas(tabs, SPEC.instanceId);
    const view = render(groupView(tabs, SPEC.instanceId, true));

    await waitFor(() => {
      expect(testState.closeAutoFocusGuards.get(SPEC.id)).toBeDefined();
    });
    seedCanvasWithActivePane(tabs, SPEC.instanceId, "other-group");
    view.rerender(groupView(tabs, SPEC.instanceId, true));
    await waitFor(() => {
      expect(view.getByTestId("tab-group").dataset.active).toBe("false");
    });

    const closeAutoFocusEvent = new Event("closeAutoFocus", {
      cancelable: true,
    });
    testState.closeAutoFocusGuards.get(SPEC.id)?.(closeAutoFocusEvent);

    expect(closeAutoFocusEvent.defaultPrevented).toBe(true);
  });

  it("keeps recently active tabs mounted under display:none and evicts past the LRU cap", async () => {
    const tabs = [specTab(1), specTab(2), specTab(3), specTab(4)];
    seedCanvas(tabs, "inst-spec-1");
    const { container, rerender } = render(
      groupView(tabs, "inst-spec-1", true),
    );

    await waitFor(() => {
      expect(testState.mounts.get("spec-1")).toBe(1);
    });

    seedCanvas(tabs, "inst-spec-2");
    rerender(groupView(tabs, "inst-spec-2", true));

    // Switching away keeps the previous tab mounted (no unmount), hidden
    // via display:none.
    expect(testState.unmounts.get("spec-1")).toBeUndefined();
    const hiddenLayer = container.querySelector(
      '[data-tab-instance-id="inst-spec-1"]',
    );
    expect(hiddenLayer?.getAttribute("data-selected")).toBe("false");
    expect(hiddenLayer?.classList.contains("hidden")).toBe(true);
    const selectedLayer = container.querySelector(
      '[data-tab-instance-id="inst-spec-2"]',
    );
    expect(selectedLayer?.classList.contains("hidden")).toBe(false);

    // Visiting two more tabs evicts the least recently active one.
    seedCanvas(tabs, "inst-spec-3");
    rerender(groupView(tabs, "inst-spec-3", true));
    seedCanvas(tabs, "inst-spec-4");
    rerender(groupView(tabs, "inst-spec-4", true));

    expect(testState.unmounts.get("spec-1")).toBe(1);
    expect(testState.unmounts.get("spec-2")).toBeUndefined();
    expect(testState.unmounts.get("spec-3")).toBeUndefined();

    // Switching back to a kept-alive tab is a visibility toggle, not a
    // remount; the evicted tab pays a fresh mount.
    seedCanvas(tabs, "inst-spec-3");
    rerender(groupView(tabs, "inst-spec-3", true));
    expect(testState.mounts.get("spec-3")).toBe(1);
    seedCanvas(tabs, "inst-spec-1");
    rerender(groupView(tabs, "inst-spec-1", true));
    expect(testState.mounts.get("spec-1")).toBe(2);
  });

  it("collapses a hidden pane to the active tab plus terminals", async () => {
    const tabs = [TERMINAL_AGENT, specTab(1), specTab(2)];
    seedCanvas(tabs, "inst-spec-1");
    const { rerender } = render(groupView(tabs, "inst-spec-1", true));

    seedCanvas(tabs, "inst-spec-2");
    rerender(groupView(tabs, "inst-spec-2", true));
    await waitFor(() => {
      expect(testState.mounts.get("spec-1")).toBe(1);
    });
    expect(testState.unmounts.get("spec-1")).toBeUndefined();

    // The pane goes to the background: the LRU keep-alive unmounts, the
    // active tab and the pinned terminal survive.
    rerender(groupView(tabs, "inst-spec-2", false));
    expect(testState.unmounts.get("spec-1")).toBe(1);
    expect(testState.unmounts.get("spec-2")).toBeUndefined();
    expect(testState.unmounts.get("agent-1")).toBeUndefined();
  });
});

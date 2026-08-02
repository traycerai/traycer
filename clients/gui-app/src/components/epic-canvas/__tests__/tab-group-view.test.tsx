import "../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useLayoutEffect, type ReactNode } from "react";
import { TabGroupView } from "@/components/epic-canvas/canvas/tab-group-view";
import { paneActivationDeferProps } from "@/components/epic-canvas/pane-activation";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef, TilePane } from "@/stores/epics/canvas/types";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
  HOSTED_TILE_PANE_ID_ATTRIBUTE,
  HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE,
} from "@/components/epic-canvas/surface-host/hosted-tile-dom";
import {
  isChatRemoteDeleted,
  resetChatRemoteDeletionRegistryForTesting,
} from "@/components/epic-canvas/surface-host/remote-deleted-chat-registry";
import { StableTileSurfaceHost } from "@/components/epic-canvas/surface-host/stable-tile-surface-host";
import {
  getTileSurfaceMembership,
  resetTileSurfaceMembershipForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-membership";
import {
  getTileSurfaceEnvironment,
  publishTileSurfaceEnvironment,
  resetTileSurfaceEnvironmentRegistryForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import { buildSyntheticTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/__tests__/synthetic-tile-surface-fixture";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

const VIEW_TAB_ID = "view-tab-1";

interface TestState {
  readonly mounts: Map<string, number>;
  readonly unmounts: Map<string, number>;
  readonly deferredClicks: Map<string, number>;
  readonly deferredRemovalClicks: Map<string, number>;
  readonly closeAutoFocusGuards: Map<string, (event: Event) => void>;
  /**
   * When an artifact id is listed here, `useEpicArtifact` returns `null` so
   * `computeIsRemoteDeleted` can fire (snapshot loaded + no live projection).
   */
  readonly missingArtifactIds: Set<string>;
  /**
   * Controllable stand-in for `STABLE_TILE_SURFACE_HOST_ENABLED`. A getter
   * mock keeps the live ESM binding fresh on every `surfaceOwnerFor` call
   * without `vi.resetModules()` (which would re-instantiate the canvas store
   * and desync the static `useEpicCanvasStore` import this file seeds).
   */
  stableTileSurfaceHostEnabled: boolean;
}

const testState = vi.hoisted((): TestState => ({
  mounts: new Map(),
  unmounts: new Map(),
  deferredClicks: new Map(),
  deferredRemovalClicks: new Map(),
  closeAutoFocusGuards: new Map(),
  missingArtifactIds: new Set(),
  stableTileSurfaceHostEnabled: false,
}));

vi.mock(
  "@/components/epic-canvas/surface-host/stable-tile-surface-host-switch",
  () => ({
    get STABLE_TILE_SURFACE_HOST_ENABLED() {
      return testState.stableTileSurfaceHostEnabled;
    },
  }),
);

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
  useEpicArtifact: (id: string) =>
    testState.missingArtifactIds.has(id) ? null : { id },
  useEpicTabDisplayTitle: (node: { readonly name: string }) => node.name,
  useEpicLiveArtifactTitleGenerating: () => false,
  useEpicPermissionRole: () => "owner",
  useEpicSnapshotLoaded: () => true,
  useMaybeEpicTuiAgentHarnessId: () => null,
  useRegisteredEpicActiveAgentIds: () => new Set<string>(),
  // Chat tab strip icons (ChatProgressIcon) need activity tiers when a chat
  // tile is the active tab - not exercised by the older spec/terminal-only
  // fixtures in this file.
  useEpicAgentActivityTiers: () => new Map<string, false>(),
}));

vi.mock("@/lib/registries/chat-session-registry", () => ({
  useExistingChatSessionHandle: () => null,
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
        <button
          type="button"
          data-testid={`stopped-pointer-activation-${props.id}`}
          onPointerDown={(event) => event.stopPropagation()}
        >
          Stopped pointer action
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

const CHAT: EpicCanvasTileRef = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat",
  name: "Chat",
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
  activeTabId: string | null,
): TilePane {
  return {
    kind: "pane",
    id: "group-1",
    tabInstanceIds: tabs.map((tab) => tab.instanceId),
    activeTabId,
    previewTabId: null,
    activationHistory: activeTabId === null ? [] : [activeTabId],
  };
}

// TabGroupView resolves its tab payloads via `usePaneTabRefs(tabId, pane)`,
// which reads `canvasByTabId[tabId].tilesByInstanceId`. Seed that so the pane's
// instanceIds resolve to the given refs.
function seedCanvas(
  tabs: ReadonlyArray<EpicCanvasTileRef>,
  activeTabId: string | null,
): void {
  seedCanvasWithActivePane(tabs, activeTabId, "group-1");
}

function seedCanvasWithActivePane(
  tabs: ReadonlyArray<EpicCanvasTileRef>,
  activeTabId: string | null,
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
  activeTabId: string | null,
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

const OPEN_EPIC_HANDLE = {} as OpenEpicStoreHandle;

function seedHostedTopLevelTab(): void {
  useEpicCanvasStore.setState((state) => ({
    ...state,
    openTabOrder: [VIEW_TAB_ID],
  }));
  const ref: TabRef = { kind: "epic", id: VIEW_TAB_ID };
  useTabsStore.setState((state) => ({
    ...state,
    items: [{ kind: "tab" as const, id: `tab:${ref.kind}:${ref.id}`, ref }],
    activeItemId: `tab:${ref.kind}:${ref.id}`,
    stripOrder: [ref],
  }));
}

function hostedGroupView(
  renderRecordBody: () => ReactNode,
  onPointerDownCapture: (() => void) | undefined,
): ReactNode {
  return (
    <EpicSessionContext.Provider value={OPEN_EPIC_HANDLE}>
      <TooltipProvider>
        <PaneVisibilityContext.Provider value>
          <div onPointerDownCapture={onPointerDownCapture}>
            <TabGroupView
              epicId="epic-1"
              tabId={VIEW_TAB_ID}
              pane={pane([CHAT], CHAT.instanceId)}
            />
            <StableTileSurfaceHost renderRecordBody={renderRecordBody} />
          </div>
        </PaneVisibilityContext.Provider>
      </TooltipProvider>
    </EpicSessionContext.Provider>
  );
}

/**
 * Design-review slice-4 F2 residual: the four-way ownership shape the
 * reviewer's own probe used, resampled on demand.
 */
interface OwnershipSnapshot {
  readonly deleted: boolean;
  readonly member: boolean;
  readonly inline: boolean;
  readonly hosted: boolean;
}

function ownershipSnapshot(instanceId: string): OwnershipSnapshot {
  return {
    deleted: isChatRemoteDeleted(instanceId),
    member: getTileSurfaceMembership().has(instanceId),
    inline:
      document.querySelector('[data-testid="deleted-node-body"]') !== null,
    hosted:
      document.querySelector(
        `[${HOSTED_TILE_INSTANCE_ID_ATTRIBUTE}="${instanceId}"]`,
      ) !== null,
  };
}

/**
 * Design-review slice-4 F2 residual: a genuine sibling `useLayoutEffect`
 * (no deps array - it re-samples on EVERY commit that touches this tree)
 * captures the four-way ownership shape the reviewer's own probe used.
 * Rendered as the LAST sibling after `TabGroupView` and
 * `StableTileSurfaceHost`, its layout effect only runs once React has
 * finished processing every earlier sibling's own layout effects for the
 * SAME commit - so it observes exactly what has settled by the end of the
 * layout phase, strictly before any passive effect (a `useEffect`-based
 * report, if the fix regresses) gets a chance to run.
 *
 * This reliably discriminates `deleted`/`member`/`inline` (all three are
 * driven by plain, synchronous function calls in the report's own reaction
 * chain - see `tab-group-view.tsx`'s doc comment on
 * `reportChatRemoteDeletionState`). `hosted` is NOT part of what this probe
 * can prove: `StableTileSurfaceHost` reacts to membership through
 * `useSyncExternalStore`, a SEPARATE component whose consequential
 * re-render is necessarily a LATER React commit than the one containing
 * `TabGroupView`'s own layout effect - still synchronous and still strictly
 * pre-paint (nothing yields to the browser in between), but after this
 * probe's own same-commit vantage point has already sampled. Three other
 * techniques were tried to also pin `hosted` at this exact vantage point and
 * rejected, each confirmed empirically rather than assumed: an `act()`-
 * wrapped `rerender()`, a raw non-act `setState` plus a `setTimeout`
 * macrotask tick, and `react-dom`'s `flushSync` ALL settle to the fully
 * "fixed" shape even under the reverted `useEffect` mutation - in this
 * environment none of them stop short of also draining the passive effect,
 * so none can tell "resolved without ever yielding to a paint" apart from
 * "resolved, but only after yielding once" (a stricter case of the
 * established React-19 act-environment lesson - see
 * `chat-timeline.test.tsx` - which this component's simpler, unvirtualized
 * effect chain leaves no natural gap for even the raw-non-act/macrotask
 * variant to exploit). `hosted` clearing is instead covered by the
 * post-flip `waitFor` below, which confirms real eventual settlement.
 */
function LayoutPhaseOwnershipProbe(props: {
  readonly instanceId: string;
  readonly onSnapshot: (snapshot: OwnershipSnapshot) => void;
}): ReactNode {
  useLayoutEffect(() => {
    props.onSnapshot(ownershipSnapshot(props.instanceId));
  });
  return null;
}

describe("<TabGroupView />", () => {
  afterEach(() => {
    cleanup();
    testState.mounts.clear();
    testState.unmounts.clear();
    testState.deferredClicks.clear();
    testState.deferredRemovalClicks.clear();
    testState.closeAutoFocusGuards.clear();
    testState.missingArtifactIds.clear();
    testState.stableTileSurfaceHostEnabled = false;
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

  it("activates a physical pane before a descendant stops pointerdown propagation", async () => {
    const tabs = [SPEC];
    seedCanvasWithActivePane(tabs, SPEC.instanceId, "other-group");
    render(groupView(tabs, SPEC.instanceId, true));

    const stoppedPointer = await screen.findByTestId(
      `stopped-pointer-activation-${SPEC.id}`,
    );
    fireEvent.pointerDown(stoppedPointer);

    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
    ).toBe("group-1");
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

  it("falls back to the first tab when pane.activeTabId is null (resolveActivePaneTab wiring)", async () => {
    // Byte-equivalence pin for Ticket 21 slice 1: TabGroupView delegates
    // body active-tab resolution to `resolveActivePaneTab`. A null
    // activeTabId must still mount/select the first strip tab - same as the
    // previous inline fallback. Inactive never-visited tabs stay unmounted
    // under the keep-alive policy (not display:none).
    const tabs = [specTab(1), specTab(2)];
    seedCanvas(tabs, null);
    const { container } = render(groupView(tabs, null, true));

    await waitFor(() => {
      expect(testState.mounts.get("spec-1")).toBe(1);
    });
    const firstLayer = container.querySelector(
      '[data-tab-instance-id="inst-spec-1"]',
    );
    expect(firstLayer).not.toBeNull();
    expect(firstLayer?.getAttribute("data-selected")).toBe("true");
    expect(firstLayer?.classList.contains("hidden")).toBe(false);
    expect(
      container.querySelector('[data-tab-instance-id="inst-spec-2"]'),
    ).toBeNull();
    expect(testState.mounts.get("spec-2")).toBeUndefined();
  });

  it("falls back to the first tab when pane.activeTabId is stale (resolveActivePaneTab wiring)", async () => {
    const tabs = [specTab(1), specTab(2)];
    const staleActiveId = "inst-spec-gone";
    seedCanvas(tabs, staleActiveId);
    const { container } = render(groupView(tabs, staleActiveId, true));

    await waitFor(() => {
      expect(testState.mounts.get("spec-1")).toBe(1);
    });
    const firstLayer = container.querySelector(
      '[data-tab-instance-id="inst-spec-1"]',
    );
    expect(firstLayer).not.toBeNull();
    expect(firstLayer?.getAttribute("data-selected")).toBe("true");
    expect(firstLayer?.classList.contains("hidden")).toBe(false);
    expect(
      container.querySelector('[data-tab-instance-id="inst-spec-2"]'),
    ).toBeNull();
    expect(testState.mounts.get("spec-2")).toBeUndefined();
  });
});

/**
 * Ticket 21 slice 4: with the stable-tile-surface-host switch ON, ActiveTabBody
 * routes live chats through `TileSurfaceSlot` instead of the inline
 * EpicNodeTile body. The switch module is mocked with a live getter (see
 * `testState.stableTileSurfaceHostEnabled`) so these pins can flip it without
 * `vi.resetModules()` / re-importing TabGroupView.
 */
describe("<TabGroupView /> stable tile surface host routing (switch ON)", () => {
  afterEach(() => {
    cleanup();
    testState.mounts.clear();
    testState.unmounts.clear();
    testState.deferredClicks.clear();
    testState.missingArtifactIds.clear();
    testState.stableTileSurfaceHostEnabled = false;
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    tabCommandCoordinator.resetReconciliationForTesting();
    resetChatRemoteDeletionRegistryForTesting();
    resetTileSurfaceMembershipForTesting();
    resetTileSurfaceEnvironmentRegistryForTesting();
  });

  it("renders TileSurfaceSlot for a live chat instead of the inline EpicNodeTile body", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    const tabs = [CHAT];
    seedCanvas(tabs, CHAT.instanceId);
    const { container } = render(groupView(tabs, CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="tile-surface-slot"]'),
      ).not.toBeNull();
    });
    const slot = container.querySelector('[data-testid="tile-surface-slot"]');
    expect(slot?.getAttribute("data-tile-instance-id")).toBe(CHAT.instanceId);
    // Inline EpicNodeTile body must NOT mount for a hosted chat.
    expect(
      container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
    ).toBeNull();
    expect(testState.mounts.get(CHAT.id)).toBeUndefined();
  });

  it("keeps a remote-deleted chat on DeletedArtifactBody (not hosted) even with the switch ON", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    const tabs = [CHAT];
    testState.missingArtifactIds.add(CHAT.id);
    seedCanvas(tabs, CHAT.instanceId);
    const { container } = render(groupView(tabs, CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="deleted-node-body"]'),
      ).not.toBeNull();
    });
    expect(
      container.querySelector('[data-testid="tile-surface-slot"]'),
    ).toBeNull();
    expect(
      container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
    ).toBeNull();
  });

  it("reports the remote-deletion transition into the shared registry so membership can react", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    const tabs = [CHAT];
    seedCanvas(tabs, CHAT.instanceId);
    const { container, rerender } = render(
      groupView(tabs, CHAT.instanceId, true),
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="tile-surface-slot"]'),
      ).not.toBeNull();
    });
    expect(isChatRemoteDeleted(CHAT.instanceId)).toBe(false);

    // Same chat, still hosted going in - now becomes remote-deleted mid-session
    // (a Y.Doc sync event), not deleted from the start.
    testState.missingArtifactIds.add(CHAT.id);
    rerender(groupView(tabs, CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="deleted-node-body"]'),
      ).not.toBeNull();
    });
    expect(
      container.querySelector('[data-testid="tile-surface-slot"]'),
    ).toBeNull();
    // `tile-surface-membership.ts`'s and `remote-deleted-chat-registry.ts`'s own
    // pure-function pins cover the membership-drop/registry-clear consequence
    // of this report (both are unreachable from this React-mounted harness:
    // `TileSurfaceSlot` never publishes here without a real epic session
    // handle, and no `StableTileSurfaceHost` sibling is mounted to observe).
    expect(isChatRemoteDeleted(CHAT.instanceId)).toBe(true);
  });

  it("design-review F2 residual: a real StableTileSurfaceHost sibling loses the hosted owner in the SAME pre-paint commit as the inline flip", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    const tabs = [CHAT];
    seedCanvas(tabs, CHAT.instanceId);
    // `seedCanvas` does not set `openTabOrder`; `getHeaderTabs()` (the
    // top-level retention layer's source of truth) resolves this view tab
    // only through `openTabOrder`, not `tabsById` alone.
    useEpicCanvasStore.setState((state) => ({
      ...state,
      openTabOrder: [VIEW_TAB_ID],
    }));
    const ref: TabRef = { kind: "epic", id: VIEW_TAB_ID };
    useTabsStore.setState((state) => ({
      ...state,
      items: [{ kind: "tab" as const, id: `tab:${ref.kind}:${ref.id}`, ref }],
      activeItemId: `tab:${ref.kind}:${ref.id}`,
      stripOrder: [ref],
    }));
    resetTileSurfaceEnvironmentRegistryForTesting();

    const snapshots: OwnershipSnapshot[] = [];
    const tree = (): ReactNode => (
      <TooltipProvider>
        <PaneVisibilityContext.Provider value>
          <TabGroupView
            epicId="epic-1"
            tabId={VIEW_TAB_ID}
            pane={pane(tabs, CHAT.instanceId)}
          />
          <StableTileSurfaceHost
            renderRecordBody={() => <div data-testid="hosted-body-stub" />}
          />
          <LayoutPhaseOwnershipProbe
            instanceId={CHAT.instanceId}
            onSnapshot={(snapshot) => snapshots.push(snapshot)}
          />
        </PaneVisibilityContext.Provider>
      </TooltipProvider>
    );

    const { rerender } = render(tree());
    await waitFor(() => {
      expect(getTileSurfaceMembership().has(CHAT.instanceId)).toBe(true);
    });

    // A real published environment - not a manufactured DOM node - so a real
    // `StableTileSurfaceHost` record is genuinely mounted before the flip.
    // `publishTileSurfaceEnvironment` synchronously notifies its
    // `useSyncExternalStore` subscribers outside any RTL-driven update, so
    // wrap it the same way the transfer-gap test wraps its store mutation.
    act(() => {
      publishTileSurfaceEnvironment(
        buildSyntheticTileSurfaceEnvironment(CHAT.instanceId, {
          placement: {
            epicId: "epic-1",
            viewTabId: VIEW_TAB_ID,
            paneId: "group-1",
            hostId: "host-A",
          },
        }),
      );
    });
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="hosted-body-stub"]'),
      ).not.toBeNull();
    });

    // Discard every snapshot the setup steps above produced - only the
    // deletion-triggering commit's samples matter.
    snapshots.length = 0;

    testState.missingArtifactIds.add(CHAT.id);
    rerender(tree());

    await waitFor(() => {
      // Confirms real eventual settlement - including `StableTileSurfaceHost`
      // actually dropping the stale record - so a genuinely broken
      // transition doesn't silently pass this test. See
      // `LayoutPhaseOwnershipProbe`'s doc comment for why `hosted`'s exact
      // pre-paint timing isn't independently provable in this environment,
      // even though it's provably synchronous by construction (a plain,
      // uninterrupted `useSyncExternalStore` cascade from the same report).
      expect(isChatRemoteDeleted(CHAT.instanceId)).toBe(true);
      expect(
        document.querySelector(
          `[${HOSTED_TILE_INSTANCE_ID_ATTRIBUTE}="${CHAT.instanceId}"]`,
        ),
      ).toBeNull();
    });

    expect(snapshots.length).toBeGreaterThan(0);
    // The FIRST post-trigger commit's layout-phase snapshot is the one that
    // discriminates the report's own effect type: `LayoutPhaseOwnershipProbe`
    // is the LAST sibling, so by the time ITS layout effect runs,
    // `TabGroupView`'s own layout effect (and the synchronous registry/
    // membership chain it calls directly) has already completed for that
    // same commit - a passive-effect report would not have run yet at this
    // point, reproducing the reviewer's exact `{ deleted: false, member:
    // true, inline: true, hosted: true }` red shape under the useEffect
    // mutation below.
    expect(snapshots[0].deleted).toBe(true);
    expect(snapshots[0].member).toBe(false);
    expect(snapshots[0].inline).toBe(true);
  });

  it("keeps a non-chat tile inline even with the switch ON", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    const tabs = [SPEC];
    seedCanvas(tabs, SPEC.instanceId);
    const { container } = render(groupView(tabs, SPEC.instanceId, true));

    await waitFor(() => {
      expect(testState.mounts.get(SPEC.id)).toBe(1);
    });
    expect(
      container.querySelector(`[data-testid="tile-${SPEC.id}"]`),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="tile-surface-slot"]'),
    ).toBeNull();
  });

  it("design-review F3: completes a deferred hosted activation on a real pointerdown+click on the hosted record itself", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    const tabs = [CHAT];
    // Pane is not the active canvas pane - activation should flip activePaneId.
    seedCanvasWithActivePane(tabs, CHAT.instanceId, "other-group");
    seedHostedTopLevelTab();
    render(
      hostedGroupView(
        () => (
          <button
            type="button"
            {...paneActivationDeferProps}
            data-testid="hosted-deferred-activation"
          >
            Deferred hosted action
          </button>
        ),
        undefined,
      ),
    );
    const hostedDeferred = await screen.findByTestId(
      "hosted-deferred-activation",
    );

    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
    ).toBe("other-group");

    // A real pointerdown directly on the hosted deferred marker - no
    // physical-pane pointerdown involved - arms the deferred flag; the
    // subsequent click on the same hosted element completes it.
    fireEvent.pointerDown(hostedDeferred);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
    ).toBe("other-group");
    fireEvent.click(hostedDeferred);

    await waitFor(() => {
      expect(
        useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
      ).toBe("group-1");
    });
  });

  it("design-review F3: activates the pane immediately on a non-deferred pointerdown on a hosted record", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    const tabs = [CHAT];
    seedCanvasWithActivePane(tabs, CHAT.instanceId, "other-group");
    seedHostedTopLevelTab();
    render(
      hostedGroupView(
        () => <div data-testid="hosted-non-deferred-body" />,
        undefined,
      ),
    );
    const hostedBody = await screen.findByTestId("hosted-non-deferred-body");

    // No `data-pane-activation-defer` anywhere on this target - ordinary
    // hosted clicks must activate on pointerdown itself, same as an ordinary
    // physical-pane pointerdown does via `handlePointerDownCapture`.
    fireEvent.pointerDown(hostedBody);

    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
    ).toBe("group-1");
  });

  it("activates a hosted pane before a descendant stops pointerdown propagation", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    seedCanvasWithActivePane([CHAT], CHAT.instanceId, "other-group");
    seedHostedTopLevelTab();
    render(
      hostedGroupView(
        () => (
          <button
            type="button"
            data-testid="hosted-stopped-pointer"
            onPointerDown={(event) => event.stopPropagation()}
          >
            Hosted stopped pointer action
          </button>
        ),
        undefined,
      ),
    );

    fireEvent.pointerDown(await screen.findByTestId("hosted-stopped-pointer"));

    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
    ).toBe("group-1");
  });

  it("does not let descendant pointerdown preventDefault suppress a hosted claim", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    seedCanvasWithActivePane([CHAT], CHAT.instanceId, "other-group");
    seedHostedTopLevelTab();
    render(
      hostedGroupView(
        () => (
          <button
            type="button"
            data-testid="hosted-prevented-pointer"
            onPointerDown={(event) => event.preventDefault()}
          >
            Hosted prevented pointer action
          </button>
        ),
        undefined,
      ),
    );

    fireEvent.pointerDown(
      await screen.findByTestId("hosted-prevented-pointer"),
    );

    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
    ).toBe("group-1");
  });

  it("keeps the hosted claim structurally after document capture and before descendants across a full remount", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    const order: string[] = [];
    const unsubscribe = useEpicCanvasStore.subscribe((next, previous) => {
      const nextPaneId = next.canvasByTabId[VIEW_TAB_ID]?.activePaneId ?? null;
      const previousPaneId =
        previous.canvasByTabId[VIEW_TAB_ID]?.activePaneId ?? null;
      if (nextPaneId === "group-1" && previousPaneId !== "group-1") {
        order.push("claim");
      }
    });
    onTestFinished(unsubscribe);
    // This wrapper is structurally below document but above the hosted plane.
    // Seeing it before the claim, and the target after the claim, proves the
    // document marker has completed before the plane dispatches ownership.
    const renderOrderingHarness = () =>
      hostedGroupView(
        () => (
          <div
            data-testid="hosted-ordering-target"
            onPointerDownCapture={() => order.push("descendant")}
          />
        ),
        () => order.push("plane-ancestor"),
      );

    seedCanvasWithActivePane([CHAT], CHAT.instanceId, "other-group");
    seedHostedTopLevelTab();
    let rendered = render(renderOrderingHarness());
    fireEvent.pointerDown(await screen.findByTestId("hosted-ordering-target"));
    expect(order).toEqual(["plane-ancestor", "claim", "descendant"]);

    rendered.unmount();
    seedCanvasWithActivePane([CHAT], CHAT.instanceId, "other-group");
    seedHostedTopLevelTab();
    order.length = 0;
    rendered = render(renderOrderingHarness());
    fireEvent.pointerDown(await screen.findByTestId("hosted-ordering-target"));
    expect(order).toEqual(["plane-ancestor", "claim", "descendant"]);
    rendered.unmount();
  });

  it("publishes the hosted control's pane activation focus intent through the real slot", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    const tabs = [CHAT];
    seedCanvasWithActivePane(tabs, CHAT.instanceId, "other-group");
    seedHostedTopLevelTab();
    resetTileSurfaceEnvironmentRegistryForTesting();
    render(
      hostedGroupView(
        () => <button type="button">Hosted action</button>,
        undefined,
      ),
    );

    const hostedControl = await screen.findByRole("button", {
      name: "Hosted action",
    });
    expect(
      getTileSurfaceEnvironment(
        CHAT.instanceId,
      )?.paneActivation.focusIntent.shouldYieldAutoFocus(),
    ).toBe(false);

    fireEvent.pointerDown(hostedControl);

    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
    ).toBe("group-1");
    expect(
      getTileSurfaceEnvironment(
        CHAT.instanceId,
      )?.paneActivation.focusIntent.shouldYieldAutoFocus(),
    ).toBe(true);
  });

  it("does not activate this pane when a hosted pointerdown belongs to a different paneId", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    const tabs = [CHAT];
    seedCanvasWithActivePane(tabs, CHAT.instanceId, "other-group");
    const { container } = render(groupView(tabs, CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="tile-surface-slot"]'),
      ).not.toBeNull();
    });

    const foreignHosted = document.createElement("div");
    foreignHosted.setAttribute(
      HOSTED_TILE_INSTANCE_ID_ATTRIBUTE,
      "inst-other-chat",
    );
    foreignHosted.setAttribute(HOSTED_TILE_PANE_ID_ATTRIBUTE, "sibling-pane");
    foreignHosted.setAttribute(
      HOSTED_TILE_VIEW_TAB_ID_ATTRIBUTE,
      "other-view-tab",
    );
    document.body.appendChild(foreignHosted);
    onTestFinished(() => foreignHosted.remove());
    const foreignBody = document.createElement("div");
    foreignBody.setAttribute("data-testid", "foreign-hosted-body");
    foreignHosted.appendChild(foreignBody);

    fireEvent.pointerDown(foreignBody);

    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]?.activePaneId,
    ).toBe("other-group");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  render,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { TileSurfaceSlot } from "@/components/epic-canvas/surface-host/tile-surface-slot";
import {
  getTileSurfaceEnvironment,
  resetTileSurfaceEnvironmentRegistryForTesting,
  subscribeTileSurfaceEnvironment,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import { resetTileSurfaceMembershipForTesting } from "@/components/epic-canvas/surface-host/tile-surface-membership";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import { useTabsStore } from "@/stores/tabs/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";
import {
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
  PaneFocusProbeContext,
  PanePortalContainerContext,
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
} from "@/components/epic-tabs/pane-visibility-context";
import {
  PaneActivationFocusIntentContext,
  type PaneActivationFocusIntent,
} from "@/components/epic-canvas/pane-activation";

const INSTANCE_ID = "chat-slot-1";
const VIEW_TAB_ID = "tab-1";
const PANE_ID = "p1";
const EPIC_ID = "epic-1";

const CHAT_NODE = {
  id: INSTANCE_ID,
  instanceId: INSTANCE_ID,
  type: "chat" as const,
  name: "Chat slot",
  hostId: TEST_HOST_ID,
};

const OPEN_EPIC_HANDLE = {} as OpenEpicStoreHandle;
const HOST_CLIENT = {} as HostClient<HostRpcRegistry>;

function canvasWithChat(): EpicCanvasState {
  return {
    root: pane(PANE_ID, [INSTANCE_ID]),
    activePaneId: PANE_ID,
    tilesByInstanceId: { [INSTANCE_ID]: CHAT_NODE },
    sizesByGroupId: {},
  };
}

function seedMembership(): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: {
        tabId: VIEW_TAB_ID,
        epicId: EPIC_ID,
        name: "Epic 1",
      },
    },
    canvasByTabId: { [VIEW_TAB_ID]: canvasWithChat() },
    openTabOrder: [VIEW_TAB_ID],
    activeTabId: VIEW_TAB_ID,
  });
  const ref: TabRef = { kind: "epic", id: VIEW_TAB_ID };
  useTabsStore.setState((state) => ({
    ...state,
    items: [{ kind: "tab" as const, id: `tab:${ref.kind}:${ref.id}`, ref }],
    activeItemId: `tab:${ref.kind}:${ref.id}`,
    stripOrder: [ref],
  }));
}

function resetAll(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  tabCommandCoordinator.resetReconciliationForTesting();
  resetTileSurfaceMembershipForTesting();
  resetTileSurfaceEnvironmentRegistryForTesting();
}

function renderSlot(args: {
  readonly visible: boolean;
  readonly focused: boolean;
  readonly tabSelected: boolean;
  readonly canvasPaneActive: boolean;
}): RenderResult {
  const tree = (providers: {
    readonly visible: boolean;
    readonly focused: boolean;
  }): ReactNode => (
    <EpicSessionContext.Provider value={OPEN_EPIC_HANDLE}>
      <EpicSessionHostClientContext.Provider value={HOST_CLIENT}>
        <PaneVisibilityContext.Provider value={providers.visible}>
          <PaneSurfaceActivityContext.Provider
            value={{ visible: providers.visible, focused: providers.focused }}
          >
            <PaneFocusProbeContext.Provider value={() => providers.focused}>
              <TileSurfaceSlot
                node={CHAT_NODE}
                epicId={EPIC_ID}
                paneId={PANE_ID}
                viewTabId={VIEW_TAB_ID}
                tabSelected={args.tabSelected}
                canvasPaneActive={args.canvasPaneActive}
              />
            </PaneFocusProbeContext.Provider>
          </PaneSurfaceActivityContext.Provider>
        </PaneVisibilityContext.Provider>
      </EpicSessionHostClientContext.Provider>
    </EpicSessionContext.Provider>
  );

  return render(tree({ visible: args.visible, focused: args.focused }));
}

describe("TileSurfaceSlot environment publish", () => {
  beforeEach(() => {
    resetAll();
    seedMembership();
  });
  afterEach(() => {
    cleanup();
    resetAll();
  });

  it("publishes a ReadyTileSurfaceEnvironment with identity/placement/canvasActivity/services", async () => {
    renderSlot({
      visible: true,
      focused: false,
      tabSelected: true,
      canvasPaneActive: true,
    });

    await waitFor(() => {
      expect(getTileSurfaceEnvironment(INSTANCE_ID)).not.toBeNull();
    });

    const env = getTileSurfaceEnvironment(INSTANCE_ID);
    if (env === null) throw new Error("expected published environment");
    expect(env.identity).toEqual({
      instanceId: INSTANCE_ID,
      tileKind: "chat",
      contentId: INSTANCE_ID,
      epicId: EPIC_ID,
      hostId: TEST_HOST_ID,
    });
    expect(env.placement).toEqual({
      epicId: EPIC_ID,
      viewTabId: VIEW_TAB_ID,
      paneId: PANE_ID,
      hostId: TEST_HOST_ID,
    });
    expect(env.canvasActivity).toEqual({
      tabSelected: true,
      canvasPaneActive: true,
    });
    expect(env.services.openEpicHandle).toBe(OPEN_EPIC_HANDLE);
    expect(env.services.hostClient).toBe(HOST_CLIENT);
    expect(env.services.geometryAnchorElement).toBeInstanceOf(HTMLElement);
    // No `PanePortalContainerContext.Provider` wraps this render, so the
    // ambient value is the context's own `null` default.
    expect(env.services.panePortalContainer).toBeNull();
    expect(typeof env.services.isPaneFocusedNow).toBe("function");
  });

  it("design-review F5: publishes the REAL ambient PanePortalContainerContext value as services.panePortalContainer, distinct from the slot's own geometry anchor", async () => {
    const realPortalHost = document.createElement("div");
    render(
      <EpicSessionContext.Provider value={OPEN_EPIC_HANDLE}>
        <PaneVisibilityContext.Provider value>
          <PaneSurfaceActivityContext.Provider
            value={{ visible: true, focused: true }}
          >
            <PaneFocusProbeContext.Provider value={() => true}>
              <PanePortalContainerContext.Provider value={realPortalHost}>
                <TileSurfaceSlot
                  node={CHAT_NODE}
                  epicId={EPIC_ID}
                  paneId={PANE_ID}
                  viewTabId={VIEW_TAB_ID}
                  tabSelected
                  canvasPaneActive
                />
              </PanePortalContainerContext.Provider>
            </PaneFocusProbeContext.Provider>
          </PaneSurfaceActivityContext.Provider>
        </PaneVisibilityContext.Provider>
      </EpicSessionContext.Provider>,
    );

    await waitFor(() => {
      expect(getTileSurfaceEnvironment(INSTANCE_ID)).not.toBeNull();
    });

    const env = getTileSurfaceEnvironment(INSTANCE_ID);
    if (env === null) throw new Error("expected published environment");
    expect(env.services.panePortalContainer).toBe(realPortalHost);
    expect(env.services.geometryAnchorElement).toBeInstanceOf(HTMLElement);
    expect(env.services.geometryAnchorElement).not.toBe(realPortalHost);
  });

  it("publishes topLevelFocused from the RAW PaneSurfaceActivityContext.focused, not visible&&focused (design-review finding 1)", async () => {
    // Case A: visible=true, focused=false -> collapsed (visible&&focused) is
    // false, raw focused is false - both agree, baseline.
    const { rerender } = renderSlot({
      visible: true,
      focused: false,
      tabSelected: true,
      canvasPaneActive: false,
    });
    await waitFor(() => {
      expect(getTileSurfaceEnvironment(INSTANCE_ID)).not.toBeNull();
    });
    expect(getTileSurfaceEnvironment(INSTANCE_ID)?.presentation).toEqual({
      topLevelVisible: true,
      topLevelFocused: false,
    });

    // Case B: visible=false, focused=true -> collapsed would be false, raw
    // focused is true. Pin that the published value is the RAW focused bit.
    const nextTree = (
      <EpicSessionContext.Provider value={OPEN_EPIC_HANDLE}>
        <PaneVisibilityContext.Provider value={false}>
          <PaneSurfaceActivityContext.Provider
            value={{ visible: false, focused: true }}
          >
            <PaneFocusProbeContext.Provider value={() => true}>
              <TileSurfaceSlot
                node={CHAT_NODE}
                epicId={EPIC_ID}
                paneId={PANE_ID}
                viewTabId={VIEW_TAB_ID}
                tabSelected
                canvasPaneActive={false}
              />
            </PaneFocusProbeContext.Provider>
          </PaneSurfaceActivityContext.Provider>
        </PaneVisibilityContext.Provider>
      </EpicSessionContext.Provider>
    );
    rerender(nextTree);

    await waitFor(() => {
      expect(getTileSurfaceEnvironment(INSTANCE_ID)?.presentation).toEqual({
        topLevelVisible: false,
        topLevelFocused: true,
      });
    });
    // Collapsed form (visible && focused) would be false here - asserting the
    // published value is true is the direct signal that the slot did NOT go
    // through usePaneFocused().
    const published = getTileSurfaceEnvironment(INSTANCE_ID)?.presentation;
    if (published === undefined) {
      throw new Error("expected published presentation");
    }
    const collapsedFocused =
      published.topLevelVisible && published.topLevelFocused;
    expect(published.topLevelFocused).toBe(true);
    expect(collapsedFocused).toBe(false);
  });

  it("notifies environment subscribers when presentation changes", async () => {
    const notifications: number[] = [];
    const unsubscribe = subscribeTileSurfaceEnvironment(INSTANCE_ID, () => {
      notifications.push(notifications.length + 1);
    });

    const { rerender } = renderSlot({
      visible: true,
      focused: false,
      tabSelected: true,
      canvasPaneActive: false,
    });
    await waitFor(() => {
      expect(getTileSurfaceEnvironment(INSTANCE_ID)).not.toBeNull();
    });
    const afterFirstPublish = notifications.length;
    expect(afterFirstPublish).toBeGreaterThan(0);

    act(() => {
      rerender(
        <EpicSessionContext.Provider value={OPEN_EPIC_HANDLE}>
          <PaneVisibilityContext.Provider value>
            <PaneSurfaceActivityContext.Provider
              value={{ visible: true, focused: true }}
            >
              <PaneFocusProbeContext.Provider value={() => true}>
                <TileSurfaceSlot
                  node={CHAT_NODE}
                  epicId={EPIC_ID}
                  paneId={PANE_ID}
                  viewTabId={VIEW_TAB_ID}
                  tabSelected
                  canvasPaneActive={false}
                />
              </PaneFocusProbeContext.Provider>
            </PaneSurfaceActivityContext.Provider>
          </PaneVisibilityContext.Provider>
        </EpicSessionContext.Provider>,
      );
    });

    await waitFor(() => {
      expect(notifications.length).toBeGreaterThan(afterFirstPublish);
    });
    expect(getTileSurfaceEnvironment(INSTANCE_ID)?.presentation).toEqual({
      topLevelVisible: true,
      topLevelFocused: true,
    });
    unsubscribe();
  });

  it("republishes the dedicated pane activation axis before paint when its context identity changes", async () => {
    const firstIntent: PaneActivationFocusIntent = {
      mark: () => undefined,
      shouldYieldAutoFocus: () => false,
    };
    const secondIntent: PaneActivationFocusIntent = {
      mark: () => undefined,
      shouldYieldAutoFocus: () => true,
    };
    const notifications: number[] = [];
    const unsubscribe = subscribeTileSurfaceEnvironment(INSTANCE_ID, () => {
      notifications.push(notifications.length + 1);
    });
    const tree = (focusIntent: PaneActivationFocusIntent): ReactNode => (
      <EpicSessionContext.Provider value={OPEN_EPIC_HANDLE}>
        <PaneVisibilityContext.Provider value>
          <PaneSurfaceActivityContext.Provider
            value={{ visible: true, focused: true }}
          >
            <PaneFocusProbeContext.Provider value={() => true}>
              <PaneActivationFocusIntentContext.Provider value={focusIntent}>
                <TileSurfaceSlot
                  node={CHAT_NODE}
                  epicId={EPIC_ID}
                  paneId={PANE_ID}
                  viewTabId={VIEW_TAB_ID}
                  tabSelected
                  canvasPaneActive
                />
              </PaneActivationFocusIntentContext.Provider>
            </PaneFocusProbeContext.Provider>
          </PaneSurfaceActivityContext.Provider>
        </PaneVisibilityContext.Provider>
      </EpicSessionContext.Provider>
    );

    const { rerender } = render(tree(firstIntent));
    await waitFor(() => {
      expect(
        getTileSurfaceEnvironment(INSTANCE_ID)?.paneActivation.focusIntent,
      ).toBe(firstIntent);
    });
    const afterFirstPublish = notifications.length;

    rerender(tree(secondIntent));

    expect(
      getTileSurfaceEnvironment(INSTANCE_ID)?.paneActivation.focusIntent,
    ).toBe(secondIntent);
    expect(notifications.length).toBeGreaterThan(afterFirstPublish);
    unsubscribe();
  });

  it("stays cold (no publish) when the epic session handle is not yet available", () => {
    render(
      <EpicSessionContext.Provider value={null}>
        <PaneVisibilityContext.Provider value>
          <PaneSurfaceActivityContext.Provider
            value={{ visible: true, focused: true }}
          >
            <TileSurfaceSlot
              node={CHAT_NODE}
              epicId={EPIC_ID}
              paneId={PANE_ID}
              viewTabId={VIEW_TAB_ID}
              tabSelected
              canvasPaneActive
            />
          </PaneSurfaceActivityContext.Provider>
        </PaneVisibilityContext.Provider>
      </EpicSessionContext.Provider>,
    );

    // Layout effect has already run; no publish without a handle.
    expect(getTileSurfaceEnvironment(INSTANCE_ID)).toBeNull();
  });
});

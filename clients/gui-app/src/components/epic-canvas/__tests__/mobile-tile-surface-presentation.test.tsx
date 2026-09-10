/**
 * The phone canvas mounts ONE tile at a time, which makes it the only branch
 * where a hosted chat's environment publisher can vanish while the record it
 * published for is still a member. Every assertion here is a registry dump -
 * which records read as presented - because that predicate is what decides
 * whether a record paints, and two records reading presented at once means two
 * chat transcripts stacked at the same pane rect.
 *
 * The desktop tab group cannot reach this state (it keeps deselected tabs
 * mounted, so their slots republish `tabSelected: false`), so no desktop-branch
 * test can stand in for these.
 */
import "../../../../__tests__/test-browser-apis";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MobileEpicTileView } from "@/components/epic-canvas/mobile/mobile-epic-tile-view";
import {
  getTileSurfaceEnvironment,
  isTileSurfacePresented,
  resetTileSurfaceEnvironmentRegistryForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import {
  getTileSurfaceMembership,
  resetTileSurfaceMembershipForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-membership";
import { resetChatRemoteDeletionRegistryForTesting } from "@/components/epic-canvas/surface-host/remote-deleted-chat-registry";
import {
  PaneFocusProbeContext,
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
} from "@/components/epic-tabs/pane-visibility-context";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabRef } from "@/stores/tabs/types";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  TilePane,
} from "@/stores/epics/canvas/types";

const HOST_ID = "host-A";
const EPIC_A = { epicId: "epic-1", viewTabId: "view-tab-1", paneId: "pane-A" };
const EPIC_B = { epicId: "epic-2", viewTabId: "view-tab-2", paneId: "pane-B" };

// `ActiveTabBody` reads permission/snapshot/projection state through these
// seams on every render regardless of tab type; stubbed so the chat body
// routes through `surfaceOwnerFor` without a HostRuntimeProvider /
// EpicSessionProvider (same seams `tab-group-view.test` stubs).
vi.mock("@/lib/epic-selectors", () => ({
  useEpicArtifact: (id: string) => ({ id, userId: "user-1" }),
  useEpicChatRecordListAuthoritative: () => true,
  useEpicChatRetraction: () => null,
  useEpicTabDisplayTitle: (node: { readonly name: string }) => node.name,
  useEpicLiveArtifactTitleGenerating: () => false,
  useEpicPermissionRole: () => "owner",
  useEpicSnapshotLoaded: () => true,
  useMaybeEpicTuiAgentHarnessId: () => null,
}));

// A null canvas host keeps `computeIsRemoteDeleted` unauthoritative and the
// published-copy fallback withdrawn, so every fixture chat here takes the
// live hosted path - the one under test.
vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => null,
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => ({
    status: "reachable",
    hostLabel: hostId,
  }),
}));

vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatList: () => ({
    data: undefined,
    isError: false,
    isPending: false,
    isFetching: false,
  }),
  useCloudChatHasCloudAuthorization: () => true,
  cloudChatListAuthorizesRecordSweep: () => false,
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useExistingChatSessionHandle: () => null,
  useExistingChatSessionFatalClose: () => null,
}));

// `tab-group-view` imports the dead-tile banner container straight from
// `chat-tile`, whose real module graph pulls the chat session/host runtime
// this render-focused suite deliberately does not provide.
vi.mock("@/components/epic-canvas/renderers/chat-tile", () => ({
  ChatDeadTileBannerContainer: () => null,
}));

vi.mock("@/components/epic-canvas/renderers/epic-node-tile", () => ({
  EpicNodeTile: ({ node }: { readonly node: EpicCanvasTileRef }) => (
    <div data-testid={`tile-${node.id}`} />
  ),
}));

vi.mock("@/components/epic-canvas/canvas/pane-opener", () => ({
  PaneOpener: () => <div data-testid="pane-opener" />,
}));

vi.mock("@/components/epic-canvas/mobile/mobile-current-tile-bar", () => ({
  MobileCurrentTileBar: () => null,
}));

vi.mock("@/components/epic-canvas/mobile/tab-switcher-sheet", () => ({
  TabSwitcherSheet: () => null,
}));

const OPEN_EPIC_HANDLE = {} as OpenEpicStoreHandle;

function chat(n: number): EpicCanvasTileRef {
  return {
    id: `chat-${n}`,
    instanceId: `inst-${n}`,
    type: "chat",
    name: `Chat ${n}`,
    hostId: HOST_ID,
  };
}

function makePane(
  id: string,
  tiles: ReadonlyArray<EpicCanvasTileRef>,
  activeInstanceId: string,
): TilePane {
  return {
    kind: "pane",
    id,
    tabInstanceIds: tiles.map((tile) => tile.instanceId),
    activeTabId: activeInstanceId,
    previewTabId: null,
    activationHistory: [activeInstanceId],
  };
}

function canvasOf(
  paneId: string,
  tiles: ReadonlyArray<EpicCanvasTileRef>,
  activeInstanceId: string,
): EpicCanvasState {
  return {
    root: makePane(paneId, tiles, activeInstanceId),
    activePaneId: paneId,
    tilesByInstanceId: Object.fromEntries(
      tiles.map((tile) => [tile.instanceId, tile]),
    ),
    sizesByGroupId: {},
  };
}

function tabItem(viewTabId: string) {
  const ref: TabRef = { kind: "epic", id: viewTabId };
  return {
    item: { kind: "tab" as const, id: `tab:epic:${viewTabId}`, ref },
    ref,
  };
}

function seedCanvases(
  canvases: ReadonlyArray<{
    readonly epicId: string;
    readonly viewTabId: string;
    readonly canvas: EpicCanvasState;
  }>,
  activeViewTabId: string,
): void {
  useEpicCanvasStore.setState({
    tabsById: Object.fromEntries(
      canvases.map((entry) => [
        entry.viewTabId,
        { tabId: entry.viewTabId, epicId: entry.epicId, name: entry.epicId },
      ]),
    ),
    canvasByTabId: Object.fromEntries(
      canvases.map((entry) => [entry.viewTabId, entry.canvas]),
    ),
    openTabOrder: canvases.map((entry) => entry.viewTabId),
    activeTabId: activeViewTabId,
  });
  const entries = canvases.map((entry) => tabItem(entry.viewTabId));
  useTabsStore.setState((state) => ({
    ...state,
    items: entries.map((entry) => entry.item),
    activeItemId: `tab:epic:${activeViewTabId}`,
    stripOrder: entries.map((entry) => entry.ref),
  }));
}

function activateTopLevel(viewTabId: string): void {
  useTabsStore.setState((state) => ({
    ...state,
    activeItemId: `tab:epic:${viewTabId}`,
  }));
}

function resetAll(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  tabCommandCoordinator.resetReconciliationForTesting();
  resetChatRemoteDeletionRegistryForTesting();
  resetTileSurfaceMembershipForTesting();
  resetTileSurfaceEnvironmentRegistryForTesting();
}

/** The registry dump: every member that currently reads as painting. */
function presentedInstanceIds(): ReadonlyArray<string> {
  return [...getTileSurfaceMembership()].filter((instanceId) =>
    isTileSurfacePresented(getTileSurfaceEnvironment(instanceId)),
  );
}

function mobileView(view: {
  readonly epicId: string;
  readonly viewTabId: string;
}): ReactNode {
  return (
    <EpicSessionContext.Provider value={OPEN_EPIC_HANDLE}>
      <PaneVisibilityContext.Provider value>
        <PaneSurfaceActivityContext.Provider
          value={{ visible: true, focused: true }}
        >
          <PaneFocusProbeContext.Provider value={() => true}>
            <MobileEpicTileView epicId={view.epicId} tabId={view.viewTabId} />
          </PaneFocusProbeContext.Provider>
        </PaneSurfaceActivityContext.Provider>
      </PaneVisibilityContext.Provider>
    </EpicSessionContext.Provider>
  );
}

describe("mobile single-tile canvas: hosted surface presentation", () => {
  beforeEach(() => resetAll());
  afterEach(() => {
    cleanup();
    resetAll();
  });

  it("hands presentation over on a chat switch - the outgoing record stops reading as presented", () => {
    seedCanvases(
      [
        {
          ...EPIC_A,
          canvas: canvasOf(EPIC_A.paneId, [chat(1), chat(2)], "inst-1"),
        },
      ],
      EPIC_A.viewTabId,
    );
    render(mobileView(EPIC_A));

    // Step 1: the shown chat has published and paints alone.
    expect(presentedInstanceIds()).toEqual(["inst-1"]);

    // Step 2: switch chats, through the same store transition the mobile
    // switcher drives. Only ONE tile mounts here, so `inst-1` loses its
    // publisher while pane retention keeps its record alive.
    act(() => {
      useEpicCanvasStore
        .getState()
        .prepareSetActiveTileTabFocusTarget(
          EPIC_A.viewTabId,
          EPIC_A.paneId,
          "inst-2",
        );
    });

    // Step 3: dump. Both are members, exactly one paints.
    expect([...getTileSurfaceMembership()].sort()).toEqual([
      "inst-1",
      "inst-2",
    ]);
    expect(presentedInstanceIds()).toEqual(["inst-2"]);

    const outgoing = getTileSurfaceEnvironment("inst-1");
    if (outgoing === null) {
      throw new Error("the outgoing record must be RETAINED, not cleared");
    }
    expect(outgoing.canvasActivity.tabSelected).toBe(false);
    expect(isTileSurfacePresented(outgoing)).toBe(false);
    // Retention is intact - the record keeps a usable environment to re-show
    // from; only its claim on the rect was withdrawn.
    expect(outgoing.services.openEpicHandle).toBe(OPEN_EPIC_HANDLE);
    expect(outgoing.placement.paneId).toBe(EPIC_A.paneId);
  });

  it("switching back and forth never leaves two records presented", () => {
    seedCanvases(
      [
        {
          ...EPIC_A,
          canvas: canvasOf(EPIC_A.paneId, [chat(1), chat(2)], "inst-1"),
        },
      ],
      EPIC_A.viewTabId,
    );
    render(mobileView(EPIC_A));

    for (const instanceId of ["inst-2", "inst-1", "inst-2", "inst-1"]) {
      act(() => {
        useEpicCanvasStore
          .getState()
          .prepareSetActiveTileTabFocusTarget(
            EPIC_A.viewTabId,
            EPIC_A.paneId,
            instanceId,
          );
      });
      expect(presentedInstanceIds()).toEqual([instanceId]);
    }
  });

  it("navigating to another epic leaves no presented record behind in the one it left", () => {
    seedCanvases(
      [
        {
          ...EPIC_A,
          canvas: canvasOf(EPIC_A.paneId, [chat(1)], "inst-1"),
        },
        {
          ...EPIC_B,
          canvas: canvasOf(EPIC_B.paneId, [chat(2)], "inst-2"),
        },
      ],
      EPIC_A.viewTabId,
    );
    const { rerender } = render(mobileView(EPIC_A));
    expect(presentedInstanceIds()).toEqual(["inst-1"]);

    // The record the departed epic leaves behind stays a MEMBER (its
    // top-level surface is still retained), which is exactly why a stale
    // presentation claim on it would paint over the epic navigated to - the
    // two panes are different, and every record sits at its pane's rect.
    act(() => {
      activateTopLevel(EPIC_B.viewTabId);
      rerender(mobileView(EPIC_B));
    });

    expect([...getTileSurfaceMembership()].sort()).toEqual([
      "inst-1",
      "inst-2",
    ]);
    expect(presentedInstanceIds()).toEqual(["inst-2"]);
    expect(getTileSurfaceEnvironment("inst-1")).not.toBeNull();
  });

  it("tearing the epic view down withdraws its presentation claim", () => {
    seedCanvases(
      [
        {
          ...EPIC_A,
          canvas: canvasOf(EPIC_A.paneId, [chat(1)], "inst-1"),
        },
      ],
      EPIC_A.viewTabId,
    );
    const { unmount } = render(mobileView(EPIC_A));
    expect(presentedInstanceIds()).toEqual(["inst-1"]);

    act(() => {
      unmount();
    });

    expect(getTileSurfaceMembership().has("inst-1")).toBe(true);
    expect(presentedInstanceIds()).toEqual([]);
  });
});

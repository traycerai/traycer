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
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
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
  /**
   * Per-host reachability answered by the `useHostReachability` mock.
   * Unlisted hosts answer "reachable", which keeps every pre-existing
   * fixture on the live render path.
   */
  readonly unreachableHostIds: Set<string>;
  /** Value the `useReactiveActiveHostId` mock returns; null matches the
   * provider-less default the older fixtures render under. */
  activeHostId: string | null;
  /** Per-chat `fatalClose.code` the `useExistingChatSessionFatalClose` mock
   * answers; unlisted chat ids answer `null` (no fatal close observed). */
  readonly fatalCloseCodeByChatId: Map<string, string>;
  /** Chat ids the `useCloudChatList` mock answers as present
   * (chat-sync-v2 ticket 36's same-host cloud-known exemption). */
  readonly cloudKnownChatIds: Set<string>;
  /**
   * Per-chat record-plane retraction, as `useEpicChatRetraction` reads it off
   * `OpenEpicState.chatRetractions` (multi-host-chats record layer). Unlisted
   * chats answer `null` - no removal delta seen - which is every pre-existing
   * fixture in this file.
   */
  readonly chatRetractionByChatId: Map<string, "deleted" | "revoked">;
}

const testState = vi.hoisted((): TestState => ({
  mounts: new Map(),
  unmounts: new Map(),
  deferredClicks: new Map(),
  deferredRemovalClicks: new Map(),
  closeAutoFocusGuards: new Map(),
  missingArtifactIds: new Set(),
  stableTileSurfaceHostEnabled: false,
  unreachableHostIds: new Set(),
  activeHostId: null,
  fatalCloseCodeByChatId: new Map(),
  cloudKnownChatIds: new Set(),
  chatRetractionByChatId: new Map(),
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
  // `userId` present so the published-copy fallback can derive the chat's
  // owner from the projection, the way the live store shape provides it.
  useEpicArtifact: (id: string) =>
    testState.missingArtifactIds.has(id) ? null : { id, userId: "user-1" },
  useEpicChatRetraction: (chatId: string | null) =>
    chatId === null
      ? null
      : (testState.chatRetractionByChatId.get(chatId) ?? null),
  useEpicTabDisplayTitle: (node: { readonly name: string }) => node.name,
  useEpicLiveArtifactTitleGenerating: () => false,
  useEpicPermissionRole: () => "owner",
  useEpicSnapshotLoaded: () => true,
  useMaybeEpicTuiAgentHarnessId: () => null,
  useRegisteredEpicActiveAgentIds: () => new Set<string>(),
  useRegisteredEpicNodeArchived: () => false,
  // Chat tab strip icons (ChatProgressIcon) need activity tiers when a chat
  // tile is the active tab - not exercised by the older spec/terminal-only
  // fixtures in this file.
  useEpicAgentActivityTiers: () => new Map<string, false>(),
}));

vi.mock("@/lib/registries/chat-session-registry", () => ({
  useExistingChatSessionHandle: () => null,
  useExistingChatSessionFatalClose: (_epicId: string, chatId: string) => {
    const code = testState.fatalCloseCodeByChatId.get(chatId);
    return code === undefined
      ? null
      : {
          code,
          reason: code,
          incompatibleMethods: null,
          upgradeGuidance: null,
        };
  },
}));

// ActiveTabBody's published-copy fallback reads reachability + the active host
// through these two hook seams. Stubbed at the hook boundary (not their query
// internals) so this provider-less suite can flip a bound host dead per test.
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => ({
    status: testState.unreachableHostIds.has(hostId)
      ? "unreachable"
      : "reachable",
    hostLabel: hostId,
  }),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => testState.activeHostId,
}));

// ticket 36's same-host cloud-known exemption reads these two - stubbed at
// the same hook boundary as the pair above, for the same reason
// (provider-less suite).
vi.mock("@/lib/host", () => ({
  useHostClient: () => null,
}));

// Rows are built as WHOLE `CloudChatSummary` values, not as the subset the
// consumer happened to read when this stub was written. `tab-group-view`'s
// same-host arm reads `isOwnedByViewer` as well as `identity`, and a stub
// that enumerates fields answers `undefined` for the ones it forgot - which
// a boolean predicate reads as "not the viewer's", silently withdrawing the
// substitution this suite exists to assert. The return annotation is the
// gate: the next field the row gains fails `compile` here instead of
// quietly turning these tests red in CI.
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatList: () => ({
    data:
      testState.cloudKnownChatIds.size === 0
        ? undefined
        : {
            chats: [...testState.cloudKnownChatIds].map(
              (chatId): CloudChatSummary => ({
                identity: { taskId: "epic-1", chatId, ownerUserId: "user-1" },
                ownerHostId: "host-A",
                createdAt: 1,
                visibility: "task",
                title: null,
                isTitleEditedByUser: false,
                parentChatId: null,
                isArchived: false,
                runSettingsSummary: null,
                metadataUpdatedAt: 1,
                headSha256: null,
                publishedAt: null,
                throughRecordSeq: null,
                isOwnedByViewer: true,
              }),
            ),
          },
    isError: false,
    isPending: false,
    isFetching: false,
  }),
}));

// tab-group-view imports ChatDeadTileBannerContainer straight from chat-tile,
// whose real module graph needs the chat session registry + host runtime this
// render-focused suite deliberately does not provide (the EpicNodeTile mock
// used to sever that edge). Stub just the banner container at the same seam.
vi.mock("@/components/epic-canvas/renderers/chat-tile", () => ({
  ChatDeadTileBannerContainer: (props: {
    readonly testId: string;
    readonly reason: string;
  }) => <div data-testid={props.testId} data-reason={props.reason} />,
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

describe("<TabGroupView /> published-copy fallback for an unreachable bound host", () => {
  afterEach(() => {
    cleanup();
    testState.mounts.clear();
    testState.unmounts.clear();
    testState.missingArtifactIds.clear();
    testState.unreachableHostIds.clear();
    testState.fatalCloseCodeByChatId.clear();
    testState.cloudKnownChatIds.clear();
    testState.chatRetractionByChatId.clear();
    testState.activeHostId = null;
    testState.stableTileSurfaceHostEnabled = false;
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    tabCommandCoordinator.resetReconciliationForTesting();
    resetChatRemoteDeletionRegistryForTesting();
    resetTileSurfaceMembershipForTesting();
    resetTileSurfaceEnvironmentRegistryForTesting();
  });

  const PUBLISHED_COPY_TILE_ID = "published-chat:epic-1:user-1:chat-1";

  it("renders the published copy + dead-tile banner instead of the live chat body", async () => {
    testState.unreachableHostIds.add(CHAT.hostId);
    testState.activeHostId = "host-B";
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`,
        ),
      ).not.toBeNull();
    });
    const banner = container.querySelector(
      `[data-testid="chat-dead-tile-${CHAT.id}"]`,
    );
    expect(banner).not.toBeNull();
    // Nothing answered for this chat, so the banner is about the HOST - the
    // one state of the three that is allowed to tell the reader to go wake a
    // machine (ticket 47/48's copy split).
    expect(banner?.getAttribute("data-reason")).toBe("host-offline");
    // The live chat body must NOT render alongside the copy.
    expect(
      container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
    ).toBeNull();
  });

  it("flips back to the live chat surface when the bound host returns", async () => {
    testState.unreachableHostIds.add(CHAT.hostId);
    testState.activeHostId = "host-B";
    seedCanvas([CHAT], CHAT.instanceId);
    const { container, rerender } = render(
      groupView([CHAT], CHAT.instanceId, true),
    );
    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`,
        ),
      ).not.toBeNull();
    });

    testState.unreachableHostIds.delete(CHAT.hostId);
    rerender(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(`[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`),
    ).toBeNull();
    expect(
      container.querySelector(`[data-testid="chat-dead-tile-${CHAT.id}"]`),
    ).toBeNull();
  });

  it("stays on the live surface when the copy identity cannot be derived (no active host)", async () => {
    testState.unreachableHostIds.add(CHAT.hostId);
    testState.activeHostId = null;
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(`[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`),
    ).toBeNull();
  });

  it("does not substitute when the unreachable bound host IS the active host", async () => {
    testState.unreachableHostIds.add(CHAT.hostId);
    testState.activeHostId = CHAT.hostId;
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(`[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`),
    ).toBeNull();
  });

  it("shows the lock icon on the live chat tab's strip entry while unreachable", async () => {
    testState.unreachableHostIds.add(CHAT.hostId);
    testState.activeHostId = "host-B";
    seedCanvas([CHAT], CHAT.instanceId);
    const { container, rerender } = render(
      groupView([CHAT], CHAT.instanceId, true),
    );

    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-testid="tab-live-chat-lock-${CHAT.instanceId}"]`,
        ),
      ).not.toBeNull();
    });

    testState.unreachableHostIds.delete(CHAT.hostId);
    rerender(groupView([CHAT], CHAT.instanceId, true));
    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-testid="tab-live-chat-lock-${CHAT.instanceId}"]`,
        ),
      ).toBeNull();
    });
  });

  it("drops the instance from hosted-surface membership while the fallback is active (switch ON)", async () => {
    testState.stableTileSurfaceHostEnabled = true;
    testState.unreachableHostIds.add(CHAT.hostId);
    testState.activeHostId = "host-B";
    seedHostedTopLevelTab();
    seedCanvas([CHAT], CHAT.instanceId);
    const { container, rerender } = render(
      groupView([CHAT], CHAT.instanceId, true),
    );

    // Inline copy renders; no slot, no hosted membership - membership keeping
    // the instance would leave the environment registry holding a stale
    // visible snapshot from the unmounted slot ("removal only by membership"),
    // painting the live body over the copy.
    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`,
        ),
      ).not.toBeNull();
    });
    expect(
      container.querySelector('[data-testid="tile-surface-slot"]'),
    ).toBeNull();
    expect(getTileSurfaceMembership().has(CHAT.instanceId)).toBe(false);

    // Host returns: hosted routing resumes and membership re-admits.
    testState.unreachableHostIds.delete(CHAT.hostId);
    rerender(groupView([CHAT], CHAT.instanceId, true));
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="tile-surface-slot"]'),
      ).not.toBeNull();
    });
    expect(getTileSurfaceMembership().has(CHAT.instanceId)).toBe(true);
    expect(isChatRemoteDeleted(CHAT.instanceId)).toBe(false);
  });
});

// chat-sync-v2 ticket 35's view arm: a REACHABLE host can still have
// nothing to serve for a specific chat (`chat.subscribe` terminates
// `CHAT_NOT_VISIBLE` - a leased identity that never adopted this chat's
// rows, among other causes). Same substitution shape as the unreachable
// arm above, reusing the SAME banner + published-copy ladder - extended
// gate, not a parallel path.
describe("<TabGroupView /> published-copy fallback for a confirmed-absent chat on a reachable host", () => {
  afterEach(() => {
    cleanup();
    testState.mounts.clear();
    testState.unmounts.clear();
    testState.missingArtifactIds.clear();
    testState.unreachableHostIds.clear();
    testState.fatalCloseCodeByChatId.clear();
    testState.cloudKnownChatIds.clear();
    testState.chatRetractionByChatId.clear();
    testState.activeHostId = null;
    testState.stableTileSurfaceHostEnabled = false;
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    tabCommandCoordinator.resetReconciliationForTesting();
    resetChatRemoteDeletionRegistryForTesting();
    resetTileSurfaceMembershipForTesting();
    resetTileSurfaceEnvironmentRegistryForTesting();
  });

  const PUBLISHED_COPY_TILE_ID = "published-chat:epic-1:user-1:chat-1";

  it("substitutes the published copy + dead-tile banner (chat-not-visible reason) for a cross-host confirmed-absent chat", async () => {
    // Host is NOT in unreachableHostIds - reachable, but this chat's own
    // session already terminated CHAT_NOT_VISIBLE (chat-tile.tsx would
    // have attempted the open first; this test starts from that landed
    // state, the same way `useExistingChatSessionFatalClose` observes it).
    testState.fatalCloseCodeByChatId.set(CHAT.id, "CHAT_NOT_VISIBLE");
    testState.activeHostId = "host-B";
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`,
        ),
      ).not.toBeNull();
    });
    const banner = container.querySelector(
      `[data-testid="chat-dead-tile-${CHAT.id}"]`,
    );
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("data-reason")).toBe("chat-not-visible");
    // The live chat body must NOT render alongside the copy.
    expect(
      container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
    ).toBeNull();
  });

  it("keeps the live (generic-error) surface for a SAME-HOST confirmed-absent chat", async () => {
    testState.fatalCloseCodeByChatId.set(CHAT.id, "CHAT_NOT_VISIBLE");
    testState.activeHostId = CHAT.hostId;
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(`[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`),
    ).toBeNull();
  });

  it("does NOT substitute for an unrelated fatal close (e.g. CHAT_INVALID) - only CHAT_NOT_VISIBLE triggers this arm", async () => {
    testState.fatalCloseCodeByChatId.set(CHAT.id, "CHAT_INVALID");
    testState.activeHostId = "host-B";
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(`[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`),
    ).toBeNull();
  });

  it("flips to the live surface once the confirmed-absent signal clears (e.g. a fresh subscribe attempt)", async () => {
    testState.fatalCloseCodeByChatId.set(CHAT.id, "CHAT_NOT_VISIBLE");
    testState.activeHostId = "host-B";
    seedCanvas([CHAT], CHAT.instanceId);
    const { container, rerender } = render(
      groupView([CHAT], CHAT.instanceId, true),
    );
    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`,
        ),
      ).not.toBeNull();
    });

    testState.fatalCloseCodeByChatId.delete(CHAT.id);
    rerender(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(`[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`),
    ).toBeNull();
  });
});

// chat-sync-v2 ticket 36, NARROWED by ticket 49: a SAME-host chat (the
// active host IS the chat's bound host) with no local record but still
// cloud-known is the ORDINARY shape of a healthy migrated chat, not evidence
// of absence - creation stopped projecting into the epic doc (ticket 19) and
// `ChatDocEntrySweep` deletes every entry whose publication it proves (ticket
// 20). So the cloud row now supplies the copy's OWNER while the trigger must
// be an honest absence signal: an unreachable owner, or the host's own
// `CHAT_NOT_VISIBLE` terminate (which `chat-tile.tsx` can now produce for
// this shape, because ticket 49 widened its record gate to let a cloud-known
// chat subscribe).
describe("<TabGroupView /> published-copy fallback for a same-host chat with no local record (tickets 36 + 49)", () => {
  afterEach(() => {
    cleanup();
    testState.mounts.clear();
    testState.unmounts.clear();
    testState.missingArtifactIds.clear();
    testState.unreachableHostIds.clear();
    testState.fatalCloseCodeByChatId.clear();
    testState.cloudKnownChatIds.clear();
    testState.chatRetractionByChatId.clear();
    testState.activeHostId = null;
    testState.stableTileSurfaceHostEnabled = false;
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    tabCommandCoordinator.resetReconciliationForTesting();
    resetChatRemoteDeletionRegistryForTesting();
    resetTileSurfaceMembershipForTesting();
    resetTileSurfaceEnvironmentRegistryForTesting();
  });

  const PUBLISHED_COPY_TILE_ID = "published-chat:epic-1:user-1:chat-1";

  // This assertion is the INVERSE of the one that shipped with ticket 36
  // ("substitutes for a same-host chat with no local record that is still
  // cloud-known"), which codified the defect: post-sweep that shape is every
  // healthy migrated chat, and substituting locked each one read-only on its
  // own connected host.
  it("keeps the LIVE chat surface for a same-host record-less cloud-known chat while its owner is REACHABLE", async () => {
    testState.missingArtifactIds.add(CHAT.id);
    testState.activeHostId = CHAT.hostId;
    testState.cloudKnownChatIds.add(CHAT.id);
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    // The live tile mounts, so `chat-tile.tsx` gets to attempt
    // `chat.subscribe` at all - which is what makes the CHAT_NOT_VISIBLE
    // terminate below reachable as a signal.
    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(`[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`),
    ).toBeNull();
    expect(
      container.querySelector(`[data-testid="chat-dead-tile-${CHAT.id}"]`),
    ).toBeNull();
    // Not reaped either - the cloud row still exempts it from
    // `computeIsRemoteDeleted`, which is the other way this tab could have
    // lost its live body.
    expect(
      container.querySelector('[data-testid="deleted-node-body"]'),
    ).toBeNull();
  });

  it("still substitutes the locked published copy when the same-host owner is UNREACHABLE", async () => {
    testState.missingArtifactIds.add(CHAT.id);
    testState.activeHostId = CHAT.hostId;
    testState.unreachableHostIds.add(CHAT.hostId);
    testState.cloudKnownChatIds.add(CHAT.id);
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`,
        ),
      ).not.toBeNull();
    });
    const banner = container.querySelector(
      `[data-testid="chat-dead-tile-${CHAT.id}"]`,
    );
    expect(banner).not.toBeNull();
    // SAME host, but nothing answered - reachability outranks the (absent)
    // terminate, so this keeps the host sentence rather than claiming the
    // history "is no longer on this host", which would assert something no
    // one has said while the host is down.
    expect(banner?.getAttribute("data-reason")).toBe("host-offline");
    expect(
      container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
    ).toBeNull();
  });

  it("substitutes for a same-host record-less chat once the REACHABLE owner's own subscribe terminates CHAT_NOT_VISIBLE", async () => {
    // The honest absence detector for a reachable owner: not "this device's
    // projection has no record" (true of every swept chat) but the host
    // itself refusing the chat. `chat-tile.tsx` produces this terminate only
    // because its record gate now lets a cloud-known chat open.
    testState.missingArtifactIds.add(CHAT.id);
    testState.activeHostId = CHAT.hostId;
    testState.cloudKnownChatIds.add(CHAT.id);
    seedCanvas([CHAT], CHAT.instanceId);
    const { container, rerender } = render(
      groupView([CHAT], CHAT.instanceId, true),
    );
    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });

    testState.fatalCloseCodeByChatId.set(CHAT.id, "CHAT_NOT_VISIBLE");
    rerender(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`,
        ),
      ).not.toBeNull();
    });
    const banner = container.querySelector(
      `[data-testid="chat-dead-tile-${CHAT.id}"]`,
    );
    expect(banner).not.toBeNull();
    // The host the reader is connected to answered "not here" about ITSELF.
    // Its cross-host sentence ("history isn't available on <label>", "stays
    // bound to <label>") would print this machine's own label as somewhere
    // else - the 2026-08-11 lie. Separate reason, separate copy.
    expect(banner?.getAttribute("data-reason")).toBe("chat-not-on-this-host");
    expect(
      container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
    ).toBeNull();
  });

  it("does NOT substitute, and does not render published-chat's DeletedArtifactBody either, when the same-host chat has no local record and is NOT cloud-known", async () => {
    // Neither reap-exempted (not cloud-known) nor live (no local record) -
    // this is what a stale persisted tab reduces to once nothing anywhere
    // attests to the chat. `computeIsRemoteDeleted` renders
    // `DeletedArtifactBody`, not a silent no-op and not the copy-ladder.
    testState.missingArtifactIds.add(CHAT.id);
    testState.activeHostId = CHAT.hostId;
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="deleted-node-body"]'),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(`[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`),
    ).toBeNull();
  });

  it("does not substitute when the same-host chat still HAS a local record, even if also cloud-known", async () => {
    // liveArtifact !== null here (CHAT.id not in missingArtifactIds) - the
    // live tile renders normally, exactly today's behavior. Cloud-known
    // alone is never sufficient; it only matters once there is no local
    // record to explain the tile with.
    testState.activeHostId = CHAT.hostId;
    testState.cloudKnownChatIds.add(CHAT.id);
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(`[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`),
    ).toBeNull();
  });

  it("flips to the live surface once a local record appears (e.g. this identity adopts the chat)", async () => {
    // Unreachable owner is what puts this tab on the copy in the first place
    // now; the flip under test is still the record's arrival.
    testState.missingArtifactIds.add(CHAT.id);
    testState.activeHostId = CHAT.hostId;
    testState.unreachableHostIds.add(CHAT.hostId);
    testState.cloudKnownChatIds.add(CHAT.id);
    seedCanvas([CHAT], CHAT.instanceId);
    const { container, rerender } = render(
      groupView([CHAT], CHAT.instanceId, true),
    );
    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`,
        ),
      ).not.toBeNull();
    });

    testState.missingArtifactIds.delete(CHAT.id);
    rerender(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(`[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`),
    ).toBeNull();
  });
});

/**
 * OPEN-TAB RETRACTION (multi-host-chats record layer).
 *
 * A `host.chatRecords.subscribe` `remove` delta for a chat that is currently
 * open. The record table can only report that a row is gone; the delta's reason
 * is what picks between the two honest end states, and the two are NOT
 * interchangeable - one says the work no longer exists, the other says it does
 * and is not yours to read.
 *
 * Both arms are ABSENT-BY-DEFAULT: without a retraction these fixtures render
 * exactly what the ticket-49 tests above assert, which is what keeps this
 * additive.
 */
describe("<TabGroupView /> open-tab retraction from the record plane", () => {
  afterEach(() => {
    cleanup();
    testState.mounts.clear();
    testState.unmounts.clear();
    testState.missingArtifactIds.clear();
    testState.unreachableHostIds.clear();
    testState.fatalCloseCodeByChatId.clear();
    testState.cloudKnownChatIds.clear();
    testState.chatRetractionByChatId.clear();
    testState.activeHostId = null;
    testState.stableTileSurfaceHostEnabled = false;
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    tabCommandCoordinator.resetReconciliationForTesting();
    resetChatRemoteDeletionRegistryForTesting();
    resetTileSurfaceMembershipForTesting();
    resetTileSurfaceEnvironmentRegistryForTesting();
  });

  const PUBLISHED_COPY_TILE_ID = "published-chat:epic-1:user-1:chat-1";

  it("routes a DELETED retraction into the existing remote-deleted close flow", async () => {
    // The chat is cloud-known and its host is reachable - the exact shape
    // ticket 49 narrowed `computeIsRemoteDeleted` to LEAVE ALONE, because a
    // record-less cloud-known chat is the steady state of a healthy migrated
    // one. A `deleted` delta is the positive evidence that was missing.
    //
    // Ablation: drop the `retractedAsDeleted` check from
    // `computeIsRemoteDeleted` and this renders the live tile forever - the
    // stale transcript of a chat the host has destroyed.
    testState.missingArtifactIds.add(CHAT.id);
    testState.activeHostId = CHAT.hostId;
    testState.cloudKnownChatIds.add(CHAT.id);
    seedCanvas([CHAT], CHAT.instanceId);
    const { container, rerender } = render(
      groupView([CHAT], CHAT.instanceId, true),
    );
    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });

    testState.chatRetractionByChatId.set(CHAT.id, "deleted");
    rerender(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="deleted-node-body"]'),
      ).not.toBeNull();
    });
    // The deleted-node body is the SAME surface every other reap lands on,
    // Close action included - not a fourth bespoke end state.
    expect(
      container.querySelector('[data-testid="deleted-node-close"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
    ).toBeNull();
    // Not the revoked banner: a deleted chat is not "no longer shared".
    expect(
      container.querySelector(`[data-testid="chat-dead-tile-${CHAT.id}"]`),
    ).toBeNull();
    // And the hosted surface has been told this body took the chat inline, so
    // nothing paints over it.
    expect(isChatRemoteDeleted(CHAT.instanceId)).toBe(true);
  });

  it("renders the no-longer-shared banner, alone, for a REVOKED retraction", async () => {
    // Ablation: remove the `isRetractedAsRevoked` branch and this falls through
    // to the published-copy substitution, which offers to clone a transcript
    // the server has just stopped serving this viewer.
    testState.missingArtifactIds.add(CHAT.id);
    testState.activeHostId = CHAT.hostId;
    testState.cloudKnownChatIds.add(CHAT.id);
    seedCanvas([CHAT], CHAT.instanceId);
    const { container, rerender } = render(
      groupView([CHAT], CHAT.instanceId, true),
    );
    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });

    testState.chatRetractionByChatId.set(CHAT.id, "revoked");
    rerender(groupView([CHAT], CHAT.instanceId, true));

    const banner = await waitFor(() => {
      const found = container.querySelector(
        `[data-testid="chat-dead-tile-${CHAT.id}"]`,
      );
      expect(found).not.toBeNull();
      return found;
    });
    expect(banner?.getAttribute("data-reason")).toBe("chat-no-longer-shared");
    // The live region: the banner appears mid-session with no focus move, so a
    // screen-reader user is told nothing about why the tile emptied unless the
    // sentence is announced.
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toContain("no longer shared with you");
    // No transcript under it - there is no copy this viewer may read - and no
    // reap either: the chat still exists, it is simply not theirs.
    expect(
      container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
    ).toBeNull();
    expect(
      container.querySelector(`[data-testid="tile-${PUBLISHED_COPY_TILE_ID}"]`),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="deleted-node-body"]'),
    ).toBeNull();
    expect(isChatRemoteDeleted(CHAT.instanceId)).toBe(true);
  });

  it("outranks the unreachable-host banner - the reader's own machine is not the story", async () => {
    // Reachability normally outranks everything (a terminate is a fact from an
    // earlier moment; the host being down is the state right now). A revocation
    // is newer still AND about a different subject, so naming the host would
    // send the reader to inspect a machine that has nothing to do with it.
    testState.missingArtifactIds.add(CHAT.id);
    testState.activeHostId = "host-B";
    testState.unreachableHostIds.add(CHAT.hostId);
    testState.chatRetractionByChatId.set(CHAT.id, "revoked");
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    const banner = await waitFor(() => {
      const found = container.querySelector(
        `[data-testid="chat-dead-tile-${CHAT.id}"]`,
      );
      expect(found).not.toBeNull();
      return found;
    });
    expect(banner?.getAttribute("data-reason")).toBe("chat-no-longer-shared");
    expect(banner?.textContent).not.toContain("host-A");
  });

  it("changes nothing for a chat with no retraction", async () => {
    testState.missingArtifactIds.add(CHAT.id);
    testState.activeHostId = CHAT.hostId;
    testState.cloudKnownChatIds.add(CHAT.id);
    // A retraction for a DIFFERENT chat must not reach this tab.
    testState.chatRetractionByChatId.set("chat-other", "deleted");
    seedCanvas([CHAT], CHAT.instanceId);
    const { container } = render(groupView([CHAT], CHAT.instanceId, true));

    await waitFor(() => {
      expect(
        container.querySelector(`[data-testid="tile-${CHAT.id}"]`),
      ).not.toBeNull();
    });
    expect(
      container.querySelector('[data-testid="deleted-node-body"]'),
    ).toBeNull();
    expect(
      container.querySelector(`[data-testid="chat-dead-tile-${CHAT.id}"]`),
    ).toBeNull();
  });
});

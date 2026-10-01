import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { INERT_ROOT_STATE_PORT } from "@/stores/epics/open-epic/test-support/root-state-port-fixture";
import {
  SheetJoinBridge,
  SheetJoinScope,
} from "@/components/layout/tabs/sheet-join";
import { TabStrip } from "@/components/layout/tabs/tab-strip";
import {
  SplitMemberChrome,
  SplitTabLayout,
} from "@/components/layout/tabs/split-tab-chrome";
import {
  TabChrome,
  HeaderTabPreview,
} from "@/components/layout/tabs/header-tab-visual";
import { TabStripHomeItemView } from "@/components/layout/tabs/tab-strip-home-item";
import { TooltipProvider } from "@/components/ui/tooltip";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { tabItemId } from "@/stores/tabs/layout";
import type { TabRef } from "@/stores/tabs/types";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { KeybindingProvider } from "@/providers/keybinding-provider";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import {
  ensureHistoryTab,
  ensureSettingsTab,
} from "@/lib/commands/actions/open-system-tab";
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { __getChatSessionRegistryForTests } from "@/lib/registries/chat-session-registry";
import type { PermissionRole } from "@/lib/epic-collaborator-roles";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { EMPTY_PROJECTED_SLICES } from "@/stores/epics/open-epic/types";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { phaseMigrationController } from "@/components/epic-tabs/phase-migration-controller";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { anyTooltipHasText } from "@/components/ui/__tests__/tooltip-probe";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const notificationIndicatorTestState = vi.hoisted(
  (): {
    request: {
      readonly epicIds: ReadonlyArray<string>;
      readonly chatIds: ReadonlyArray<string>;
    } | null;
  } => ({ request: null }),
);

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: (request: {
    readonly epicIds: ReadonlyArray<string>;
    readonly chatIds: ReadonlyArray<string>;
  }) => {
    notificationIndicatorTestState.request = request;
    return {
      data: { epics: {}, chats: {} },
      isPending: false,
      isFetching: false,
      error: null,
      refetch: () => Promise.resolve(),
    };
  },
}));

interface TestSetPinnedVariables {
  readonly epicId: string;
  readonly pinned: boolean;
}

interface TestSetPinnedOptions {
  readonly onSuccess: () => void;
}

interface TestToastOptions {
  readonly action: {
    readonly label: string;
    readonly onClick: () => void;
  };
}

const pinTestState = vi.hoisted(
  (): {
    pinnedByEpicId: Map<string, TaskPinnedState>;
    pendingEpicIds: Set<string>;
    mutate: Mock<
      (
        variables: TestSetPinnedVariables,
        options: TestSetPinnedOptions | undefined,
      ) => void
    >;
    retryUnansweredTaskPinReading: Mock<(epicId: string) => void>;
  } => ({
    pinnedByEpicId: new Map(),
    pendingEpicIds: new Set(),
    mutate: vi.fn(),
    retryUnansweredTaskPinReading: vi.fn(),
  }),
);

const toastTestState = vi.hoisted(
  (): {
    messages: string[];
    actionLabel: string | null;
    undo: (() => void) | null;
  } => ({
    messages: [],
    actionLabel: null,
    undo: null,
  }),
);

vi.mock("@/hooks/epic/use-epic-task-pinned-states-query", () => ({
  useEpicTaskPinnedStates: () => pinTestState.pinnedByEpicId,
  useRetryUnansweredTaskPinReading: () =>
    pinTestState.retryUnansweredTaskPinReading,
}));

vi.mock("@/hooks/epic/use-epic-set-pinned-mutation", async (importOriginal) => {
  // `epicPinDispatchAdmitted` is a real pure predicate `tab-strip.tsx` calls
  // directly (not through a hook) at both the initial and Undo dispatch
  // sites - kept REAL here via importOriginal, rather than mocked away,
  // because a mock that always admits would make the Undo/no-op assertions
  // below vacuous.
  const actual =
    await importOriginal<
      typeof import("@/hooks/epic/use-epic-set-pinned-mutation")
    >();
  return {
    epicPinDispatchAdmitted: actual.epicPinDispatchAdmitted,
    useEpicSetPinned: () => ({ mutate: pinTestState.mutate }),
    usePendingSetPinnedEpicIds: () => pinTestState.pendingEpicIds,
  };
});

/**
 * `useEpicPinLocalHomeSupported` reads `useHostClient()`, which throws
 * outside a `<HostRuntimeProvider>` - absent everywhere in this file.
 * Defaults to `false` (reset every test): every legacy pin case in this file
 * predates lane 9 item 5 and pins the pre-`@1.1` reading (`local-home`
 * permanently unavailable). The §3.2 cases (lane 9 evidence artifact) flip
 * this to `true` for the duration of one test to exercise the negotiated
 * `@1.1` local-home pin path through the tab strip's two dispatch edges.
 */
const pinLocalHomeSupportedTestState = vi.hoisted(
  (): { supported: boolean } => ({ supported: false }),
);
vi.mock("@/hooks/epic/use-epic-pin-local-home-support", () => ({
  useEpicPinLocalHomeSupported: () => pinLocalHomeSupportedTestState.supported,
}));

// No host transport in this strip fixture; appearance queries remain disabled.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

/**
 * `useEpicRecordViewed` also reads `useHostClient()` directly, and mounts on
 * every epic-tab route rendered through `buildRouter` in this file - unmocked
 * it throws the same `HostRuntimeProvider` error on nearly every test here,
 * unrelated to what any of them is actually about.
 */
const recordViewedTestState = vi.hoisted(
  (): { mutate: Mock<(variables: unknown) => void> } => ({
    mutate: vi.fn(),
  }),
);
vi.mock("@/hooks/epic/use-epic-record-viewed-mutation", () => ({
  useEpicRecordViewed: () => ({ mutate: recordViewedTestState.mutate }),
}));

/**
 * `TabStripBody` itself now reads `useHostClient()` unconditionally, to pass
 * `hostClient.getActiveHostId()` into `epicPinDispatchAdmitted` at the Undo
 * dispatch site. Every test in this file renders `TabStripBody`, and none of
 * them wraps in a `<HostRuntimeProvider>`, so this one call throws on nearly
 * every case regardless of what it is testing. Partial mock: only
 * `useHostClient` is replaced, everything else in the module comes from the
 * real implementation (`useHostBinding`, `useHostDirectory`, etc., which
 * other parts of the render tree may still call for real).
 */
const hostClientTestState = vi.hoisted((): { activeHostId: string | null } => ({
  activeHostId: "host-a",
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => ({
      getActiveHostId: () => hostClientTestState.activeHostId,
    }),
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: (message: string, options: TestToastOptions) => {
      toastTestState.messages.push(message);
      toastTestState.actionLabel = options.action.label;
      toastTestState.undo = options.action.onClick;
    },
    error: vi.fn(),
  },
}));

interface EpicTab {
  readonly id: string;
  readonly name: string;
  readonly draft: boolean;
}

const EPIC_A: EpicTab = { id: "e-a", name: "Alpha", draft: false };
const EPIC_B: EpicTab = { id: "e-b", name: "Beta", draft: false };
const SPEC_A: EpicNodeRef = {
  id: "spec-a",
  instanceId: "spec-a-instance",
  type: "spec",
  name: "Spec A",
  hostId: "host-a",
};
const SPEC_B: EpicNodeRef = {
  id: "spec-b",
  instanceId: "spec-b-instance",
  type: "spec",
  name: "Spec B",
  hostId: "host-a",
};
const EPIC_C: EpicTab = { id: "e-c", name: "Gamma", draft: false };
const PHASE_TAB_ID = "phase-tab";
const PHASE_ID = "phase-1";
const PARTNER_TAB_ID = "partner-tab";
let queryClient: QueryClient;

function epicFixture(index: number): EpicTab {
  return {
    id: `e-${index}`,
    name: `Epic ${index}`,
    draft: false,
  };
}

function openEpicFixture(tab: EpicTab): string {
  useEpicCanvasStore
    .getState()
    .seedEpic(tab.id, { tabId: tab.id, name: tab.name }, []);
  return tab.id;
}

function seedSplitHeaderTabs(): void {
  openEpicFixture(EPIC_A);
  openEpicFixture(EPIC_B);
  const left: TabRef = { kind: "epic", id: EPIC_A.id };
  const right: TabRef = { kind: "epic", id: EPIC_B.id };
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "split",
        id: "split-a",
        left: { kind: "tab", ref: left },
        right: { kind: "tab", ref: right },
        focusedSide: "left",
        routeBackingSide: "left",
        leftRatio: 0.5,
      },
    ],
    activeItemId: "split-a",
    stripOrder: [left, right],
    systemTabs: { history: null, settings: null },
  });
}

function canvasTabIds(tabId: string): ReadonlyArray<string> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId] ?? null;
  if (canvas === null) return [];
  return collectPanes(canvas.root).flatMap((pane) =>
    paneTabRefs(canvas, pane).map((tab) => tab.id),
  );
}

function registerEpicHeader(
  tab: EpicTab,
  permissionRole: PermissionRole,
): void {
  __getOpenEpicRegistryForTests().acquire(tab.id, () =>
    buildHeaderEpicHandle(tab, permissionRole, []),
  );
}

/**
 * Same lightweight handle as {@link registerEpicHeader}, with the store's
 * projected state carrying the preserved-orphan pause reason
 * `isPreservedOrphanEpic` reads (`preserved-orphan-epic.ts`). Composed over
 * `buildHeaderEpicHandle` rather than threading a new parameter through it -
 * every other call site in this file wants the plain handle, and the pause
 * reason is a fact about ONE test's fixture, not a fourth argument every
 * caller would have to pass `undefined`/`null` for.
 */
function registerPreservedOrphanEpicHeader(
  tab: EpicTab,
  permissionRole: PermissionRole,
): void {
  __getOpenEpicRegistryForTests().acquire(tab.id, () => {
    const handle = buildHeaderEpicHandle(tab, permissionRole, []);
    const state = {
      ...handle.store.getState(),
      durabilityPauseReason: "orphaned-local-edits-after-cloud-delete" as const,
    };
    const storeCallable = (_selector: unknown): unknown => state;
    const storeBase: unknown = Object.assign(storeCallable, {
      getState: () => state as never,
      subscribe: () => () => undefined,
    });
    return { ...handle, store: storeBase as OpenEpicStoreHandle["store"] };
  });
}

/**
 * Agent activity now arrives on the per-user notification room, so the epic
 * handle only supplies the live projection (the liveness filter) while the
 * working set is published as host presence.
 */
const headerActivityByEpic = new Map<string, ReadonlyArray<string>>();

function publishHeaderActivity(
  tab: EpicTab,
  activeAgentIds: ReadonlyArray<string>,
): void {
  // Accumulate: one host publishes ONE entry carrying every epic it is working
  // on, so republishing only the latest tab would silently clear the activity
  // an earlier call established.
  headerActivityByEpic.set(tab.id, activeAgentIds);
  const byEpic: Record<
    string,
    { working: ReadonlyArray<string>; turn: ReadonlyArray<string> }
  > = {};
  for (const [epicId, ids] of headerActivityByEpic) {
    byEpic[epicId] = { working: ids, turn: ids };
  }
  publishAgentActivity([{ hostId: "host-a", byEpic }]);
}

function registerActiveEpicHeader(
  tab: EpicTab,
  permissionRole: PermissionRole,
  activeAgentIds: ReadonlyArray<string>,
): void {
  __getOpenEpicRegistryForTests().acquire(tab.id, () =>
    buildHeaderEpicHandle(tab, permissionRole, activeAgentIds),
  );
  publishHeaderActivity(tab, activeAgentIds);
}

function registerLiveEpicHeader(
  tab: EpicTab,
  permissionRole: PermissionRole,
  liveAgentIds: ReadonlyArray<string>,
): void {
  __getOpenEpicRegistryForTests().acquire(tab.id, () =>
    buildHeaderEpicHandle(tab, permissionRole, liveAgentIds),
  );
}

/**
 * Presence naming an agent the epic's live projection no longer holds. The
 * session IS registered, so its (empty) projection is authoritative and the
 * liveness filter must drop the stale id.
 */
function registerStaleActiveEpicHeader(
  tab: EpicTab,
  permissionRole: PermissionRole,
  activeAgentIds: ReadonlyArray<string>,
): void {
  __getOpenEpicRegistryForTests().acquire(tab.id, () =>
    buildHeaderEpicHandle(tab, permissionRole, []),
  );
  publishHeaderActivity(tab, activeAgentIds);
}

function buildHeaderEpicHandle(
  tab: EpicTab,
  permissionRole: PermissionRole,
  liveAgentIds: ReadonlyArray<string>,
): OpenEpicStoreHandle {
  const liveChatsById = Object.fromEntries(
    liveAgentIds.map((id) => [
      id,
      {
        id,
        title: id,
        parentId: null,
        createdAt: 1,
        updatedAt: 1,
        userId: null,
        hostId: "host-a",
        isTitleEditedByUser: false,
        settings: null,
      },
    ]),
  );
  const state = {
    ...EMPTY_PROJECTED_SLICES,
    epic: {
      title: tab.name,
      updatedAt: 1,
    },
    chats: {
      byId: liveChatsById,
      allIds: liveAgentIds,
    },
    permissionRole,
    snapshotMeta: null,
    isDirty: false,
    unsyncedQueueSize: 0,
    // The registry's eligibility key reads all three work fields and the
    // transport.
    writeCommands: [],
    hostTransportStatus: "open",
    bindingVersion: 0,
    installedArm: null,
    chatIngestSeq: 0,
    tuiAgentIngestSeq: 0,
  };
  const storeCallable = (_selector: unknown): unknown => state;
  const storeBase: unknown = Object.assign(storeCallable, {
    getState: () => state as never,
    subscribe: () => () => undefined,
  });
  return {
    epicId: tab.id,
    userId: null,
    // The HANDLE's own host, distinct from the per-chat `hostId` above.
    hostId: "test-host",
    // A production handle has no `doc` / `awareness`: the replica lives on the
    // worker thread and a `Y.Doc` cannot cross a structured clone.
    projection: {
      accept: () => null,
      apply: () => {},
      reject: () => {},
    },
    body: { applyDocUpdate: () => {}, applyAwareness: () => {} },
    store: storeBase as OpenEpicStoreHandle["store"],
    dispose: () => undefined,
    detachTransport: () => undefined,
    requestFreshSnapshot: () => undefined,
    retryTransport: () => undefined,
    wakeTransport: () => undefined,
    isClean: () => true,
    hotArtifactRoomIdsForTests: () => [],
    ...INERT_ROOT_STATE_PORT,
  };
}

/** Chat sessions are keyed by (epic, chat, host); these fixtures all live on
 *  one host, so the header's aggregate reads see them all. */
const CHAT_SESSION_HOST = "host-1";

function registerChatSession(epicId: string, chatId: string): void {
  __getChatSessionRegistryForTests().acquire(
    {
      epicId,
      chatId,
      hostId: CHAT_SESSION_HOST,
      scopeKey: `test:${epicId}:${chatId}`,
    },
    (factoryEpicId, factoryChatId) =>
      createChatSessionStore({
        environment: CHAT_STORE_TEST_ENVIRONMENT,
        hostId: "host-a",
        epicId: factoryEpicId,
        chatId: factoryChatId,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        wakeTransport: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: () => ({
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          draftBlobBridgeSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        }),
      }),
  );
}

function resetStores(): void {
  // This unit router omits the permanent root bridge. Production releases the
  // controller's hydration gate through that bridge before strip commands run.
  __resetTabNavigationControllerForTesting();
  phaseMigrationController.resetForTesting();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.getState().clearAllTitleGenerationPending();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useEpicDndStore.getState().dragEnded();
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  __getOpenEpicRegistryForTests().disposeAll();
  __getChatSessionRegistryForTests().disposeAll();
}

function seedPhaseMigrationHeaderTabs(): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [PHASE_TAB_ID]: {
        tabId: PHASE_TAB_ID,
        epicId: PHASE_ID,
        name: "Legacy Phase",
        surfaceMode: { kind: "phase-migration", phaseId: PHASE_ID },
      },
      [PARTNER_TAB_ID]: {
        tabId: PARTNER_TAB_ID,
        epicId: "epic-partner",
        name: "Partner",
      },
    },
    canvasByTabId: {
      [PHASE_TAB_ID]: createEmptyCanvas(),
      [PARTNER_TAB_ID]: createEmptyCanvas(),
    },
    openTabOrder: [PHASE_TAB_ID, PARTNER_TAB_ID],
    activeTabId: PHASE_TAB_ID,
    mostRecentTabIdByEpicId: {
      [PHASE_ID]: PHASE_TAB_ID,
      "epic-partner": PARTNER_TAB_ID,
    },
  });
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "tab",
        id: `tab:epic:${PHASE_TAB_ID}`,
        ref: { kind: "epic", id: PHASE_TAB_ID },
      },
      {
        kind: "tab",
        id: `tab:epic:${PARTNER_TAB_ID}`,
        ref: { kind: "epic", id: PARTNER_TAB_ID },
      },
    ],
    activeItemId: `tab:epic:${PHASE_TAB_ID}`,
    stripOrder: [
      { kind: "epic", id: PHASE_TAB_ID },
      { kind: "epic", id: PARTNER_TAB_ID },
    ],
    systemTabs: { history: null, settings: null },
  });
}

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {/* The app's own join scope and top bridge (`AppColumnFrame`), so a
              joined tab's published outline reaches the real bridge. */}
          <SheetJoinScope>
            <TabStrip />
            <SheetJoinBridge edge="top" />
          </SheetJoinScope>
        </TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="home" />,
  });
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId",
    validateSearch: (
      search: Record<string, unknown>,
    ): { focusedAt: number | undefined } => ({
      focusedAt:
        typeof search.focusedAt === "number" ? search.focusedAt : undefined,
    }),
    component: () => <div data-testid="epic-body" />,
  });
  const epicTabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    validateSearch: (
      search: Record<string, unknown>,
    ): { focusedAt: number | undefined } => ({
      focusedAt:
        typeof search.focusedAt === "number" ? search.focusedAt : undefined,
    }),
    component: () => <div data-testid="epic-tab-body" />,
  });
  const epicsListRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics",
    component: () => <div data-testid="epics-list" />,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$section",
    component: () => <div data-testid="settings-body" />,
  });
  const draftRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/draft/$draftId",
    component: () => <div data-testid="draft-body" />,
  });
  const routeTree = rootRoute.addChildren([
    indexRoute,
    epicRoute,
    epicTabRoute,
    epicsListRoute,
    settingsRoute,
    draftRoute,
  ]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

async function flushNav(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise<void>((r) => setTimeout(r, 0));
}

interface RevealBox {
  readonly left: number;
  readonly right: number;
}

interface RevealGeometryShim {
  readonly scrolled: () => number;
  readonly restore: () => void;
}

/**
 * The strip's active-tab reveal, under a jsdom with no layout: the scroller's
 * viewport box, the box of the MEMBER the strip painted selected, and storage
 * for `scrollLeft` (jsdom's is a layout read that never keeps what is written
 * to it) are all shimmed.
 *
 * What is NOT shimmed is the decision. The component reads those boxes and
 * writes `scrollLeft` itself, and the amount it writes is the assertion.
 *
 * Two boxes, not one, and the pair is what makes the production walk
 * measurable (R4B-05). `tab-strip.tsx` deliberately climbs from the selected
 * NODE to the scroller's own child, because inside a split group the selected
 * node is one HALF of the member - so the shim gives the scroller's child the
 * member box and gives anything nested below it the member's leading half.
 * Handing every ancestor the same rect made the walk unobservable: replacing
 * it with `const member = selected` produced the same numbers in all four
 * cases, and the split group L-146 was written against would have scrolled by
 * the half's overflow and left the other half cut.
 *
 * `memberBox` is read per measurement so one test can move the selection from
 * a member that fits to one that does not.
 */
function installRevealGeometry(memberBox: () => RevealBox): RevealGeometryShim {
  const realRect = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  );
  const box = (left: number, right: number): DOMRect =>
    ({ left, right, width: right - left }) as DOMRect;
  const isScroller = (node: Element | null): boolean =>
    node !== null && node.hasAttribute("data-layout-passive-members");
  HTMLElement.prototype.getBoundingClientRect = function boxFor(
    this: HTMLElement,
  ): DOMRect {
    // The scroller shows 0..200.
    if (isScroller(this)) return box(0, 200);
    const holdsSelection =
      this.getAttribute("aria-selected") === "true" ||
      this.querySelector('[aria-selected="true"]') !== null;
    if (!holdsSelection) return box(0, 0);
    const member = memberBox();
    // The scroller's own child IS the member; anything below it is a half of
    // one, and a half is strictly narrower and flush with the member's start.
    if (isScroller(this.parentElement)) return box(member.left, member.right);
    return box(member.left, (member.left + member.right) / 2);
  };
  let scrolled = 0;
  const realScrollLeft = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollLeft",
  );
  Object.defineProperty(Element.prototype, "scrollLeft", {
    configurable: true,
    get: () => scrolled,
    set: (value: number) => {
      scrolled = value;
    },
  });
  return {
    scrolled: () => scrolled,
    restore: () => {
      if (realRect === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
      } else {
        Object.defineProperty(
          HTMLElement.prototype,
          "getBoundingClientRect",
          realRect,
        );
      }
      if (realScrollLeft === undefined) {
        Reflect.deleteProperty(Element.prototype, "scrollLeft");
      } else {
        Object.defineProperty(Element.prototype, "scrollLeft", realScrollLeft);
      }
    },
  };
}

function seedTwoEpicTabs(): { readonly alpha: TabRef; readonly beta: TabRef } {
  openEpicFixture(EPIC_A);
  openEpicFixture(EPIC_B);
  const alpha: TabRef = { kind: "epic", id: EPIC_A.id };
  const beta: TabRef = { kind: "epic", id: EPIC_B.id };
  useTabsStore.setState({
    version: 2,
    items: [
      { kind: "tab", id: tabItemId(alpha), ref: alpha },
      { kind: "tab", id: tabItemId(beta), ref: beta },
    ],
    activeItemId: tabItemId(alpha),
    stripOrder: [alpha, beta],
    systemTabs: { history: null, settings: null },
  });
  return { alpha, beta };
}

// Reconciliation install is owned by `WindowsBridgeProvider` in
// production. Test mounts skip the provider, so install once here.
installTabSyncCoordinator({ readyPromise: Promise.resolve() });

describe("<TabStrip />", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    window.localStorage.clear();
    pinTestState.pinnedByEpicId.clear();
    pinTestState.pendingEpicIds.clear();
    pinTestState.mutate.mockReset();
    pinTestState.mutate.mockImplementation(
      (
        _variables: TestSetPinnedVariables,
        options: TestSetPinnedOptions | undefined,
      ) => options?.onSuccess(),
    );
    pinTestState.retryUnansweredTaskPinReading.mockReset();
    toastTestState.messages.length = 0;
    toastTestState.actionLabel = null;
    toastTestState.undo = null;
    notificationIndicatorTestState.request = null;
    __resetAppLocalNotificationsStoreForTests();
    resetStores();
    pinLocalHomeSupportedTestState.supported = false;
    // The tab History pin is a cloud CAPABILITY, and the store defaults to
    // `signed-out` - under which the menu item is disabled and every pin
    // assertion below would pass without exercising anything.
    useAuthStore.setState({ status: "signed-in" });
  });

  afterEach(() => {
    cleanup();
    // Module-scope store: a staged status outlives this file in the worker.
    useAuthStore.setState({ status: "signed-out" });
    queryClient.clear();
    headerActivityByEpic.clear();
    resetAgentActivity();
    __resetAppLocalNotificationsStoreForTests();
    resetStores();
    resetNegotiatedManifests();
  });

  it("renders one tab per open epic", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("tab-epic-e-a")).toBeDefined();
    expect(screen.getByTestId("tab-epic-e-b")).toBeDefined();
    expect(screen.getByTestId("tab-new")).toBeDefined();
  });

  it("uses the project color for the active outline while keeping the neutral fill", () => {
    render(
      <TabChrome
        isActive
        joined={false}
        concealed={false}
        color="#12ab34"
        session={false}
      />,
    );

    const box = screen.getByTestId("tab-chrome-box");
    expect(box.style.getPropertyValue("--swatch")).toBe(
      "var(--color-background)",
    );
    expect(box.style.getPropertyValue("--swatch-border")).toBe("#12ab34");
  });

  it("keeps the project color on an inactive tab", () => {
    const { container } = render(
      <TabChrome
        isActive={false}
        joined={false}
        concealed={false}
        color="#12ab34"
        session={false}
      />,
    );

    expect(
      container.querySelector("span[style]")?.getAttribute("style"),
    ).toContain("--swatch: #12ab34;");
  });

  it("draws an inactive coloured tab's color as an edge line, and none on the active one", () => {
    const { rerender } = render(
      <TabChrome
        isActive={false}
        joined={false}
        concealed={false}
        color="#12ab34"
        session={false}
      />,
    );
    expect(
      screen
        .getByTestId("tab-color-edge-line")
        .style.getPropertyValue("--swatch"),
    ).toBe("#12ab34");

    rerender(
      <TabChrome
        isActive
        joined={false}
        concealed={false}
        color="#12ab34"
        session={false}
      />,
    );
    // The box's own border carries the color once the tab is active; nothing
    // left for the edge line to draw.
    expect(screen.queryByTestId("tab-color-edge-line")).toBeNull();
    expect(
      screen
        .getByTestId("tab-chrome-box")
        .style.getPropertyValue("--swatch-border"),
    ).toBe("#12ab34");
  });

  /**
   * The editing signal on the tab (L-87, L-138, L-163, F4): ACTIVE, the
   * editor's own tab IS the colour and wears none of it on its edge. The
   * fill is the colour the tab is handed, at full strength, and the border is
   * the ordinary canvas border every other active tab gets - so the frame
   * around the screen owns the only amber line while a session is live.
   */
  it("fills the editor's own tab instead of outlining it like every other", () => {
    render(
      <TabChrome
        isActive
        joined={false}
        concealed={false}
        color="var(--warning-foreground)"
        session
      />,
    );

    const box = screen.getByTestId("tab-chrome-box");
    expect(box.style.getPropertyValue("--swatch")).toBe(
      "var(--warning-foreground)",
    );
    expect(box.style.getPropertyValue("--swatch-border")).toBe(
      "var(--canvas-border)",
    );
  });

  /**
   * At rest the cap is `SessionTabMark`'s, so `TabChrome` must not draw a
   * second bar of the same colour underneath it: two strokes on one edge is
   * the kind of stacked decoration this redesign exists to remove (L-138).
   */
  it("leaves the resting editor tab's bottom edge to the session mark", () => {
    render(
      <TabChrome
        isActive={false}
        joined={false}
        concealed={false}
        color="var(--warning-foreground)"
        session
      />,
    );

    expect(screen.queryByTestId("tab-color-edge-line")).toBeNull();
  });

  /**
   * The strip may not cut the layout editor's own tab in half (L-87, L-138).
   *
   * The scroller is `overflow-x-auto` and nothing reveals a newly opened tab,
   * so with enough tabs open the editor's tab was appended past the right edge
   * and clipped there - which is the single cause of all three things the
   * owner's third live pass reported as a broken tab: a label cut to "Sample",
   * an amber outline covering only the left and the top (the right cap of the
   * silhouette was past the edge), and a mark ending on a razor edge.
   *
   * jsdom has no layout, so the two boxes and the scroll position are shimmed.
   * What is NOT shimmed is the decision: the component reads those boxes and
   * writes `scrollLeft` itself, and the amount it writes is the assertion.
   */
  it("reveals the editor's own tab when the strip has scrolled it out", async () => {
    const sampleRef: TabRef = {
      kind: "sample-workspace",
      id: "sample-workspace",
    };
    useTabsStore.setState({
      version: 2,
      items: [{ kind: "tab", id: tabItemId(sampleRef), ref: sampleRef }],
      activeItemId: tabItemId(sampleRef),
      stripOrder: [sampleRef],
      systemTabs: { history: null, settings: null },
    });
    // The scroller shows 0..200; the tab's member box runs 120..320, so 120px
    // of it - the trailing cap and the end of the label - is past the edge.
    const geometry = installRevealGeometry(() => ({ left: 120, right: 320 }));
    try {
      const router = buildRouter("/sample-workspace");
      render(<RouterProvider router={router} />);
      await screen.findByTestId("header-tab-strip-scroll");

      expect(geometry.scrolled()).toBe(120);
    } finally {
      geometry.restore();
    }
  });

  /**
   * The other half of the solid fill (L-163): with the tab painted in
   * `--warning-foreground`, the strip's own `text-foreground` is the one
   * colour its label cannot be in, so the session tab hands its content
   * wrapper the fill's counterpart instead. `layout-editor-contrast.test.ts`
   * measures that pair per palette; what is asserted here is that the class
   * reaches the element the label and the icon are inside, and reaches only
   * that tab.
   */
  it("gives the active editor tab's label the fill's counterpart colour", async () => {
    const sampleRef: TabRef = {
      kind: "sample-workspace",
      id: "sample-workspace",
    };
    openEpicFixture(EPIC_A);
    const epicRef: TabRef = { kind: "epic", id: EPIC_A.id };
    useTabsStore.setState({
      version: 2,
      items: [
        { kind: "tab", id: tabItemId(epicRef), ref: epicRef },
        { kind: "tab", id: tabItemId(sampleRef), ref: sampleRef },
      ],
      activeItemId: tabItemId(sampleRef),
      stripOrder: [epicRef, sampleRef],
      systemTabs: { history: null, settings: null },
    });
    const router = buildRouter("/sample-workspace");
    render(<RouterProvider router={router} />);

    const sampleTab = await screen.findByTestId(
      "tab-sample-workspace-sample-workspace",
    );
    const title = within(sampleTab).getByTestId(
      "tab-title-sample-workspace-sample-workspace",
    );
    expect(title.closest(".text-background")).not.toBeNull();
    // The ordinary tab beside it keeps the strip's own colours, so the class
    // is the session tab's and not the strip's.
    const epicTab = screen.getByTestId(`tab-epic-${EPIC_A.id}`);
    expect(epicTab.querySelector(".text-background")).toBeNull();
  });

  /**
   * The reveal is the SELECTION's, not the editing indicator's (L-146).
   *
   * The L-138 version above keyed on the session tab's own marker, so an
   * ORDINARY tab activated behind the strip's right edge stayed there - worst
   * for the keyboard paths, where there is no pointer to say where the tab
   * went and the only evidence of the switch is the tab that should have
   * appeared.
   */
  it("reveals an ordinary tab when it becomes the active one", async () => {
    const { beta } = seedTwoEpicTabs();
    // Alpha's member sits wholly inside the scroller's 0..200, so mounting on
    // it must move nothing; Beta's runs 260..460, entirely past the edge.
    let selected: RevealBox = { left: 0, right: 180 };
    const geometry = installRevealGeometry(() => selected);
    try {
      const router = buildRouter("/epics/e-a/e-a");
      render(<RouterProvider router={router} />);
      await screen.findByTestId("tab-epic-e-b");
      expect(geometry.scrolled()).toBe(0);

      selected = { left: 260, right: 460 };
      act(() => {
        useTabsStore.setState({ activeItemId: tabItemId(beta) });
      });

      expect(geometry.scrolled()).toBe(260);
    } finally {
      geometry.restore();
    }
  });

  /**
   * Reordering is dnd-kit's gesture and the strip's scroll offset is its
   * working surface: members carry displacement transforms and the drag model
   * reads this scroller's `scrollLeft` as its content origin. A reveal fired
   * mid-drag would measure a transient box and move the ground under the
   * pointer, so a live drag is not a moment to reveal anything.
   */
  it("does not reveal while a header tab is being dragged", async () => {
    const { alpha, beta } = seedTwoEpicTabs();
    let selected: RevealBox = { left: 0, right: 180 };
    const geometry = installRevealGeometry(() => selected);
    try {
      const router = buildRouter("/epics/e-a/e-a");
      render(<RouterProvider router={router} />);
      await screen.findByTestId("tab-epic-e-b");

      act(() => {
        useEpicDndStore.getState().headerTabDragStarted(
          {
            kind: "header-tab",
            stripItemId: tabItemId(alpha),
            tabKind: "epic",
            tabId: EPIC_A.id,
            index: 0,
          },
          { width: 120, height: 36 },
          "x",
          null,
        );
      });
      selected = { left: 260, right: 460 };
      act(() => {
        useTabsStore.setState({ activeItemId: tabItemId(beta) });
      });

      expect(geometry.scrolled()).toBe(0);
    } finally {
      geometry.restore();
    }
  });

  it("uses the manual color for a focused split member and retains the primary fallback", () => {
    const { rerender } = render(<SplitMemberChrome focused color="#12ab34" />);
    expect(
      screen
        .getByTestId("tab-chrome-box")
        .style.getPropertyValue("--swatch-border"),
    ).toBe("#12ab34");

    rerender(<SplitMemberChrome focused color={null} />);
    expect(
      screen
        .getByTestId("tab-chrome-box")
        .style.getPropertyValue("--swatch-border"),
    ).toBe("var(--color-primary)");

    rerender(<SplitMemberChrome focused={false} color="#12ab34" />);
    expect(screen.queryByTestId("tab-chrome-box")).toBeNull();
    expect(screen.getByTestId("tab-hover-box").className).toContain(
      "group-hover/tab:bg-foreground/5",
    );
    // An unfocused colored member has no box to wear its color in, so it
    // gets the same edge line an inactive lone tab does. The focused member
    // above never draws one - its box border carries the color.
    expect(
      screen
        .getByTestId("tab-color-edge-line")
        .style.getPropertyValue("--swatch"),
    ).toBe("#12ab34");

    rerender(<SplitMemberChrome focused={false} color={null} />);
    expect(screen.queryByTestId("tab-color-edge-line")).toBeNull();
  });

  describe("the task tray join (top strip)", () => {
    it("joins the active tab's chrome box to the tray, and draws no chrome box at all on the inactive one", async () => {
      seedTwoEpicTabs();
      const router = buildRouter("/epics/e-a/e-a");
      render(<RouterProvider router={router} />);

      const activeTab = await screen.findByTestId("tab-epic-e-a");
      expect(
        within(activeTab)
          .getByTestId("tab-chrome-box")
          .getAttribute("data-sheet-joined"),
      ).toBe("top");

      const inactiveTab = screen.getByTestId("tab-epic-e-b");
      expect(within(inactiveTab).queryByTestId("tab-chrome-box")).toBeNull();
    });

    it("keeps the active tab joined while another tab is dragged", async () => {
      const { beta } = seedTwoEpicTabs();
      const router = buildRouter("/epics/e-a/e-a");
      render(<RouterProvider router={router} />);

      const activeTab = await screen.findByTestId("tab-epic-e-a");
      expect(
        within(activeTab)
          .getByTestId("tab-chrome-box")
          .hasAttribute("data-sheet-joined"),
      ).toBe(true);

      act(() => {
        useEpicDndStore.getState().headerTabDragStarted(
          {
            kind: "header-tab",
            stripItemId: tabItemId(beta),
            tabKind: "epic",
            tabId: EPIC_B.id,
            index: 1,
          },
          { width: 120, height: 36 },
          "x",
          null,
        );
      });

      expect(
        within(activeTab)
          .getByTestId("tab-chrome-box")
          .hasAttribute("data-sheet-joined"),
      ).toBe(true);
    });

    it("never joins the layout editor's own (session) tab", async () => {
      const sampleRef: TabRef = {
        kind: "sample-workspace",
        id: "sample-workspace",
      };
      useTabsStore.setState({
        version: 2,
        items: [{ kind: "tab", id: tabItemId(sampleRef), ref: sampleRef }],
        activeItemId: tabItemId(sampleRef),
        stripOrder: [sampleRef],
        systemTabs: { history: null, settings: null },
      });
      const router = buildRouter("/sample-workspace");
      render(<RouterProvider router={router} />);

      const sessionTab = await screen.findByTestId(
        "tab-sample-workspace-sample-workspace",
      );
      expect(
        within(sessionTab)
          .getByTestId("tab-chrome-box")
          .hasAttribute("data-sheet-joined"),
      ).toBe(false);
    });

    it("joins an active tab that has its own color, and draws the join outline in that color", async () => {
      const { alpha } = seedTwoEpicTabs();
      const router = buildRouter("/epics/e-a/e-a");
      const { container } = render(<RouterProvider router={router} />);

      const activeTab = await screen.findByTestId("tab-epic-e-a");
      // Uncoloured control: the same tab in the same setup joins.
      expect(
        within(activeTab)
          .getByTestId("tab-chrome-box")
          .getAttribute("data-sheet-joined"),
      ).toBe("top");

      act(() => {
        useTabsStore
          .getState()
          .setTabCustomization(alpha, { color: "#12ab34" });
      });

      const box = within(activeTab).getByTestId("tab-chrome-box");
      expect(box.getAttribute("data-sheet-joined")).toBe("top");
      expect(box.style.getPropertyValue("--join-outline")).toBe("#12ab34");
      expect(box.style.getPropertyValue("--swatch-border")).toBe("#12ab34");

      const bridge = container.querySelector<HTMLElement>(
        '[data-sheet-join-bridge="top"]',
      );
      if (bridge === null) throw new Error("expected the top join bridge");
      expect(bridge.hasAttribute("data-join-active")).toBe(true);
      expect(bridge.style.getPropertyValue("--join-outline")).toBe("#12ab34");
    });

    it("joins the active Home tab", () => {
      render(
        <TooltipProvider>
          <TabStripHomeItemView isActive onActivate={() => undefined} />
        </TooltipProvider>,
      );
      expect(
        screen.getByTestId("tab-chrome-box").getAttribute("data-sheet-joined"),
      ).toBe("top");
    });

    // The active overlay DOES join during a real drag - `HeaderTabDragOverlay`
    // threads `joined={isActive}` into this same component (see
    // `header-strip-active-join.test.tsx`). This is the leaf's own prop
    // contract: given `joined={false}` explicitly, it draws no marker.
    it("honors an explicit joined={false} on the preview, drawing no sheet marker", () => {
      seedTwoEpicTabs();
      const tab = getHeaderTabs().find(
        (candidate) =>
          candidate.kind === "epic" && candidate.epicId === EPIC_A.id,
      );
      if (tab === undefined) throw new Error("expected alpha's header tab");

      render(
        <TooltipProvider>
          <HeaderTabPreview
            tab={tab}
            ghost={null}
            chrome="own"
            isActive
            joined={false}
          />
        </TooltipProvider>,
      );
      expect(
        screen.getByTestId("tab-chrome-box").hasAttribute("data-sheet-joined"),
      ).toBe(false);
    });

    it("joins an active split pair as one container, and draws no marker when inactive", () => {
      const { rerender } = render(
        <SplitTabLayout
          splitId="split-a"
          selectedSide="left"
          joined
          control={null}
          left={<span>left</span>}
          right={<span>right</span>}
        />,
      );
      expect(
        screen
          .getByTestId("split-tab-joined-split-a")
          .getAttribute("data-sheet-joined"),
      ).toBe("top");

      rerender(
        <SplitTabLayout
          splitId="split-a"
          selectedSide="left"
          joined={false}
          control={null}
          left={<span>left</span>}
          right={<span>right</span>}
        />,
      );
      expect(screen.queryByTestId("split-tab-joined-split-a")).toBeNull();
    });
  });

  it("shows the pair highlight on the approach half during a merge", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);
    await screen.findByTestId("tab-epic-e-a");

    act(() => {
      const dndStore = useEpicDndStore.getState();
      dndStore.headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "tab:epic:e-a",
          tabKind: "epic",
          tabId: "e-a",
          index: 0,
        },
        { width: 120, height: 36 },
        "x",
        null,
      );
      // Dragging rightward onto B: the dragged tab's centre is on B's
      // approach (left) half, so the merge is live immediately with the
      // dragged tab taking the pair's left side.
      dndStore.headerStripDragStateChanged({
        kind: "merge",
        targetIndex: 0,
        targetItemId: "tab:epic:e-b",
        targetSide: "left",
      });
      dndStore.headerStripDropIndexChanged(null);
      dndStore.topLevelStripPairPreviewChanged({
        targetRef: { kind: "epic", id: "e-b" },
        side: "left",
      });
    });

    // The merge is an approach-half highlight, not an insertion line: a line
    // beside a highlighted merge target would advertise two outcomes for one
    // release.
    expect(screen.queryByTestId("tab-drop-indicator")).toBeNull();
    const mergePreview = screen.getByTestId("tab-strip-pair-preview-epic-e-b");
    expect(mergePreview.dataset.side).toBe("left");
  });

  it("shows insertion feedback across the full hovered top tab", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);
    await screen.findByTestId("tab-epic-e-a");

    act(() => {
      const dndStore = useEpicDndStore.getState();
      dndStore.headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "tab:epic:e-a",
          tabKind: "epic",
          tabId: "e-a",
          index: 0,
        },
        { width: 120, height: 36 },
        "x",
        null,
      );
      dndStore.headerStripDragStateChanged({
        kind: "reorder",
        targetIndex: 0,
      });
      dndStore.headerStripDropIndexChanged(1);
    });

    expect(
      within(screen.getByTestId("tab-epic-e-b")).getByTestId(
        "tab-drop-indicator",
      ).dataset.side,
    ).toBe("left");
  });

  it("mirrors the merge highlight when approached from the right", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);
    await screen.findByTestId("tab-epic-e-a");

    act(() => {
      const dndStore = useEpicDndStore.getState();
      dndStore.headerTabDragStarted(
        {
          kind: "header-tab",
          stripItemId: "tab:epic:e-a",
          tabKind: "epic",
          tabId: "e-a",
          index: 0,
        },
        { width: 120, height: 36 },
        "x",
        null,
      );
      // Dragging leftward back onto B: the dragged tab's centre is on B's
      // approach (right) half, so the dragged tab would take the pair's
      // right side.
      dndStore.headerStripDragStateChanged({
        kind: "merge",
        targetIndex: 1,
        targetItemId: "tab:epic:e-b",
        targetSide: "right",
      });
      dndStore.headerStripDropIndexChanged(null);
      dndStore.topLevelStripPairPreviewChanged({
        targetRef: { kind: "epic", id: "e-b" },
        side: "right",
      });
    });

    expect(screen.queryByTestId("tab-drop-indicator")).toBeNull();
    expect(
      screen.getByTestId("tab-strip-pair-preview-epic-e-b").dataset.side,
    ).toBe("right");
  });

  it("queries every open task tab without requiring a live Epic session", async () => {
    const epics = Array.from({ length: 6 }, (_value, index) =>
      epicFixture(index),
    );
    for (const epic of epics) openEpicFixture(epic);
    const router = buildRouter(`/epics/${epics[0].id}/${epics[0].id}`);
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId(`tab-epic-${epics[5].id}`)).toBeDefined();
    await waitFor(() => {
      expect(notificationIndicatorTestState.request?.epicIds).toHaveLength(6);
      expect(notificationIndicatorTestState.request?.epicIds).toEqual(
        epics.map((epic) => epic.id),
      );
      expect(notificationIndicatorTestState.request?.chatIds).toEqual([]);
    });
  });

  it("updates a Phase migration close button without rebuilding its unlocked partner", async () => {
    seedPhaseMigrationHeaderTabs();
    phaseMigrationController.attach(PHASE_TAB_ID, PHASE_ID, () => undefined);
    const pendingPartner = getHeaderTabs().find(
      (tab) => tab.id === PARTNER_TAB_ID,
    );
    const router = buildRouter(`/epics/${PHASE_ID}/${PHASE_TAB_ID}`);
    render(<RouterProvider router={router} />);

    const closeButton = await screen.findByTestId(
      `tab-close-epic-${PHASE_TAB_ID}`,
    );
    expect(closeButton.hasAttribute("disabled")).toBe(true);

    act(() =>
      phaseMigrationController.fail(PHASE_TAB_ID, PHASE_ID, 1, "failed"),
    );
    await waitFor(() =>
      expect(closeButton.hasAttribute("disabled")).toBe(false),
    );
    expect(getHeaderTabs().find((tab) => tab.id === PARTNER_TAB_ID)).toBe(
      pendingPartner,
    );

    act(() => phaseMigrationController.retry(PHASE_TAB_ID));
    await waitFor(() =>
      expect(closeButton.hasAttribute("disabled")).toBe(true),
    );
    expect(getHeaderTabs().find((tab) => tab.id === PARTNER_TAB_ID)).toBe(
      pendingPartner,
    );
  });

  it("caps header tab frames while preserving the shrink floor", async () => {
    openEpicFixture(EPIC_A);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const tab = await screen.findByTestId("tab-epic-e-a");
    const frame = tab.parentElement;
    if (frame === null) throw new Error("Expected tab frame");

    expect(frame.className).toContain("min-w-[min(40vw,12rem)]");
    expect(frame.className).toContain("w-56");
    expect(frame.className).toContain("max-w-56");
    expect(frame.className).toContain("flex-[1_1_14rem]");
    expect(frame.className).toContain("[container-type:inline-size]");
    expect(tab.className).toContain("[-webkit-app-region:no-drag]");
    expect(screen.getByTestId("tab-new").className).toContain(
      "[-webkit-app-region:no-drag]",
    );
  });

  it("renders a hover chrome layer for inactive header tabs", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    // Source reconciliation preserves the current selection when B is added
    // in the background. Explicitly select B for this active/inactive chrome
    // fixture so its intended distinction is independent of insertion order.
    tabCommandCoordinator.activateTab({
      kind: "ref",
      ref: { kind: "epic", id: EPIC_B.id },
    });
    const router = buildRouter("/epics/e-b/e-b");
    render(<RouterProvider router={router} />);

    const inactiveTab = await screen.findByTestId("tab-epic-e-a");
    const activeTab = screen.getByTestId("tab-epic-e-b");
    const hoverChrome = inactiveTab.firstElementChild;

    expect(inactiveTab.getAttribute("aria-selected")).toBe("false");
    expect(activeTab.getAttribute("aria-selected")).toBe("true");
    const closeSlot = screen.getByTestId("tab-close-epic-e-a").parentElement;
    if (closeSlot === null) throw new Error("Expected tab close slot");

    expect(closeSlot.className).toContain("header-tab-trailing-slot");
    expect(closeSlot.className).not.toContain("group-hover/tab:w-5");
    expect(hoverChrome?.className).toContain("group-hover/tab:opacity-100");
    // :focus-visible (keyboard-only), NOT :focus-within - a mouse-drag reorder
    // focuses the tab div without activating it, and :focus-within would leave
    // this accent chrome stuck lit on the inactive tab. The has-[:focus-visible]
    // gate keeps it lit when the separate close button (a descendant tab stop)
    // takes keyboard focus. See tab-strip-item.tsx.
    expect(hoverChrome?.className).toContain(
      "group-focus-visible/tab:opacity-100",
    );
    expect(hoverChrome?.className).toContain(
      "group-has-[:focus-visible]/tab:opacity-100",
    );
    expect(hoverChrome?.querySelector("svg")).toBeNull();
  });

  it("separates a split group from the next strip item like any other tab", async () => {
    // A split group is one strip item, so the separator rule ("hairline unless
    // this item or the next one is active") has to apply to it too. It didn't:
    // the rule was restated inside the plain-tab branch only, so a group drew
    // no trailing hairline and the group-to-tab boundary read as a blank gap.
    const tabD = epicFixture(4);
    const tabE = epicFixture(5);
    for (const epic of [EPIC_A, EPIC_B, EPIC_C, tabD, tabE]) {
      openEpicFixture(epic);
    }
    const refA: TabRef = { kind: "epic", id: EPIC_A.id };
    const refB: TabRef = { kind: "epic", id: EPIC_B.id };
    const refC: TabRef = { kind: "epic", id: EPIC_C.id };
    const refD: TabRef = { kind: "epic", id: tabD.id };
    const refE: TabRef = { kind: "epic", id: tabE.id };
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-a",
          left: { kind: "tab", ref: refA },
          right: { kind: "tab", ref: refB },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
        { kind: "tab", id: tabItemId(refC), ref: refC },
        { kind: "tab", id: tabItemId(refD), ref: refD },
        { kind: "tab", id: tabItemId(refE), ref: refE },
      ],
      // Last item active, so the group and C both have an inactive successor -
      // the only arrangement that exercises the positive and both negative
      // branches of the rule in one render.
      activeItemId: tabItemId(refE),
      stripOrder: [refA, refB, refC, refD, refE],
      systemTabs: { history: null, settings: null },
    });
    const router = buildRouter(`/epics/${tabE.id}/${tabE.id}`);
    render(<RouterProvider router={router} />);

    const group = await screen.findByTestId("split-tab-group-split-a");
    // Exactly one: the group's own trailing hairline. The two halves inside
    // must not draw their own, or a group would read as two tabs.
    expect(within(group).queryAllByTestId("header-tab-separator")).toHaveLength(
      1,
    );
    // Distinct from the unconditional divider between the halves - a fix that
    // reused that divider would leave the group-to-tab boundary still blank.
    expect(screen.getByTestId("split-tab-divider-split-a")).toBeDefined();

    const plainC = screen.getByTestId(`tab-epic-${EPIC_C.id}`);
    const plainD = screen.getByTestId(`tab-epic-${tabD.id}`);
    const plainE = screen.getByTestId(`tab-epic-${tabE.id}`);
    expect(within(plainC).queryByTestId("header-tab-separator")).not.toBeNull();
    // Suppressed next to the active tab, and after the last item.
    expect(within(plainD).queryByTestId("header-tab-separator")).toBeNull();
    expect(within(plainE).queryByTestId("header-tab-separator")).toBeNull();
  });

  it("keeps the separator between adjacent split groups when one is active", async () => {
    const tabD = epicFixture(4);
    for (const epic of [EPIC_A, EPIC_B, EPIC_C, tabD]) {
      openEpicFixture(epic);
    }
    const refA: TabRef = { kind: "epic", id: EPIC_A.id };
    const refB: TabRef = { kind: "epic", id: EPIC_B.id };
    const refC: TabRef = { kind: "epic", id: EPIC_C.id };
    const refD: TabRef = { kind: "epic", id: tabD.id };
    useTabsStore.setState({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-a",
          left: { kind: "tab", ref: refA },
          right: { kind: "tab", ref: refB },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
        {
          kind: "split",
          id: "split-b",
          left: { kind: "tab", ref: refC },
          right: { kind: "tab", ref: refD },
          focusedSide: "left",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-a",
      stripOrder: [refA, refB, refC, refD],
      systemTabs: { history: null, settings: null },
    });
    const router = buildRouter(`/epics/${EPIC_A.id}/${EPIC_A.id}`);
    render(<RouterProvider router={router} />);

    const firstGroup = await screen.findByTestId("split-tab-group-split-a");
    expect(
      within(firstGroup).queryByTestId("header-tab-separator"),
    ).not.toBeNull();
    expect(
      within(screen.getByTestId("split-tab-group-split-b")).queryByTestId(
        "header-tab-separator",
      ),
    ).toBeNull();
  });

  it("keeps split arrangement commands flat in the main tab context menu", async () => {
    seedSplitHeaderTabs();
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));

    const separate = await screen.findByTestId("tab-separate-split-epic-e-a");
    expect(screen.queryByTestId("tab-arrange-split-epic-e-a")).toBeNull();
    expect(separate.parentElement?.dataset.slot).toBe("context-menu-content");
    expect(screen.getByTestId("tab-close-left-epic-e-a")).not.toBeNull();
    expect(screen.getByTestId("tab-close-right-epic-e-a")).not.toBeNull();
    expect(screen.getByTestId("tab-swap-split-epic-e-a")).not.toBeNull();
  });

  it("shows leading quick split actions without shrinking the merged titles", async () => {
    seedSplitHeaderTabs();
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    // Purely cosmetic geometry (frame width, member padding) is not asserted
    // via Tailwind class strings - those break on any restyle without proving
    // behavior. The focus semantics that matter are the
    // data-focused-side/data-focused attributes and the box below (F4 round
    // 2 dropped the group underline; the focused member's own box is now
    // what says which side is focused).
    await screen.findByTestId("split-tab-group-split-a");
    const trigger = screen.getByTestId("split-quick-actions-split-a");
    const indicator = screen.getByTestId("split-focus-indicator-split-a");
    const leftTab = screen.getByTestId("tab-epic-e-a");
    const rightTab = screen.getByTestId("tab-epic-e-b");
    const leftPane = indicator.querySelector('[data-split-pane="left"]');
    const rightPane = indicator.querySelector('[data-split-pane="right"]');
    expect(screen.queryByTestId("split-tab-divider-split-a")).toBeNull();
    expect(
      within(leftTab)
        .getByTestId("tab-chrome-box")
        .style.getPropertyValue("--swatch-border"),
    ).toBe("var(--color-primary)");
    expect(within(rightTab).queryByTestId("tab-chrome-box")).toBeNull();
    expect(screen.queryByTestId("split-member-focus-accent")).toBeNull();
    expect(trigger.className).toContain("text-info-foreground");
    expect(
      screen.queryByTestId("split-quick-actions-status-split-a"),
    ).toBeNull();
    expect(trigger.getAttribute("aria-label")).toContain("left view focused");
    expect(indicator.dataset.focusedSide).toBe("left");
    expect(leftPane?.getAttribute("data-focused")).toBe("true");
    expect(rightPane?.getAttribute("data-focused")).toBe("false");
    expect(leftPane?.getAttribute("width")).toBe("8");
    expect(rightPane?.getAttribute("width")).toBe("8");
    expect(leftPane?.getAttribute("fill")).toBe("currentColor");
    expect(rightPane?.getAttribute("fill")).toBe("none");

    act(() => {
      useTabsStore
        .getState()
        .focusSplitSide({ splitId: "split-a", side: "right" });
    });

    expect(trigger.getAttribute("aria-label")).toContain("right view focused");
    expect(indicator.dataset.focusedSide).toBe("right");
    expect(leftPane?.getAttribute("data-focused")).toBe("false");
    expect(rightPane?.getAttribute("data-focused")).toBe("true");
    expect(leftPane?.getAttribute("width")).toBe("8");
    expect(rightPane?.getAttribute("width")).toBe("8");
    expect(leftPane?.getAttribute("fill")).toBe("none");
    expect(rightPane?.getAttribute("fill")).toBe("currentColor");
    expect(leftTab.className).toContain(
      "px-[var(--header-tab-padding,1.25rem)]",
    );
    expect(rightTab.className).toContain(
      "px-[var(--header-tab-padding,1.25rem)]",
    );
    expect(within(leftTab).queryByTestId("tab-chrome-box")).toBeNull();
    expect(
      within(rightTab)
        .getByTestId("tab-chrome-box")
        .style.getPropertyValue("--swatch-border"),
    ).toBe("var(--color-primary)");

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByTestId("split-quick-swap-epic-e-a"));

    expect(useTabsStore.getState().items[0]).toMatchObject({
      kind: "split",
      left: { kind: "tab", ref: { kind: "epic", id: EPIC_B.id } },
      right: { kind: "tab", ref: { kind: "epic", id: EPIC_A.id } },
    });
  });

  it("keeps the new-tab button after the tabs while preserving overflow", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);
    await screen.findByTestId("tab-epic-e-a");

    const tabRow = screen.getByTestId("header-tab-strip-scroll");
    const newTabButton = screen.getByTestId("tab-new");
    // The button sits in the strip's own placement box inside the cluster.
    const tabCluster = newTabButton.parentElement?.parentElement ?? null;
    if (tabCluster === null) throw new Error("Expected tab cluster");
    Object.defineProperties(tabRow, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 400 },
    });

    fireEvent.wheel(tabRow, { deltaY: 80, deltaMode: 0 });

    expect(tabRow.className).toContain("flex-[0_1_auto]");
    expect(tabRow.className).not.toContain("w-max");
    expect(tabRow.className).toContain("overflow-x-auto");
    expect(tabRow.scrollLeft).toBe(80);
    expect(newTabButton.parentElement).not.toBe(tabRow);
    expect(tabCluster.className).toContain("max-w-full");
    expect(tabCluster.className).toContain("flex-[0_1_auto]");
    expect(tabCluster.className).not.toContain("flex-1");
    expect(newTabButton.className).toContain("shrink-0");
  });

  it("shows the New task shortcut on the trailing button", async () => {
    openEpicFixture(EPIC_A);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const newTaskButton = await screen.findByRole("button", {
      name: "Start Page",
    });
    expect(
      anyTooltipHasText(`New task (${formatChordForDisplay("mod+n")})`),
    ).toBe(true);
    expect(
      anyTooltipHasText(`New task (${formatChordForDisplay("mod+t")})`),
    ).toBe(false);
    expect(newTaskButton).toBeDefined();
  });

  /**
   * Route activation, against the STRIP's reveal (L-146).
   *
   * The item's own `scrollIntoView` callback ref is gone: it had no drag gate,
   * it revealed one half of a split group rather than the strip member, and it
   * scrolled every scrollable ancestor. This is the case it covered that the
   * cases above do not - a real router navigation rather than a store write -
   * kept, and now asserted on the amount the strip scrolls its own scroller.
   */
  it("scrolls the active header tab into view after any route activation", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    openEpicFixture(EPIC_C);
    useTabsStore.setState({ activeItemId: "tab:epic:e-a" });
    // Alpha's member fits inside the scroller's 0..200; Gamma's runs 300..500,
    // entirely past the right edge.
    let selected: RevealBox = { left: 0, right: 180 };
    const geometry = installRevealGeometry(() => selected);
    try {
      const router = buildRouter("/epics/e-a/e-a");
      render(<RouterProvider router={router} />);
      await screen.findByTestId("tab-epic-e-a");
      expect(geometry.scrolled()).toBe(0);

      selected = { left: 300, right: 500 };
      await router.navigate({
        to: "/epics/$epicId/$tabId",
        params: { epicId: "e-c", tabId: "e-c" },
        search: {
          focusedAt: undefined,
          focusArtifactId: undefined,
          focusThreadId: undefined,
          migrationSource: undefined,
          focusPaneId: undefined,
          focusTileInstanceId: undefined,
        },
      });
      act(() => {
        useTabsStore.setState({ activeItemId: "tab:epic:e-c" });
      });
      await flushNav();

      expect(screen.getByTestId("tab-epic-e-c")).toBeDefined();
      expect(geometry.scrolled()).toBe(300);
    } finally {
      geometry.restore();
    }
  });

  it("scopes the epic title hover card trigger to the title text", async () => {
    openEpicFixture(EPIC_A);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const tab = await screen.findByTestId("tab-epic-e-a");
    const title = screen.getByTestId("tab-title-epic-e-a");
    const closeButton = screen.getByTestId("tab-close-epic-e-a");

    // The hover card's `HoverCard.trigger` clones its interaction props onto
    // the title's own wrapping span (`Slot.Root`, no extra DOM node), so the
    // title's parent IS the trigger - the same scoping the plain tooltip it
    // replaced had, checked structurally rather than through a `data-slot`
    // Radix no longer sets on this primitive.
    const trigger = title.parentElement;
    if (trigger === null) throw new Error("Expected a hover card trigger");

    expect(trigger).not.toBe(tab);
    expect(trigger.contains(title)).toBe(true);
    expect(trigger.contains(closeButton)).toBe(false);
  });

  it("shows a spinner while epic title generation is pending", async () => {
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    useEpicCanvasStore.getState().markEpicTitlePending(EPIC_A.id, EPIC_A.name);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByTestId(`header-tab-title-generating-${EPIC_A.id}`),
    ).toBeDefined();
  });

  it("shows the chat error glyph on a task tab when chat and terminal failures coexist", async () => {
    openEpicFixture(EPIC_A);
    useAppLocalNotificationsStore.getState().activateIdentity("user-1");
    useAppLocalNotificationsStore.getState().upsert({
      id: "chat-failure",
      updatedAt: 1,
      readAt: null,
      kind: "stream.transport.error",
      sourceRef: "chat-1",
      payload: { kind: "chat", epicId: EPIC_A.id, chatId: "chat-1" },
      message: "Chat failed",
      detail: null,
    });
    useAppLocalNotificationsStore.getState().upsert({
      id: "terminal-failure",
      updatedAt: 2,
      readAt: null,
      kind: "terminal.crashed",
      sourceRef: "terminal-1",
      payload: {
        kind: "terminal",
        epicId: EPIC_A.id,
        terminalId: "terminal-1",
        tabId: EPIC_A.id,
        paneId: "pane-1",
        tileInstanceId: "terminal-instance-1",
      },
      message: "Terminal failed",
      detail: null,
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const indicator = await screen.findByTestId(
      `header-tab-failure-${EPIC_A.id}`,
    );
    expect(
      indicator
        .closest("[data-status-glyph]")
        ?.getAttribute("data-status-glyph"),
    ).toBe("failure");
    expect(screen.queryByTestId(`header-tab-done-${EPIC_A.id}`)).toBeNull();
  });

  it("shows a task activity spinner while any chat is active in the epic", async () => {
    openEpicFixture(EPIC_A);
    registerActiveEpicHeader(EPIC_A, "owner", ["chat-active"]);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByTestId(`header-tab-activity-${EPIC_A.id}`),
    ).toBeDefined();
  });

  it("shows the chat-level background indicator when only background work remains", async () => {
    openEpicFixture(EPIC_A);
    registerActiveEpicHeader(EPIC_A, "owner", ["chat-background"]);
    registerChatSession(EPIC_A.id, "chat-background");
    const handle = __getChatSessionRegistryForTests().peek(
      EPIC_A.id,
      "chat-background",
      CHAT_SESSION_HOST,
    );
    if (handle === null) throw new Error("expected chat session handle");
    handle.store.setState({
      runStatus: "running",
      activeTurn: null,
      turnInProgress: false,
      backgroundItems: [
        {
          taskId: "background-task",
          kind: "monitor",
          title: "Monitor",
          blockId: "background-task",
          parentTaskId: null,
          scheduledFor: null,
        },
      ],
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    const backgroundIcon = await screen.findByTestId(
      `header-tab-background-activity-${EPIC_A.id}`,
    );
    expect(
      backgroundIcon
        .closest("[data-status-glyph]")
        ?.getAttribute("data-status-glyph"),
    ).toBe("background");
    expect(screen.queryByTestId(`header-tab-activity-${EPIC_A.id}`)).toBeNull();
    expect(anyTooltipHasText("Background activity — agent idle")).toBe(true);
  });

  it("prioritizes turn activity over background work from another chat", async () => {
    openEpicFixture(EPIC_A);
    registerActiveEpicHeader(EPIC_A, "owner", ["chat-background", "chat-turn"]);
    registerChatSession(EPIC_A.id, "chat-background");
    registerChatSession(EPIC_A.id, "chat-turn");
    const backgroundHandle = __getChatSessionRegistryForTests().peek(
      EPIC_A.id,
      "chat-background",
      CHAT_SESSION_HOST,
    );
    const turnHandle = __getChatSessionRegistryForTests().peek(
      EPIC_A.id,
      "chat-turn",
      CHAT_SESSION_HOST,
    );
    if (backgroundHandle === null || turnHandle === null) {
      throw new Error("expected chat session handles");
    }
    backgroundHandle.store.setState({
      runStatus: "running",
      activeTurn: null,
      turnInProgress: false,
      backgroundItems: [],
    });
    turnHandle.store.setState({
      runStatus: "running",
      activeTurn: null,
      turnInProgress: true,
      backgroundItems: [],
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByTestId(`header-tab-activity-${EPIC_A.id}`),
    ).toBeDefined();
    expect(
      screen.queryByTestId(`header-tab-background-activity-${EPIC_A.id}`),
    ).toBeNull();
  });

  it("ignores stale active awareness for a deleted chat", async () => {
    openEpicFixture(EPIC_A);
    registerStaleActiveEpicHeader(EPIC_A, "owner", ["chat-deleted"]);
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId(`tab-epic-${EPIC_A.id}`)).toBeDefined();
    expect(screen.queryByTestId(`header-tab-activity-${EPIC_A.id}`)).toBeNull();
    expect(
      screen.queryByTestId(`header-tab-interview-${EPIC_A.id}`),
    ).toBeNull();
    expect(screen.queryByTestId(`header-tab-approval-${EPIC_A.id}`)).toBeNull();
  });

  it("shows the interview glyph for a live chat's pending interview with no notification lit", async () => {
    openEpicFixture(EPIC_A);
    registerLiveEpicHeader(EPIC_A, "owner", ["chat-waiting"]);
    registerChatSession(EPIC_A.id, "chat-waiting");
    const handle = __getChatSessionRegistryForTests().peek(
      EPIC_A.id,
      "chat-waiting",
      CHAT_SESSION_HOST,
    );
    if (handle === null) throw new Error("expected chat session handle");
    handle.store.setState({
      pendingInterviews: [{ blockId: "question-1", requestedAt: 1 }],
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByTestId(`header-tab-interview-${EPIC_A.id}`),
    ).toBeDefined();
    expect(screen.queryByTestId(`header-tab-approval-${EPIC_A.id}`)).toBeNull();
  });

  it("shows the approval glyph for a live chat's pending approval with no notification lit", async () => {
    openEpicFixture(EPIC_A);
    registerLiveEpicHeader(EPIC_A, "owner", ["chat-permission"]);
    registerChatSession(EPIC_A.id, "chat-permission");
    const handle = __getChatSessionRegistryForTests().peek(
      EPIC_A.id,
      "chat-permission",
      CHAT_SESSION_HOST,
    );
    if (handle === null) throw new Error("expected chat session handle");
    handle.store.setState({
      pendingApprovals: [
        {
          kind: "tool",
          approvalId: "approval-1",
          toolName: "edit",
          description: "Apply change",
          input: null,
          planId: null,
          actions: [],
          requestedAt: 1,
          reason: null,
          reviewing: null,
        },
      ],
    });
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByTestId(`header-tab-approval-${EPIC_A.id}`),
    ).toBeDefined();
    expect(
      screen.queryByTestId(`header-tab-interview-${EPIC_A.id}`),
    ).toBeNull();
  });

  it("hides the header epic edit-title menu item for viewer role", async () => {
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    expect(await screen.findByText("Edit Title")).toBeDefined();
    cleanup();
    queryClient.clear();
    resetStores();

    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "viewer");
    const viewerRouter = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={viewerRouter} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    expect(screen.queryByText("Edit Title")).toBeNull();
    expect(screen.getByText("Pin Task in History")).toBeDefined();
  });

  it("pins a task from its tab context menu and offers Undo", async () => {
    pinTestState.pinnedByEpicId.set(EPIC_A.id, {
      pinned: false,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    });
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    fireEvent.click(await screen.findByText("Pin Task in History"));

    expect(pinTestState.mutate).toHaveBeenCalledTimes(1);
    const firstCall = pinTestState.mutate.mock.calls[0];
    expect(firstCall[0]).toEqual({
      epicId: EPIC_A.id,
      pinned: true,
      isLocalHome: false,
      // A cloud-homed reading carries no host, so the mutation dispatches on
      // the following client exactly as it did before the host rode along.
      hostId: null,
    });
    expect(typeof firstCall[1]?.onSuccess).toBe("function");
    expect(toastTestState.messages).toEqual([
      "Pinned “Alpha” to the top of History",
    ]);
    expect(toastTestState.actionLabel).toBe("Undo");
    expect(toastTestState.undo).not.toBeNull();

    toastTestState.undo?.();

    expect(pinTestState.mutate).toHaveBeenNthCalledWith(2, {
      epicId: EPIC_A.id,
      pinned: false,
      isLocalHome: false,
      hostId: null,
    });
  });

  it("shows the inverse task-history action for a pinned task", async () => {
    pinTestState.pinnedByEpicId.set(EPIC_A.id, {
      pinned: true,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    });
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));

    expect(await screen.findByText("Unpin Task in History")).toBeDefined();
  });

  it("re-asks for a tab's pin reading when its context menu opens with no answer yet", async () => {
    // No entry at all for EPIC_A in `pinnedByEpicId` - the batch never
    // resolved it (absent, still "in flight" from the strip's point of view).
    // Opening the menu is exactly when `useRetryUnansweredTaskPinReading`
    // (wired through `onTaskPinMenuOpen`) is supposed to re-ask for it.
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    await screen.findByTestId(`tab-pin-history-${EPIC_A.id}`);

    expect(pinTestState.retryUnansweredTaskPinReading).toHaveBeenCalledWith(
      EPIC_A.id,
    );
  });

  it("re-asks for a tab's pin reading when the batch settled without answering it", async () => {
    // Present, but as an UNANSWERED filler (`pinnedKnown: false`) rather than
    // absent - the settled-miss case the fix introduced. This must re-ask
    // exactly like the absent case above.
    pinTestState.pinnedByEpicId.set(EPIC_A.id, {
      pinned: false,
      home: undefined,
      hostId: null,
      pinnedKnown: false,
    });
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    await screen.findByTestId(`tab-pin-history-${EPIC_A.id}`);

    expect(pinTestState.retryUnansweredTaskPinReading).toHaveBeenCalledWith(
      EPIC_A.id,
    );
  });

  it("does not re-ask for a tab's pin reading once it is already known", async () => {
    pinTestState.pinnedByEpicId.set(EPIC_A.id, {
      pinned: false,
      home: undefined,
      hostId: null,
      pinnedKnown: true,
    });
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    await screen.findByText("Pin Task in History");

    expect(pinTestState.retryUnansweredTaskPinReading).not.toHaveBeenCalled();
  });

  it("does not re-ask for a tab's pin reading when it is local-homed with no serving host", async () => {
    // A local-homed row's owning host is who could actually answer it; with
    // no serving host there is nobody to ask, and the window's batch cannot
    // resolve an epic it does not own either. Re-asking here would just
    // repeat the same unanswered result forever.
    pinTestState.pinnedByEpicId.set(EPIC_A.id, {
      pinned: false,
      home: "local",
      hostId: null,
      pinnedKnown: false,
    });
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    await screen.findByTestId(`tab-pin-history-${EPIC_A.id}`);

    expect(pinTestState.retryUnansweredTaskPinReading).not.toHaveBeenCalled();
  });

  it("does not re-ask for a tab's pin reading when the epic is a preserved orphan", async () => {
    // Its cloud row is gone for good, so a re-ask can only ever come back
    // the same way - the menu item already says "task deleted" regardless of
    // what a retry would return.
    openEpicFixture(EPIC_A);
    registerPreservedOrphanEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    await screen.findByTestId(`tab-pin-history-${EPIC_A.id}`);

    expect(pinTestState.retryUnansweredTaskPinReading).not.toHaveBeenCalled();
  });

  it("refuses the cloud-only pin action on a local-home epic tab", async () => {
    // `home: "local"` reaches the tab strip through
    // `epic.getTaskContexts@1.2`'s `localHomedTaskIds`. Before that key
    // existed the strip saw only `pinned: false`, which is indistinguishable
    // from "in the cloud and not pinned" - so the item rendered enabled, fired
    // the cloud mutation, and the toast claimed the epic had been pinned.
    pinTestState.pinnedByEpicId.set(EPIC_A.id, {
      pinned: false,
      home: "local",
      hostId: null,
      pinnedKnown: true,
    });
    openEpicFixture(EPIC_A);
    registerEpicHeader(EPIC_A, "owner");
    const router = buildRouter("/epics/e-a/e-a");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
    const item = await screen.findByTestId(`tab-pin-history-${EPIC_A.id}`);
    expect(item.getAttribute("data-local-home-pin-unavailable")).toBe("true");
    // Permanently unavailable, so `aria-disabled` rather than `disabled`:
    // the explanatory label stays keyboard-reachable.
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("data-disabled")).toBeNull();
    // States the condition; does not promise a cloud sync that may never come.
    expect(item.textContent).toContain(
      "Pin Task in History — needs a newer host",
    );
    expect(item.textContent).not.toMatch(/cloud|device/i);

    fireEvent.click(item);

    // The load-bearing assertion: no cloud mutation, and no toast claiming a
    // pin that never happened.
    expect(pinTestState.mutate).not.toHaveBeenCalled();
    expect(toastTestState.messages).toEqual([]);
  });

  /**
   * `06641bf75` - the `unverified` local-home carve-out's tab-strip half
   * (lane 9 evidence artifact, §3.2). The desktop-History/mobile-tray half
   * is `use-epic-set-pinned-mutation.test.tsx`'s "refuses at dispatch"
   * case; this pins the tab strip's own two entry points into the SAME
   * `epicPinDispatchAdmitted` gate - the menu select and the toast's Undo
   * action - under an `unverified` session on a host that has negotiated
   * `epic.setPinned@1.1`.
   */
  describe("unverified local-home pin carve-out (06641bf75)", () => {
    beforeEach(() => {
      recordNegotiatedHostManifest(hostClientTestState.activeHostId ?? "", {
        "epic.setPinned": { major: 1, minor: 1 },
      });
      useAuthStore.setState({ status: "unverified" });
      pinLocalHomeSupportedTestState.supported = true;
    });

    it("dispatches the menu pin for a local-homed tab", async () => {
      pinTestState.pinnedByEpicId.set(EPIC_A.id, {
        pinned: false,
        home: "local",
        hostId: null,
        pinnedKnown: true,
      });
      openEpicFixture(EPIC_A);
      registerEpicHeader(EPIC_A, "owner");
      const router = buildRouter("/epics/e-a/e-a");
      render(<RouterProvider router={router} />);

      fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
      const item = await screen.findByTestId(`tab-pin-history-${EPIC_A.id}`);
      expect(item.getAttribute("aria-disabled")).toBeNull();
      fireEvent.click(item);

      expect(pinTestState.mutate).toHaveBeenCalledTimes(1);
      expect(pinTestState.mutate.mock.calls[0]?.[0]).toEqual({
        epicId: EPIC_A.id,
        pinned: true,
        isLocalHome: true,
        hostId: null,
      });

      toastTestState.undo?.();

      expect(pinTestState.mutate).toHaveBeenNthCalledWith(2, {
        epicId: EPIC_A.id,
        pinned: false,
        isLocalHome: true,
        hostId: null,
      });
    });

    /**
     * The host half of the same dispatch: a local-homed reading names the host
     * whose `epic.listTasks` page produced it, and THAT host - not the
     * window's effective host - is where the pin write is sent. The Undo
     * action is the case that forces the host into the VARIABLES rather than
     * being read at dispatch time: the toast outlives the row, so by the time
     * Undo fires there may be no reading left to re-read a host from.
     */
    it("sends the reading's own host into the dispatch and the Undo closure", async () => {
      // The gate asks the DISPATCH host's negotiation, so the owning host is
      // the one that has to have negotiated `@1.1` - see the refusal case
      // below, where only the window's host has.
      recordNegotiatedHostManifest("host-owning-epic-a", {
        "epic.setPinned": { major: 1, minor: 1 },
      });
      pinTestState.pinnedByEpicId.set(EPIC_A.id, {
        pinned: false,
        home: "local",
        hostId: "host-owning-epic-a",
        pinnedKnown: true,
      });
      openEpicFixture(EPIC_A);
      registerEpicHeader(EPIC_A, "owner");
      const router = buildRouter("/epics/e-a/e-a");
      render(<RouterProvider router={router} />);

      fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
      fireEvent.click(
        await screen.findByTestId(`tab-pin-history-${EPIC_A.id}`),
      );

      expect(pinTestState.mutate.mock.calls[0]?.[0]).toEqual({
        epicId: EPIC_A.id,
        pinned: true,
        isLocalHome: true,
        hostId: "host-owning-epic-a",
      });

      // Drop the reading, then Undo: the host must come from the closure.
      pinTestState.pinnedByEpicId.delete(EPIC_A.id);
      toastTestState.undo?.();

      expect(pinTestState.mutate).toHaveBeenNthCalledWith(2, {
        epicId: EPIC_A.id,
        pinned: false,
        isLocalHome: true,
        hostId: "host-owning-epic-a",
      });
    });

    /**
     * The falsifier for the host moving: the WINDOW's host has negotiated
     * `@1.1` (the `beforeEach` records it) and the epic's own host has not, so
     * a gate reading the window's host admits the write and a gate reading the
     * dispatch host refuses it. Refusing is correct - the write is going to a
     * host that never promised to serve it off local disk.
     */
    it("refuses when the epic's host has not negotiated, though the window's has", async () => {
      pinTestState.pinnedByEpicId.set(EPIC_A.id, {
        pinned: false,
        home: "local",
        hostId: "host-without-the-minor",
        pinnedKnown: true,
      });
      openEpicFixture(EPIC_A);
      registerEpicHeader(EPIC_A, "owner");
      const router = buildRouter("/epics/e-a/e-a");
      render(<RouterProvider router={router} />);

      fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
      fireEvent.click(
        await screen.findByTestId(`tab-pin-history-${EPIC_A.id}`),
      );

      expect(pinTestState.mutate).not.toHaveBeenCalled();
      expect(toastTestState.messages).toEqual([]);
    });

    it("does neither for a cloud-homed tab - no mutate, no toast", async () => {
      pinTestState.pinnedByEpicId.set(EPIC_A.id, {
        pinned: false,
        home: undefined,
        hostId: null,
        pinnedKnown: true,
      });
      openEpicFixture(EPIC_A);
      registerEpicHeader(EPIC_A, "owner");
      const router = buildRouter("/epics/e-a/e-a");
      render(<RouterProvider router={router} />);

      fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
      const item = await screen.findByTestId(`tab-pin-history-${EPIC_A.id}`);
      // The menu's own gate (`tabPinUnavailableReason`) refuses first, before
      // `onSetTaskPinned` - and therefore `epicPinDispatchAdmitted` - is ever
      // reached: the item states WHY rather than firing and doing nothing.
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.textContent).toContain(
        "Pin Task in History — sign-in not confirmed",
      );

      fireEvent.click(item);

      expect(pinTestState.mutate).not.toHaveBeenCalled();
      expect(toastTestState.messages).toEqual([]);
    });

    it("makes Undo a no-op once the host rolls back to @1.0 between the click and the Undo", async () => {
      pinTestState.pinnedByEpicId.set(EPIC_A.id, {
        pinned: false,
        home: "local",
        hostId: null,
        pinnedKnown: true,
      });
      openEpicFixture(EPIC_A);
      registerEpicHeader(EPIC_A, "owner");
      const router = buildRouter("/epics/e-a/e-a");
      render(<RouterProvider router={router} />);

      fireEvent.contextMenu(await screen.findByTestId("tab-epic-e-a"));
      fireEvent.click(
        await screen.findByTestId(`tab-pin-history-${EPIC_A.id}`),
      );

      expect(pinTestState.mutate).toHaveBeenCalledTimes(1);
      expect(toastTestState.undo).not.toBeNull();

      // The toast outlives the click: the host the client is bound to rolls
      // back to the pre-local-home line before Undo is pressed.
      recordNegotiatedHostManifest(hostClientTestState.activeHostId ?? "", {
        "epic.setPinned": { major: 1, minor: 0 },
      });

      toastTestState.undo?.();

      // Still one call - the Undo dispatch re-read the live negotiation, saw
      // it no longer serves a local-home write with no cloud verdict, and
      // silently declined rather than sending an unverified bearer's write.
      expect(pinTestState.mutate).toHaveBeenCalledTimes(1);
    });
  });

  it("does not expose the task-history pin action on system tabs", async () => {
    ensureHistoryTab();
    const router = buildRouter("/epics");
    render(<RouterProvider router={router} />);

    fireEvent.contextMenu(await screen.findByTestId("tab-history-history"));

    expect(screen.queryByText("Pin Task in History")).toBeNull();
    expect(screen.queryByText("Unpin Task in History")).toBeNull();
  });

  it("delays leader digit badges on header tabs", async () => {
    openEpicFixture(EPIC_A);
    openEpicFixture(EPIC_B);
    const router = buildRouter("/epics/e-a/e-a");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(await screen.findByTestId("tab-epic-e-a")).toBeDefined();
    vi.useFakeTimers();
    try {
      expect(screen.queryByTestId("tab-digit-1")).toBeNull();

      fireEvent.keyDown(window, {
        code: "MetaLeft",
        key: "Meta",
        metaKey: true,
      });
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(screen.queryByTestId("tab-digit-1")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByTestId("tab-digit-1")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not close the previous epic canvas tab when Cmd-W follows new draft activation", async () => {
    const epicTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-current", "Current Epic");
    useEpicCanvasStore.getState().openTileInTab(epicTabId, SPEC_A);
    useEpicCanvasStore.getState().openTileInTab(epicTabId, SPEC_B);
    useTabsStore.setState((state) => ({
      ...state,
      stripOrder: useEpicCanvasStore
        .getState()
        .openTabOrder.map((id) => ({ kind: "epic", id })),
    }));
    const before = canvasTabIds(epicTabId);
    const router = buildRouter(`/epics/epic-current/${epicTabId}`);

    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
    await screen.findByTestId(`tab-epic-${epicTabId}`);

    fireEvent.click(screen.getByTestId("tab-new"));
    await flushNav();
    fireEvent.keyDown(window, {
      code: "KeyW",
      key: "w",
      metaKey: true,
    });
    await flushNav();

    expect(canvasTabIds(epicTabId)).toEqual(before);
  });

  it("does not close the previous epic canvas tab when Cmd-W follows Cmd-T", async () => {
    const epicTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-current", "Current Epic");
    useEpicCanvasStore.getState().openTileInTab(epicTabId, SPEC_A);
    useEpicCanvasStore.getState().openTileInTab(epicTabId, SPEC_B);
    useTabsStore.setState((state) => ({
      ...state,
      stripOrder: useEpicCanvasStore
        .getState()
        .openTabOrder.map((id) => ({ kind: "epic", id })),
    }));
    const before = canvasTabIds(epicTabId);
    const router = buildRouter(`/epics/epic-current/${epicTabId}`);

    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );
    await screen.findByTestId(`tab-epic-${epicTabId}`);

    fireEvent.keyDown(window, {
      code: "KeyT",
      key: "t",
      metaKey: true,
    });
    await flushNav();
    fireEvent.keyDown(window, {
      code: "KeyW",
      key: "w",
      metaKey: true,
    });
    await flushNav();

    // Cmd-T now opens a blank tab in the active group (`tab.new`); `epic.new`
    // moved to Cmd-N. So Cmd-T no longer spawns a landing draft, and the
    // following Cmd-W closes that blank - leaving the previous epic canvas tab
    // and its real tabs untouched.
    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
    expect(screen.queryByTestId(`tab-epic-${epicTabId}`)).not.toBeNull();
    expect(canvasTabIds(epicTabId)).toEqual(before);
  });

  it("renders leader number badges beyond single digit on header tabs", async () => {
    Array.from({ length: 11 }, (_, index) => epicFixture(index + 1)).forEach(
      (fixture) => openEpicFixture(fixture),
    );
    const router = buildRouter("/epics/e-1/e-1");
    render(
      <KeybindingProvider router={router}>
        <RouterProvider router={router} />
      </KeybindingProvider>,
    );

    expect(await screen.findByTestId("tab-epic-e-1")).toBeDefined();
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(window, {
        code: "MetaLeft",
        key: "Meta",
        metaKey: true,
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(screen.getByTestId("tab-digit-10").textContent).toContain("10");
      expect(screen.getByTestId("tab-digit-11").textContent).toContain("11");
      expect(screen.queryByTestId("tab-digit-0")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the strip on the landing page when there are no tabs", () => {
    const router = buildRouter("/");
    render(<RouterProvider router={router} />);

    expect(screen.queryByTestId("tab-strip")).toBeNull();
  });

  it("renders a History tab opened via ensureHistoryTab", async () => {
    ensureHistoryTab();
    openEpicFixture(EPIC_A);
    const router = buildRouter("/epics");
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("tab-history-history")).toBeDefined();
    expect(screen.getByTestId("tab-epic-e-a")).toBeDefined();
  });

  it("renders a Settings tab opened via ensureSettingsTab", async () => {
    ensureSettingsTab({ subSection: null, resetToGeneral: true });
    const router = buildRouter("/settings/general");
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId("tab-settings-settings")).toBeDefined();
  });

  it("falls back to Settings general when a persisted Settings path is stale", async () => {
    useTabsStore.getState().openSystemTab({
      kind: "settings",
      name: "Settings",
      lastPath: "/epics/e-a/tab-a",
    });
    const router = buildRouter("/epics/e-a/tab-a");
    render(<RouterProvider router={router} />);
    await screen.findByTestId("tab-settings-settings");

    fireEvent.click(screen.getByTestId("tab-settings-settings"));
    await flushNav();

    expect(router.state.location.pathname).toBe("/settings/general");
  });

  it("switches from an active epic tab to non-epic strip tabs", async () => {
    const epicTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-current", "Current Epic");
    useTabsStore.getState().openSystemTab({
      kind: "settings",
      name: "Settings",
      lastPath: "/settings/general",
    });
    useTabsStore.getState().openSystemTab({
      kind: "history",
      name: "History",
      lastPath: "/epics",
    });
    const draftId = useLandingDraftStore.getState().createDraft(null);

    const router = buildRouter(`/epics/epic-current/${epicTabId}`);
    render(<RouterProvider router={router} />);
    await screen.findByTestId(`tab-epic-${epicTabId}`);

    fireEvent.click(screen.getByTestId("tab-settings-settings"));
    await flushNav();
    expect(router.state.location.pathname).toBe("/settings/general");

    await router.navigate({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-current", tabId: epicTabId },
      search: {
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
        focusPaneId: undefined,
        focusTileInstanceId: undefined,
      },
    });
    fireEvent.click(screen.getByTestId("tab-history-history"));
    await flushNav();
    expect(router.state.location.pathname).toBe("/epics");

    await router.navigate({
      to: "/epics/$epicId/$tabId",
      params: { epicId: "epic-current", tabId: epicTabId },
      search: {
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
        focusPaneId: undefined,
        focusTileInstanceId: undefined,
      },
    });
    fireEvent.click(screen.getByTestId(`tab-draft-${draftId}`));
    await flushNav();
    expect(router.state.location.pathname).toBe(`/draft/${draftId}`);
  });

  it("only marks the routed tab active when one epic has multiple tabs", async () => {
    const store = useEpicCanvasStore.getState();
    const firstTabId = store.openEpicTab("epic-shared", "Shared");
    const secondTabId = useEpicCanvasStore.getState().duplicateTab(firstTabId);
    const thirdTabId = useEpicCanvasStore.getState().duplicateTab(firstTabId);
    if (secondTabId === null || thirdTabId === null) {
      throw new Error("Expected duplicate tabs");
    }
    useTabsStore.setState({
      activeItemId: `tab:epic:${secondTabId}`,
    });
    const router = buildRouter(`/epics/epic-shared/${secondTabId}`);
    render(<RouterProvider router={router} />);

    const first = await screen.findByTestId(`tab-epic-${firstTabId}`);
    const second = await screen.findByTestId(`tab-epic-${secondTabId}`);
    const third = await screen.findByTestId(`tab-epic-${thirdTabId}`);

    expect(first.getAttribute("aria-selected")).toBe("false");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(third.getAttribute("aria-selected")).toBe("false");
  });

  it("does not resurrect same-epic duplicates when closing them serially", async () => {
    const store = useEpicCanvasStore.getState();
    const firstTabId = store.openEpicTab("epic-shared", "Shared");
    const secondTabId = useEpicCanvasStore.getState().duplicateTab(firstTabId);
    const thirdTabId = useEpicCanvasStore
      .getState()
      .duplicateTab(secondTabId ?? firstTabId);
    if (secondTabId === null || thirdTabId === null) {
      throw new Error("Expected duplicate tabs");
    }
    const router = buildRouter(`/epics/epic-shared/${thirdTabId}`);
    render(<RouterProvider router={router} />);
    await screen.findByTestId(`tab-epic-${thirdTabId}`);

    fireEvent.click(screen.getByTestId(`tab-close-epic-${thirdTabId}`));
    await flushNav();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([
      firstTabId,
      secondTabId,
    ]);
    expect(useTabsStore.getState().stripOrder).toEqual([
      { kind: "epic", id: firstTabId },
      { kind: "epic", id: secondTabId },
    ]);

    fireEvent.click(screen.getByTestId(`tab-close-epic-${secondTabId}`));
    await flushNav();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([firstTabId]);
    expect(useTabsStore.getState().stripOrder).toEqual([
      { kind: "epic", id: firstTabId },
    ]);

    fireEvent.click(screen.getByTestId(`tab-close-epic-${firstTabId}`));
    await flushNav();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
    expect(useEpicCanvasStore.getState().tabsById[firstTabId]?.epicId).toBe(
      "epic-shared",
    );
    expect(useEpicCanvasStore.getState().tabsById[secondTabId]?.epicId).toBe(
      "epic-shared",
    );
    expect(useEpicCanvasStore.getState().tabsById[thirdTabId]?.epicId).toBe(
      "epic-shared",
    );
    expect(useTabsStore.getState().stripOrder).toEqual([]);
    expect(screen.queryByTestId(`tab-epic-${firstTabId}`)).toBeNull();
    expect(screen.queryByTestId(`tab-epic-${secondTabId}`)).toBeNull();
    expect(screen.queryByTestId(`tab-epic-${thirdTabId}`)).toBeNull();
  });

  it("ignores stale legacy epic rows after canonical tabs close", async () => {
    const store = useEpicCanvasStore.getState();
    const firstTabId = store.openEpicTab("epic-shared", "Shared");
    const secondTabId = useEpicCanvasStore.getState().duplicateTab(firstTabId);
    const thirdTabId = useEpicCanvasStore
      .getState()
      .duplicateTab(secondTabId ?? firstTabId);
    if (secondTabId === null || thirdTabId === null) {
      throw new Error("Expected duplicate tabs");
    }

    useEpicCanvasStore.setState((state) => ({
      tabsById: {
        [firstTabId]: state.tabsById[firstTabId],
      },
      openTabOrder: [firstTabId],
    }));
    useTabsStore.setState({
      stripOrder: [
        { kind: "epic", id: firstTabId },
        { kind: "epic", id: secondTabId },
        { kind: "epic", id: thirdTabId },
      ],
    });

    const router = buildRouter(`/epics/epic-shared/${firstTabId}`);
    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId(`tab-epic-${firstTabId}`)).toBeDefined();
    expect(screen.queryByTestId(`tab-epic-${secondTabId}`)).toBeNull();
    expect(screen.queryByTestId(`tab-epic-${thirdTabId}`)).toBeNull();
  });

  it("ensureHistoryTab is a singleton - repeat calls do not duplicate", () => {
    ensureHistoryTab();
    ensureHistoryTab();
    ensureHistoryTab();

    const refs = useTabsStore.getState().stripOrder;
    expect(
      refs.filter((ref) => ref.kind === "history" && ref.id === "history"),
    ).toHaveLength(1);
  });

  it("closing the History tab via X removes it from the strip", async () => {
    ensureHistoryTab();
    openEpicFixture(EPIC_A);
    const router = buildRouter("/epics");
    render(<RouterProvider router={router} />);
    await screen.findByTestId("tab-close-history-history");

    fireEvent.click(screen.getByTestId("tab-close-history-history"));
    await flushNav();

    expect(useTabsStore.getState().systemTabs.history).toBeNull();
    expect(
      useTabsStore.getState().stripOrder.some((ref) => ref.kind === "history"),
    ).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { EpicRouteSessionBody } from "@/components/epic-canvas/epic-route-session-body";
import {
  __resetEpicParkingForTests,
  isEpicParked,
  trackEpicParkingSurface,
} from "@/lib/epics/epic-parking";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { PARK_HIDDEN_EPIC_AFTER_MS } from "@/stores/replica-memory/retention-profile";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import {
  __setAgentActivityPlaneAnsweringForTests,
  __resetAgentActivityStoreForTests,
} from "@/stores/agent-activity-store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { INERT_ROOT_STATE_PORT } from "@/stores/epics/open-epic/test-support/root-state-port-fixture";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const useInitialChatHandoffMock = vi.hoisted(() => vi.fn());
const useEpicRouteSynchronizationMock = vi.hoisted(() => vi.fn());
const useEpicSyncChatRecordsMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/epic-canvas/hooks/use-initial-chat-handoff", () => ({
  useInitialChatHandoff: useInitialChatHandoffMock,
}));

vi.mock(
  "@/components/epic-canvas/hooks/use-epic-route-synchronization",
  () => ({
    useEpicRouteSynchronization: useEpicRouteSynchronizationMock,
  }),
);

// Both exports, not just the hook this component calls: a factory that lists
// only what today's importer uses answers `undefined` for the rest, and the
// next importer of this module gets a silent no-op instead of a failure.
vi.mock("@/hooks/chats/use-epic-chat-records", () => ({
  useEpicSyncChatRecords: useEpicSyncChatRecordsMock,
  invalidateEpicChatRecords: () => undefined,
}));
// The terminal-agent twin of the record sync above: same subtree, same
// reason to stub it - it reaches the session host client, which this
// harness does not provide.
vi.mock("@/hooks/chats/use-epic-tui-agent-records", () => ({
  useEpicSyncTuiAgentRecords: () => undefined,
  invalidateEpicTuiAgentRecords: () => undefined,
}));

vi.mock("@/providers/epic-session-gate", () => ({
  EpicSessionGate: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/components/epic-canvas/epic-shell", () => ({
  EpicShell: (props: {
    readonly active: boolean;
    readonly epicId: string;
    readonly tabId: string;
  }) => (
    <div
      data-testid="epic-shell"
      data-active={props.active ? "true" : "false"}
      data-epic-id={props.epicId}
      data-tab-id={props.tabId}
    />
  ),
}));

vi.mock("@/components/epic-canvas/dialogs/epic-migration-modal", () => ({
  EpicMigrationModal: (props: { readonly tabId: string }) => (
    <div data-testid="epic-migration-modal" data-tab-id={props.tabId} />
  ),
}));

vi.mock("@/components/epic-canvas/epic-plain-terminal-create-owner", () => ({
  EpicPlainTerminalCreateOwner: () => null,
}));

const BODY_PROPS = {
  epicId: "epic-a",
  tabId: "tab-a",
  focusedAt: 123,
  focusArtifactId: "artifact-a",
  focusThreadId: "thread-a",
  focusPaneId: "pane-a",
  focusTileInstanceId: "tile-a",
};

function renderBody(props: Parameters<typeof EpicRouteSessionBody>[0]): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = (wrapperProps: { readonly children: ReactNode }): ReactNode =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      wrapperProps.children,
    );
  render(<EpicRouteSessionBody {...props} />, { wrapper: Wrapper });
}

describe("<EpicRouteSessionBody />", () => {
  afterEach(() => {
    cleanup();
    useInitialChatHandoffMock.mockReset();
    useEpicRouteSynchronizationMock.mockReset();
    useEpicSyncChatRecordsMock.mockReset();
  });

  it("keeps visual state mounted but suppresses route-global effects when inactive", () => {
    renderBody({ ...BODY_PROPS, active: false });

    expect(screen.getByTestId("epic-shell").dataset.active).toBe("false");
    expect(useInitialChatHandoffMock).toHaveBeenCalledWith("epic-a", "tab-a");
    expect(useEpicRouteSynchronizationMock).not.toHaveBeenCalled();
    // Session-scoped, NOT route-active-scoped: the chat record channel backs
    // the sidebar tree and every open tile of a background epic, which would
    // lose their swept chats again if it stopped while another tab is in front.
    expect(useEpicSyncChatRecordsMock).toHaveBeenCalledWith("epic-a");
    expect(screen.queryByTestId("epic-migration-modal")).toBeNull();
  });

  it("runs route synchronization and migration modal only for the active pane", () => {
    renderBody({ ...BODY_PROPS, active: true });

    expect(screen.getByTestId("epic-shell").dataset.active).toBe("true");
    expect(useEpicRouteSynchronizationMock).toHaveBeenCalledWith(BODY_PROPS);
    expect(screen.getByTestId("epic-migration-modal").dataset.tabId).toBe(
      "tab-a",
    );
  });
});

// ── Renderer parking (plan C, decision C1) ──────────────────────────────────
//
// `useEpicParked` is the REAL hook here - only `EpicShell` and friends are
// mocked above, `EpicSessionGate` is a passthrough, and neither reads or
// writes parking state - so driving the real `epic-parking` module's clock
// through `trackEpicParkingSurface` + `setEpicSurfaceVisibility` exercises
// the genuine park/unpark transition this component reacts to, with no fake
// standing in for the decision itself.
//
// A clean, unmounted `OpenEpicSessionRegistry` entry and a warm
// `ChatSessionRegistry` entry are registered directly against the production
// singletons (`__getOpenEpicRegistryForTests` / `__getChatSessionRegistryForTests`)
// - the same registries `epic-parking.ts` and its `subscribeEpicParking`
// wiring in `lib/registries/chat-session-registry.ts` act on - so parking's
// actual release (not a mock standing in for it) is what these assertions
// observe.

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function buildParkableEpicHandle(epicId: string) {
  const base = openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: noopEpicStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  let disposed = false;
  const realDispose = base.dispose.bind(base);
  return {
    handle: {
      ...base,
      get doc() {
        return base.doc;
      },
      get awareness() {
        return base.awareness;
      },
      get store() {
        return base.store;
      },
      dispose: () => {
        disposed = true;
        realDispose();
      },
      hotArtifactRoomIdsForTests: () => [],
      ...INERT_ROOT_STATE_PORT,
    },
    get disposed() {
      return disposed;
    },
  };
}

describe("<EpicRouteSessionBody /> - renderer parking (plan C, C1)", () => {
  const PARK_EPIC_ID = "epic-park-1";
  const PARK_VIEW_TAB_ID = "view-park-1";
  const PARK_HOST_ID = "host-park-1";
  const PARK_CHAT_ID = "chat-park-1";
  let unsubscribeSurface: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    __setAgentActivityPlaneAnsweringForTests();
  });

  afterEach(() => {
    cleanup();
    unsubscribeSurface?.();
    unsubscribeSurface = null;
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    disposeAllChatSessions();
    __resetAgentActivityStoreForTests();
    useInitialChatHandoffMock.mockReset();
    useEpicRouteSynchronizationMock.mockReset();
    useEpicSyncChatRecordsMock.mockReset();
    vi.useRealTimers();
  });

  it("at 5 minutes hidden releases the epic session, the chat lease and the record polls; at 4:59 releases nothing", async () => {
    const epicHandle = buildParkableEpicHandle(PARK_EPIC_ID);
    __getOpenEpicRegistryForTests().acquireMounted(
      PARK_EPIC_ID,
      () => epicHandle.handle,
    );

    const chatHandle = createChatSessionStore({
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      hostId: PARK_HOST_ID,
      epicId: PARK_EPIC_ID,
      chatId: PARK_CHAT_ID,
      userId: null,
      onAuthError: null,
      onProviderAuthError: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: () => ({
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      }),
    });
    const chatRegistry = __getChatSessionRegistryForTests();
    chatRegistry.acquire(
      {
        epicId: PARK_EPIC_ID,
        chatId: PARK_CHAT_ID,
        hostId: PARK_HOST_ID,
        scopeKey: "park-scope",
      },
      () => chatHandle,
    );

    renderBody({ ...BODY_PROPS, epicId: PARK_EPIC_ID, active: false });
    expect(useEpicSyncChatRecordsMock).toHaveBeenCalledWith(PARK_EPIC_ID);
    const callsBeforeHidden = useEpicSyncChatRecordsMock.mock.calls.length;

    act(() => {
      unsubscribeSurface = trackEpicParkingSurface(
        PARK_EPIC_ID,
        PARK_VIEW_TAB_ID,
      );
    });
    act(() => {
      setEpicSurfaceVisibility(PARK_EPIC_ID, PARK_VIEW_TAB_ID, false);
    });

    // Arm 1: 4 minutes 59 seconds hidden - one second short of the window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS - 1_000);
    });

    expect(isEpicParked(PARK_EPIC_ID)).toBe(false);
    expect(epicHandle.disposed).toBe(false);
    expect(
      chatRegistry.peek(PARK_EPIC_ID, PARK_CHAT_ID, PARK_HOST_ID),
    ).not.toBeNull();
    // Still in the tree: a re-render here would call the (unmemoized) hook
    // again if `EpicRecordSyncEffects` were still mounted, so an unchanged
    // count together with the assertions below proves nothing has released.
    expect(useEpicSyncChatRecordsMock.mock.calls.length).toBe(
      callsBeforeHidden,
    );

    // Arm 2: the remaining second - now 5:00 hidden.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(isEpicParked(PARK_EPIC_ID)).toBe(true);
    expect(epicHandle.disposed).toBe(true);
    expect(__getOpenEpicRegistryForTests().get(PARK_EPIC_ID)).toBeNull();
    expect(
      chatRegistry.peek(PARK_EPIC_ID, PARK_CHAT_ID, PARK_HOST_ID),
    ).toBeNull();
    // The parked transition unmounted `EpicRecordSyncEffects` - no further
    // call was issued for it.
    expect(useEpicSyncChatRecordsMock.mock.calls.length).toBe(
      callsBeforeHidden,
    );
  });

  it("remounts and refetches record-sync effects once a parked epic is shown again", async () => {
    renderBody({ ...BODY_PROPS, epicId: PARK_EPIC_ID, active: false });
    const initialCalls = useEpicSyncChatRecordsMock.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);

    act(() => {
      unsubscribeSurface = trackEpicParkingSurface(
        PARK_EPIC_ID,
        PARK_VIEW_TAB_ID,
      );
    });
    act(() => {
      setEpicSurfaceVisibility(PARK_EPIC_ID, PARK_VIEW_TAB_ID, false);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
    });
    expect(isEpicParked(PARK_EPIC_ID)).toBe(true);
    const callsWhileParked = useEpicSyncChatRecordsMock.mock.calls.length;
    expect(callsWhileParked).toBe(initialCalls);

    // Showing the tab again unparks synchronously - no registry entry exists
    // for this epic id (it was never mounted in this test), so the epic
    // parking module's own "an epic with no live entry answers `true`" rule
    // for parking has no bearing on UNparking, which is driven purely by
    // visibility.
    act(() => {
      setEpicSurfaceVisibility(PARK_EPIC_ID, PARK_VIEW_TAB_ID, true);
    });

    expect(isEpicParked(PARK_EPIC_ID)).toBe(false);
    // `EpicRecordSyncEffects` remounted: a fresh call was issued, which is
    // what produces a NEW `ingestFenceIdentity` read (`use-epic-chat-records.ts`)
    // on show - the unmount/remount is what makes the fence fresh, rather than
    // the hook somehow refreshing an in-place subscription.
    expect(useEpicSyncChatRecordsMock.mock.calls.length).toBeGreaterThan(
      callsWhileParked,
    );
  });
});

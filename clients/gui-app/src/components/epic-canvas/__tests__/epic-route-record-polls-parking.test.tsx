/**
 * Renderer parking (plan C, C1) vs the two record polls, observed as REQUESTS.
 *
 * `epic-route-session-body.tsx` gates `EpicRecordSyncEffects` on
 * `useEpicParked`, and the reason given there is a claim about the wire: each
 * of those reads opens the epic on the host under a request-scoped VISIBLE
 * lease, so a parked epic that kept polling would rebuild the slot the park
 * just released every 20 seconds and the park would free nothing.
 *
 * That claim is about an interval and a transport, and it can only be checked
 * against an interval and a transport. The pins this file replaces mocked both
 * hooks and counted how many times they were INVOKED - a number that moves with
 * React re-renders, says nothing about whether a `refetchInterval` is armed,
 * and (with the terminal-agent hook mocked to a no-op) covered one of the two
 * reads not at all. Every one of them would have passed with the interval still
 * running.
 *
 * So this suite mounts the REAL hooks - real `QueryClient`, real `HostClient`
 * over the mock messenger, real open-epic stores - and counts the
 * `epic.listChatRecords` / `epic.listTuiAgents` frames that actually leave the
 * renderer, across a real park driven by the real clock.
 *
 * Ablations each test is written against:
 *  - drop the `parked ?` gate in `epic-route-session-body.tsx` and the polls
 *    keep firing past the park;
 *  - drop `poll: true` from either hook and the "still polling at 4:59" arm
 *    reads one request instead of many.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import * as Y from "yjs";
import type { ReactNode } from "react";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  EpicRouteSessionBody,
  type EpicRouteSessionBodyProps,
} from "@/components/epic-canvas/epic-route-session-body";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import {
  __resetEpicParkingForTests,
  isEpicParked,
} from "@/lib/epics/epic-parking";
import { __syncEpicParkingOpenTabsForTests } from "@/lib/epics/epic-parking-open-tabs";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { HOST_METHOD_POLL_TABLE } from "@/lib/host-rpc-policy/host-method-policy-table";
import { PARK_HIDDEN_EPIC_AFTER_MS } from "@/stores/replica-memory/retention-profile";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
} from "@/stores/agent-activity-store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { INERT_ROOT_STATE_PORT } from "@/stores/epics/open-epic/test-support/root-state-port-fixture";
import type {
  EpicStreamClientFactory,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useAuthStore } from "@/stores/auth/auth-store";

const useInitialChatHandoffMock = vi.hoisted(() => vi.fn());
const useEpicRouteSynchronizationMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/epic-canvas/hooks/use-initial-chat-handoff", () => ({
  useInitialChatHandoff: useInitialChatHandoffMock,
}));

vi.mock(
  "@/components/epic-canvas/hooks/use-epic-route-synchronization",
  () => ({
    useEpicRouteSynchronization: useEpicRouteSynchronizationMock,
  }),
);

// The record hooks are deliberately NOT mocked - they are the subject.
vi.mock("@/providers/epic-session-gate", () => ({
  EpicSessionGate: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/components/epic-canvas/epic-shell", () => ({
  EpicShell: () => <div data-testid="epic-shell" />,
}));

vi.mock("@/components/epic-canvas/epic-plain-terminal-create-owner", () => ({
  EpicPlainTerminalCreateOwner: () => null,
}));

const EPIC_ID = "epic-record-poll-park";
const TAB_ID = "tab-record-poll-park";
const VIEW_TAB_ID = "view-record-poll-park";
const CHAT_HOST_ID = "host-record-poll-park";
const CHAT_ID = "chat-record-poll-park";
const VIEWER_ID = "viewer-record-poll-park";

/**
 * The cadence both reads declare in `HOST_METHOD_POLL_TABLE`, restated as a
 * local constant so the arithmetic below reads. Pinned against the table in
 * the first test rather than imported through a narrowing dance, so a change
 * to the table fails here with a sentence rather than a type error.
 */
const RECORD_POLL_INTERVAL_MS = 20_000;

const BODY_PROPS: EpicRouteSessionBodyProps = {
  epicId: EPIC_ID,
  tabId: TAB_ID,
  active: false,
  focusedAt: 123,
  focusArtifactId: undefined,
  focusThreadId: undefined,
  focusPaneId: undefined,
  focusTileInstanceId: undefined,
};

interface RecordChannelFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  /** Frames that actually left the renderer, per method. */
  readonly chatCalls: { value: number };
  readonly tuiCalls: { value: number };
}

function createRecordChannelFixture(): RecordChannelFixture {
  const chatCalls = { value: 0 };
  const tuiCalls = { value: 0 };
  const requestSeq = { value: 0 };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSeq.value += 1;
        return `req-${String(requestSeq.value)}`;
      },
      handlers: {
        "epic.listChatRecords": () => {
          chatCalls.value += 1;
          return Promise.resolve({
            kind: "snapshot" as const,
            listStamp: null,
            chats: [],
          });
        },
        "epic.listTuiAgents": () => {
          tuiCalls.value += 1;
          return Promise.resolve({
            kind: "snapshot" as const,
            listStamp: null,
            tuiAgents: [],
          });
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return {
    client: spine.createRequester(mockLocalHostEntry),
    queryClient,
    chatCalls,
    tuiCalls,
  };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Record poll parking",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: VIEWER_ID,
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

interface ParkableSession {
  readonly handle: OpenEpicStoreHandle;
  readonly disposed: boolean;
}

/**
 * A real open-epic session, snapshotted so the store is past its establishing
 * state, wrapped so the test can see the park DISPOSE it.
 */
function buildParkableSession(): ParkableSession {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const base = openStoreForTest({
    epicId: EPIC_ID,
    userId: VIEWER_ID,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  const seed = new Y.Doc();
  seed.getMap("epic").set("chats", new Y.Map<unknown>());
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(seed));

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

function BodyHarness(props: {
  readonly handle: OpenEpicStoreHandle;
  readonly fixture: RecordChannelFixture;
}) {
  return (
    <QueryClientProvider client={props.fixture.queryClient}>
      <EpicSessionContext.Provider value={props.handle}>
        <EpicSessionHostClientContext.Provider value={props.fixture.client}>
          <EpicRouteSessionBody {...BODY_PROPS} />
        </EpicSessionHostClientContext.Provider>
      </EpicSessionContext.Provider>
    </QueryClientProvider>
  );
}

/** Registers a warm chat lease under the epic, so a park has one to release. */
function acquireChatLease(): void {
  const chatHandle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: CHAT_HOST_ID,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: null,
    onAuthError: null,
    onProviderAuthError: null,
    // Required since #1815's syncing bar; this fixture never redials.
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
      requestTranscriptRange: () => undefined,
      requestResnapshot: () => undefined,
      close: () => undefined,
    }),
  });
  __getChatSessionRegistryForTests().acquire(
    {
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: CHAT_HOST_ID,
      scopeKey: "record-poll-park-scope",
    },
    () => chatHandle,
  );
}

function hideEpicTab(): void {
  act(() => {
    useEpicCanvasStore.getState().openEpicTabWithId(TAB_ID, EPIC_ID, EPIC_ID);
    __syncEpicParkingOpenTabsForTests();
  });
  act(() => {
    setEpicSurfaceVisibility(EPIC_ID, VIEW_TAB_ID, false);
  });
}

describe("epic route record polls across a park (plan C, C1)", () => {
  let fixture: RecordChannelFixture;

  beforeEach(() => {
    vi.useFakeTimers();
    __setAgentActivityPlaneAnsweringForTests();
    useAuthStore.setState({
      contextMetadata: { userId: VIEWER_ID, username: VIEWER_ID },
    });
    fixture = createRecordChannelFixture();
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    __syncEpicParkingOpenTabsForTests();
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    disposeAllChatSessions();
    __resetAgentActivityStoreForTests();
    setEpicSurfaceVisibility(EPIC_ID, VIEW_TAB_ID, false);
    useInitialChatHandoffMock.mockReset();
    useEpicRouteSynchronizationMock.mockReset();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    vi.useRealTimers();
  });

  it("keeps both 20s polls on the wire while hidden, and stops them dead at the park", async () => {
    // The cadence this test does arithmetic with is the table's, not a number
    // invented here.
    expect(HOST_METHOD_POLL_TABLE["epic.listChatRecords"].poll).toEqual({
      kind: "fixed",
      intervalMs: RECORD_POLL_INTERVAL_MS,
    });
    expect(HOST_METHOD_POLL_TABLE["epic.listTuiAgents"].poll).toEqual({
      kind: "fixed",
      intervalMs: RECORD_POLL_INTERVAL_MS,
    });

    const session = buildParkableSession();
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC_ID,
      () => session.handle,
    );
    acquireChatLease();

    render(<BodyHarness handle={session.handle} fixture={fixture} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The mount read - one frame per method, on the wire.
    expect(fixture.chatCalls.value).toBe(1);
    expect(fixture.tuiCalls.value).toBe(1);

    hideEpicTab();

    // ── Arm 1: 4:59 hidden. Hidden-but-not-parked still polls, which is the
    // deliberate placement OUTSIDE `props.active` that the component
    // documents - a background epic that stopped hearing about its own chats
    // would lose the rows again the moment it was swept.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS - 1_000);
    });

    expect(isEpicParked(EPIC_ID)).toBe(false);
    expect(session.disposed).toBe(false);
    expect(
      __getChatSessionRegistryForTests().peek(EPIC_ID, CHAT_ID, CHAT_HOST_ID),
    ).not.toBeNull();
    // 299s at 20s is fourteen further reads; asserted as "the interval fired
    // repeatedly" rather than an exact count, because the exact count is a
    // property of TanStack's scheduling and not of anything this pin is about.
    // What matters is that it is not 1 - a dead interval reads exactly 1 here,
    // which is what makes the arm below evidence of anything.
    const chatCallsWhileHidden = fixture.chatCalls.value;
    const tuiCallsWhileHidden = fixture.tuiCalls.value;
    expect(chatCallsWhileHidden).toBeGreaterThan(1);
    expect(tuiCallsWhileHidden).toBeGreaterThan(1);

    // ── Arm 2: the remaining second - now 5:00 hidden, and parked.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(isEpicParked(EPIC_ID)).toBe(true);
    expect(session.disposed).toBe(true);
    expect(__getOpenEpicRegistryForTests().get(EPIC_ID)).toBeNull();
    expect(
      __getChatSessionRegistryForTests().peek(EPIC_ID, CHAT_ID, CHAT_HOST_ID),
    ).toBeNull();
    const chatCallsAtPark = fixture.chatCalls.value;
    const tuiCallsAtPark = fixture.tuiCalls.value;

    // Three more poll intervals with the tab still open and still hidden. Not
    // one further frame: the queries stopped being OBSERVERS, so there is no
    // `refetchInterval` left to fire and no visible lease to rebuild the slot
    // the park just released.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_POLL_INTERVAL_MS * 3);
    });
    expect(fixture.chatCalls.value).toBe(chatCallsAtPark);
    expect(fixture.tuiCalls.value).toBe(tuiCallsAtPark);
  });

  it("re-reads both records and re-arms both polls when the parked tab is shown again", async () => {
    const parked = buildParkableSession();
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC_ID,
      () => parked.handle,
    );

    const view = render(
      <BodyHarness handle={parked.handle} fixture={fixture} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    hideEpicTab();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
    });
    expect(isEpicParked(EPIC_ID)).toBe(true);
    const chatCallsAtPark = fixture.chatCalls.value;
    const tuiCallsAtPark = fixture.tuiCalls.value;

    // Showing the tab unparks synchronously.
    act(() => {
      setEpicSurfaceVisibility(EPIC_ID, VIEW_TAB_ID, true);
    });
    expect(isEpicParked(EPIC_ID)).toBe(false);

    // On show the provider re-acquires: the parked session was disposed, so
    // what comes back is a FRESH store generation, not the one that was
    // released. Re-rendering the harness against it is exactly that.
    const shown = buildParkableSession();
    __getOpenEpicRegistryForTests().acquireMounted(EPIC_ID, () => shown.handle);
    view.rerender(<BodyHarness handle={shown.handle} fixture={fixture} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // A real re-read, on the wire - not a remounted hook serving the answer it
    // had before the park.
    expect(fixture.chatCalls.value).toBeGreaterThan(chatCallsAtPark);
    expect(fixture.tuiCalls.value).toBeGreaterThan(tuiCallsAtPark);

    // And the cadence is armed again rather than the reads being one-shot: one
    // further interval, one further frame per method.
    const chatCallsAfterShow = fixture.chatCalls.value;
    const tuiCallsAfterShow = fixture.tuiCalls.value;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECORD_POLL_INTERVAL_MS);
    });
    expect(fixture.chatCalls.value).toBeGreaterThan(chatCallsAfterShow);
    expect(fixture.tuiCalls.value).toBeGreaterThan(tuiCallsAfterShow);
  });
});

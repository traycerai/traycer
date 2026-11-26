/**
 * Oracle tests for the tab-owned session controller
 * (`lib/registries/epic-session-controller.ts`): a session can exist with no
 * `EpicSessionProvider` mounted at all, driven purely by tab membership and
 * demand (a surface, or unobserved metadata).
 *
 * Most of these tests drive the controller directly - `syncOpenTabs` (via the
 * canvas store + `__syncEpicParkingOpenTabsForTests()`), `attachSurface`,
 * `retry` - and read back `readEntryStatusForTests` / `readTabSnapshot` /
 * the registry, with NO React involved. One test mounts `TestEpicSessionTab`
 * to check the same entry through the public provider surface.
 */
import { use, useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import * as Y from "yjs";
import { QueryClient } from "@tanstack/react-query";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { EpicStatusStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { EpicStateStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { EpicRuntimeStreamFactories } from "@/stores/epics/open-epic/runtime/worker/epic-runtime-composition";
import type { EpicLaneSelectionSources } from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { StreamCloseReason } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type {
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import {
  RUNTIME_BRIDGE_PROTOCOL_VERSION,
  type WorkerToMainEvent,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type { BridgeMessageEventLike } from "@traycer-clients/shared/replica-runtime/worker/bridge-transports";

import {
  getEpicSessionController,
  __resetEpicSessionControllerForTests,
} from "@/lib/registries/epic-session-controller";
import {
  __getOpenEpicRegistryForTests,
  disposeAllOpenEpicSessions,
  EpicSessionPresentationContext,
  type EpicSessionPresentation,
} from "@/lib/registries/epic-session-registry";
import {
  __setEpicRuntimeWorkerFactoryForTests,
  getEpicRuntimeWorkerFactoryOverride,
} from "@/lib/registries/epic-runtime-worker-factory-slot";
import type { RuntimeWorkerLike } from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/runtime/legacy-epic-stream-adapter";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  createInProcessEpicRuntimeWorker,
  createProxiedInProcessEpicRuntimeWorker,
} from "@/stores/epics/open-epic/test-support/in-process-epic-runtime-worker";
import { absentLaneUnaries } from "@/stores/epics/open-epic/test-support/absent-lane-unaries";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import {
  fakeDurableStreamTransports,
  resetFakeDurableStreamTransports,
} from "@/lib/host/test-support/fake-durable-stream-transport";
import type { InProcessEpicRuntimeWorker } from "@/stores/epics/open-epic/test-support/in-process-epic-runtime-worker";

import {
  defaultTestEpicSessionEnvironment,
  installTestEpicSessionEnvironment,
  openTestEpicTab,
  closeTestEpicTab,
  setTestEffectiveHost,
} from "@/lib/registries/test-support/epic-session-controller-test-support";
import {
  assertPoolTaskLanes,
  assertTestFixture,
  COMPLETE_TEST_LANE_MANIFEST,
  FakePoolEndpoint,
  installPoolTaskTransportSpy,
  poolStateLaneSnapshot as stateLaneSnapshot,
  poolStatusLaneSnapshot as statusLaneSnapshot,
  PUBLICATION_REPLACEMENT_WIRE_INPUTS,
  sendPoolTaskSnapshots,
  type CapturedPoolBodyLane,
  type PoolEndpointSocket,
  type PoolTransportForTest,
} from "@/lib/registries/test-support/epic-session-pool-test-support";
import { TestEpicSessionTab } from "@/lib/registries/test-support/test-epic-session-tab";
import { __syncEpicParkingOpenTabsForTests } from "@/lib/epics/epic-parking-open-tabs";
import {
  __resetEpicParkingForTests,
  isEpicParked,
} from "@/lib/epics/epic-parking";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { PARK_HIDDEN_EPIC_AFTER_MS } from "@/stores/replica-memory/retention-profile";
import { TITLE_GENERATION_PENDING_TIMEOUT_MS } from "@/stores/epics/canvas/canvas-title-timers";
import {
  SESSION_REBUILD_INITIAL_BACKOFF_MS,
  SESSION_REBUILD_MAX_BACKOFF_MS,
} from "@/lib/host/session-rebuild-backoff";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
} from "@/stores/agent-activity-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { epicStatusSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/status-subscribe";
import { epicStateSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/state-subscribe";
import {
  artifactSubscribeServerFrameSchemaV13,
  artifactSubscribeServerFrameSchemaV12,
} from "@traycer/protocol/host/epic/artifact-subscribe";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";
import { encodeDocStateVectorBase64 } from "@/stores/epics/open-epic/runtime/dirty-watermark";
import { setDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import type {
  DesktopOwnershipClaimResult,
  DesktopOwnershipEntry,
  DesktopPerWindowStatePatch,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import {
  clearSessionCreatedEpics,
  markEpicCreatedThisSession,
} from "@/lib/epics/session-created-epics";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import { updateEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import { cloudQueryKeys } from "@/lib/query-keys";
import { ESTABLISHING_DEADLINE_MS } from "@/lib/host/bounded-load-budgets";

// ── Mocks needed only by the React mount test ───────────────────────────────
// `TestEpicSessionTab` renders the real `<EpicSessionProvider>`, which reads
// `useNavigate()` and (through `useHostClientForHostId`) `useHostClient()` /
// `useHostBinding()` - all of which throw outside their real providers. Every
// OTHER test in this file drives the controller directly and never mounts
// anything, so these mocks are inert for them.
const authServiceStub = vi.hoisted(() => ({
  revalidateCurrentContext: vi.fn(() =>
    Promise.resolve({ kind: "valid" as const }),
  ),
}));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => null,
  useAuthService: () => authServiceStub,
}));

function resetCanvasStore(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

function resetAuth(
  status: "signed-out" | "signed-in",
  email: string | null,
): void {
  if (status === "signed-in" && email !== null) {
    useAuthStore.setState({
      status,
      profile: { userId: email, userName: email, email },
      contextMetadata: { userId: email, username: email },
    });
    return;
  }
  useAuthStore.setState({ status, profile: null, contextMetadata: null });
}

function createTestHostClient(
  hostId: string,
  taskCalls: string[],
): HostClient<HostRpcRegistry> {
  const hostEntry = { ...mockLocalHostEntry, hostId };
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `request-${hostId}`,
    handlers: {
      "epic.listTasks": () => {
        taskCalls.push(hostId);
        return { tasks: [], hasMore: false };
      },
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    messenger,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (candidateHostId) =>
      candidateHostId === hostId ? hostEntry : null,
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "test" }),
  );
  return client.createRequester(hostEntry);
}

function unauthorizedEpicClose(doorReason: string | null): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "test host refusal",
      incompatibleMethods: null,
      upgradeGuidance: null,
      ...(doorReason === null ? {} : { doorReason }),
    },
  };
}

interface ControlledEpicStream {
  closeCount: number;
  readonly callbacks: EpicStreamCallbacks;
}

function snapshotMeta(roomId: string): SnapshotMetaEpic {
  return {
    schemaVersion: "2.0.0",
    roomId,
    epicLight: null,
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

function permissionChangedLaneFrame(
  authorityEpoch: string,
  securityEpoch: number,
  permissionRole: "owner" | null,
) {
  const frame = epicStatusSubscribeServerFrameSchemaV11.parse({
    kind: "permissionChanged",
    hasBinaryPayload: false,
    authorityEpoch,
    securityEpoch,
    permissionRole,
  });
  if (frame.kind !== "permissionChanged") {
    throw new Error("expected permission change frame");
  }
  return frame;
}

function poolStateSnapshotWithArtifact(
  authorityEpoch: string,
  title: string,
  artifactId: string,
) {
  const frame = epicStateSubscribeServerFrameSchemaV11.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    basis: "cold",
    authorityEpoch,
    position: 0,
    reconciledWithCloud: false,
    epicMeta: { revision: 0, meta: { title, updatedAt: 1000 } },
    artifactRecords: [
      {
        kind: "spec",
        id: artifactId,
        folderName: `${artifactId}-folder`,
        title: "Task body",
        createdAt: 1000,
        updatedAt: 1000,
        createdManually: true,
        parentId: null,
        revision: 1,
      },
    ],
    deletedArtifacts: [],
    roleClaims: { revision: 0, claims: [] },
    commentThreads: [],
  });
  if (frame.kind !== "snapshot") throw new Error("expected state snapshot");
  return frame;
}

function deliverArtifactDoc(
  lane: CapturedPoolBodyLane,
  authorityEpoch: string,
  docGuid: string,
  doc: Y.Doc,
): void {
  const frame = artifactSubscribeServerFrameSchemaV13.parse({
    kind: "doc",
    hasBinaryPayload: true,
    authorityEpoch,
    artifactId: lane.artifactId,
    docGuid,
    stateVectorBase64: encodeDocStateVectorBase64(doc),
  });
  if (frame.kind !== "doc") throw new Error("expected artifact doc frame");
  lane.callbacks.onDoc(frame, Y.encodeStateAsUpdate(doc));
}

function deliverArtifactDocAck(
  lane: CapturedPoolBodyLane,
  authorityEpoch: string,
  docGuid: string,
  coverageStateVectorBase64: string,
): void {
  const frame = artifactSubscribeServerFrameSchemaV13.parse({
    kind: "docAck",
    hasBinaryPayload: false,
    authorityEpoch,
    artifactId: lane.artifactId,
    docGuid,
    coverageStateVectorBase64,
  });
  if (frame.kind !== "docAck")
    throw new Error("expected artifact coverage frame");
  lane.callbacks.onDocAck(frame);
}

function deliverArtifactDocUpdate(
  lane: CapturedPoolBodyLane,
  authorityEpoch: string,
  docGuid: string,
  update: Uint8Array,
): void {
  const frame = artifactSubscribeServerFrameSchemaV13.parse({
    kind: "docUpdate",
    hasBinaryPayload: true,
    authorityEpoch,
    artifactId: lane.artifactId,
    docGuid,
  });
  if (frame.kind !== "docUpdate") {
    throw new Error("expected artifact body update frame");
  }
  lane.callbacks.onDocUpdate(frame, update);
}

function reportBodyMoved(
  lane: CapturedPoolBodyLane,
  authorityEpoch: string,
): void {
  const frame = artifactSubscribeServerFrameSchemaV12.parse({
    kind: "unavailable",
    hasBinaryPayload: false,
    authorityEpoch,
    artifactId: lane.artifactId,
    code: "bodyMoved",
    reason: "the task body moved to a new document",
    terminal: true,
  });
  if (frame.kind !== "unavailable")
    throw new Error("expected body movement frame");
  lane.callbacks.onUnavailable(frame);
}

/**
 * The two facts that make a session an AUTHORITY for its write-throughs
 * (`isEpicSessionLive`): a session that is not live stays attached and writes
 * nothing, so a fixture that injects state straight into the store has to say
 * the session is live, exactly as a fixture that drives a stream has to open it.
 */
const LIVE_SESSION = {
  snapshotLoaded: true,
  hostTransportStatus: "open",
} as const;

function deliverSnapshot(stream: ControlledEpicStream, roomId: string): void {
  // Open first, as a real stream does: the snapshot arrives on an open
  // transport, and the write-throughs and the metadata hold both wait for it.
  stream.callbacks.onConnectionStatus("open", null, false, null);
  stream.callbacks.onSnapshot(snapshotMeta(roomId), new Uint8Array([0, 0]));
}

/**
 * Seed a LOCAL root edit without reaching for a `Y.Doc` directly on the
 * handle - it lives on the worker thread, so `applyRootUpdate` is the surface
 * production itself writes through. Mirrors
 * `epic-session-provider.test.tsx`'s helper of the same name.
 */
async function seedLocalRootEdit(
  handle: OpenEpicStoreHandle,
  key: string,
  value: string,
): Promise<void> {
  const donor = new Y.Doc();
  donor.getMap("epic").set(key, value);
  await handle.applyRootUpdate(Y.encodeStateAsUpdate(donor), true);
  donor.destroy();
}

/**
 * Installs a REAL, in-process runtime worker (a genuine document core) with a
 * legacy stream client this test can drive by hand - needed only by the tests
 * that must observe an actual `epic.title` land in the store. Every entry this
 * factory serves records its `ControlledEpicStream` in `streams`, in
 * construction order.
 */
function installLegacyStreamFactory(streams: ControlledEpicStream[]): void {
  const factory: EpicStreamClientFactory = (_epicId, callbacks) => {
    const stream: ControlledEpicStream = { closeCount: 0, callbacks };
    streams.push(stream);
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => {
        stream.closeCount += 1;
      },
    };
  };
  __setEpicRuntimeWorkerFactoryForTests(() =>
    createInProcessEpicRuntimeWorker({
      streamClientFactory: factory,
      laneSelection: null,
    }).createWorker(),
  );
}

function installPoolStatusLaneFactory(
  onStatusCallbacks: (callbacks: EpicStatusStreamCallbacks) => void,
  onStateCallbacks: (callbacks: EpicStateStreamCallbacks) => void,
  legacyOpenEpicIds: string[],
): void {
  const streamClientFactory: EpicStreamClientFactory = (epicId) => {
    legacyOpenEpicIds.push(epicId);
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const stateStreamClientFactory: EpicStateStreamClientFactory = (
    _epicId,
    callbacks,
  ) => {
    onStateCallbacks(callbacks);
    return { close: () => undefined };
  };
  const statusStreamClientFactory: EpicStatusStreamClientFactory = (
    _epicId,
    callbacks,
  ) => {
    onStatusCallbacks(callbacks);
    return { close: () => undefined };
  };
  const artifactStreamClientFactory: ArtifactStreamClientFactory = () => ({
    applyUpdate: () => undefined,
    awareness: () => undefined,
    close: () => undefined,
  });
  const laneSelection: EpicLaneSelectionSources = {
    support: () => "supported",
    subscribeSupport: () => () => undefined,
    stateStreamClientFactory,
    statusStreamClientFactory,
    artifactStreamClientFactory,
    unaries: absentLaneUnaries(),
  };
  const factories: EpicRuntimeStreamFactories = {
    streamClientFactory,
    laneSelection,
  };
  __setEpicRuntimeWorkerFactoryForTests(() =>
    createInProcessEpicRuntimeWorker(factories).createWorker(),
  );
}

interface RealPoolEndpointRig {
  readonly transports: PoolTransportForTest[];
  readonly workers: InProcessEpicRuntimeWorker[];
}

function installRealPoolEndpointEnvironment(
  endpoint: FakePoolEndpoint,
  resolveHostClient:
    | ((hostId: string) => HostClient<HostRpcRegistry> | null)
    | null,
): RealPoolEndpointRig {
  const transports: PoolTransportForTest[] = [];
  const workers: InProcessEpicRuntimeWorker[] = [];
  const bearerSource = {
    identity: { userId: "pool-t8-test-user" },
    getBearerToken: () => "pool-t8-test-bearer",
  };
  const bearer = () => bearerSource;
  installTestEpicSessionEnvironment({
    ...defaultTestEpicSessionEnvironment(),
    resolveHostClient: resolveHostClient ?? (() => null),
    openTransport: (hostId) => {
      if (hostId !== POOL_HOST_ID) {
        return fakeDurableStreamTransports().opener(hostId);
      }
      const transport = endpoint.openTransport("pool-t8-test-user", bearer);
      transports.push(transport);
      return transport.durableTransport;
    },
  });
  __setEpicRuntimeWorkerFactoryForTests(() => {
    const worker = createProxiedInProcessEpicRuntimeWorker();
    workers.push(worker);
    return worker.createWorker();
  });
  return { transports, workers };
}

function taskSubscription(
  socket: PoolEndpointSocket,
  method: "epic.status.subscribe" | "epic.state.subscribe",
  occurrence: number,
): { readonly streamId: number } {
  const subscription = socket.subscriptions
    .filter((candidate) => candidate.method === method)
    .at(occurrence);
  if (subscription === undefined) {
    throw new Error(`expected the ${method} wire subscription`);
  }
  return subscription;
}

function refusePoolTaskOpen(
  socket: PoolEndpointSocket,
  status: { readonly streamId: number },
): void {
  act(() => {
    socket.sendFatal(status.streamId, {
      code: "EPIC_NOT_FOUND",
      reason: "The task could not be opened in the cloud",
      retryable: false,
      incompatibleMethods: null,
      upgradeGuidance: null,
    });
  });
}

/** A no-op canvas-store write that still notifies every subscriber. */
function pokeCanvasStoreNoOp(): void {
  useEpicCanvasStore.setState((state) => ({ ...state }));
}

/** Flips the effective host away and back - every input `requestReconcileAll` wakes. */
function pokeSelectionAuthority(): void {
  setTestEffectiveHost("host-b", true);
  setTestEffectiveHost("host-a", true);
}

/**
 * A genuine no-op selection-authority notification: same `effectiveHostId`,
 * same `attached`, so `requestReconcileAll` wakes every entry but no entry's
 * run key can change. Unlike `pokeSelectionAuthority`, which legitimately
 * moves the target host (and so legitimately restarts a NOT-suspended run),
 * this is the poke a "notifications alone add no attempts" assertion needs.
 */
function pokeSelectionAuthorityNoOp(): void {
  useSelectionAuthorityStore.setState((state) => ({ ...state }));
}

type DesktopOwnershipClaimForTests = (
  tabId: string,
  epicId: string,
) => Promise<DesktopOwnershipClaimResult>;

interface TestDesktopBridgeCalls {
  readonly claims: Array<{ readonly tabId: string; readonly epicId: string }>;
  readonly releases: string[];
  readonly focusRequests: string[];
}

/**
 * A minimal `DesktopWindowsBridge` whose `ownership.claim` is supplied by the
 * caller, so a test can control exactly when (and how) a claim resolves. Only
 * the members the controller actually reads are made to do anything; the rest
 * satisfy the interface inertly.
 */
function createTestDesktopBridge(
  calls: TestDesktopBridgeCalls,
  claim: DesktopOwnershipClaimForTests,
): DesktopWindowsBridge {
  // STATEFUL, unlike an unconditional `[]`: a granted claim records an entry,
  // a release removes it, and `snapshot()` reports the current set. This is
  // what the registry's release listener
  // (`releaseDesktopEpicOwnershipForEpic` in
  // `@/lib/windows/desktop-epic-ownership`) reads to release every entry for
  // an evicted/disposed epic - an unconditional `[]` here silently defeated
  // that release path for every suite in this file, because `snapshot()`
  // never reported the grant that a cap eviction or a sign-out needed to walk.
  const records = new Map<string, DesktopOwnershipEntry>();
  return {
    windowId: "window-under-test",
    list: () => Promise.resolve([]),
    onChange: () => ({ dispose: () => undefined }),
    requestNew: () => Promise.resolve(),
    requestFocus: (windowId) => {
      calls.focusRequests.push(windowId);
      return Promise.resolve();
    },
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: () =>
      Promise.resolve({
        result: "moved" as const,
        windowId: "window-elsewhere",
      }),
    ownership: {
      snapshot: () => Promise.resolve(Array.from(records.values())),
      claim: (tabId, epicId) => {
        calls.claims.push({ tabId, epicId });
        return claim(tabId, epicId).then((result) => {
          if (result.ok) {
            records.set(tabId, {
              tabId,
              epicId,
              windowId: "window-under-test",
            });
          }
          return result;
        });
      },
      release: (tabId) => {
        calls.releases.push(tabId);
        records.delete(tabId);
        return Promise.resolve();
      },
      onChange: () => ({ dispose: () => undefined }),
    },
    perWindowState: {
      get: () =>
        Promise.resolve({
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        }),
      update: (_patch: DesktopPerWindowStatePatch) => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    authSession: {
      get: () =>
        Promise.resolve({
          status: "signed-out" as const,
          token: null,
          profile: null,
        }),
      set: () => Promise.resolve({ outcome: "accepted" as const }),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
}

function PresentationProbe(props: {
  onPresentation: (presentation: EpicSessionPresentation | null) => void;
}) {
  const { onPresentation } = props;
  const presentation = use(EpicSessionPresentationContext);
  useEffect(() => {
    onPresentation(presentation);
  }, [onPresentation, presentation]);
  return null;
}

describe("EpicSessionController: session lifecycle with no surface mounted", () => {
  let previousWorkerFactory: (() => RuntimeWorkerLike) | null = null;
  let constructionCount = 0;

  beforeEach(() => {
    window.localStorage.clear();
    __getOpenEpicRegistryForTests().disposeAll();
    __resetEpicParkingForTests();
    __setAgentActivityPlaneAnsweringForTests();
    resetFakeDurableStreamTransports();
    installTestEpicSessionEnvironment(defaultTestEpicSessionEnvironment());
    setTestEffectiveHost("host-a", true);

    previousWorkerFactory = getEpicRuntimeWorkerFactoryOverride();
    constructionCount = 0;
    __setEpicRuntimeWorkerFactoryForTests(() => {
      constructionCount += 1;
      if (previousWorkerFactory === null) {
        throw new Error("expected the setup worker factory to be installed");
      }
      return previousWorkerFactory();
    });
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    resetCanvasStore();
    __resetEpicParkingForTests();
    __resetAgentActivityStoreForTests();
    useSelectionAuthorityStore.getState().reset();
    __setEpicRuntimeWorkerFactoryForTests(previousWorkerFactory);
    setDesktopEpicOwnershipBridge(null);
    resetAuth("signed-out", null);
    vi.useRealTimers();
  });

  it("swap without activate: an unnamed tab opened in the background acquires a session with no provider mounted", () => {
    const EPIC_ID = "epic-swap-no-activate";
    const controller = getEpicSessionController();

    useEpicCanvasStore.getState().openEpicTabInBackground(EPIC_ID, "");
    __syncEpicParkingOpenTabsForTests();

    const tabId = useEpicCanvasStore
      .getState()
      .openTabOrder.find(
        (id) => useEpicCanvasStore.getState().tabsById[id]?.epicId === EPIC_ID,
      );
    expect(tabId).not.toBeUndefined();
    expect(useEpicCanvasStore.getState().tabsById[tabId ?? ""]?.name).toBe("");

    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBeNull();
    expect(fakeDurableStreamTransports().records).toHaveLength(1);

    const status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status).not.toBeNull();
    expect(status?.hasSession).toBe(true);
    expect(status?.demandHeld).toBe(true);
    expect(status?.metadataHold).toBe(true);
    expect(status?.suspended).toBe(false);
  });

  it.each(["enrolment_broken", "host_claimed", null] as const)(
    "does not revalidate sign-in when host-token epic closes (%s)",
    async (doorReason) => {
      const streams: ControlledEpicStream[] = [];
      const revalidateAuth = vi.fn();
      installLegacyStreamFactory(streams);
      installTestEpicSessionEnvironment({
        ...defaultTestEpicSessionEnvironment(),
        revalidateAuth,
      });
      openTestEpicTab("tab-host-token-close", "epic-host-token-close", "");
      await waitFor(() => expect(streams).toHaveLength(1));
      const stream = streams.at(0);
      if (stream === undefined) throw new Error("expected an epic stream");

      act(() => {
        stream.callbacks.onConnectionStatus(
          "closed",
          unauthorizedEpicClose(doorReason),
          false,
          null,
        );
      });

      expect(revalidateAuth).not.toHaveBeenCalled();
    },
  );

  it("still revalidates sign-in when the pool status lane closes unauthorized", async () => {
    const statusCapture: { callbacks: EpicStatusStreamCallbacks | null } = {
      callbacks: null,
    };
    const legacyOpenEpicIds: string[] = [];
    const revalidateAuth = vi.fn();
    installPoolStatusLaneFactory(
      (callbacks) => {
        statusCapture.callbacks = callbacks;
      },
      () => undefined,
      legacyOpenEpicIds,
    );
    installTestEpicSessionEnvironment({
      ...defaultTestEpicSessionEnvironment(),
      revalidateAuth,
    });
    setTestEffectiveHost(POOL_HOST_ID, true);
    openTestEpicTab("tab-pool-close", "epic-pool-close", "");
    await waitFor(() => expect(statusCapture.callbacks).not.toBeNull());
    const callbacks = statusCapture.callbacks;
    assertTestFixture(callbacks, "expected the pool status lane");

    act(() => {
      callbacks.onConnectionStatus(
        "closed",
        unauthorizedEpicClose(null),
        null,
        null,
      );
    });

    expect(revalidateAuth).toHaveBeenCalledTimes(1);
    expect(legacyOpenEpicIds).toEqual([]);
  });

  it("keeps the computer task published until a complete pool status and task snapshot, then follows a returning computer", async () => {
    const controller = getEpicSessionController();
    const registry = __getOpenEpicRegistryForTests();
    const legacyOpenEpicIds: string[] = [];
    const computerStreams: ControlledEpicStream[] = [];
    installLegacyStreamFactory(computerStreams);
    openTestEpicTab("tab-pool-repoint", "epic-pool-repoint", "");
    controller.attachSurface("epic-pool-repoint", "tab-pool-repoint");
    await waitFor(() => expect(computerStreams).toHaveLength(1));
    const initialComputerStream = computerStreams[0];
    act(() => deliverSnapshot(initialComputerStream, "computer-room"));
    const initialComputerHandle = registry.peek("epic-pool-repoint");
    assertTestFixture(
      initialComputerHandle,
      "expected initial computer task handle",
    );

    const poolCallbacks: {
      status: EpicStatusStreamCallbacks | null;
      state: EpicStateStreamCallbacks | null;
    } = { status: null, state: null };
    installPoolStatusLaneFactory(
      (callbacks) => {
        poolCallbacks.status = callbacks;
      },
      (callbacks) => {
        poolCallbacks.state = callbacks;
      },
      legacyOpenEpicIds,
    );
    setTestEffectiveHost(POOL_HOST_ID, true);
    await waitFor(() => {
      expect(poolCallbacks.status).not.toBeNull();
      expect(poolCallbacks.state).not.toBeNull();
    });
    expect(registry.peek("epic-pool-repoint")).toBe(initialComputerHandle);
    expect(
      controller.readTabSnapshot("epic-pool-repoint", "tab-pool-repoint")
        .presentation.kind,
    ).toBe("establishing");

    const poolStatus = poolCallbacks.status;
    const poolState = poolCallbacks.state;
    if (poolStatus === null || poolState === null) {
      throw new Error("expected the pool task lanes");
    }
    act(() => {
      poolStatus.onConnectionStatus("open", null, null, null);
      poolState.onConnectionStatus("open", null, null, null);
      poolStatus.onSnapshot(statusLaneSnapshot("pool-epoch-1"), true);
    });
    expect(registry.peek("epic-pool-repoint")).toBe(initialComputerHandle);
    act(() => {
      poolState.onSnapshot(stateLaneSnapshot("pool-epoch-1", "Pool task"));
    });
    await waitFor(() => {
      const current = registry.peek("epic-pool-repoint");
      expect(current).not.toBeNull();
      expect(current).not.toBe(initialComputerHandle);
    });
    const poolHandle = registry.peek("epic-pool-repoint");
    assertTestFixture(poolHandle, "expected pool task handle");
    expect(
      controller.readTabSnapshot("epic-pool-repoint", "tab-pool-repoint")
        .handle,
    ).toBe(poolHandle);
    expect(legacyOpenEpicIds).toEqual([]);

    const returningLegacyStreams: ControlledEpicStream[] = [];
    installLegacyStreamFactory(returningLegacyStreams);
    setTestEffectiveHost("host-b", true);
    await waitFor(() => expect(returningLegacyStreams).toHaveLength(1));
    const returningComputerStream = returningLegacyStreams[0];
    act(() => deliverSnapshot(returningComputerStream, "computer-room-2"));
    await waitFor(() => {
      const current = registry.peek("epic-pool-repoint");
      expect(current).not.toBeNull();
      expect(current).not.toBe(poolHandle);
    });
    expect(
      controller.readTabSnapshot("epic-pool-repoint", "tab-pool-repoint")
        .sessionHostId,
    ).toBe("host-b");
    expect(legacyOpenEpicIds).toEqual([]);
  });

  it.each([
    {
      name: "last computer",
      createHostId: "host-a",
      initialServingHostId: "host-a",
      nextServingHostId: POOL_HOST_ID,
    },
    {
      name: "team sandbox while pool serves the app",
      createHostId: "host-team",
      initialServingHostId: POOL_HOST_ID,
      nextServingHostId: "host-b",
    },
  ])(
    "retires the $name create seed on the next serving peer move",
    async ({ createHostId, initialServingHostId, nextServingHostId }) => {
      const EPIC_ID = `epic-created-on-${createHostId}`;
      const TAB_ID = `tab-created-on-${createHostId}`;
      const controller = getEpicSessionController();
      const registry = __getOpenEpicRegistryForTests();
      const spy = installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST);
      clearSessionCreatedEpics();
      markEpicCreatedThisSession(EPIC_ID, createHostId);
      setTestEffectiveHost(initialServingHostId, true);
      openTestEpicTab(TAB_ID, EPIC_ID, "Created task");
      controller.attachSurface(EPIC_ID, TAB_ID);

      try {
        await waitFor(() => expect(spy.sessions).toHaveLength(1));
        const seededSession = spy.sessions.at(0);
        assertPoolTaskLanes(
          seededSession,
          "expected the create-host task lanes",
        );
        expect(
          controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.targetHostId,
        ).toBe(createHostId);
        expect(
          fakeDurableStreamTransports().records.map((record) => record.hostId),
        ).toEqual([createHostId]);
        act(() => {
          seededSession.status.onConnectionStatus("open", null, null, null);
          seededSession.state.onConnectionStatus("open", null, null, null);
          seededSession.status.onSnapshot(
            statusLaneSnapshot("seed-epoch"),
            true,
          );
          seededSession.state.onSnapshot(
            stateLaneSnapshot("seed-epoch", "Created task"),
          );
        });
        await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
        const seededHandle = registry.peek(EPIC_ID);
        assertTestFixture(seededHandle, "expected the create-host handle");

        setTestEffectiveHost(nextServingHostId, true);
        await waitFor(() => expect(spy.sessions).toHaveLength(2));
        const successor = spy.sessions.at(1);
        assertPoolTaskLanes(
          successor,
          "expected a session on the moved serving peer",
        );
        expect(
          controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.targetHostId,
        ).toBe(nextServingHostId);
        expect(
          fakeDurableStreamTransports().records.map((record) => record.hostId),
        ).toEqual([createHostId, nextServingHostId]);
        expect(registry.peek(EPIC_ID)).toBe(seededHandle);
        act(() => {
          successor.status.onConnectionStatus("open", null, null, null);
          successor.state.onConnectionStatus("open", null, null, null);
          successor.status.onSnapshot(
            statusLaneSnapshot("successor-epoch"),
            true,
          );
          successor.state.onSnapshot(
            stateLaneSnapshot("successor-epoch", "Created task"),
          );
        });
        await waitFor(() => {
          const current = registry.peek(EPIC_ID);
          expect(current).not.toBeNull();
          expect(current).not.toBe(seededHandle);
        });
        expect(controller.readTabSnapshot(EPIC_ID, TAB_ID).sessionHostId).toBe(
          nextServingHostId,
        );
      } finally {
        clearSessionCreatedEpics();
      }
    },
  );

  it("waits on an unknown pool manifest, then opens all three real task lanes", async () => {
    const EPIC_ID = "epic-pool-manifest-gate";
    const TAB_ID = "tab-pool-manifest-gate";
    const controller = getEpicSessionController();
    const registry = __getOpenEpicRegistryForTests();
    const endpoint = new FakePoolEndpoint("wss://pool-t8.test/manifest-gate", {
      omittedStreamMethods: [],
      acknowledgeOpen: false,
    });
    const rig = installRealPoolEndpointEnvironment(endpoint, null);
    setTestEffectiveHost(POOL_HOST_ID, true);
    openTestEpicTab(TAB_ID, EPIC_ID, "");
    controller.attachSurface(EPIC_ID, TAB_ID);
    await waitFor(() => expect(endpoint.sockets).toHaveLength(1));
    const socket = endpoint.sockets.at(0);
    assertTestFixture(socket, "expected the pool manifest socket");
    const transport = rig.transports.at(0);
    assertTestFixture(transport, "expected the acquired pool transport");
    const worker = rig.workers.at(0);
    assertTestFixture(worker, "expected the proxied runtime worker");
    await worker.flush();
    expect(
      transport.remoteTransport.streamClient.getMethodSupport(
        "epic.status.subscribe",
      ),
    ).toBe("unknown");
    expect(
      transport.remoteTransport.streamClient.getMethodSupport(
        "epic.state.subscribe",
      ),
    ).toBe("unknown");
    expect(
      transport.remoteTransport.streamClient.getMethodSupport(
        "artifact.subscribe",
      ),
    ).toBe("unknown");
    expect(socket.subscriptions).toEqual([]);
    expect(controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind).toBe(
      "establishing",
    );
    expect(socket.subscriptions.map(({ method }) => method)).not.toContain(
      "epic.subscribe",
    );

    endpoint.setAcknowledgeOpen(true);
    socket.sendOpenAck();
    await waitFor(() => {
      expect(socket.subscriptions.map((stream) => stream.method)).toEqual(
        expect.arrayContaining([
          "epic.status.subscribe",
          "epic.state.subscribe",
        ]),
      );
    });
    expect(
      transport.remoteTransport.streamClient.getMethodSupport(
        "epic.status.subscribe",
      ),
    ).toBe("supported");
    expect(
      transport.remoteTransport.streamClient.getMethodSupport(
        "epic.state.subscribe",
      ),
    ).toBe("supported");
    expect(
      transport.remoteTransport.streamClient.getMethodSupport(
        "artifact.subscribe",
      ),
    ).toBe("supported");
    sendPoolTaskSnapshots(socket, "manifest-epoch", "Manifest task");
    await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
    const handle = registry.peek(EPIC_ID);
    assertTestFixture(handle, "expected the real proxied task handle");
    const releaseBody = handle.store
      .getState()
      .acquireArtifactBodyLease("manifest-artifact");
    await waitFor(() => {
      expect(socket.subscriptions.map((stream) => stream.method)).toContain(
        "artifact.subscribe",
      );
    });
    expect(socket.subscriptions.map((stream) => stream.method)).toEqual(
      expect.arrayContaining([
        "epic.status.subscribe",
        "epic.state.subscribe",
        "artifact.subscribe",
      ]),
    );
    expect(socket.subscriptions.map((stream) => stream.method)).not.toContain(
      "epic.subscribe",
    );
    expect(controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind).toBe(
      "ready",
    );
    releaseBody();
  });

  it.each([
    {
      label: "artifact only",
      id: "artifact-only",
      omittedStreamMethods: ["artifact.subscribe"],
      expectedStateSupport: "supported",
    },
    {
      label: "state and artifact",
      id: "state-and-artifact",
      omittedStreamMethods: ["epic.state.subscribe", "artifact.subscribe"],
      expectedStateSupport: "unsupported",
    },
  ] as const)(
    "fails an unpublished pool candidate when $label methods are absent",
    async ({ id, omittedStreamMethods, expectedStateSupport }) => {
      const EPIC_ID = `epic-pool-${id}-manifest`;
      const TAB_ID = `tab-pool-${id}-manifest`;
      const endpoint = new FakePoolEndpoint(
        `wss://pool-t8.test/${id}-manifest`,
        {
          omittedStreamMethods,
          acknowledgeOpen: true,
        },
      );
      const rig = installRealPoolEndpointEnvironment(endpoint, null);
      const controller = getEpicSessionController();
      setTestEffectiveHost(POOL_HOST_ID, true);
      openTestEpicTab(TAB_ID, EPIC_ID, "");
      controller.attachSurface(EPIC_ID, TAB_ID);

      await waitFor(() => {
        expect(
          controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
        ).toBe("failed");
      });
      expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBeNull();
      const transport = rig.transports.at(0);
      assertTestFixture(transport, "expected the partial-manifest transport");
      expect(
        transport.remoteTransport.streamClient.getMethodSupport(
          "epic.status.subscribe",
        ),
      ).toBe("supported");
      expect(
        transport.remoteTransport.streamClient.getMethodSupport(
          "epic.state.subscribe",
        ),
      ).toBe(expectedStateSupport);
      expect(
        transport.remoteTransport.streamClient.getMethodSupport(
          "artifact.subscribe",
        ),
      ).toBe("unsupported");
      const socket = endpoint.sockets.at(0);
      assertTestFixture(socket, "expected the partial-manifest socket");
      expect(socket.subscriptions).toEqual([]);
    },
  );

  it("closes a replayed pool status lane after a deficient pre-snapshot reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const EPIC_ID = "epic-pool-deficient-reconnect-before-snapshot";
    const TAB_ID = "tab-pool-deficient-reconnect-before-snapshot";
    const controller = getEpicSessionController();
    const registry = __getOpenEpicRegistryForTests();
    const computerStreams: ControlledEpicStream[] = [];
    const originalHostClient = createTestHostClient("host-a", []);
    installTestEpicSessionEnvironment({
      ...defaultTestEpicSessionEnvironment(),
      resolveHostClient: (hostId) =>
        hostId === "host-a" ? originalHostClient : null,
    });
    installLegacyStreamFactory(computerStreams);
    setTestEffectiveHost("host-a", true);
    openTestEpicTab(TAB_ID, EPIC_ID, "Loaded computer task");
    controller.attachSurface(EPIC_ID, TAB_ID);

    await waitFor(() => expect(computerStreams).toHaveLength(1));
    const computerStream = computerStreams.at(0);
    assertTestFixture(computerStream, "expected the loaded computer stream");
    act(() => deliverSnapshot(computerStream, "computer-room"));
    await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
    const outgoingHandle = registry.peek(EPIC_ID);
    assertTestFixture(outgoingHandle, "expected the loaded computer handle");
    const loadedComputer = controller.readTabSnapshot(EPIC_ID, TAB_ID);
    expect(loadedComputer.presentation.kind).toBe("ready");
    expect(loadedComputer.handle).toBe(outgoingHandle);
    expect(loadedComputer.sessionHostId).toBe("host-a");
    expect(loadedComputer.sessionHostClient).toBe(originalHostClient);
    const readHeldProjection = () => {
      const state = outgoingHandle.store.getState();
      return {
        permissionRole: state.permissionRole,
        roomId: state.snapshotMeta?.roomId ?? null,
        cloudSyncStatus: state.cloudSyncStatus,
        connectionStatus: state.connectionStatus,
      };
    };
    const heldProjectionBefore = readHeldProjection();
    expect(heldProjectionBefore.permissionRole).toBe("editor");
    expect(heldProjectionBefore.roomId).toBe("computer-room");
    const observedViews: Array<{
      registryHandle: OpenEpicStoreHandle | null;
      controllerHandle: OpenEpicStoreHandle | null;
      heldProjection: typeof heldProjectionBefore;
    }> = [];
    const observeView = () => {
      observedViews.push({
        registryHandle: registry.peek(EPIC_ID),
        controllerHandle: controller.readTabSnapshot(EPIC_ID, TAB_ID).handle,
        heldProjection: readHeldProjection(),
      });
    };
    const stopRegistryObservation = registry.subscribe(observeView);
    const stopControllerObservation = controller.subscribe(observeView);
    const stopHeldStoreObservation =
      outgoingHandle.store.subscribe(observeView);
    onTestFinished(() => {
      stopRegistryObservation();
      stopControllerObservation();
      stopHeldStoreObservation();
    });

    const endpoint = new FakePoolEndpoint(
      "wss://pool-t8.test/deficient-reconnect-before-snapshot",
      {
        omittedStreamMethods: [],
        omittedStreamMethodsByBackend: {
          "status-only": ["epic.state.subscribe", "artifact.subscribe"],
        },
        statusSnapshotsByBackend: {
          "status-only": statusLaneSnapshot("pool-deficient-sentinel-status"),
        },
        acknowledgeOpen: false,
        backendForPhysicalDial: (dialIndex) =>
          dialIndex === 0 ? "complete" : "status-only",
      },
    );
    const rig = installRealPoolEndpointEnvironment(endpoint, (hostId) =>
      hostId === "host-a" ? originalHostClient : null,
    );
    const poolCandidateStartedAt = Date.now();
    setTestEffectiveHost(POOL_HOST_ID, true);

    await waitFor(() => expect(endpoint.sockets).toHaveLength(1));
    const firstSocket = endpoint.sockets.at(0);
    assertTestFixture(firstSocket, "expected the first pool socket");
    expect(firstSocket.backendId).toBe("complete");
    await waitFor(() => expect(firstSocket.opens).toHaveLength(1));
    firstSocket.sendOpenAck();
    await waitFor(() => {
      expect(firstSocket.subscriptions.map(({ method }) => method)).toEqual(
        expect.arrayContaining([
          "epic.status.subscribe",
          "epic.state.subscribe",
        ]),
      );
    });
    const poolTransport = rig.transports.at(0);
    assertTestFixture(poolTransport, "expected the pool transport");
    expect(rig.transports).toHaveLength(1);
    expect(
      poolTransport.remoteTransport.streamClient.getMethodSupport(
        "epic.status.subscribe",
      ),
    ).toBe("supported");
    expect(
      poolTransport.remoteTransport.streamClient.getMethodSupport(
        "epic.state.subscribe",
      ),
    ).toBe("supported");
    expect(
      poolTransport.remoteTransport.streamClient.getMethodSupport(
        "artifact.subscribe",
      ),
    ).toBe("supported");
    expect(registry.peek(EPIC_ID)).toBe(outgoingHandle);
    expect(controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind).toBe(
      "establishing",
    );

    firstSocket.closeFromServer();
    expect(firstSocket.serverClosed).toBe(true);
    await waitFor(() => expect(endpoint.sockets).toHaveLength(2));
    const secondSocket = endpoint.sockets.at(1);
    assertTestFixture(secondSocket, "expected the reconnect socket");
    expect(secondSocket.backendId).toBe("status-only");
    await waitFor(() => expect(secondSocket.opens).toHaveLength(1));
    const recoveringView = controller.readTabSnapshot(EPIC_ID, TAB_ID);
    expect(recoveringView.presentation).toMatchObject({
      kind: "establishing",
      targetHostId: POOL_HOST_ID,
    });
    expect(recoveringView.handle).toBe(outgoingHandle);
    expect(registry.peek(EPIC_ID)).toBe(outgoingHandle);
    expect(recoveringView.sessionHostId).toBe("host-a");
    expect(recoveringView.sessionHostClient).toBe(originalHostClient);
    expect(Date.now() - poolCandidateStartedAt).toBeLessThan(
      ESTABLISHING_DEADLINE_MS,
    );

    secondSocket.sendOpenAck();
    await waitFor(() => {
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("failed");
    });
    expect(rig.transports).toHaveLength(1);
    expect(rig.workers).toHaveLength(1);
    expect(secondSocket.openAckStreamMethods).toHaveLength(1);
    expect(secondSocket.openAckStreamMethods.at(0)).toEqual(
      expect.arrayContaining(["epic.status.subscribe"]),
    );
    expect(secondSocket.openAckStreamMethods.at(0)).not.toContain(
      "epic.state.subscribe",
    );
    expect(secondSocket.openAckStreamMethods.at(0)).not.toContain(
      "artifact.subscribe",
    );
    const poolWorker = rig.workers.at(0);
    assertTestFixture(poolWorker, "expected the pool runtime worker");
    await poolWorker.flush();
    const failedView = controller.readTabSnapshot(EPIC_ID, TAB_ID);
    expect(Date.now() - poolCandidateStartedAt).toBeLessThan(
      ESTABLISHING_DEADLINE_MS,
    );
    expect(failedView.presentation).toMatchObject({
      kind: "failed",
      targetHostId: POOL_HOST_ID,
    });
    expect(failedView.handle).toBe(outgoingHandle);
    expect(registry.peek(EPIC_ID)).toBe(outgoingHandle);
    expect(failedView.sessionHostId).toBe("host-a");
    expect(failedView.sessionHostClient).toBe(originalHostClient);
    expect(
      secondSocket.subscriptions.map(({ method }) => method),
    ).not.toContain("epic.state.subscribe");
    expect(
      secondSocket.subscriptions.map(({ method }) => method),
    ).not.toContain("artifact.subscribe");
    expect(
      endpoint.sockets.flatMap((socket) =>
        socket.subscriptions.map(({ method }) => method),
      ),
    ).not.toContain("epic.subscribe");
    await waitFor(() => {
      for (const replay of secondSocket.subscriptions.filter(
        ({ method }) => method === "epic.status.subscribe",
      )) {
        expect(
          secondSocket.clientClosedStreamIds.includes(replay.streamId) ||
            secondSocket.clientSocketClosed ||
            secondSocket.serverClosed,
        ).toBe(true);
      }
    });
    expect(endpoint.sockets).toHaveLength(2);
    expect(observedViews.length).toBeGreaterThan(0);
    for (const observedView of observedViews) {
      expect(observedView.registryHandle).toBe(outgoingHandle);
      expect(observedView.controllerHandle).toBe(outgoingHandle);
      expect(observedView.heldProjection).toEqual(heldProjectionBefore);
    }
    expect(readHeldProjection()).toEqual(heldProjectionBefore);
  });

  it.each(["fresh", "held"] as const)(
    "keeps the pool's single establishing budget after a loss before the first snapshot (%s tab)",
    async (kind) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const EPIC_ID = `epic-pool-before-snapshot-${kind}`;
      const TAB_ID = `tab-pool-before-snapshot-${kind}`;
      const ARTIFACT_ID = "spec-held-pool-body";
      const controller = getEpicSessionController();
      const registry = __getOpenEpicRegistryForTests();
      const spy = installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST);
      const taskCalls: string[] = [];
      const originalHostClient = createTestHostClient("host-a", taskCalls);
      installTestEpicSessionEnvironment({
        ...defaultTestEpicSessionEnvironment(),
        resolveHostClient: (hostId) =>
          hostId === "host-a" ? originalHostClient : null,
      });

      let outgoingHandle: OpenEpicStoreHandle | null = null;
      let releaseOutgoingBody: (() => void) | null = null;
      if (kind === "held") {
        setTestEffectiveHost("host-a", true);
        openTestEpicTab(TAB_ID, EPIC_ID, "Held task");
        controller.attachSurface(EPIC_ID, TAB_ID);
        await waitFor(() => expect(spy.sessions).toHaveLength(1));
        const source = spy.sessions.at(0);
        assertPoolTaskLanes(
          source,
          "expected the outgoing computer task lanes",
        );
        act(() => {
          source.status.onConnectionStatus("open", null, null, null);
          source.state.onConnectionStatus("open", null, null, null);
          source.status.onSnapshot(statusLaneSnapshot("source-epoch"), true);
          source.state.onSnapshot(
            poolStateSnapshotWithArtifact(
              "source-epoch",
              "Held task",
              ARTIFACT_ID,
            ),
          );
        });
        await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
        outgoingHandle = registry.peek(EPIC_ID);
        assertTestFixture(outgoingHandle, "expected the outgoing task handle");
        releaseOutgoingBody = outgoingHandle.store
          .getState()
          .acquireArtifactBodyLease(ARTIFACT_ID);
        await waitFor(() => expect(source.bodyLanes).toHaveLength(1));
        const bodyLane = source.bodyLanes.at(0);
        assertTestFixture(bodyLane, "expected the computer body lane");
        const body = new Y.Doc();
        body
          .getXmlFragment(artifactBodyFragmentName(ARTIFACT_ID))
          .insert(0, [new Y.XmlText("computer body")]);
        deliverArtifactDoc(bodyLane, "source-epoch", "source-guid", body);
        body.destroy();
        await waitFor(() => {
          expect(
            outgoingHandle?.store
              .getState()
              .getArtifactBodyAvailability(ARTIFACT_ID),
          ).toBe("ready");
        });
        expect(
          controller.readTabSnapshot(EPIC_ID, TAB_ID).sessionHostClient,
        ).toBe(originalHostClient);
        setTestEffectiveHost(POOL_HOST_ID, true);
      } else {
        setTestEffectiveHost(POOL_HOST_ID, true);
        openTestEpicTab(TAB_ID, EPIC_ID, "Fresh task");
        controller.attachSurface(EPIC_ID, TAB_ID);
      }

      const expectedSessionCount = kind === "held" ? 2 : 1;
      await waitFor(() =>
        expect(spy.sessions).toHaveLength(expectedSessionCount),
      );
      const pending = spy.sessions.at(-1);
      assertPoolTaskLanes(pending, "expected the pending pool task lanes");
      act(() => {
        pending.status.onConnectionStatus("open", null, null, null);
        pending.state.onConnectionStatus("open", null, null, null);
        pending.status.onConnectionStatus("closed", null, null, null);
        pending.state.onConnectionStatus("closed", null, null, null);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ESTABLISHING_DEADLINE_MS);
      });
      await waitFor(() => {
        expect(
          controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
        ).toBe("failed");
      });
      const failed = controller.readTabSnapshot(EPIC_ID, TAB_ID);
      expect(failed.presentation.targetHostId).toBe(POOL_HOST_ID);
      expect(failed.presentation.originalHostId).toBe(
        kind === "held" ? "host-a" : null,
      );
      expect(failed.handle).toBe(outgoingHandle);
      expect(registry.peek(EPIC_ID)).toBe(outgoingHandle);
      if (kind === "held") {
        assertTestFixture(outgoingHandle, "expected the held task handle");
        expect(failed.sessionHostId).toBe("host-a");
        expect(failed.sessionHostClient).toBe(originalHostClient);
        expect(
          outgoingHandle.store
            .getState()
            .getArtifactFragment(ARTIFACT_ID)
            ?.toJSON(),
        ).toBe("computer body");
        expect(
          outgoingHandle.store
            .getState()
            .getArtifactBodyAvailability(ARTIFACT_ID),
        ).toBe("ready");
        releaseOutgoingBody?.();
        controller.openOnOriginalHost(EPIC_ID);
        await waitFor(() => {
          expect(controller.readEpicHostId(EPIC_ID)).toBe("host-a");
          expect(
            controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
          ).toBe("ready");
        });
        setTestEffectiveHost("host-b", true);
        expect(controller.readEpicHostId(EPIC_ID)).toBe("host-a");
        expect(
          controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.targetHostId,
        ).toBe("host-a");
        const pinnedClient = controller.readTabSnapshot(
          EPIC_ID,
          TAB_ID,
        ).sessionHostClient;
        expect(pinnedClient).toBe(originalHostClient);
        await pinnedClient?.request("epic.listTasks", LIST_CLOUD_TASKS_REQUEST);
        expect(taskCalls).toEqual(["host-a"]);
        expect(
          fakeDurableStreamTransports().records.map((record) => record.hostId),
        ).not.toContain("host-b");
      } else {
        expect(failed.handle).toBeNull();
        controller.retry(EPIC_ID);
        await waitFor(() =>
          expect(spy.sessions.length).toBeGreaterThan(expectedSessionCount),
        );
        const retrySession = spy.sessions.at(-1);
        assertPoolTaskLanes(retrySession, "expected retry task lanes");
        act(() => {
          retrySession.status.onConnectionStatus("open", null, null, null);
          retrySession.state.onConnectionStatus("open", null, null, null);
          retrySession.status.onSnapshot(
            statusLaneSnapshot("retry-epoch"),
            true,
          );
          retrySession.state.onSnapshot(
            stateLaneSnapshot("retry-epoch", "Recovered task"),
          );
        });
        await waitFor(() => {
          const recovered = registry.peek(EPIC_ID);
          expect(recovered).not.toBeNull();
          if (outgoingHandle !== null)
            expect(recovered).not.toBe(outgoingHandle);
        });
        expect(
          controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
        ).toBe("ready");
        expect(registry.retainedCountForTests(EPIC_ID)).toBe(0);
      }
      expect(spy.legacyOpenEpicIds).toEqual([]);
    },
  );

  it.each(["recover", "expire"] as const)(
    "keeps one pool candidate and its original deadline across a temporary servingPeer gap (%s)",
    async (outcome) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const EPIC_ID = `epic-pool-peer-gap-${outcome}`;
      const TAB_ID = `tab-pool-peer-gap-${outcome}`;
      const controller = getEpicSessionController();
      const registry = __getOpenEpicRegistryForTests();
      const spy = installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST);
      setTestEffectiveHost(POOL_HOST_ID, true);
      openTestEpicTab(TAB_ID, EPIC_ID, "Pool reconnect");
      controller.attachSurface(EPIC_ID, TAB_ID);
      await waitFor(() => expect(spy.sessions).toHaveLength(1));
      const candidate = spy.sessions.at(0);
      assertPoolTaskLanes(candidate, "expected initial pool task lanes");
      act(() => {
        candidate.status.onConnectionStatus("open", null, null, null);
        candidate.state.onConnectionStatus("open", null, null, null);
        candidate.status.onConnectionStatus("closed", null, null, null);
        candidate.state.onConnectionStatus("closed", null, null, null);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      setTestEffectiveHost(null, true);
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation,
      ).toMatchObject({
        kind: "establishing",
        targetHostId: POOL_HOST_ID,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      setTestEffectiveHost(POOL_HOST_ID, true);
      expect(spy.sessions).toHaveLength(1);
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("establishing");

      if (outcome === "expire") {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        await waitFor(() => {
          expect(
            controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
          ).toBe("failed");
        });
        expect(
          controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.targetHostId,
        ).toBe(POOL_HOST_ID);
        expect(registry.peek(EPIC_ID)).toBeNull();
        expect(spy.sessions).toHaveLength(1);
        return;
      }

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      act(() => {
        candidate.status.onConnectionStatus("open", null, null, null);
        candidate.state.onConnectionStatus("open", null, null, null);
        candidate.status.onSnapshot(
          statusLaneSnapshot("recovered-epoch"),
          true,
        );
        candidate.state.onSnapshot(
          stateLaneSnapshot("recovered-epoch", "Recovered pool task"),
        );
      });
      await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("ready");
      expect(spy.sessions).toHaveLength(1);
      expect(spy.legacyOpenEpicIds).toEqual([]);
    },
  );

  it("retries a task on one endpoint, then redistributes after its second refusal", async () => {
    const EPIC_ID = "epic-pool-capacity-second-endpoint";
    const TAB_ID = "tab-pool-capacity-second-endpoint";
    const endpoint = new FakePoolEndpoint(
      "wss://pool-t8.test/stable-capacity-url",
      {
        omittedStreamMethods: [],
        acknowledgeOpen: true,
        backendForPhysicalDial: (dialIndex) =>
          dialIndex === 0 ? "replica-a" : "replica-b",
      },
    );
    const rig = installRealPoolEndpointEnvironment(endpoint, null);
    const controller = getEpicSessionController();
    const registry = __getOpenEpicRegistryForTests();
    setTestEffectiveHost(POOL_HOST_ID, true);
    openTestEpicTab(TAB_ID, EPIC_ID, "Capacity task");
    controller.attachSurface(EPIC_ID, TAB_ID);

    await waitFor(() => {
      expect(endpoint.sockets).toHaveLength(1);
      expect(rig.transports.at(0)?.remoteTransport.session.isReady()).toBe(
        true,
      );
    });
    const negotiatedTransport = rig.transports.at(0);
    assertTestFixture(
      negotiatedTransport,
      "expected the acquired pool transport",
    );
    expect(
      negotiatedTransport.remoteTransport.streamClient.getMethodSupport(
        "epic.status.subscribe",
      ),
    ).toBe("supported");
    expect(
      negotiatedTransport.remoteTransport.streamClient.getMethodSupport(
        "epic.state.subscribe",
      ),
    ).toBe("supported");
    expect(
      negotiatedTransport.remoteTransport.streamClient.getMethodSupport(
        "artifact.subscribe",
      ),
    ).toBe("supported");
    const runtimeWorker = rig.workers.at(0);
    assertTestFixture(runtimeWorker, "expected the proxied runtime worker");
    await runtimeWorker.flush();
    await waitFor(() => {
      const socket = endpoint.sockets.at(0);
      assertTestFixture(socket, "expected the initial pool socket");
      expect(socket.subscriptions.map(({ method }) => method)).toEqual(
        expect.arrayContaining([
          "epic.status.subscribe",
          "epic.state.subscribe",
        ]),
      );
    });
    const firstSocket = endpoint.sockets.at(0);
    assertTestFixture(firstSocket, "expected the initial pool socket");
    expect(firstSocket.backendId).toBe("replica-a");
    refusePoolTaskOpen(
      firstSocket,
      taskSubscription(firstSocket, "epic.status.subscribe", 0),
    );
    await waitFor(() => {
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("failed");
    });
    expect(firstSocket.serverClosed).toBe(false);
    expect(firstSocket.clientCloseCount).toBe(0);
    expect(endpoint.sockets).toHaveLength(1);

    controller.retry(EPIC_ID);
    await waitFor(() => {
      expect(
        firstSocket.subscriptions.filter(
          ({ method }) => method === "epic.status.subscribe",
        ),
      ).toHaveLength(2);
      expect(
        firstSocket.subscriptions.filter(
          ({ method }) => method === "epic.state.subscribe",
        ),
      ).toHaveLength(2);
    });
    refusePoolTaskOpen(
      firstSocket,
      taskSubscription(firstSocket, "epic.status.subscribe", 1),
    );
    await waitFor(() => expect(endpoint.sockets).toHaveLength(2));
    const retrySocket = endpoint.sockets.at(1);
    assertTestFixture(retrySocket, "expected the forced-redial socket");
    await waitFor(() => {
      expect(retrySocket.opens).toHaveLength(1);
      expect(retrySocket.subscriptions.map(({ method }) => method)).toEqual(
        expect.arrayContaining([
          "epic.status.subscribe",
          "epic.state.subscribe",
        ]),
      );
    });
    expect(retrySocket.backendId).toBe("replica-b");
    expect(retrySocket.opens).toEqual([
      {
        bearer: "pool-t8-test-bearer",
        authzPresent: true,
        authz: null,
      },
    ]);
    const retrySocketFirstAttempt = endpoint.sendAttempts.indexOf(retrySocket);
    sendPoolTaskSnapshots(
      retrySocket,
      "capacity-recovered",
      "Capacity recovered",
    );
    await waitFor(() => {
      expect(registry.peek(EPIC_ID)).not.toBeNull();
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("ready");
    });
    expect(retrySocketFirstAttempt).toBeGreaterThanOrEqual(0);
    expect(endpoint.sendAttempts.lastIndexOf(firstSocket)).toBeLessThan(
      retrySocketFirstAttempt,
    );
    expect(firstSocket.clientSocketClosed).toBe(true);
    expect(endpoint.sockets).toHaveLength(2);
    expect(
      endpoint.sockets.flatMap((socket) =>
        socket.subscriptions.map(({ method }) => method),
      ),
    ).not.toContain("epic.subscribe");
  });

  it("re-subscribes on the same pool connection after capacity returns", async () => {
    const EPIC_ID = "epic-pool-capacity-returns";
    const TAB_ID = "tab-pool-capacity-returns";
    const endpoint = new FakePoolEndpoint(
      "wss://pool-t8.test/single-endpoint-capacity",
      { omittedStreamMethods: [], acknowledgeOpen: true },
    );
    installRealPoolEndpointEnvironment(endpoint, null);
    const controller = getEpicSessionController();
    const registry = __getOpenEpicRegistryForTests();
    setTestEffectiveHost(POOL_HOST_ID, true);
    openTestEpicTab(TAB_ID, EPIC_ID, "Capacity returns");
    controller.attachSurface(EPIC_ID, TAB_ID);
    await waitFor(() => {
      const socket = endpoint.sockets.at(0);
      assertTestFixture(socket, "expected the initial pool socket");
      expect(socket.subscriptions.map(({ method }) => method)).toEqual(
        expect.arrayContaining([
          "epic.status.subscribe",
          "epic.state.subscribe",
        ]),
      );
    });
    const recoveredSocket = endpoint.sockets.at(0);
    assertTestFixture(recoveredSocket, "expected the pool socket");
    refusePoolTaskOpen(
      recoveredSocket,
      taskSubscription(recoveredSocket, "epic.status.subscribe", 0),
    );
    await waitFor(() => {
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("failed");
    });
    expect(recoveredSocket.serverClosed).toBe(false);
    expect(recoveredSocket.clientCloseCount).toBe(0);

    controller.retry(EPIC_ID);
    await waitFor(() => {
      expect(
        recoveredSocket.subscriptions.filter(
          ({ method }) => method === "epic.status.subscribe",
        ),
      ).toHaveLength(2);
      expect(
        recoveredSocket.subscriptions.filter(
          ({ method }) => method === "epic.state.subscribe",
        ),
      ).toHaveLength(2);
    });
    expect(recoveredSocket.opens).toHaveLength(1);
    expect(recoveredSocket.backendId).toBe("pool-endpoint");
    sendPoolTaskSnapshots(
      recoveredSocket,
      "capacity-returned",
      "Capacity returned",
    );
    await waitFor(() => {
      expect(registry.peek(EPIC_ID)).not.toBeNull();
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("ready");
    });
    expect(endpoint.sockets).toHaveLength(1);
    expect(recoveredSocket.clientCloseCount).toBe(0);
  });

  it("limits a persistent task refusal to one physical redial", async () => {
    const EPIC_ID = "epic-pool-capacity-refused-twice";
    const TAB_ID = "tab-pool-capacity-refused-twice";
    const endpoint = new FakePoolEndpoint(
      "wss://pool-t8.test/refusal-redial-limit",
      { omittedStreamMethods: [], acknowledgeOpen: true },
    );
    const rig = installRealPoolEndpointEnvironment(endpoint, null);
    const controller = getEpicSessionController();
    setTestEffectiveHost(POOL_HOST_ID, true);
    openTestEpicTab(TAB_ID, EPIC_ID, "Repeated refusal");
    controller.attachSurface(EPIC_ID, TAB_ID);
    await waitFor(() => {
      const socket = endpoint.sockets.at(0);
      assertTestFixture(socket, "expected the first endpoint socket");
      expect(socket.subscriptions.map(({ method }) => method)).toEqual(
        expect.arrayContaining([
          "epic.status.subscribe",
          "epic.state.subscribe",
        ]),
      );
    });
    const firstSocket = endpoint.sockets.at(0);
    assertTestFixture(firstSocket, "expected the first endpoint socket");
    refusePoolTaskOpen(
      firstSocket,
      taskSubscription(firstSocket, "epic.status.subscribe", 0),
    );
    await waitFor(() => {
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("failed");
    });
    expect(firstSocket.serverClosed).toBe(false);
    expect(firstSocket.clientCloseCount).toBe(0);

    controller.retry(EPIC_ID);
    await waitFor(() => {
      expect(
        firstSocket.subscriptions.filter(
          ({ method }) => method === "epic.status.subscribe",
        ),
      ).toHaveLength(2);
      expect(
        firstSocket.subscriptions.filter(
          ({ method }) => method === "epic.state.subscribe",
        ),
      ).toHaveLength(2);
    });
    refusePoolTaskOpen(
      firstSocket,
      taskSubscription(firstSocket, "epic.status.subscribe", 1),
    );
    await waitFor(() => expect(endpoint.sockets).toHaveLength(2));
    const boundedRedial = endpoint.sockets.at(1);
    assertTestFixture(boundedRedial, "expected exactly one forced redial");
    await waitFor(() => {
      expect(boundedRedial.opens).toEqual([
        {
          bearer: "pool-t8-test-bearer",
          authzPresent: true,
          authz: null,
        },
      ]);
      expect(boundedRedial.subscriptions.map(({ method }) => method)).toContain(
        "epic.status.subscribe",
      );
      expect(boundedRedial.subscriptions.map(({ method }) => method)).toContain(
        "epic.state.subscribe",
      );
    });
    expect(firstSocket.clientSocketClosed).toBe(true);
    refusePoolTaskOpen(
      boundedRedial,
      taskSubscription(boundedRedial, "epic.status.subscribe", 0),
    );
    await waitFor(() => {
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("failed");
    });
    const worker = rig.workers.at(0);
    assertTestFixture(worker, "expected the persistent-refusal worker");
    await worker.flush();
    expect(boundedRedial.serverClosed).toBe(false);
    expect(boundedRedial.clientCloseCount).toBe(0);
    expect(endpoint.sockets).toHaveLength(2);
  });

  it("fails a pool task when a required lane is refused without opening the legacy stream", async () => {
    const EPIC_ID = "epic-pool-required-lane-refused";
    const TAB_ID = "tab-pool-required-lane-refused";
    const endpoint = new FakePoolEndpoint(
      "wss://pool-t8.test/required-lane-refusal",
      { omittedStreamMethods: [], acknowledgeOpen: true },
    );
    const rig = installRealPoolEndpointEnvironment(endpoint, null);
    const controller = getEpicSessionController();
    setTestEffectiveHost(POOL_HOST_ID, true);
    openTestEpicTab(TAB_ID, EPIC_ID, "");
    controller.attachSurface(EPIC_ID, TAB_ID);

    await waitFor(() => {
      const socket = endpoint.sockets.at(0);
      assertTestFixture(socket, "expected the required-lane socket");
      expect(socket.subscriptions.map(({ method }) => method)).toEqual(
        expect.arrayContaining([
          "epic.status.subscribe",
          "epic.state.subscribe",
        ]),
      );
    });
    const socket = endpoint.sockets.at(0);
    assertTestFixture(socket, "expected the required-lane socket");
    refusePoolTaskOpen(
      socket,
      taskSubscription(socket, "epic.state.subscribe", 0),
    );
    await waitFor(() => {
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("failed");
    });
    const worker = rig.workers.at(0);
    assertTestFixture(worker, "expected the real proxied runtime worker");
    await worker.flush();
    expect(socket.serverClosed).toBe(false);
    expect(socket.clientCloseCount).toBe(0);
    expect(socket.subscriptions.map(({ method }) => method)).not.toContain(
      "epic.subscribe",
    );
  });

  it.each([false, true])(
    "replaces a pool task on authority epoch change and retains only a dirty outgoing handle (dirty=$dirty)",
    async (dirty) => {
      const EPIC_ID = `epic-pool-authority-${String(dirty)}`;
      const TAB_ID = `tab-pool-authority-${String(dirty)}`;
      const ARTIFACT_ID = "spec-pool-authority";
      const controller = getEpicSessionController();
      const registry = __getOpenEpicRegistryForTests();
      const spy = installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST);
      setTestEffectiveHost(POOL_HOST_ID, true);
      openTestEpicTab(TAB_ID, EPIC_ID, "");
      controller.attachSurface(EPIC_ID, TAB_ID);
      await waitFor(() => expect(spy.sessions).toHaveLength(1));
      const outgoing = spy.sessions.at(0);
      assertPoolTaskLanes(outgoing, "expected the outgoing pool lanes");
      act(() => {
        outgoing.status.onConnectionStatus("open", null, null, null);
        outgoing.state.onConnectionStatus("open", null, null, null);
        outgoing.status.onSnapshot(statusLaneSnapshot("authority-1"), true);
        outgoing.state.onSnapshot(
          poolStateSnapshotWithArtifact(
            "authority-1",
            "Pool authority task",
            ARTIFACT_ID,
          ),
        );
      });
      await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
      const originalHandle = registry.peek(EPIC_ID);
      assertTestFixture(originalHandle, "expected the outgoing task handle");

      if (dirty) {
        const releaseBody = originalHandle.store
          .getState()
          .acquireArtifactBodyLease(ARTIFACT_ID);
        await waitFor(() => expect(outgoing.bodyLanes).toHaveLength(1));
        const bodyLane = outgoing.bodyLanes.at(0);
        assertTestFixture(bodyLane, "expected the outgoing artifact lane");
        const body = new Y.Doc();
        body
          .getXmlFragment(artifactBodyFragmentName(ARTIFACT_ID))
          .insert(0, [new Y.XmlText("cloud body")]);
        deliverArtifactDoc(bodyLane, "authority-1", "authority-guid", body);
        body.destroy();
        await waitFor(() => {
          expect(
            originalHandle.store
              .getState()
              .getArtifactBodyAvailability(ARTIFACT_ID),
          ).toBe("ready");
        });
        const fragment = originalHandle.store
          .getState()
          .getArtifactFragment(ARTIFACT_ID);
        assertTestFixture(fragment, "expected the outgoing body");
        fragment.insert(fragment.length, [new Y.XmlText(" local edit")]);
        const worker = spy.workers.at(0);
        assertTestFixture(worker, "expected the outgoing task worker");
        await worker.flush();
        await waitFor(() => expect(bodyLane.updates).toHaveLength(1));
        expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(true);

        act(() => {
          outgoing.status.onSnapshot(statusLaneSnapshot("authority-2"), true);
        });
        await waitFor(() => expect(spy.sessions).toHaveLength(2));
        expect(registry.peek(EPIC_ID)).toBe(originalHandle);
        expect(outgoing.bodyLanes.at(0)?.closed).toBe(true);
        releaseBody();
      } else {
        act(() => {
          outgoing.status.onSnapshot(statusLaneSnapshot("authority-2"), true);
        });
        await waitFor(() => expect(spy.sessions).toHaveLength(2));
        expect(registry.peek(EPIC_ID)).toBe(originalHandle);
      }

      await waitFor(() => {
        expect(outgoing.statusClosed).toBe(true);
        expect(outgoing.stateClosed).toBe(true);
      });
      const candidate = spy.sessions.at(1);
      assertPoolTaskLanes(candidate, "expected replacement pool task lanes");
      act(() => {
        candidate.status.onConnectionStatus("open", null, null, null);
        candidate.status.onSnapshot(statusLaneSnapshot("authority-2"), true);
      });
      expect(registry.peek(EPIC_ID)).toBe(originalHandle);
      act(() => {
        candidate.state.onConnectionStatus("open", null, null, null);
        candidate.state.onSnapshot(
          poolStateSnapshotWithArtifact(
            "authority-2",
            "Pool authority task",
            ARTIFACT_ID,
          ),
        );
      });
      await waitFor(() => {
        const current = registry.peek(EPIC_ID);
        expect(current).not.toBeNull();
        expect(current).not.toBe(originalHandle);
      });
      expect(registry.retainedCountForTests(EPIC_ID)).toBe(dirty ? 1 : 0);
      expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(dirty);
      expect(
        spy.sessions.filter(
          (session) => !session.statusClosed && !session.stateClosed,
        ),
      ).toEqual([candidate]);
      expect(spy.legacyOpenEpicIds).toEqual([]);
    },
  );

  it("keeps a dirty same-epoch pool body and its request snapshot when replacement misses its deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const EPIC_ID = "epic-pool-same-epoch-timeout";
    const TAB_ID = "tab-pool-same-epoch-timeout";
    const ARTIFACT_ID = "spec-same-epoch-timeout";
    const EPOCH = "same-authority-epoch";
    const controller = getEpicSessionController();
    const registry = __getOpenEpicRegistryForTests();
    const spy = installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST);
    setTestEffectiveHost(POOL_HOST_ID, true);
    openTestEpicTab(TAB_ID, EPIC_ID, "Same epoch task");
    controller.attachSurface(EPIC_ID, TAB_ID);
    await waitFor(() => expect(spy.sessions).toHaveLength(1));
    const outgoing = spy.sessions.at(0);
    assertPoolTaskLanes(outgoing, "expected the original pool task lanes");
    act(() => {
      outgoing.status.onConnectionStatus("open", null, null, null);
      outgoing.state.onConnectionStatus("open", null, null, null);
      outgoing.status.onSnapshot(statusLaneSnapshot(EPOCH), true);
      outgoing.state.onSnapshot(
        poolStateSnapshotWithArtifact(EPOCH, "Same epoch task", ARTIFACT_ID),
      );
    });
    await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
    const outgoingHandle = registry.peek(EPIC_ID);
    assertTestFixture(outgoingHandle, "expected the published pool handle");
    const releaseBody = outgoingHandle.store
      .getState()
      .acquireArtifactBodyLease(ARTIFACT_ID);
    await waitFor(() => expect(outgoing.bodyLanes).toHaveLength(1));
    const outgoingBodyLane = outgoing.bodyLanes.at(0);
    assertTestFixture(outgoingBodyLane, "expected the original body lane");
    const originalDoc = new Y.Doc();
    originalDoc
      .getXmlFragment(artifactBodyFragmentName(ARTIFACT_ID))
      .insert(0, [new Y.XmlText("original body")]);
    deliverArtifactDoc(outgoingBodyLane, EPOCH, "same-epoch-guid", originalDoc);
    await waitFor(() => {
      expect(
        outgoingHandle.store
          .getState()
          .getArtifactBodyAvailability(ARTIFACT_ID),
      ).toBe("ready");
    });
    const fragment = outgoingHandle.store
      .getState()
      .getArtifactFragment(ARTIFACT_ID);
    assertTestFixture(fragment, "expected the original body fragment");
    fragment.insert(fragment.length, [new Y.XmlText(" + local draft")]);
    const outgoingWorker = spy.workers.at(0);
    assertTestFixture(outgoingWorker, "expected the original pool worker");
    await outgoingWorker.flush();
    await waitFor(() => expect(outgoingBodyLane.updates).toHaveLength(1));
    expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(true);

    reportBodyMoved(outgoingBodyLane, EPOCH);
    await waitFor(() => expect(outgoing.bodyLanes).toHaveLength(2));
    const movedBodyLane = outgoing.bodyLanes.at(1);
    assertTestFixture(movedBodyLane, "expected the same-epoch reattach");
    const movedDoc = new Y.Doc();
    movedDoc
      .getXmlFragment(artifactBodyFragmentName(ARTIFACT_ID))
      .insert(0, [new Y.XmlText("new replica seed")]);
    deliverArtifactDoc(movedBodyLane, EPOCH, "new-same-epoch-guid", movedDoc);
    movedDoc.destroy();
    await outgoingWorker.flush();
    await waitFor(() => expect(spy.sessions).toHaveLength(2));
    expect(registry.peek(EPIC_ID)).toBe(outgoingHandle);
    expect(
      controller.readTabSnapshot(EPIC_ID, TAB_ID).sessionHostClient,
    ).toBeNull();
    expect(
      outgoingHandle.store
        .getState()
        .getArtifactFragment(ARTIFACT_ID)
        ?.toJSON(),
    ).toBe("original body + local draft");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ESTABLISHING_DEADLINE_MS);
    });
    await waitFor(() => {
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("failed");
    });
    const failed = controller.readTabSnapshot(EPIC_ID, TAB_ID);
    expect(failed.presentation.targetHostId).toBe(POOL_HOST_ID);
    expect(failed.presentation.originalHostId).toBeNull();
    expect(failed.handle).toBe(outgoingHandle);
    expect(registry.peek(EPIC_ID)).toBe(outgoingHandle);
    expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(true);
    expect(
      outgoingHandle.store
        .getState()
        .getArtifactFragment(ARTIFACT_ID)
        ?.toJSON(),
    ).toBe("original body + local draft");

    controller.retry(EPIC_ID);
    await waitFor(() => expect(spy.sessions).toHaveLength(3));
    const retrySession = spy.sessions.at(2);
    assertPoolTaskLanes(retrySession, "expected the same-epoch retry lanes");
    act(() => {
      retrySession.status.onConnectionStatus("open", null, null, null);
      retrySession.state.onConnectionStatus("open", null, null, null);
      retrySession.status.onSnapshot(statusLaneSnapshot(EPOCH), true);
      retrySession.state.onSnapshot(
        poolStateSnapshotWithArtifact(
          EPOCH,
          "Same epoch replacement",
          ARTIFACT_ID,
        ),
      );
    });
    await waitFor(() => {
      const replacement = registry.peek(EPIC_ID);
      expect(replacement).not.toBeNull();
      expect(replacement).not.toBe(outgoingHandle);
    });
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(1);
    expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(true);
    expect(
      registry.getUnsyncedEdits().some((row) => row.epicId === EPIC_ID),
    ).toBe(true);
    releaseBody();
    originalDoc.destroy();
  });

  it("keeps a computer task handle in place when its authority epoch changes", async () => {
    const EPIC_ID = "epic-computer-authority-epoch";
    const TAB_ID = "tab-computer-authority-epoch";
    const controller = getEpicSessionController();
    const registry = __getOpenEpicRegistryForTests();
    const spy = installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST);
    setTestEffectiveHost("host-a", true);
    openTestEpicTab(TAB_ID, EPIC_ID, "Computer epoch task");
    controller.attachSurface(EPIC_ID, TAB_ID);
    await waitFor(() => expect(spy.sessions).toHaveLength(1));
    const session = spy.sessions.at(0);
    assertPoolTaskLanes(session, "expected the computer task lanes");
    act(() => {
      session.status.onConnectionStatus("open", null, null, null);
      session.state.onConnectionStatus("open", null, null, null);
      session.status.onSnapshot(statusLaneSnapshot("computer-epoch-1"), true);
      session.state.onSnapshot(
        stateLaneSnapshot("computer-epoch-1", "Before epoch change"),
      );
    });
    await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
    const handle = registry.peek(EPIC_ID);
    assertTestFixture(handle, "expected the computer task handle");

    act(() => {
      session.status.onSnapshot(statusLaneSnapshot("computer-epoch-2"), true);
      session.state.onSnapshot(
        stateLaneSnapshot("computer-epoch-2", "After epoch change"),
      );
    });
    await waitFor(() => {
      expect(handle.store.getState().epic.title).toBe("After epoch change");
    });
    expect(registry.peek(EPIC_ID)).toBe(handle);
    expect(controller.readTabSnapshot(EPIC_ID, TAB_ID).handle).toBe(handle);
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(0);
    expect(spy.sessions).toHaveLength(1);
    expect(spy.legacyOpenEpicIds).toEqual([]);
  });

  it("keeps a loaded original-host task ready when its computer lease dies and the app serves elsewhere", async () => {
    const EPIC_ID = "epic-pinned-computer-dead";
    const TAB_ID = "tab-pinned-computer-dead";
    const ARTIFACT_ID = "spec-pinned-computer-dead";
    const controller = getEpicSessionController();
    const registry = __getOpenEpicRegistryForTests();
    const spy = installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST);
    const taskCalls: string[] = [];
    const originalHostClient = createTestHostClient("host-a", taskCalls);
    installTestEpicSessionEnvironment({
      ...defaultTestEpicSessionEnvironment(),
      resolveHostClient: (hostId) =>
        hostId === "host-a" ? originalHostClient : null,
    });
    setTestEffectiveHost("host-a", true);
    openTestEpicTab(TAB_ID, EPIC_ID, "Pinned task");
    controller.attachSurface(EPIC_ID, TAB_ID);
    await waitFor(() => expect(spy.sessions).toHaveLength(1));
    const session = spy.sessions.at(0);
    assertPoolTaskLanes(session, "expected the original computer task lanes");
    act(() => {
      session.status.onConnectionStatus("open", null, null, null);
      session.state.onConnectionStatus("open", null, null, null);
      session.status.onSnapshot(statusLaneSnapshot("pinned-epoch"), true);
      session.state.onSnapshot(
        poolStateSnapshotWithArtifact(
          "pinned-epoch",
          "Pinned task",
          ARTIFACT_ID,
        ),
      );
    });
    await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
    const handle = registry.peek(EPIC_ID);
    assertTestFixture(handle, "expected the published computer handle");
    const releaseBody = handle.store
      .getState()
      .acquireArtifactBodyLease(ARTIFACT_ID);
    await waitFor(() => expect(session.bodyLanes).toHaveLength(1));
    const bodyLane = session.bodyLanes.at(0);
    assertTestFixture(bodyLane, "expected the original computer body lane");
    const body = new Y.Doc();
    body
      .getXmlFragment(artifactBodyFragmentName(ARTIFACT_ID))
      .insert(0, [new Y.XmlText("pinned body")]);
    deliverArtifactDoc(bodyLane, "pinned-epoch", "pinned-guid", body);
    body.destroy();
    await waitFor(() => {
      expect(
        handle.store.getState().getArtifactBodyAvailability(ARTIFACT_ID),
      ).toBe("ready");
    });

    controller.openOnOriginalHost(EPIC_ID);
    setTestEffectiveHost("host-b", true);
    useSelectionAuthorityStore.setState({
      leases: [
        { hostId: "host-a", status: "dead", dead: { reason: "offline" } },
      ],
    });

    const snapshot = controller.readTabSnapshot(EPIC_ID, TAB_ID);
    expect(snapshot.presentation).toMatchObject({
      kind: "ready",
      targetHostId: "host-a",
      originalHostId: "host-a",
    });
    expect(snapshot.handle).toBe(handle);
    expect(snapshot.sessionHostId).toBe("host-a");
    expect(snapshot.sessionHostClient).toBe(originalHostClient);
    expect(controller.readEpicHostId(EPIC_ID)).toBe("host-a");
    expect(registry.peek(EPIC_ID)).toBe(handle);
    expect(registry.retainedCountForTests(EPIC_ID)).toBe(0);
    expect(
      handle.store.getState().getArtifactFragment(ARTIFACT_ID)?.toJSON(),
    ).toBe("pinned body");
    await snapshot.sessionHostClient?.request(
      "epic.listTasks",
      LIST_CLOUD_TASKS_REQUEST,
    );
    expect(taskCalls).toEqual(["host-a"]);
    expect(spy.sessions).toHaveLength(1);
    expect(
      fakeDurableStreamTransports().records.map((record) => record.hostId),
    ).toEqual(["host-a"]);
    releaseBody();
  });

  it("keeps the original-host deadline and failure when the explicit computer cannot reopen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const EPIC_ID = "epic-original-host-open-fails";
    const TAB_ID = "tab-original-host-open-fails";
    const controller = getEpicSessionController();
    const registry = __getOpenEpicRegistryForTests();
    const spy = installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST);
    const originalHostClient = createTestHostClient("host-a", []);
    installTestEpicSessionEnvironment({
      ...defaultTestEpicSessionEnvironment(),
      resolveHostClient: (hostId) =>
        hostId === "host-a" ? originalHostClient : null,
    });
    setTestEffectiveHost("host-a", true);
    openTestEpicTab(TAB_ID, EPIC_ID, "Original host task");
    controller.attachSurface(EPIC_ID, TAB_ID);
    await waitFor(() => expect(spy.sessions).toHaveLength(1));
    const originalSession = spy.sessions.at(0);
    assertPoolTaskLanes(
      originalSession,
      "expected the original computer task lanes",
    );
    act(() => {
      originalSession.status.onConnectionStatus("open", null, null, null);
      originalSession.state.onConnectionStatus("open", null, null, null);
      originalSession.status.onSnapshot(
        statusLaneSnapshot("original-epoch"),
        true,
      );
      originalSession.state.onSnapshot(
        stateLaneSnapshot("original-epoch", "Original host task"),
      );
    });
    await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
    const computerHandle = registry.peek(EPIC_ID);
    assertTestFixture(computerHandle, "expected the original computer handle");

    setTestEffectiveHost(POOL_HOST_ID, true);
    await waitFor(() => expect(spy.sessions).toHaveLength(2));
    const poolSession = spy.sessions.at(1);
    assertPoolTaskLanes(poolSession, "expected the pool task lanes");
    act(() => {
      poolSession.status.onConnectionStatus("open", null, null, null);
      poolSession.state.onConnectionStatus("open", null, null, null);
      poolSession.status.onSnapshot(statusLaneSnapshot("pool-epoch"), true);
      poolSession.state.onSnapshot(
        stateLaneSnapshot("pool-epoch", "Pool task"),
      );
    });
    await waitFor(() => {
      const current = registry.peek(EPIC_ID);
      expect(current).not.toBeNull();
      expect(current).not.toBe(computerHandle);
    });
    const poolHandle = registry.peek(EPIC_ID);
    assertTestFixture(poolHandle, "expected the pool replacement handle");
    expect(
      controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.originalHostId,
    ).toBe("host-a");

    controller.openOnOriginalHost(EPIC_ID);
    await waitFor(() => expect(spy.sessions).toHaveLength(3));
    const failedOpen = spy.sessions.at(2);
    assertPoolTaskLanes(
      failedOpen,
      "expected the explicit original-host attempt",
    );
    act(() => {
      failedOpen.status.onConnectionStatus("open", null, null, null);
      failedOpen.state.onConnectionStatus("open", null, null, null);
    });
    setTestEffectiveHost("host-b", true);
    expect(
      controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.targetHostId,
    ).toBe("host-a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ESTABLISHING_DEADLINE_MS);
    });
    await waitFor(() => {
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("failed");
    });
    const failure = controller.readTabSnapshot(EPIC_ID, TAB_ID);
    expect(failure.presentation).toMatchObject({
      kind: "failed",
      targetHostId: "host-a",
      originalHostId: "host-a",
    });
    expect(failure.handle).toBe(poolHandle);
    expect(registry.peek(EPIC_ID)).toBe(poolHandle);
    expect(
      fakeDurableStreamTransports().records.map((record) => record.hostId),
    ).toEqual(["host-a", POOL_HOST_ID, "host-a"]);
  });

  it.each(["pool", "computer"] as const)(
    "routes nullable permissionChanged through the access-loss path on a %s task session",
    async (host) => {
      const EPIC_ID = `epic-permission-change-${host}`;
      const TAB_ID = `tab-permission-change-${host}`;
      const controller = getEpicSessionController();
      const registry = __getOpenEpicRegistryForTests();
      const spy = installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST);
      const servingHostId = host === "pool" ? POOL_HOST_ID : "host-a";
      setTestEffectiveHost(servingHostId, true);
      openTestEpicTab(TAB_ID, EPIC_ID, "");
      controller.attachSurface(EPIC_ID, TAB_ID);
      await waitFor(() => expect(spy.sessions).toHaveLength(1));
      const session = spy.sessions.at(0);
      assertPoolTaskLanes(session, "expected modern task lanes");
      act(() => {
        session.status.onConnectionStatus("open", null, null, null);
        session.state.onConnectionStatus("open", null, null, null);
        session.status.onSnapshot(statusLaneSnapshot("permission-epoch"), true);
        session.state.onSnapshot(
          stateLaneSnapshot("permission-epoch", "Permission task"),
        );
      });
      await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
      const handle = registry.peek(EPIC_ID);
      assertTestFixture(handle, "expected the task handle");

      act(() => {
        session.status.onTransition(
          permissionChangedLaneFrame("permission-epoch", 2, null),
          true,
        );
      });
      await waitFor(() =>
        expect(handle.store.getState().accessLost).toBe(true),
      );
      expect(handle.store.getState().permissionRole).toBeNull();
      expect(spy.legacyOpenEpicIds).toEqual([]);
    },
  );

  it.each([
    { dirty: false, nextGuid: "guid-next", replace: false, host: "pool" },
    { dirty: true, nextGuid: "guid-original", replace: false, host: "pool" },
    { dirty: true, nextGuid: "guid-next", replace: true, host: "pool" },
    { dirty: true, nextGuid: "guid-next", replace: false, host: "computer" },
  ])(
    "applies $host body identity change dirty=$dirty nextGuid=$nextGuid as replace=$replace",
    async ({ dirty, nextGuid, replace, host }) => {
      const EPIC_ID = `epic-${host}-body-${String(dirty)}-${nextGuid}`;
      const TAB_ID = `tab-${host}-body-${String(dirty)}-${nextGuid}`;
      const ARTIFACT_ID = "spec-pool-body";
      const EPOCH = "body-epoch-1";
      const controller = getEpicSessionController();
      const registry = __getOpenEpicRegistryForTests();
      const spy = installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST);
      const servingHostId = host === "pool" ? POOL_HOST_ID : "host-a";
      setTestEffectiveHost(servingHostId, true);
      openTestEpicTab(TAB_ID, EPIC_ID, "");
      controller.attachSurface(EPIC_ID, TAB_ID);
      await waitFor(() => {
        expect(spy.sessions.length).toBe(1);
        expect(spy.sessions.at(0)?.state).not.toBeNull();
      });
      const firstSession = spy.sessions.at(0);
      assertPoolTaskLanes(firstSession, "expected the initial pool task lanes");
      act(() => {
        firstSession.status.onConnectionStatus("open", null, null, null);
        firstSession.state.onConnectionStatus("open", null, null, null);
        firstSession.status.onSnapshot(statusLaneSnapshot(EPOCH), true);
        firstSession.state.onSnapshot(
          poolStateSnapshotWithArtifact(EPOCH, "Pool body task", ARTIFACT_ID),
        );
      });
      await waitFor(() => {
        expect(registry.peek(EPIC_ID)).not.toBeNull();
      });
      const originalHandle = registry.peek(EPIC_ID);
      assertTestFixture(originalHandle, "expected pool task handle");
      const releaseBody = originalHandle.store
        .getState()
        .acquireArtifactBodyLease(ARTIFACT_ID);
      await waitFor(() => expect(firstSession.bodyLanes).toHaveLength(1));
      const bodyLane = firstSession.bodyLanes.at(0);
      assertTestFixture(bodyLane, "expected pool artifact lane");

      const seedDoc = new Y.Doc();
      seedDoc
        .getXmlFragment(artifactBodyFragmentName(ARTIFACT_ID))
        .insert(0, [new Y.XmlText("published body")]);
      deliverArtifactDoc(bodyLane, EPOCH, "guid-original", seedDoc);
      await waitFor(() => {
        expect(
          originalHandle.store
            .getState()
            .getArtifactBodyAvailability(ARTIFACT_ID),
        ).toBe("ready");
      });
      const initialFragment = originalHandle.store
        .getState()
        .getArtifactFragment(ARTIFACT_ID);
      assertTestFixture(initialFragment, "expected seeded body");
      if (dirty) {
        initialFragment.insert(initialFragment.length, [
          new Y.XmlText(" local edit"),
        ]);
        await waitFor(() => {
          expect(originalHandle.store.getState().isDirty).toBe(true);
        });
        const worker = spy.workers.at(0);
        assertTestFixture(worker, "expected the initial task worker");
        await worker.flush();
        await waitFor(() => expect(bodyLane.updates).toHaveLength(1));
        expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(true);
      }

      const sameDocumentReseed = dirty && nextGuid === "guid-original";
      if (sameDocumentReseed) {
        act(() => {
          firstSession.status.onConnectionStatus("closed", null, null, null);
          firstSession.status.onConnectionStatus("open", null, null, null);
        });
      } else {
        reportBodyMoved(bodyLane, EPOCH);
      }
      if (!sameDocumentReseed) {
        await waitFor(() => expect(firstSession.bodyLanes).toHaveLength(2));
      }
      const reattachedBodyLane = sameDocumentReseed
        ? bodyLane
        : firstSession.bodyLanes.at(1);
      assertTestFixture(
        reattachedBodyLane,
        "expected a reattached pool body lane",
      );
      const replacementDoc = new Y.Doc();
      if (sameDocumentReseed) {
        Y.applyUpdate(replacementDoc, Y.encodeStateAsUpdate(seedDoc));
      }
      seedDoc.destroy();
      replacementDoc
        .getXmlFragment(artifactBodyFragmentName(ARTIFACT_ID))
        .insert(
          replacementDoc.getXmlFragment(artifactBodyFragmentName(ARTIFACT_ID))
            .length,
          [new Y.XmlText("replacement body")],
        );
      act(() =>
        deliverArtifactDoc(reattachedBodyLane, EPOCH, nextGuid, replacementDoc),
      );
      const worker = spy.workers.at(0);
      assertTestFixture(worker, "expected the initial task worker");
      await worker.flush();
      replacementDoc.destroy();

      if (replace) {
        expect(originalHandle.store.getState().poolTaskStatus).toBe("replace");
      }

      if (!replace) {
        expect(registry.peek(EPIC_ID)).toBe(originalHandle);
        expect(registry.retainedCountForTests(EPIC_ID)).toBe(0);
        const preserveDirtyBody =
          dirty && host === "pool" && nextGuid === "guid-original";
        if (preserveDirtyBody) {
          await waitFor(() => {
            expect(
              originalHandle.store
                .getState()
                .getArtifactBodyAvailability(ARTIFACT_ID),
            ).toBe("ready");
          });
          expect(
            originalHandle.store
              .getState()
              .getArtifactFragment(ARTIFACT_ID)
              ?.toJSON(),
          ).toContain("local edit");
          expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(true);
        } else {
          await waitFor(() => {
            expect(
              originalHandle.store
                .getState()
                .getArtifactFragment(ARTIFACT_ID)
                ?.toJSON(),
            ).toContain("replacement body");
          });
          expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(false);
        }
      } else {
        await waitFor(() => expect(spy.sessions).toHaveLength(2));
        expect(registry.peek(EPIC_ID)).toBe(originalHandle);
        const candidate = spy.sessions.at(1);
        assertPoolTaskLanes(candidate, "expected replacement pool lanes");
        act(() => {
          candidate.status.onConnectionStatus("open", null, null, null);
          candidate.state.onConnectionStatus("open", null, null, null);
          candidate.status.onSnapshot(statusLaneSnapshot(EPOCH), true);
          candidate.state.onSnapshot(
            poolStateSnapshotWithArtifact(EPOCH, "Pool body task", ARTIFACT_ID),
          );
        });
        await waitFor(() => {
          const current = registry.peek(EPIC_ID);
          expect(current).not.toBeNull();
          expect(current).not.toBe(originalHandle);
        });
        expect(registry.retainedCountForTests(EPIC_ID)).toBe(1);
        expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(true);
        expect(
          registry.getUnsyncedEdits().some((row) => row.epicId === EPIC_ID),
        ).toBe(true);
        expect(bodyLane.closed).toBe(true);
        releaseBody();
      }
    },
  );

  it.each(PUBLICATION_REPLACEMENT_WIRE_INPUTS)(
    "replaces at A4 row $boundaryRows: $boundary and independently checks body and warning",
    async (testCase) => {
      const {
        boundary,
        boundaryRows,
        direction,
        coveringAckReceived,
        objectSuccessorRevision,
        successorSeedContainsEdit,
        convergesWhenSourceReturns,
        storage,
      } = testCase;
      const boundaryId = boundaryRows.join("-");
      const EPIC_ID = `epic-publication-boundary-${boundaryId}-${boundary.replaceAll(" ", "-")}`;
      const TAB_ID = `tab-publication-boundary-${boundaryId}-${boundary.replaceAll(" ", "-")}`;
      const ARTIFACT_ID = "spec-publication-boundary";
      const EPOCH = "publication-epoch";
      const controller = getEpicSessionController();
      const registry = __getOpenEpicRegistryForTests();
      const spy = installPoolTaskTransportSpy(COMPLETE_TEST_LANE_MANIFEST);
      const sourceHostId =
        direction === "pool-to-computer" ? POOL_HOST_ID : "host-a";
      const destinationHostId =
        direction === "pool-to-computer" ? "host-b" : POOL_HOST_ID;
      setTestEffectiveHost(sourceHostId, true);
      openTestEpicTab(TAB_ID, EPIC_ID, "");
      controller.attachSurface(EPIC_ID, TAB_ID);
      await waitFor(() => {
        expect(spy.sessions).toHaveLength(1);
        expect(spy.sessions.at(0)?.state).not.toBeNull();
      });
      const outgoing = spy.sessions.at(0);
      assertPoolTaskLanes(outgoing, "expected the outgoing task lanes");
      act(() => {
        outgoing.status.onConnectionStatus("open", null, null, null);
        outgoing.state.onConnectionStatus("open", null, null, null);
        outgoing.status.onSnapshot(statusLaneSnapshot(EPOCH), true);
        outgoing.state.onSnapshot(
          poolStateSnapshotWithArtifact(EPOCH, "Publication task", ARTIFACT_ID),
        );
      });
      await waitFor(() => expect(registry.peek(EPIC_ID)).not.toBeNull());
      const outgoingHandle = registry.peek(EPIC_ID);
      assertTestFixture(outgoingHandle, "expected the outgoing task handle");
      const releaseOutgoingBody = outgoingHandle.store
        .getState()
        .acquireArtifactBodyLease(ARTIFACT_ID);
      await waitFor(() => expect(outgoing.bodyLanes).toHaveLength(1));
      const outgoingBodyLane = outgoing.bodyLanes.at(0);
      assertTestFixture(
        outgoingBodyLane,
        "expected the outgoing artifact body lane",
      );

      const seededDoc = new Y.Doc();
      seededDoc
        .getXmlFragment(artifactBodyFragmentName(ARTIFACT_ID))
        .insert(0, [new Y.XmlText("cloud body")]);
      const cloudSeed = Y.encodeStateAsUpdate(seededDoc);
      deliverArtifactDoc(
        outgoingBodyLane,
        EPOCH,
        "publication-guid",
        seededDoc,
      );
      await waitFor(() => {
        expect(
          outgoingHandle.store
            .getState()
            .getArtifactBodyAvailability(ARTIFACT_ID),
        ).toBe("ready");
      });
      const outgoingFragment = outgoingHandle.store
        .getState()
        .getArtifactFragment(ARTIFACT_ID);
      assertTestFixture(outgoingFragment, "expected the seeded body");
      outgoingFragment.insert(outgoingFragment.length, [
        new Y.XmlText(" + edit"),
      ]);
      const outgoingWorker = spy.workers.at(0);
      assertTestFixture(outgoingWorker, "expected the outgoing worker");
      await outgoingWorker.flush();
      await waitFor(() => expect(outgoingBodyLane.updates).toHaveLength(1));
      expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(true);

      const update = outgoingBodyLane.updates.at(0);
      assertTestFixture(update, "expected the local body update");
      let coverageStateVectorBase64: string | null = null;
      if (coveringAckReceived) {
        const coveredDoc = new Y.Doc();
        Y.applyUpdate(coveredDoc, Y.encodeStateAsUpdate(seededDoc));
        Y.applyUpdate(coveredDoc, update.update);
        coverageStateVectorBase64 = encodeDocStateVectorBase64(coveredDoc);
        coveredDoc.destroy();
        deliverArtifactDocAck(
          outgoingBodyLane,
          EPOCH,
          update.docGuid,
          coverageStateVectorBase64,
        );
        await waitFor(() =>
          expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(false),
        );
      }
      setTestEffectiveHost(destinationHostId, true);
      await waitFor(() => {
        expect(spy.sessions).toHaveLength(2);
        expect(spy.sessions.at(1)?.state).not.toBeNull();
      });
      const candidate = spy.sessions.at(1);
      assertPoolTaskLanes(candidate, "expected replacement task lanes");
      expect(registry.peek(EPIC_ID)).toBe(outgoingHandle);
      act(() => {
        candidate.status.onConnectionStatus("open", null, null, null);
        candidate.state.onConnectionStatus("open", null, null, null);
        candidate.status.onSnapshot(
          statusLaneSnapshot("replacement-epoch"),
          true,
        );
        candidate.state.onSnapshot(
          poolStateSnapshotWithArtifact(
            "replacement-epoch",
            "Publication task",
            ARTIFACT_ID,
          ),
        );
      });
      await waitFor(() => {
        const replacement = registry.peek(EPIC_ID);
        expect(replacement).not.toBeNull();
        expect(replacement).not.toBe(outgoingHandle);
      });
      const replacementHandle = registry.peek(EPIC_ID);
      assertTestFixture(replacementHandle, "expected replacement handle");
      const releaseReplacementBody = replacementHandle.store
        .getState()
        .acquireArtifactBodyLease(ARTIFACT_ID);
      await waitFor(() => expect(candidate.bodyLanes).toHaveLength(1));
      const replacementLane = candidate.bodyLanes.at(0);
      assertTestFixture(
        replacementLane,
        "expected replacement artifact body lane",
      );
      const replacementDoc = new Y.Doc();
      Y.applyUpdate(replacementDoc, cloudSeed);
      const successorContainsEdit =
        storage === "object"
          ? objectSuccessorRevision === "edit"
          : successorSeedContainsEdit;
      if (successorContainsEdit) {
        Y.applyUpdate(replacementDoc, update.update);
      }
      deliverArtifactDoc(
        replacementLane,
        "replacement-epoch",
        "replacement-guid",
        replacementDoc,
      );
      const replacementWorker = spy.workers.at(1);
      assertTestFixture(replacementWorker, "expected the replacement worker");
      await replacementWorker.flush();
      replacementDoc.destroy();
      await waitFor(() => {
        expect(
          replacementHandle.store
            .getState()
            .getArtifactBodyAvailability(ARTIFACT_ID),
        ).toBe("ready");
      });

      const replacementFragment = replacementHandle.store
        .getState()
        .getArtifactFragment(ARTIFACT_ID);
      assertTestFixture(replacementFragment, "expected the replacement body");
      expect(replacementFragment.toJSON()).toBe(
        successorSeedContainsEdit ? "cloud body + edit" : "cloud body",
      );
      expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(!coveringAckReceived);
      expect(registry.retainedCountForTests(EPIC_ID)).toBe(
        coveringAckReceived ? 0 : 1,
      );
      expect(
        registry.getUnsyncedEdits().some((row) => row.epicId === EPIC_ID),
      ).toBe(!coveringAckReceived);
      expect(outgoingBodyLane.closed).toBe(true);
      if (convergesWhenSourceReturns) {
        expect(replacementFragment.toJSON()).toBe("cloud body");
        expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(false);
        expect(registry.retainedCountForTests(EPIC_ID)).toBe(0);
        await act(async () => {
          deliverArtifactDocUpdate(
            replacementLane,
            "replacement-epoch",
            "replacement-guid",
            update.update,
          );
          await replacementWorker.flush();
        });
        await waitFor(() => {
          expect(
            replacementHandle.store
              .getState()
              .getArtifactFragment(ARTIFACT_ID)
              ?.toJSON(),
          ).toBe("cloud body + edit");
        });
        expect(registry.hasUnsyncedEdits(EPIC_ID)).toBe(false);
        expect(registry.retainedCountForTests(EPIC_ID)).toBe(0);
      }
      seededDoc.destroy();
      releaseOutgoingBody();
      releaseReplacementBody();
    },
  );

  it("a named hidden tab at restore stays suspended and builds nothing", () => {
    const EPIC_ID = "epic-named-hidden-suspended";
    const TAB_ID = "tab-named-hidden-suspended";
    const controller = getEpicSessionController();

    openTestEpicTab(TAB_ID, EPIC_ID, "My real title");

    expect(constructionCount).toBe(0);
    expect(fakeDurableStreamTransports().records).toHaveLength(0);
    expect(__getOpenEpicRegistryForTests().size()).toBe(0);

    const status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status).not.toBeNull();
    expect(status?.hasSession).toBe(false);
    expect(status?.suspended).toBe(true);
  });

  it("eight named restored tabs for eight epics construct zero sessions", () => {
    for (let i = 0; i < 8; i += 1) {
      openTestEpicTab(`tab-restored-${i}`, `epic-restored-${i}`, `Epic ${i}`);
    }

    expect(constructionCount).toBe(0);
    expect(fakeDurableStreamTransports().records).toHaveLength(0);
    expect(__getOpenEpicRegistryForTests().size()).toBe(0);
  });

  it("placeholder-named tabs count as unnamed and each acquires", () => {
    const controller = getEpicSessionController();
    const placeholders: ReadonlyArray<readonly [string, string]> = [
      ["epic-placeholder-untitled-task", "Untitled task"],
      ["epic-placeholder-host-untitled", "Untitled"],
      ["epic-placeholder-whitespace", "   "],
    ];

    for (const [epicId, name] of placeholders) {
      openTestEpicTab(`tab-${epicId}`, epicId, name);
      const status = controller.readEntryStatusForTests(epicId);
      expect(status).not.toBeNull();
      expect(status?.hasSession).toBe(true);
      expect(status?.demandHeld).toBe(true);
      expect(status?.metadataHold).toBe(true);
    }

    expect(fakeDurableStreamTransports().records).toHaveLength(
      placeholders.length,
    );
  });

  it("the hold ends when a real title is observed, the session stays warm, and the tab record is renamed", async () => {
    const EPIC_ID = "epic-metadata-hold-real-title";
    const TAB_ID = "tab-metadata-hold-real-title";
    const controller = getEpicSessionController();
    const streams: ControlledEpicStream[] = [];
    installLegacyStreamFactory(streams);

    openTestEpicTab(TAB_ID, EPIC_ID, "");

    const handle = __getOpenEpicRegistryForTests().peek(EPIC_ID);
    if (handle === null) throw new Error("expected an acquired handle");
    expect(controller.readEntryStatusForTests(EPIC_ID)?.metadataHold).toBe(
      true,
    );

    await waitFor(() => {
      expect(streams).toHaveLength(1);
    });
    const stream = streams.at(0);
    if (stream === undefined) throw new Error("expected a stream");
    deliverSnapshot(stream, "room-metadata-hold");

    // A SINGLE local edit: two independent, causally-unrelated `Y.Doc` donor
    // writes to the same map key race in Yjs's own conflict resolution (which
    // one "wins" depends on the donors' randomly-assigned client ids, not on
    // call order), so this suite never chains two `seedLocalRootEdit` calls
    // against the same key - see the module doc's note on placeholder titles.
    await seedLocalRootEdit(handle, "title", "A Generated Title");

    await waitFor(
      () => {
        const status = controller.readEntryStatusForTests(EPIC_ID);
        expect(status?.metadataHold).toBe(false);
      },
      { timeout: 5000 },
    );
    const status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status?.demandHeld).toBe(false);
    expect(status?.suspended).toBe(true);

    // Still warm in the registry - the demand unit was handed back, not the
    // session itself.
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBeNull();

    // The tab record now carries the observed title, with no surface ever
    // mounted for it.
    expect(useEpicCanvasStore.getState().tabsById[TAB_ID]?.name).toBe(
      "A Generated Title",
    );
  });

  it("the host's own Untitled placeholder, delivered as the session's whole starting snapshot, does not end the hold or rename the tab", async () => {
    // A snapshot IS the document's baseline - unlike a later local edit, this
    // is the only writer the doc has seen, so there is no second independent
    // donor to race against (see the note in the previous test).
    const EPIC_ID = "epic-metadata-hold-host-placeholder";
    const TAB_ID = "tab-metadata-hold-host-placeholder";
    const controller = getEpicSessionController();
    const streams: ControlledEpicStream[] = [];
    installLegacyStreamFactory(streams);

    openTestEpicTab(TAB_ID, EPIC_ID, "");
    const handle = __getOpenEpicRegistryForTests().peek(EPIC_ID);
    if (handle === null) throw new Error("expected an acquired handle");

    await waitFor(() => expect(streams).toHaveLength(1));
    const stream = streams.at(0);
    if (stream === undefined) throw new Error("expected a stream");

    const donor = new Y.Doc();
    donor.getMap("epic").set("title", "Untitled");
    stream.callbacks.onSnapshot(
      snapshotMeta("room-host-placeholder"),
      Y.encodeStateAsUpdate(donor),
    );
    donor.destroy();

    await waitFor(
      () => {
        expect(handle.store.getState().epic.title).toBe("Untitled");
      },
      { timeout: 5000 },
    );
    expect(controller.readEntryStatusForTests(EPIC_ID)?.metadataHold).toBe(
      true,
    );
    expect(useEpicCanvasStore.getState().tabsById[TAB_ID]?.name).toBe("");
  });

  it("a second controller boot over that persisted record constructs nothing", async () => {
    const EPIC_ID = "epic-metadata-hold-reboot";
    const TAB_ID = "tab-metadata-hold-reboot";
    const streams: ControlledEpicStream[] = [];
    installLegacyStreamFactory(streams);

    openTestEpicTab(TAB_ID, EPIC_ID, "");
    const handle = __getOpenEpicRegistryForTests().peek(EPIC_ID);
    if (handle === null) throw new Error("expected an acquired handle");
    await waitFor(() => expect(streams).toHaveLength(1));
    const stream = streams.at(0);
    if (stream === undefined) throw new Error("expected a stream");
    deliverSnapshot(stream, "room-metadata-hold-reboot");
    await seedLocalRootEdit(handle, "title", "Reboot Title");
    await waitFor(
      () => {
        expect(
          getEpicSessionController().readEntryStatusForTests(EPIC_ID)
            ?.metadataHold,
        ).toBe(false);
      },
      { timeout: 5000 },
    );
    expect(useEpicCanvasStore.getState().tabsById[TAB_ID]?.name).toBe(
      "Reboot Title",
    );

    // Boot a fresh controller over the persisted (now-named) tab record.
    __resetEpicSessionControllerForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    resetFakeDurableStreamTransports();
    __setEpicRuntimeWorkerFactoryForTests(() => {
      throw new Error("no construction should be attempted on reboot");
    });
    __syncEpicParkingOpenTabsForTests();

    expect(fakeDurableStreamTransports().records).toHaveLength(0);
    const status = getEpicSessionController().readEntryStatusForTests(EPIC_ID);
    expect(status).not.toBeNull();
    expect(status?.hasSession).toBe(false);
    expect(status?.suspended).toBe(true);
  });

  it("a record with a real name is mirrored over by the observed session title", async () => {
    // The tab record is a MIRROR of the session's title, not an independent
    // name of its own: nothing renames a tab record directly. The strip's
    // inline rename enqueues `update-epic-title` on the session, so there the
    // session's title already is the user's name.
    //
    // That does NOT make the session's title the user's latest name in
    // general: a rename from History goes straight to the `epic.updateTitle`
    // RPC and patches the Query caches, bypassing this store, so a session
    // can be the stale party. The mirror is therefore authoritative only for
    // a LIVE session (snapshot loaded, host transport open) - which this one
    // is - and a session that is not live writes nothing; see "a session that
    // is not live never reverts a History rename, and writes what changed
    // once it is live again".
    //
    // Within that, it overwrites unconditionally, as the mounted `renameTab`
    // effect it replaces did for the one tab it could see, once a real title
    // landed. Stage 3 widens that to every open tab record of the epic, named
    // or not.
    const EPIC_ID = "epic-metadata-hold-mixed-names";
    const TAB_UNNAMED = "tab-metadata-hold-mixed-unnamed";
    const TAB_NAMED = "tab-metadata-hold-mixed-named";
    const streams: ControlledEpicStream[] = [];
    installLegacyStreamFactory(streams);

    openTestEpicTab(TAB_UNNAMED, EPIC_ID, "");
    openTestEpicTab(TAB_NAMED, EPIC_ID, "My own name");

    const handle = __getOpenEpicRegistryForTests().peek(EPIC_ID);
    if (handle === null) throw new Error("expected an acquired handle");
    await waitFor(() => expect(streams).toHaveLength(1));
    const stream = streams.at(0);
    if (stream === undefined) throw new Error("expected a stream");
    deliverSnapshot(stream, "room-mixed-names");
    await seedLocalRootEdit(handle, "title", "Observed Title");

    await waitFor(
      () => {
        expect(useEpicCanvasStore.getState().tabsById[TAB_UNNAMED]?.name).toBe(
          "Observed Title",
        );
      },
      { timeout: 5000 },
    );
    expect(useEpicCanvasStore.getState().tabsById[TAB_NAMED]?.name).toBe(
      "Observed Title",
    );
  });

  it("metadata hold expires to ordinary residency, and further pokes construct nothing new", () => {
    vi.useFakeTimers();
    const EPIC_ID = "epic-metadata-hold-timeout";
    const TAB_ID = "tab-metadata-hold-timeout";
    const controller = getEpicSessionController();

    openTestEpicTab(TAB_ID, EPIC_ID, "");
    expect(controller.readEntryStatusForTests(EPIC_ID)?.metadataHold).toBe(
      true,
    );
    expect(constructionCount).toBe(1);

    vi.advanceTimersByTime(TITLE_GENERATION_PENDING_TIMEOUT_MS);

    const status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status?.metadataHold).toBe(false);
    expect(status?.demandHeld).toBe(false);
    expect(status?.suspended).toBe(true);
    // Warm, not gone: the release was to the cap/parking, not a teardown.
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBeNull();

    vi.advanceTimersByTime(TITLE_GENERATION_PENDING_TIMEOUT_MS * 10);
    pokeCanvasStoreNoOp();
    pokeSelectionAuthority();

    expect(constructionCount).toBe(1);
  });

  it("close during construction is fenced on membership: a claim that resolves after close builds nothing and is released", async () => {
    const EPIC_ID = "epic-close-during-claim";
    const TAB_ID = "tab-close-during-claim";
    const controller = getEpicSessionController();

    const capturedClaimResolvers: Array<
      (result: DesktopOwnershipClaimResult) => void
    > = [];
    const calls: TestDesktopBridgeCalls = {
      claims: [],
      releases: [],
      focusRequests: [],
    };
    const bridge = createTestDesktopBridge(
      calls,
      () =>
        new Promise<DesktopOwnershipClaimResult>((resolve) => {
          capturedClaimResolvers.push(resolve);
        }),
    );
    setDesktopEpicOwnershipBridge(bridge);

    openTestEpicTab(TAB_ID, EPIC_ID, "");

    // Membership must exist and be unnamed for the claim to have started, but
    // no session may exist yet - the claim has not resolved.
    expect(calls.claims).toEqual([{ tabId: TAB_ID, epicId: EPIC_ID }]);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBeNull();
    expect(constructionCount).toBe(0);

    closeTestEpicTab(TAB_ID);
    // The tab record must actually be gone from the controller before the
    // claim resolves, or this pin proves nothing.
    expect(controller.readEntryStatusForTests(EPIC_ID)).toBeNull();

    const settle = capturedClaimResolvers.at(0);
    if (settle === undefined) {
      throw new Error("expected a captured claim resolver");
    }
    settle({ ok: true });

    await waitFor(() => {
      expect(calls.releases).toContain(TAB_ID);
    });
    expect(constructionCount).toBe(0);
    expect(__getOpenEpicRegistryForTests().size()).toBe(0);
    expect(controller.readEntryStatusForTests(EPIC_ID)).toBeNull();
  });

  it("two windows, same epic: per-tab ownership discards the denied tab and keeps the granted one's session", async () => {
    const EPIC_ID = "epic-two-window-ownership";
    const TAB_GRANTED = "tab-two-window-granted";
    const TAB_DENIED = "tab-two-window-denied";
    const controller = getEpicSessionController();

    const calls: TestDesktopBridgeCalls = {
      claims: [],
      releases: [],
      focusRequests: [],
    };
    const bridge = createTestDesktopBridge(calls, (tabId) => {
      if (tabId === TAB_GRANTED) return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: false, currentOwner: "window-other" });
    });
    setDesktopEpicOwnershipBridge(bridge);

    openTestEpicTab(TAB_GRANTED, EPIC_ID, "Tab One");
    openTestEpicTab(TAB_DENIED, EPIC_ID, "Tab Two");
    // Both named, so nothing has demanded a session yet - only surfaces will.
    expect(controller.readEntryStatusForTests(EPIC_ID)?.suspended).toBe(true);

    const denied: Array<{ epicId: string; tabId: string }> = [];
    const unsubscribeDenied = controller.subscribeOwnershipDenied(
      (epicId, tabId) => {
        denied.push({ epicId, tabId });
      },
    );
    try {
      controller.attachSurface(EPIC_ID, TAB_GRANTED);
      controller.attachSurface(EPIC_ID, TAB_DENIED);

      await waitFor(() => {
        expect(
          useEpicCanvasStore.getState().tabsById[TAB_DENIED],
        ).toBeUndefined();
      });
      expect(denied).toEqual([{ epicId: EPIC_ID, tabId: TAB_DENIED }]);
      expect(calls.focusRequests).toContain("window-other");

      expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBeNull();
      await waitFor(() => {
        expect(
          controller.readTabSnapshot(EPIC_ID, TAB_GRANTED).handle,
        ).not.toBeNull();
      });
      expect(calls.releases).not.toContain(TAB_GRANTED);
    } finally {
      unsubscribeDenied();
    }
  });

  it("park is not undone by the controller, and reacquires only on a fresh attach", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const EPIC_ID = "epic-park-not-undone";
    const TAB_ID = "tab-park-not-undone";
    const controller = getEpicSessionController();

    openTestEpicTab(TAB_ID, EPIC_ID, "Named tab");
    setEpicSurfaceVisibility(EPIC_ID, TAB_ID, true);
    const detach = controller.attachSurface(EPIC_ID, TAB_ID);

    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBeNull();
    expect(constructionCount).toBe(1);

    act(() => {
      setEpicSurfaceVisibility(EPIC_ID, TAB_ID, false);
      detach();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
    });

    expect(isEpicParked(EPIC_ID)).toBe(true);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBeNull();
    let status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status?.hasSession).toBe(false);
    expect(status?.suspended).toBe(true);

    // Poke every input the controller listens to - none of it resurrects the
    // parked epic or builds anything for it.
    pokeSelectionAuthority();
    pokeCanvasStoreNoOp();
    openTestEpicTab(
      "tab-park-not-undone-other-epic",
      "epic-park-not-undone-other",
      "",
    );
    expect(constructionCount).toBe(2); // only the other epic's own acquisition
    expect(isEpicParked(EPIC_ID)).toBe(true);
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBeNull();

    // Showing it again and attaching a surface acquires a fresh session.
    act(() => {
      setEpicSurfaceVisibility(EPIC_ID, TAB_ID, true);
      controller.attachSurface(EPIC_ID, TAB_ID);
    });
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBeNull();
    status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status?.hasSession).toBe(true);
    expect(status?.suspended).toBe(false);
  });

  it("sign-out mid-hold does not resurrect the session", () => {
    vi.useFakeTimers();
    const EPIC_ID = "epic-signout-mid-hold";
    const TAB_ID = "tab-signout-mid-hold";
    const controller = getEpicSessionController();

    resetAuth("signed-in", "alice@example.com");
    openTestEpicTab(TAB_ID, EPIC_ID, "");
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBeNull();
    expect(constructionCount).toBe(1);

    disposeAllOpenEpicSessions();
    resetAuth("signed-out", null);

    vi.advanceTimersByTime(TITLE_GENERATION_PENDING_TIMEOUT_MS * 2);

    expect(__getOpenEpicRegistryForTests().size()).toBe(0);
    expect(constructionCount).toBe(1);
    const status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status?.hasSession).toBe(false);
    expect(status?.metadataHold).toBe(false);
    expect(status?.suspended).toBe(true);
  });

  it("failed construction is observable and retryable with no React involved", () => {
    vi.useFakeTimers();
    const EPIC_ID = "epic-failed-construction";
    const TAB_ID = "tab-failed-construction";
    const controller = getEpicSessionController();

    let shouldFail = true;
    let calls = 0;
    const workerFactory = previousWorkerFactory;
    __setEpicRuntimeWorkerFactoryForTests(() => {
      calls += 1;
      if (shouldFail) throw new Error("Worker construction blocked by CSP");
      if (workerFactory === null) {
        throw new Error("expected the setup worker factory");
      }
      return workerFactory();
    });

    openTestEpicTab(TAB_ID, EPIC_ID, "");

    let status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status?.constructionFailed).toBe(true);
    expect(status?.hasSession).toBe(false);
    expect(status?.presentation.kind).toBe("failed");
    expect(status?.presentation).toMatchObject({
      targetHostId: "host-a",
      originalHostId: null,
    });
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBeNull();
    expect(calls).toBe(1);

    pokeCanvasStoreNoOp();
    pokeSelectionAuthorityNoOp();
    expect(calls).toBe(1);

    shouldFail = false;
    vi.advanceTimersByTime(SESSION_REBUILD_INITIAL_BACKOFF_MS);

    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBeNull();
    status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status?.constructionFailed).toBe(false);
    expect(status?.hasSession).toBe(true);
    expect(status?.presentation.targetHostId).toBe("host-a");
  });

  it("a provider mounted later sees the failed presentation, and its retry rebuilds once the factory is fixed", async () => {
    const EPIC_ID = "epic-failed-then-mounted-retry";
    const TAB_ID = "tab-failed-then-mounted-retry";

    let shouldFail = true;
    let calls = 0;
    const workerFactory = previousWorkerFactory;
    __setEpicRuntimeWorkerFactoryForTests(() => {
      calls += 1;
      if (shouldFail) throw new Error("Worker construction blocked by CSP");
      if (workerFactory === null) {
        throw new Error("expected the setup worker factory");
      }
      return workerFactory();
    });

    openTestEpicTab(TAB_ID, EPIC_ID, "");
    expect(
      getEpicSessionController().readEntryStatusForTests(EPIC_ID)
        ?.constructionFailed,
    ).toBe(true);
    expect(calls).toBe(1);

    const presentations: Array<EpicSessionPresentation | null> = [];
    render(
      <TestEpicSessionTab epicId={EPIC_ID} tabId={TAB_ID}>
        <PresentationProbe
          onPresentation={(presentation) => presentations.push(presentation)}
        />
      </TestEpicSessionTab>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(presentations.at(-1)?.kind).toBe("failed");

    shouldFail = false;
    act(() => {
      presentations.at(-1)?.retry();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBeNull();
    await waitFor(() => {
      expect(presentations.at(-1)?.kind).toBe("ready");
    });
  });

  it("a claim pending across sign-out builds nothing, arms no backoff, and is released", async () => {
    const EPIC_ID = "epic-claim-across-signout";
    const TAB_ID = "tab-claim-across-signout";

    const capturedClaimResolvers: Array<
      (result: DesktopOwnershipClaimResult) => void
    > = [];
    const calls: TestDesktopBridgeCalls = {
      claims: [],
      releases: [],
      focusRequests: [],
    };
    const bridge = createTestDesktopBridge(
      calls,
      () =>
        new Promise<DesktopOwnershipClaimResult>((resolve) => {
          capturedClaimResolvers.push(resolve);
        }),
    );
    setDesktopEpicOwnershipBridge(bridge);

    try {
      resetAuth("signed-in", "alice@example.com");
      markEpicCreatedThisSession(EPIC_ID, "host-create");

      openTestEpicTab(TAB_ID, EPIC_ID, "");
      expect(calls.claims).toEqual([{ tabId: TAB_ID, epicId: EPIC_ID }]);
      expect(constructionCount).toBe(0);

      resetAuth("signed-out", null);
      disposeAllOpenEpicSessions();

      // Counted separately from `constructionCount`: this factory replaces
      // the counting one and THROWS, so a call that failed still shows up
      // here even though it built nothing - which is exactly what "no
      // construction was ever attempted" has to distinguish from "an attempt
      // failed".
      let throwingFactoryCalls = 0;
      __setEpicRuntimeWorkerFactoryForTests(() => {
        throwingFactoryCalls += 1;
        throw new Error(
          "no construction should be attempted for a claim resolved after sign-out",
        );
      });

      const settle = capturedClaimResolvers.at(0);
      if (settle === undefined) {
        throw new Error("expected a captured claim resolver");
      }
      settle({ ok: true });

      await waitFor(() => {
        expect(calls.releases).toContain(TAB_ID);
      });
      expect(constructionCount).toBe(0);
      expect(throwingFactoryCalls).toBe(0);
      expect(__getOpenEpicRegistryForTests().size()).toBe(0);

      // No backoff was armed by any of this: advancing all the way past the
      // ladder's own maximum rung produces zero further construction
      // attempts, because `signedOutFence` keeps every run key `null` until
      // the next sign-in - there is no rung to fire in the first place.
      vi.useFakeTimers();
      try {
        vi.advanceTimersByTime(SESSION_REBUILD_MAX_BACKOFF_MS);
      } finally {
        vi.useRealTimers();
      }
      expect(throwingFactoryCalls).toBe(0);
      expect(constructionCount).toBe(0);
    } finally {
      clearSessionCreatedEpics();
    }
  });

  it("cap eviction hands the claim back, and a re-shown tab re-claims and honours another window's denial", async () => {
    const EPIC_X = "epic-cap-evict-x";
    const TAB_T = "tab-cap-evict-t";
    const controller = getEpicSessionController();

    let denyT = false;
    const calls: TestDesktopBridgeCalls = {
      claims: [],
      releases: [],
      focusRequests: [],
    };
    const bridge = createTestDesktopBridge(calls, (tabId) => {
      if (tabId === TAB_T && denyT) {
        return Promise.resolve({
          ok: false,
          currentOwner: "window-other",
        });
      }
      return Promise.resolve({ ok: true });
    });
    setDesktopEpicOwnershipBridge(bridge);

    openTestEpicTab(TAB_T, EPIC_X, "Epic X");
    const detachX = controller.attachSurface(EPIC_X, TAB_T);
    await waitFor(() => {
      expect(controller.readTabSnapshot(EPIC_X, TAB_T).handle).not.toBeNull();
    });
    expect(calls.claims).toEqual([{ tabId: TAB_T, epicId: EPIC_X }]);

    // Warm: demand drops to zero and the entry suspends, but the session and
    // its desktop claim stay held - exactly what a backgrounded pane looks
    // like before the cap ever touches it.
    detachX();
    expect(__getOpenEpicRegistryForTests().peek(EPIC_X)).not.toBeNull();

    // Five OTHER epics, surfaces attached and left attached (a mounted entry
    // is never a prune candidate), so X - the only warm, demand-free entry -
    // is what the cap picks once the sixth entry crosses `maxLiveEpics` (5).
    for (let i = 0; i < 5; i += 1) {
      const otherTab = `tab-cap-evict-other-${i}`;
      const otherEpic = `epic-cap-evict-other-${i}`;
      openTestEpicTab(otherTab, otherEpic, `Other ${i}`);
      controller.attachSurface(otherEpic, otherTab);
      await waitFor(() => {
        expect(__getOpenEpicRegistryForTests().peek(otherEpic)).not.toBeNull();
      });
    }

    await waitFor(() => {
      expect(__getOpenEpicRegistryForTests().peek(EPIC_X)).toBeNull();
    });
    await waitFor(() => {
      expect(calls.releases).toContain(TAB_T);
    });

    // The tab is still open with no surface attached. Re-showing it must
    // re-claim from scratch rather than trust the ownership the cap just
    // handed back, and this window now loses that claim to another one.
    denyT = true;
    const denied: Array<{ epicId: string; tabId: string }> = [];
    const unsubscribeDenied = controller.subscribeOwnershipDenied(
      (epicId, tabId) => {
        denied.push({ epicId, tabId });
      },
    );
    try {
      controller.attachSurface(EPIC_X, TAB_T);
      // Filtered by tab id: the loop above issued its own claim per OTHER
      // epic on this same bridge, so the raw call list is not T's alone.
      const claimsForT = calls.claims.filter((call) => call.tabId === TAB_T);
      expect(claimsForT).toHaveLength(2);
      expect(claimsForT.at(-1)).toEqual({ tabId: TAB_T, epicId: EPIC_X });

      await waitFor(() => {
        expect(useEpicCanvasStore.getState().tabsById[TAB_T]).toBeUndefined();
      });
      expect(denied).toEqual([{ epicId: EPIC_X, tabId: TAB_T }]);
      await waitFor(() => {
        expect(calls.focusRequests).toContain("window-other");
      });

      expect(controller.readTabSnapshot(EPIC_X, TAB_T).handle).toBeNull();
      expect(__getOpenEpicRegistryForTests().peek(EPIC_X)).toBeNull();
    } finally {
      unsubscribeDenied();
    }
  });

  it("a stale claim reply cannot touch a tab reopened under the same id", async () => {
    const EPIC_E = "epic-stale-claim-reply";
    const TAB_S = "tab-stale-claim-sibling";
    const TAB_T = "tab-stale-claim-reopened";
    const controller = getEpicSessionController();

    const capturedClaimResolvers: Array<
      (result: DesktopOwnershipClaimResult) => void
    > = [];
    const calls: TestDesktopBridgeCalls = {
      claims: [],
      releases: [],
      focusRequests: [],
    };
    const bridge = createTestDesktopBridge(calls, (tabId) => {
      if (tabId === TAB_S) return Promise.resolve({ ok: true });
      return new Promise<DesktopOwnershipClaimResult>((resolve) => {
        capturedClaimResolvers.push(resolve);
      });
    });
    setDesktopEpicOwnershipBridge(bridge);

    openTestEpicTab(TAB_S, EPIC_E, "Sibling S");
    const detachS = controller.attachSurface(EPIC_E, TAB_S);
    await waitFor(() => {
      expect(controller.readTabSnapshot(EPIC_E, TAB_S).handle).not.toBeNull();
    });

    openTestEpicTab(TAB_T, EPIC_E, "Tab T");
    const detachT1 = controller.attachSurface(EPIC_E, TAB_T);
    expect(capturedClaimResolvers).toHaveLength(1);

    // T closes and reopens under the SAME id before its claim ever answers -
    // a new membership object, per the module's identity fence.
    detachT1();
    closeTestEpicTab(TAB_T);
    openTestEpicTab(TAB_T, EPIC_E, "Tab T");
    const detachT2 = controller.attachSurface(EPIC_E, TAB_T);
    expect(capturedClaimResolvers).toHaveLength(2);

    const denied: Array<{ epicId: string; tabId: string }> = [];
    const unsubscribeDenied = controller.subscribeOwnershipDenied(
      (epicId, tabId) => {
        denied.push({ epicId, tabId });
      },
    );
    try {
      const settleFirst = capturedClaimResolvers.at(0);
      const settleSecond = capturedClaimResolvers.at(1);
      if (settleFirst === undefined || settleSecond === undefined) {
        throw new Error("expected two captured claim resolvers");
      }
      // The STALE reply: denied, for the tab id's now-abandoned FIRST
      // membership. Nothing about the reopened tab may react to it.
      settleFirst({ ok: false, currentOwner: "window-other" });
      // The live reply: granted, for the reopened tab's own membership.
      settleSecond({ ok: true });

      await waitFor(() => {
        expect(controller.readTabSnapshot(EPIC_E, TAB_T).handle).not.toBeNull();
      });
      expect(useEpicCanvasStore.getState().openTabOrder).toContain(TAB_T);
      expect(denied).toEqual([]);
      expect(calls.focusRequests).toEqual([]);
    } finally {
      unsubscribeDenied();
      detachS();
      detachT2();
    }
  });

  it("acquired with a surface attached, detached before the title: the hold keeps the session until the title lands and renames the tab", async () => {
    const EPIC_ID = "epic-hold-survives-surface-detach";
    const TAB_ID = "tab-hold-survives-surface-detach";
    const controller = getEpicSessionController();
    const streams: ControlledEpicStream[] = [];
    installLegacyStreamFactory(streams);

    // The surface attaches FIRST, so the acquisition below happens with a
    // surface present - the metadata hold must not depend on that surface
    // once it exists, which is exactly what detaching before the title lands
    // proves.
    const detach = controller.attachSurface(EPIC_ID, TAB_ID);
    openTestEpicTab(TAB_ID, EPIC_ID, "");

    const handle = __getOpenEpicRegistryForTests().peek(EPIC_ID);
    if (handle === null) throw new Error("expected an acquired handle");
    let status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status?.hasSession).toBe(true);
    expect(status?.metadataHold).toBe(true);

    detach();

    status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status?.hasSession).toBe(true);
    expect(status?.demandHeld).toBe(true);
    expect(status?.metadataHold).toBe(true);
    expect(status?.suspended).toBe(false);

    await waitFor(() => {
      expect(streams).toHaveLength(1);
    });
    const stream = streams.at(0);
    if (stream === undefined) throw new Error("expected a stream");
    deliverSnapshot(stream, "room-hold-survives-detach");
    await seedLocalRootEdit(handle, "title", "Detached Hold Title");

    await waitFor(
      () => {
        expect(controller.readEntryStatusForTests(EPIC_ID)?.metadataHold).toBe(
          false,
        );
      },
      { timeout: 5000 },
    );
    const finalStatus = controller.readEntryStatusForTests(EPIC_ID);
    expect(finalStatus?.demandHeld).toBe(false);
    expect(finalStatus?.suspended).toBe(true);
    expect(useEpicCanvasStore.getState().tabsById[TAB_ID]?.name).toBe(
      "Detached Hold Title",
    );
  });
});

describe("session-owned write-throughs", () => {
  /** Deliberately distinct from the outer describe's "host-a": scope.hostId
   * in the write-through cache functions is `null` (any host for the user),
   * so this literal never has to match the session's own host. */
  const WRITE_THROUGH_CACHE_HOST_ID = "host-write-through-cache";

  let previousWorkerFactory: (() => RuntimeWorkerLike) | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    __getOpenEpicRegistryForTests().disposeAll();
    __resetEpicParkingForTests();
    __setAgentActivityPlaneAnsweringForTests();
    resetFakeDurableStreamTransports();
    installTestEpicSessionEnvironment(defaultTestEpicSessionEnvironment());
    setTestEffectiveHost("host-a", true);
    previousWorkerFactory = getEpicRuntimeWorkerFactoryOverride();
  });

  afterEach(() => {
    cleanup();
    __getOpenEpicRegistryForTests().disposeAll();
    resetCanvasStore();
    __resetEpicParkingForTests();
    __resetAgentActivityStoreForTests();
    useSelectionAuthorityStore.getState().reset();
    __setEpicRuntimeWorkerFactoryForTests(previousWorkerFactory);
    setDesktopEpicOwnershipBridge(null);
    resetAuth("signed-out", null);
    vi.useRealTimers();
  });

  function makeWriteThroughHistoryTask(
    id: string,
    title: string,
    createdBy: string,
  ): TaskLight {
    return {
      epic: {
        light: {
          id,
          title,
          initialUserPrompt: "Investigate the write-through",
          ticketCount: 0,
          specCount: 0,
          storyCount: 0,
          reviewCount: 0,
          status: "draft",
          createdAt: 1,
          updatedAt: 1,
          createdBy,
          version: "1",
        },
        permission: null,
        repos: [],
        workspaces: [],
        roomInfo: null,
      },
    };
  }

  function writeThroughHistoryQueryKey(userId: string): readonly unknown[] {
    return cloudEpicTasksQueryKey(
      WRITE_THROUGH_CACHE_HOST_ID,
      userId,
      LIST_CLOUD_TASKS_REQUEST,
    );
  }

  function readHistoryTitle(
    queryClient: QueryClient,
    queryKey: readonly unknown[],
  ): string | undefined {
    return queryClient.getQueryData<ListTasksResponse>(queryKey)?.tasks[0]?.epic
      ?.light?.title;
  }

  /**
   * Waits one real macrotask - long enough for any `notifyManager.schedule`
   * callback (a `setTimeout(0)`, per `@tanstack/query-core`) to run. The
   * write-throughs' Query-cache subscription reacts on that schedule, not
   * synchronously, so a "this must NOT react" pin has to let the queue drain
   * before it can trust a still-quiet cache.
   */
  async function flushQueryCacheNotifications(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  interface LiveWriteThroughSession {
    readonly epicId: string;
    readonly tabId: string;
    readonly userId: string;
    readonly queryClient: QueryClient;
    readonly queryKey: readonly unknown[];
    readonly handle: OpenEpicStoreHandle;
  }

  /**
   * A live, TITLED session with no surface ever attached: an unnamed tab
   * acquires for its metadata, then the store is written directly - the exact
   * observable `attachTabNameSync` / `attachTitleCacheSync` react to,
   * whichever pipeline produced it. The Yjs pipeline that actually generates a
   * title from a stream is pinned elsewhere in this file ("the hold ends when
   * a real title is observed…") and by test (a) below through the same
   * mechanism as every other "hold ends" test in this suite; these tests are
   * about the write-throughs the controller attaches around a title change,
   * not about how a title is generated.
   */
  function acquireLiveTitledSession(
    epicId: string,
    tabId: string,
    userId: string,
  ): LiveWriteThroughSession {
    const session = acquireLiveUntitledSession(epicId, tabId, userId);
    session.handle.store.setState((state) => ({
      epic: { ...state.epic, title: "First Title" },
    }));
    return session;
  }

  /**
   * The same session one step earlier: live, hidden, its tab unnamed and its
   * metadata hold still running, because no title has arrived yet.
   */
  function acquireLiveUntitledSession(
    epicId: string,
    tabId: string,
    userId: string,
  ): LiveWriteThroughSession {
    resetAuth("signed-in", userId);
    const queryClient = new QueryClient();
    installTestEpicSessionEnvironment({
      ...defaultTestEpicSessionEnvironment(),
      queryClient,
    });
    const queryKey = writeThroughHistoryQueryKey(userId);
    queryClient.setQueryData<ListTasksResponse>(queryKey, {
      tasks: [makeWriteThroughHistoryTask(epicId, "", userId)],
      hasMore: false,
    });

    openTestEpicTab(tabId, epicId, "");
    const handle = __getOpenEpicRegistryForTests().peek(epicId);
    if (handle === null) throw new Error("expected an acquired handle");

    handle.store.setState(LIVE_SESSION);

    return { epicId, tabId, userId, queryClient, queryKey, handle };
  }

  /**
   * Five OTHER epics, surfaces attached and left attached (a mounted entry is
   * never a prune candidate), so the registry sits at `maxLiveEpics` (5) with
   * the epic under test as its only clean idle candidate: the moment that
   * epic's demand is released, the cap takes it.
   */
  function fillRegistryToCap(label: string): void {
    const controller = getEpicSessionController();
    for (let i = 0; i < 5; i += 1) {
      const otherTab = `tab-${label}-other-${i}`;
      const otherEpic = `epic-${label}-other-${i}`;
      openTestEpicTab(otherTab, otherEpic, `Other ${i}`);
      controller.attachSurface(otherEpic, otherTab);
    }
  }

  function setDocumentTitle(handle: OpenEpicStoreHandle, title: string): void {
    handle.store.setState((state) => ({ epic: { ...state.epic, title } }));
  }

  function readTabName(tabId: string): string | undefined {
    return useEpicCanvasStore.getState().tabsById[tabId]?.name;
  }

  /**
   * Writes a NEW title through the CAPTURED (possibly stale) handle, and
   * simulates a late `epic.listTasks` fetch landing with the pre-generation
   * title - the two observables a teardown pin has to prove neither reaches.
   */
  function writeThroughOldHandle(session: LiveWriteThroughSession): void {
    // Forced LIVE in the same write: disposal may close the old handle's
    // transport, and a handle that is merely not live writes nothing either.
    // The teardown has to be the ONLY thing standing between this title and
    // the record, or these pins pass for the wrong reason.
    session.handle.store.setState((state) => ({
      ...LIVE_SESSION,
      epic: { ...state.epic, title: "Second Title" },
    }));
    session.queryClient.setQueryData<ListTasksResponse>(session.queryKey, {
      tasks: [makeWriteThroughHistoryTask(session.epicId, "", session.userId)],
      hasMore: false,
    });
  }

  /** Both subscriptions the write-through owns are gone: neither observable moved. */
  async function expectDetachedWriteThroughs(
    session: LiveWriteThroughSession,
  ): Promise<void> {
    await flushQueryCacheNotifications();
    expect(useEpicCanvasStore.getState().tabsById[session.tabId]?.name).toBe(
      "First Title",
    );
    expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe("");
  }

  interface FatalWorkerRig {
    fatal(): void;
  }

  /**
   * A worker that answers the handshake and can then die ON COMMAND - the
   * same rig the provider suite's `installWorkerWithFatalOnFirstSpawn` uses
   * for its own Retry pins, reused here with no React mounted at all: the
   * controller reaches `failConstruction` from a session a metadata hold
   * held, with no surface ever involved.
   */
  function installFatalWorkerRig(): FatalWorkerRig {
    let deliverFatal: (() => void) | null = null;
    __setEpicRuntimeWorkerFactoryForTests(() => {
      const listeners = new Set<(event: BridgeMessageEventLike) => void>();
      const deliver = (event: WorkerToMainEvent): void => {
        for (const listener of [...listeners]) {
          listener({ data: { frame: "event", event } });
        }
      };
      let answeredHandshake = false;
      deliverFatal = (): void => {
        deliver({
          kind: "fatal",
          message: "the runtime worker died",
          stack: null,
        });
      };
      return {
        postMessage: (): void => {
          if (answeredHandshake) return;
          answeredHandshake = true;
          deliver({
            kind: "ready",
            protocolVersion: RUNTIME_BRIDGE_PROTOCOL_VERSION,
          });
        },
        addEventListener: (
          _type: "message",
          listener: (event: BridgeMessageEventLike) => void,
        ): void => {
          listeners.add(listener);
        },
        removeEventListener: (
          _type: "message",
          listener: (event: BridgeMessageEventLike) => void,
        ): void => {
          listeners.delete(listener);
        },
        terminate: (): void => {},
        onWorkerFault: (): void => {},
      };
    });
    return {
      fatal: (): void => {
        if (deliverFatal === null) {
          throw new Error("the first worker was never spawned");
        }
        deliverFatal();
      },
    };
  }

  it("never-activated tab: a generated title reaches the tab record and the cached History row with no surface ever attached", () => {
    const session = acquireLiveTitledSession(
      "epic-write-through-never-activated",
      "tab-write-through-never-activated",
      "alice@example.com",
    );

    expect(useEpicCanvasStore.getState().tabsById[session.tabId]?.name).toBe(
      "First Title",
    );
    expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
      "First Title",
    );
  });

  it("a late epic.listTasks result landing after the title is re-patched back to the generated title", async () => {
    const session = acquireLiveTitledSession(
      "epic-write-through-late-list",
      "tab-write-through-late-list",
      "alice@example.com",
    );

    // What a late fetch answers: the pre-generation title, landing after the
    // session already patched the row.
    session.queryClient.setQueryData<ListTasksResponse>(session.queryKey, {
      tasks: [makeWriteThroughHistoryTask(session.epicId, "", session.userId)],
      hasMore: false,
    });

    await waitFor(() => {
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
        "First Title",
      );
    });
  });

  describe("the per-host pin reading (Current tasks local rows) takes the same title write-through", () => {
    function pinReadingKey(
      session: LiveWriteThroughSession,
    ): readonly unknown[] {
      return cloudQueryKeys.epicPinReading(
        WRITE_THROUGH_CACHE_HOST_ID,
        session.userId,
        LIST_CLOUD_TASKS_REQUEST,
        [session.epicId],
      );
    }

    function fillPinReading(
      session: LiveWriteThroughSession,
      title: string,
    ): void {
      session.queryClient.setQueryData<ListTasksResponse>(
        pinReadingKey(session),
        {
          tasks: [
            {
              ...makeWriteThroughHistoryTask(
                session.epicId,
                title,
                session.userId,
              ),
              home: "local",
            },
          ],
          hasMore: false,
        },
      );
    }

    function readPinReadingTitle(
      session: LiveWriteThroughSession,
    ): string | undefined {
      return readHistoryTitle(session.queryClient, pinReadingKey(session));
    }

    it("a title generated AFTER the reading was filled is patched into it", () => {
      const session = acquireLiveUntitledSession(
        "epic-write-through-pin-reading-fill",
        "tab-write-through-pin-reading-fill",
        "alice@example.com",
      );
      fillPinReading(session, "");

      session.handle.store.setState((state) => ({
        epic: { ...state.epic, title: "First Title" },
      }));

      expect(readPinReadingTitle(session)).toBe("First Title");
    });

    it.each([
      [
        "pin reading",
        (session: LiveWriteThroughSession): readonly unknown[] =>
          pinReadingKey(session),
      ],
      [
        "Current tasks pin tail",
        (session: LiveWriteThroughSession): readonly unknown[] =>
          cloudQueryKeys.currentTasksPinTail(
            WRITE_THROUGH_CACHE_HOST_ID,
            session.userId,
            "cursor-1",
          ),
      ],
    ])(
      "a stale %s delivered AFTER the live title is re-patched back to it",
      async (_name, keyFor) => {
        const session = acquireLiveTitledSession(
          "epic-write-through-late-derived",
          "tab-write-through-late-derived",
          "alice@example.com",
        );
        const key = keyFor(session);

        session.queryClient.setQueryData<ListTasksResponse>(key, {
          tasks: [
            makeWriteThroughHistoryTask(session.epicId, "", session.userId),
          ],
          hasMore: false,
        });

        await waitFor(() => {
          expect(readHistoryTitle(session.queryClient, key)).toBe(
            "First Title",
          );
        });
      },
    );
  });

  it("a warm, suspended session keeps writing after its metadata hold ends", () => {
    const session = acquireLiveTitledSession(
      "epic-write-through-warm-suspended",
      "tab-write-through-warm-suspended",
      "alice@example.com",
    );
    const status = getEpicSessionController().readEntryStatusForTests(
      session.epicId,
    );
    expect(status?.metadataHold).toBe(false);
    expect(status?.suspended).toBe(true);
    // Still warm in the registry - only the demand unit was handed back.
    expect(__getOpenEpicRegistryForTests().peek(session.epicId)).not.toBeNull();

    session.handle.store.setState((state) => ({
      epic: { ...state.epic, title: "Second Title" },
    }));

    expect(useEpicCanvasStore.getState().tabsById[session.tabId]?.name).toBe(
      "Second Title",
    );
    expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
      "Second Title",
    );
  });

  it("sibling seeding: a tab opened later for an already-titled epic is seeded at once", () => {
    const session = acquireLiveTitledSession(
      "epic-write-through-sibling-seed",
      "tab-write-through-sibling-seed-t1",
      "alice@example.com",
    );
    const TAB_T2 = "tab-write-through-sibling-seed-t2";

    openTestEpicTab(TAB_T2, session.epicId, "");

    expect(useEpicCanvasStore.getState().tabsById[TAB_T2]?.name).toBe(
      "First Title",
    );
  });

  describe("a session is an authority only while it is live", () => {
    it("a session that is not live never reverts a History rename, and writes what changed once it is live again", async () => {
      const session = acquireLiveTitledSession(
        "epic-write-through-stale-rename",
        "tab-write-through-stale-rename",
        "alice@example.com",
      );
      // Warm and unmounted - and now its host goes away. The session keeps
      // "First Title"; it is the stale party from here on.
      session.handle.store.setState({ hostTransportStatus: "reconnecting" });

      // The History rename, exactly as `useEpicUpdateTitle` applies it on RPC
      // success: straight into the caches, never through this session's store.
      updateEpicTitleInCloudTaskCaches(
        session.queryClient,
        { hostId: null, userId: session.userId },
        session.epicId,
        "Renamed From History",
      );
      // That patch IS a Query-cache `updated` event, which is the half that
      // re-applies the session's title over any differing row.
      await flushQueryCacheNotifications();
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
        "Renamed From History",
      );

      // Nor does the stale session's own title moving write anything.
      setDocumentTitle(session.handle, "Stale Title");
      await flushQueryCacheNotifications();
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
        "Renamed From History",
      );
      expect(readTabName(session.tabId)).toBe("First Title");

      // The host comes back and the document has caught up: what changed
      // while the gate was closed is written, to both.
      session.handle.store.setState((state) => ({
        hostTransportStatus: "open",
        epic: { ...state.epic, title: "Caught Up Title" },
      }));
      expect(readTabName(session.tabId)).toBe("Caught Up Title");
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
        "Caught Up Title",
      );
    });

    it("a title that changed while the session was not live is written when it is live again", () => {
      const session = acquireLiveTitledSession(
        "epic-write-through-reopen-changed",
        "tab-write-through-reopen-changed",
        "alice@example.com",
      );
      session.handle.store.setState({ hostTransportStatus: "reconnecting" });
      setDocumentTitle(session.handle, "Changed While Away");
      expect(readTabName(session.tabId)).toBe("First Title");
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
        "First Title",
      );

      // Reopening alone - no further title change - is what flushes it.
      session.handle.store.setState({ hostTransportStatus: "open" });

      expect(readTabName(session.tabId)).toBe("Changed While Away");
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
        "Changed While Away",
      );
    });

    it("a title that did NOT change while the session was not live is not re-written over a newer History rename when it is live again", async () => {
      const session = acquireLiveTitledSession(
        "epic-write-through-reopen-unchanged",
        "tab-write-through-reopen-unchanged",
        "alice@example.com",
      );
      session.handle.store.setState({ hostTransportStatus: "reconnecting" });
      updateEpicTitleInCloudTaskCaches(
        session.queryClient,
        { hostId: null, userId: session.userId },
        session.epicId,
        "Renamed From History",
      );
      await flushQueryCacheNotifications();
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
        "Renamed From History",
      );

      // Live again, its document still reading "First Title" - the title it
      // already wrote once. Reopening flushes what CHANGED, and nothing did.
      session.handle.store.setState({ hostTransportStatus: "open" });

      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
        "Renamed From History",
      );
      await flushQueryCacheNotifications();
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
        "Renamed From History",
      );
    });

    it("a snapshot that has not loaded writes nothing, whatever the transport says", () => {
      const session = acquireLiveUntitledSession(
        "epic-write-through-no-snapshot",
        "tab-write-through-no-snapshot",
        "alice@example.com",
      );
      session.handle.store.setState((state) => ({
        snapshotLoaded: false,
        epic: { ...state.epic, title: "Too Early" },
      }));

      expect(readTabName(session.tabId)).toBe("");
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe("");
    });
  });

  describe("the metadata hold ends when every title writer has written", () => {
    it("an early workspace-context title names the tab but does not end the hold; the document title does, and reaches History", () => {
      const session = acquireLiveUntitledSession(
        "epic-write-through-early-meta",
        "tab-write-through-early-meta",
        "alice@example.com",
      );
      const controller = getEpicSessionController();

      // `epic.getWorkspaceContext` answers before the records snapshot
      // (`applyEarlyMeta`): a real title on the LIGHT, none on the document.
      session.handle.store.setState({
        snapshotMeta: {
          ...snapshotMeta("room-write-through-early-meta"),
          epicLight: {
            id: session.epicId,
            title: "Early Meta Title",
            initialUserPrompt: "Investigate the write-through",
            ticketCount: 0,
            specCount: 0,
            storyCount: 0,
            reviewCount: 0,
            status: "draft",
            createdAt: 1,
            updatedAt: 1,
            createdBy: session.userId,
            version: "1",
          },
        },
      });

      // The tab writer takes the fallback and names the tab early...
      expect(readTabName(session.tabId)).toBe("Early Meta Title");
      // ...but the History writer is fed by the document title alone, so the
      // hold is NOT done, and its demand keeps the session through the cap.
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe("");
      expect(controller.readEntryStatusForTests(session.epicId)).toMatchObject({
        metadataHold: true,
        demandHeld: true,
      });
      fillRegistryToCap("write-through-early-meta");
      expect(
        __getOpenEpicRegistryForTests().peek(session.epicId),
      ).not.toBeNull();

      setDocumentTitle(session.handle, "Document Title");

      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe(
        "Document Title",
      );
      expect(readTabName(session.tabId)).toBe("Document Title");
      expect(
        controller.readEntryStatusForTests(session.epicId)?.metadataHold,
      ).toBe(false);
      // And only now does the cap get it.
      expect(__getOpenEpicRegistryForTests().peek(session.epicId)).toBeNull();
    });

    it("hold end flushes the write-throughs before releasing demand, whatever the subscriber order", () => {
      const session = acquireLiveUntitledSession(
        "epic-write-through-flush-order",
        "tab-write-through-flush-order",
        "alice@example.com",
      );
      const controller = getEpicSessionController();
      const TAB_SIBLING = "tab-write-through-flush-order-sibling";

      // Force the write-throughs to RE-ATTACH while the hold is running: a new
      // Query client is a new target, so they are detached and attached again
      // - which puts their store subscription AFTER the hold's. The hold's
      // callback now runs first on a title, and what it does is release the
      // demand that the cap is waiting on.
      const secondQueryClient = new QueryClient();
      secondQueryClient.setQueryData<ListTasksResponse>(session.queryKey, {
        tasks: [
          makeWriteThroughHistoryTask(session.epicId, "", session.userId),
        ],
        hasMore: false,
      });
      installTestEpicSessionEnvironment({
        ...defaultTestEpicSessionEnvironment(),
        queryClient: secondQueryClient,
      });
      openTestEpicTab(TAB_SIBLING, session.epicId, "");
      expect(
        controller.readEntryStatusForTests(session.epicId)?.metadataHold,
      ).toBe(true);
      fillRegistryToCap("write-through-flush-order");
      expect(
        __getOpenEpicRegistryForTests().peek(session.epicId),
      ).not.toBeNull();

      setDocumentTitle(session.handle, "Title Under Cap Pressure");

      // The release really happened inside that one notification...
      expect(
        controller.readEntryStatusForTests(session.epicId)?.metadataHold,
      ).toBe(false);
      expect(__getOpenEpicRegistryForTests().peek(session.epicId)).toBeNull();
      // ...and every writer had already run: the re-attached cache writer
      // (the second client, not the first) and both tab records.
      expect(readHistoryTitle(secondQueryClient, session.queryKey)).toBe(
        "Title Under Cap Pressure",
      );
      expect(readTabName(session.tabId)).toBe("Title Under Cap Pressure");
      expect(readTabName(TAB_SIBLING)).toBe("Title Under Cap Pressure");
    });

    it("the backstop ending a hold on a session that is not live writes nothing", () => {
      vi.useFakeTimers();
      const session = acquireLiveUntitledSession(
        "epic-write-through-backstop-not-live",
        "tab-write-through-backstop-not-live",
        "alice@example.com",
      );
      const controller = getEpicSessionController();

      // A real document title, on a session whose host went away: nothing a
      // writer may write, so the hold is not done either.
      session.handle.store.setState((state) => ({
        hostTransportStatus: "reconnecting",
        epic: { ...state.epic, title: "Offline Title" },
      }));
      expect(
        controller.readEntryStatusForTests(session.epicId)?.metadataHold,
      ).toBe(true);

      vi.advanceTimersByTime(TITLE_GENERATION_PENDING_TIMEOUT_MS);

      // The backstop ends it all the same, and its flush goes through the
      // same gate as every other write: a timeout does not force a stale one.
      expect(
        controller.readEntryStatusForTests(session.epicId)?.metadataHold,
      ).toBe(false);
      expect(readTabName(session.tabId)).toBe("");
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe("");
    });
  });

  describe("teardown detaches the write-throughs", () => {
    it("park: the old handle writes nothing afterward", async () => {
      // Fake timers FIRST, before the tab ever opens: the park window is
      // armed off `Date.now()` / `window.setTimeout` at tab-open, and a real
      // timer scheduled before fake timers install is invisible to
      // `vi.advanceTimersByTimeAsync` - it is a native timer the fake clock
      // never took over.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const session = acquireLiveTitledSession(
        "epic-write-through-teardown-park",
        "tab-write-through-teardown-park",
        "alice@example.com",
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      });

      expect(isEpicParked(session.epicId)).toBe(true);
      expect(__getOpenEpicRegistryForTests().peek(session.epicId)).toBeNull();

      vi.useRealTimers();
      writeThroughOldHandle(session);
      await expectDetachedWriteThroughs(session);
    });

    it("cap eviction: the old handle writes nothing afterward", async () => {
      const session = acquireLiveTitledSession(
        "epic-write-through-teardown-cap-eviction",
        "tab-write-through-teardown-cap-eviction",
        "alice@example.com",
      );
      const controller = getEpicSessionController();

      // Five OTHER epics, surfaces attached and left attached (a mounted
      // entry is never a prune candidate), so the epic under test - the only
      // warm, demand-free entry - is what the cap picks once the sixth entry
      // crosses `maxLiveEpics` (5).
      for (let i = 0; i < 5; i += 1) {
        const otherTab = `tab-write-through-evict-other-${i}`;
        const otherEpic = `epic-write-through-evict-other-${i}`;
        openTestEpicTab(otherTab, otherEpic, `Other ${i}`);
        controller.attachSurface(otherEpic, otherTab);
      }

      expect(__getOpenEpicRegistryForTests().peek(session.epicId)).toBeNull();

      writeThroughOldHandle(session);
      await expectDetachedWriteThroughs(session);
    });

    it("sign-out: the old handle writes nothing afterward, and a late list result after sign-out is not re-patched", async () => {
      const session = acquireLiveTitledSession(
        "epic-write-through-teardown-signout",
        "tab-write-through-teardown-signout",
        "alice@example.com",
      );

      disposeAllOpenEpicSessions();
      resetAuth("signed-out", null);

      expect(__getOpenEpicRegistryForTests().size()).toBe(0);

      writeThroughOldHandle(session);
      await expectDetachedWriteThroughs(session);
    });

    it("user switch without sign-out: the old handle writes nothing into the new user's caches", async () => {
      const session = acquireLiveTitledSession(
        "epic-write-through-teardown-user-switch",
        "tab-write-through-teardown-user-switch",
        "alice@example.com",
      );
      const otherUserQueryKey = writeThroughHistoryQueryKey("bob@example.com");
      session.queryClient.setQueryData<ListTasksResponse>(otherUserQueryKey, {
        tasks: [
          makeWriteThroughHistoryTask(session.epicId, "", "bob@example.com"),
        ],
        hasMore: false,
      });

      resetAuth("signed-in", "bob@example.com");

      writeThroughOldHandle(session);
      await flushQueryCacheNotifications();

      expect(useEpicCanvasStore.getState().tabsById[session.tabId]?.name).toBe(
        "First Title",
      );
      expect(readHistoryTitle(session.queryClient, session.queryKey)).toBe("");
      expect(readHistoryTitle(session.queryClient, otherUserQueryKey)).toBe("");
    });

    it("last tab close: the record is kept in tabsById, and the old handle writes nothing afterward", async () => {
      const session = acquireLiveTitledSession(
        "epic-write-through-teardown-last-tab-close",
        "tab-write-through-teardown-last-tab-close",
        "alice@example.com",
      );

      closeTestEpicTab(session.tabId);

      expect(
        getEpicSessionController().readEntryStatusForTests(session.epicId),
      ).toBeNull();
      expect(
        useEpicCanvasStore.getState().tabsById[session.tabId],
      ).not.toBeUndefined();

      writeThroughOldHandle(session);
      await expectDetachedWriteThroughs(session);
    });

    it("failed construction: the old handle writes nothing after a retry that fails to rebuild", async () => {
      const rig = installFatalWorkerRig();
      const session = acquireLiveTitledSession(
        "epic-write-through-teardown-failed-construction",
        "tab-write-through-teardown-failed-construction",
        "alice@example.com",
      );

      // Kill the live worker so the next reconcile treats the held handle as
      // a corpse - the same liveness cell `onRuntimeFatal` writes in
      // production - then force the rebuild attempt to fail.
      rig.fatal();
      __setEpicRuntimeWorkerFactoryForTests(() => {
        throw new Error("Worker construction blocked by CSP");
      });
      getEpicSessionController().retry(session.epicId);

      const status = getEpicSessionController().readEntryStatusForTests(
        session.epicId,
      );
      expect(status?.constructionFailed).toBe(true);
      expect(status?.hasSession).toBe(false);

      writeThroughOldHandle(session);
      await expectDetachedWriteThroughs(session);
    });
  });
});

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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { QueryClient } from "@tanstack/react-query";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type {
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
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
import { createInProcessEpicRuntimeWorker } from "@/stores/epics/open-epic/test-support/in-process-epic-runtime-worker";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import {
  fakeDurableStreamTransports,
  resetFakeDurableStreamTransports,
} from "@/lib/host/test-support/fake-durable-stream-transport";

import {
  defaultTestEpicSessionEnvironment,
  installTestEpicSessionEnvironment,
  openTestEpicTab,
  closeTestEpicTab,
  setTestEffectiveHost,
} from "@/lib/registries/test-support/epic-session-controller-test-support";
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
  PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS,
  PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS,
} from "@/lib/host/plan-restricted-session-rebuild-backoff";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityPlaneAnsweringForTests,
} from "@/stores/agent-activity-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";
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

// ── Mocks needed only by the React mount test ───────────────────────────────
// `TestEpicSessionTab` renders the real `<EpicSessionProvider>`, which reads
// `useNavigate()` and (through `useHostClientForHostId`) `useHostClient()` /
// `useHostBinding()` - all of which throw outside their real providers. Every
// OTHER test in this file drives the controller directly and never mounts
// anything, so these mocks are inert for them.
const authServiceStub = vi.hoisted(() => ({
  revalidateCurrentContext: () => Promise.resolve({ kind: "valid" as const }),
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
  stream.callbacks.onConnectionStatus("open", null, false);
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
    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).toBeNull();
    expect(calls).toBe(1);

    pokeCanvasStoreNoOp();
    pokeSelectionAuthorityNoOp();
    expect(calls).toBe(1);

    shouldFail = false;
    vi.advanceTimersByTime(PLAN_RESTRICTED_SESSION_REBUILD_INITIAL_BACKOFF_MS);

    expect(__getOpenEpicRegistryForTests().peek(EPIC_ID)).not.toBeNull();
    status = controller.readEntryStatusForTests(EPIC_ID);
    expect(status?.constructionFailed).toBe(false);
    expect(status?.hasSession).toBe(true);
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
        vi.advanceTimersByTime(PLAN_RESTRICTED_SESSION_REBUILD_MAX_BACKOFF_MS);
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

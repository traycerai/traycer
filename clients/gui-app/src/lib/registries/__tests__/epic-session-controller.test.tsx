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
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

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

function deliverSnapshot(stream: ControlledEpicStream, roomId: string): void {
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

  it("a record with a real name is never overwritten by the hold", async () => {
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
      "My own name",
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

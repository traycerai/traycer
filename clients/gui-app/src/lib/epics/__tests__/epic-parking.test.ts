import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetEpicParkingForTests,
  isEpicParked,
} from "@/lib/epics/epic-parking";
import { __syncEpicParkingOpenTabsForTests } from "@/lib/epics/epic-parking-open-tabs";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import {
  __resetCrossWindowEpicVisibilityForTests,
  installCrossWindowEpicVisibility,
} from "@/lib/epics/cross-window-epic-visibility";
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
import {
  publishAgentActivity,
  resetAgentActivity,
} from "@/__tests__/agent-activity-harness";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { INERT_ROOT_STATE_PORT } from "@/stores/epics/open-epic/test-support/root-state-port-fixture";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  getTileSurfaceEnvironment,
  publishTileSurfaceEnvironment,
} from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import {
  getTileSurfaceMembership,
  resetTileSurfaceMembershipForTesting,
} from "@/components/epic-canvas/surface-host/tile-surface-membership";
import { buildSyntheticTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/__tests__/synthetic-tile-surface-fixture";
import {
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import type { EpicCanvasState, EpicNodeRef } from "@/stores/epics/canvas/types";
import type {
  DesktopEpicVisibilityEntry,
  DesktopWindowsBridge,
} from "@/lib/windows/types";

// ── Shared test helpers ─────────────────────────────────────────────────────
//
// Parking's `entries` map is keyed off the epic's OPEN TAB in the canvas
// store (`useEpicCanvasStore`'s `openTabOrder`), not off a mounted surface -
// see the doc comment atop `epic-parking.ts` for why the key changed. Every
// test below registers an epic with parking by opening a real tab for it and
// forgets it by closing that tab, mirroring production exactly instead of
// standing in for it.

function resetCanvasStore(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

function openEpicTab(tabId: string, epicId: string): void {
  useEpicCanvasStore.getState().openEpicTabWithId(tabId, epicId, epicId);
  // `epic-parking-open-tabs.ts`'s module-scope `useEpicCanvasStore.subscribe`
  // re-derives parking's entries synchronously on every `setState`, so this
  // call is usually redundant. It is made explicit here anyway, matching the
  // test seam's stated purpose, and is a guaranteed no-op when the
  // subscription has already done the work.
  __syncEpicParkingOpenTabsForTests();
}

function closeEpicTab(tabId: string): void {
  useEpicCanvasStore.getState().closeTab(tabId);
  __syncEpicParkingOpenTabsForTests();
}

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function buildParkableEpicHandle(epicId: string, dirty: boolean) {
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
  if (dirty) {
    base.store.setState({ isDirty: true });
  }
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

function markAgentWorking(epicId: string, agentId: string): void {
  publishAgentActivity([
    {
      hostId: "host-parking-tests",
      byEpic: { [epicId]: { working: [agentId], turn: [agentId] } },
    },
  ]);
}

describe("epic-parking - visibility roll-up (C6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    resetCanvasStore();
    vi.useRealTimers();
  });

  it("never parks an epic that is visible in a second window", () => {
    const EPIC = "epic-park-second-window-a";
    const TAB = "tab-park-second-window-a";
    const viewA = "view-a";
    const viewB = "view-b";
    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, viewA, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 60_000);
      expect(isEpicParked(EPIC)).toBe(false);

      setEpicSurfaceVisibility(EPIC, viewB, true);
      vi.advanceTimersByTime(60_000 + PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);

      setEpicSurfaceVisibility(EPIC, viewB, false);
      setEpicSurfaceVisibility(EPIC, viewA, true);
      setEpicSurfaceVisibility(EPIC, viewB, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);
    } finally {
      closeEpicTab(TAB);
    }
  });

  it("re-bases the window on a backward clock step instead of restarting it forever", () => {
    const EPIC = "epic-park-backward-clock";
    const TAB = "tab-park-backward-clock";
    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-clock", false);
      vi.advanceTimersByTime(60_000);
      expect(isEpicParked(EPIC)).toBe(false);

      vi.setSystemTime(Date.now() - 60 * 60_000);

      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 60_000);
      expect(isEpicParked(EPIC)).toBe(false);

      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });

  it("parks once the LAST visible window of the epic goes hidden", () => {
    const EPIC = "epic-park-second-window-b";
    const TAB = "tab-park-second-window-b";
    const viewA = "view-a-last";
    const viewB = "view-b-last";
    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, viewA, true);
      setEpicSurfaceVisibility(EPIC, viewB, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);

      setEpicSurfaceVisibility(EPIC, viewA, false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 1);
      expect(isEpicParked(EPIC)).toBe(false);
      vi.advanceTimersByTime(1);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });
});

describe("epic-parking - eligibility (C1, prune's own gates)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setAgentActivityPlaneAnsweringForTests();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    resetAgentActivity();
    resetCanvasStore();
    vi.useRealTimers();
  });

  it("does not park a tab with unsynced edits", () => {
    const EPIC = "epic-park-dirty";
    const TAB = "tab-park-dirty";
    const dirty = buildParkableEpicHandle(EPIC, true);
    __getOpenEpicRegistryForTests().acquireMounted(EPIC, () => dirty.handle);

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-dirty", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(dirty.disposed).toBe(false);
      expect(__getOpenEpicRegistryForTests().get(EPIC)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  it("does not park a tab with an active agent turn", () => {
    const EPIC = "epic-park-busy";
    const TAB = "tab-park-busy";
    const busy = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(EPIC, () => busy.handle);
    markAgentWorking(EPIC, "agent-1");

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-busy", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS * 3);

      expect(isEpicParked(EPIC)).toBe(false);
      expect(busy.disposed).toBe(false);
      expect(__getOpenEpicRegistryForTests().get(EPIC)).not.toBeNull();
    } finally {
      closeEpicTab(TAB);
    }
  });

  it("parks a formerly-dirty tab once its edits settle, without a fresh hidden window", () => {
    const EPIC = "epic-park-settles";
    const TAB = "tab-park-settles";
    const th = buildParkableEpicHandle(EPIC, true);
    __getOpenEpicRegistryForTests().acquireMounted(EPIC, () => th.handle);

    openEpicTab(TAB, EPIC);
    try {
      setEpicSurfaceVisibility(EPIC, "view-settles", false);
      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);

      th.handle.store.setState({
        ...th.handle.store.getState(),
        isDirty: false,
      });

      expect(isEpicParked(EPIC)).toBe(true);
      expect(th.disposed).toBe(true);
    } finally {
      closeEpicTab(TAB);
    }
  });
});

// ── B1: the retention-pool / warm-session key ───────────────────────────────
//
// The fixup's whole reason to exist: a tab pushed out of the retention pool
// (`TopLevelTabHost`'s `retainedTopLevelSurfaces` cap) is hidden by
// definition, and its provider's `releaseMounted` drops demand to zero while
// its session stays WARM with `epic.subscribe` still open. The old
// mounted-surface key had no entry for that population at all. These pins
// build that exact shape - `acquireMounted` then `releaseMounted`, with the
// canvas tab left open throughout - and prove the OPEN-TAB key reaches it.

function chatRef(instanceId: string): EpicNodeRef {
  return {
    id: instanceId,
    instanceId,
    type: "chat",
    name: `Chat ${instanceId}`,
    hostId: TEST_HOST_ID,
  };
}

function canvasWithChat(instanceId: string, paneId: string): EpicCanvasState {
  return {
    root: pane(paneId, [instanceId]),
    activePaneId: paneId,
    tilesByInstanceId: { [instanceId]: chatRef(instanceId) },
    sizesByGroupId: {},
  };
}

function seedSingleTabStrip(
  refs: ReadonlyArray<TabRef>,
  activeRef: TabRef,
): void {
  useTabsStore.setState((state) => ({
    ...state,
    items: refs.map((ref) => ({
      kind: "tab" as const,
      id: `tab:${ref.kind}:${ref.id}`,
      ref,
    })),
    activeItemId: `tab:${activeRef.kind}:${activeRef.id}`,
    stripOrder: refs,
  }));
}

function resetTabsStore(): void {
  useTabsStore.setState(useTabsStore.getInitialState(), true);
}

describe("epic-parking - B1: retention-pool / warm-session key", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setAgentActivityPlaneAnsweringForTests();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __getOpenEpicRegistryForTests().disposeAll();
    disposeAllChatSessions();
    __resetAgentActivityStoreForTests();
    resetTileSurfaceMembershipForTesting();
    resetTabsStore();
    resetCanvasStore();
    vi.useRealTimers();
  });

  it("parks a warm (unmounted, undisposed) session: releases the epic session, its chat lease and its hosted-surface membership", () => {
    const EPIC = "epic-warm-park-positive";
    const TAB = "tab-warm-park-positive";
    const CHAT_ID = "chat-warm-park-positive";
    const HOST_ID = "host-warm-park-positive";
    const INSTANCE_ID = "chat-inst-warm-park-positive";

    // Canvas + tab-strip setup so the epic also holds a hosted-surface
    // membership record to release.
    useEpicCanvasStore.setState({
      tabsById: { [TAB]: { tabId: TAB, epicId: EPIC, name: "Warm park" } },
      canvasByTabId: { [TAB]: canvasWithChat(INSTANCE_ID, "p1") },
      openTabOrder: [TAB],
      activeTabId: TAB,
    });
    seedSingleTabStrip([{ kind: "epic", id: TAB }], { kind: "epic", id: TAB });
    __syncEpicParkingOpenTabsForTests();
    expect(getTileSurfaceMembership().has(INSTANCE_ID)).toBe(true);
    publishTileSurfaceEnvironment(
      buildSyntheticTileSurfaceEnvironment(INSTANCE_ID, {}),
    );
    expect(getTileSurfaceEnvironment(INSTANCE_ID)).not.toBeNull();

    // Mounted, then unmounted: the surface went away (retention-pool
    // eviction) but the session stays warm - `acquireMounted` +
    // `releaseMounted`, never `release`.
    const epicHandle = buildParkableEpicHandle(EPIC, false);
    __getOpenEpicRegistryForTests().acquireMounted(
      EPIC,
      () => epicHandle.handle,
    );
    __getOpenEpicRegistryForTests().releaseMounted(EPIC);

    // Positive pre-assertion: the warm state genuinely exists before the
    // clock advances at all, so a park succeeding below is evidence of a
    // release rather than of `park()`'s "no entry -> true" default.
    expect(__getOpenEpicRegistryForTests().get(EPIC)).not.toBeNull();
    expect(__getOpenEpicRegistryForTests().size()).toBe(1);

    const chatHandle = createChatSessionStore({
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      hostId: HOST_ID,
      epicId: EPIC,
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
    const chatRegistry = __getChatSessionRegistryForTests();
    chatRegistry.acquire(
      {
        epicId: EPIC,
        chatId: CHAT_ID,
        hostId: HOST_ID,
        scopeKey: "warm-park-scope",
      },
      () => chatHandle,
    );
    expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).not.toBeNull();

    vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS);

    expect(isEpicParked(EPIC)).toBe(true);
    // The session is released: disposed, and gone from the registry.
    expect(epicHandle.disposed).toBe(true);
    expect(__getOpenEpicRegistryForTests().get(EPIC)).toBeNull();
    // The chat lease is gone - `chat-session-registry.ts`'s module-scope
    // `subscribeEpicParking` listener called `disposeForEpic`.
    expect(chatRegistry.peek(EPIC, CHAT_ID, HOST_ID)).toBeNull();
    // The hosted-surface membership record is dropped, not merely
    // unpresented.
    expect(getTileSurfaceMembership().has(INSTANCE_ID)).toBe(false);
    expect(getTileSurfaceEnvironment(INSTANCE_ID)).toBeNull();
  });

  it("at 4:59 the warm session is untouched, and a remount reuses the SAME handle", () => {
    const EPIC = "epic-warm-park-negative";
    const TAB = "tab-warm-park-negative";
    openEpicTab(TAB, EPIC);
    try {
      const epicHandle = buildParkableEpicHandle(EPIC, false);
      __getOpenEpicRegistryForTests().acquireMounted(
        EPIC,
        () => epicHandle.handle,
      );
      __getOpenEpicRegistryForTests().releaseMounted(EPIC);

      expect(__getOpenEpicRegistryForTests().get(EPIC)).not.toBeNull();
      expect(__getOpenEpicRegistryForTests().size()).toBe(1);

      vi.advanceTimersByTime(PARK_HIDDEN_EPIC_AFTER_MS - 1_000);

      // Synchronous, right after advancing - not behind an await.
      expect(isEpicParked(EPIC)).toBe(false);
      const otherHandle = buildParkableEpicHandle(`${EPIC}-other`, false);
      const remounted = __getOpenEpicRegistryForTests().acquireMounted(
        EPIC,
        () => otherHandle.handle,
      );
      expect(remounted).toBe(epicHandle.handle);
      // The factory that would have built a different handle was never
      // adopted - proof this was the warm handle, not a rebuild.
      expect(otherHandle.disposed).toBe(false);
      expect(epicHandle.disposed).toBe(false);
    } finally {
      __getOpenEpicRegistryForTests().releaseMounted(EPIC);
      closeEpicTab(TAB);
    }
  });
});

// ── B2: cross-window visibility ─────────────────────────────────────────────
//
// `epicVisibility` carries a THIRD method, `snapshot()`, alongside `report`
// and `onChange`: main replays its per-window map on the SYNC `windowId`
// read the preload performs while constructing the bridge, which has already
// happened by the time `installCrossWindowEpicVisibility` runs and subscribes
// via `onChange` - so the install effect seeds itself from an explicit
// `snapshot()` call instead, discarded if a live `onChange` fan-out has
// already landed by the time it resolves (`lifecycle.fanOutSeen`).
//
// Every test's `snapshot()` resolves as a real Promise, so every test body is
// `async` and flushes it with `await vi.advanceTimersByTimeAsync(0)` right
// after install, before driving `onChange` or advancing the park window - the
// same reason production reads `snapshot()` as a Promise in the first place.

function fakeEpicVisibilityChannel(
  snapshotEntries: readonly DesktopEpicVisibilityEntry[] = [],
): {
  readonly channel: NonNullable<DesktopWindowsBridge["epicVisibility"]>;
  readonly emit: (entries: readonly DesktopEpicVisibilityEntry[]) => void;
  /** Every roll-up this window pushed to main, in order. */
  readonly reports: ReadonlyArray<readonly string[]>;
} {
  let handler:
    | ((entries: readonly DesktopEpicVisibilityEntry[]) => void)
    | null = null;
  const reports: Array<readonly string[]> = [];
  return {
    reports,
    channel: {
      report: (epicIds) => {
        reports.push([...epicIds].sort());
        return Promise.resolve();
      },
      snapshot: () => Promise.resolve(snapshotEntries),
      onChange: (nextHandler) => {
        handler = nextHandler;
        return {
          dispose: () => {
            handler = null;
          },
        };
      },
    },
    emit: (entries) => handler?.(entries),
  };
}

/**
 * A channel whose `snapshot()` only resolves when `resolveSnapshot` is
 * called - for the "a live `onChange` pre-empts a slower `snapshot`" race,
 * driven explicitly rather than hoping real timing falls out right.
 */
function deferredEpicVisibilityChannel(): {
  readonly channel: NonNullable<DesktopWindowsBridge["epicVisibility"]>;
  readonly emit: (entries: readonly DesktopEpicVisibilityEntry[]) => void;
  readonly resolveSnapshot: (
    entries: readonly DesktopEpicVisibilityEntry[],
  ) => void;
} {
  let handler:
    | ((entries: readonly DesktopEpicVisibilityEntry[]) => void)
    | null = null;
  let resolveDeferred:
    | ((entries: readonly DesktopEpicVisibilityEntry[]) => void)
    | null = null;
  const snapshotPromise = new Promise<readonly DesktopEpicVisibilityEntry[]>(
    (resolve) => {
      resolveDeferred = resolve;
    },
  );
  return {
    channel: {
      report: () => Promise.resolve(),
      snapshot: () => snapshotPromise,
      onChange: (nextHandler) => {
        handler = nextHandler;
        return {
          dispose: () => {
            handler = null;
          },
        };
      },
    },
    emit: (entries) => handler?.(entries),
    resolveSnapshot: (entries) => resolveDeferred?.(entries),
  };
}

function fakeDesktopWindowsBridge(
  windowId: string,
  epicVisibility: DesktopWindowsBridge["epicVisibility"],
): DesktopWindowsBridge {
  return {
    windowId,
    list: () => Promise.resolve([]),
    onChange: () => ({ dispose: () => undefined }),
    requestNew: () => Promise.resolve(),
    requestFocus: () => Promise.resolve(),
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: () =>
      Promise.resolve({ result: "moved" as const, windowId: "window-other" }),
    ownership: {
      snapshot: () => Promise.resolve([]),
      claim: () => Promise.resolve({ ok: true as const }),
      release: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    epicVisibility,
    perWindowState: {
      get: () =>
        Promise.resolve({
          epicTabs: [],
          activeTabId: null,
          canvasByTabId: {},
          landingDrafts: [],
          activeLandingDraftId: null,
        }),
      update: () => Promise.resolve(),
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

describe("epic-parking - B2: cross-window visibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetEpicParkingForTests();
    __resetCrossWindowEpicVisibilityForTests();
    resetCanvasStore();
    vi.useRealTimers();
  });

  it("does not park an epic another window is showing", async () => {
    const EPIC = "epic-cross-window-visible-elsewhere";
    const TAB = "tab-cross-window-visible-elsewhere";
    const { channel, emit } = fakeEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    await vi.advanceTimersByTimeAsync(0);
    openEpicTab(TAB, EPIC);
    try {
      // A foreign window (not "window-a") reports this epic visible.
      emit([{ windowId: "window-b", epicIds: [EPIC] }]);
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });

  // Single-process bound, stated plainly: this exercises window A's own read
  // of an EMPTY foreign-visibility map - the only shape a real second window
  // reporting itself hidden can actually produce over this channel, since a
  // hidden window reports no epics at all rather than a negative entry.
  it("parks an epic that is hidden everywhere the cross-window map can prove", async () => {
    const EPIC = "epic-cross-window-hidden-both";
    const TAB = "tab-cross-window-hidden-both";
    const { channel } = fakeEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    await vi.advanceTimersByTimeAsync(0);
    openEpicTab(TAB, EPIC);
    try {
      // No entries reported for this epic from anywhere.
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });

  // The OUTBOUND leg. Everything else in this describe drives the channel's
  // inbound half, so cutting `subscribeEpicSurfaceVisibility(report)` out of
  // `installCrossWindowEpicVisibility` reddened nothing - and that cut is
  // exactly what makes every OTHER window blind to this one, which is the
  // failure the channel exists to prevent. Nobody can pin it from the far
  // side, because there is only one renderer in a test.
  it("pushes this window's own roll-up at install and on every local visibility edge", async () => {
    const EPIC_A = "epic-cross-window-report-a";
    const EPIC_B = "epic-cross-window-report-b";
    const { channel, reports } = fakeEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      // The install-time push: a restored window mounts its surfaces before
      // this runs, so the set it is already showing arrives on no edge.
      // Asserted by COUNT, and the epics by membership below, because
      // `surface-host-opened-tab.ts`'s visible-view map is module state with
      // no reset - an earlier test in this file can leave a view behind.
      expect(reports).toHaveLength(1);
      expect(reports.at(-1)).not.toContain(EPIC_A);

      setEpicSurfaceVisibility(EPIC_A, "view-report-a", true);
      expect(reports).toHaveLength(2);
      expect(reports.at(-1)).toContain(EPIC_A);

      setEpicSurfaceVisibility(EPIC_B, "view-report-b", true);
      expect(reports).toHaveLength(3);
      expect(reports.at(-1)).toContain(EPIC_A);
      expect(reports.at(-1)).toContain(EPIC_B);

      // Hiding is an edge like any other - main must be told the set SHRANK,
      // or the other windows keep reading this epic as shown here for ever.
      setEpicSurfaceVisibility(EPIC_A, "view-report-a", false);
      expect(reports).toHaveLength(4);
      expect(reports.at(-1)).not.toContain(EPIC_A);
      expect(reports.at(-1)).toContain(EPIC_B);
    } finally {
      setEpicSurfaceVisibility(EPIC_B, "view-report-b", false);
      uninstall();
    }
  });

  it("does not count window A's own reported row as foreign visibility", async () => {
    const EPIC = "epic-cross-window-own-row";
    const TAB = "tab-cross-window-own-row";
    const { channel, emit } = fakeEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    await vi.advanceTimersByTimeAsync(0);
    openEpicTab(TAB, EPIC);
    try {
      // Only window A's OWN id names the epic - `foreignVisibleEpics` must
      // exclude it, so this must NOT suppress the park.
      emit([{ windowId: "window-a", epicIds: [EPIC] }]);
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });

  it("degrades gracefully with no epicVisibility channel (older preload / browser): parking still runs off local visibility alone", async () => {
    const EPIC = "epic-cross-window-no-channel";
    const TAB = "tab-cross-window-no-channel";
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", undefined),
    );
    openEpicTab(TAB, EPIC);
    try {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });

  it("seeds the cross-window answer from snapshot() before any onChange fan-out arrives", async () => {
    const EPIC = "epic-cross-window-snapshot-seed";
    const TAB = "tab-cross-window-snapshot-seed";
    // snapshot() resolves immediately, naming a foreign window already
    // showing this epic - no onChange call ever fires in this test.
    const { channel } = fakeEpicVisibilityChannel([
      { windowId: "window-b", epicIds: [EPIC] },
    ]);
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    // Flush the snapshot's `.then` before opening the tab (hidden-from-birth
    // arms immediately), so the seeded answer is in place from the start.
    await vi.advanceTimersByTimeAsync(0);
    openEpicTab(TAB, EPIC);
    try {
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(false);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });

  it("discards a snapshot() that resolves after a live onChange has already landed", async () => {
    const EPIC = "epic-cross-window-stale-snapshot";
    const TAB = "tab-cross-window-stale-snapshot";
    const { channel, emit, resolveSnapshot } = deferredEpicVisibilityChannel();
    const uninstall = installCrossWindowEpicVisibility(
      fakeDesktopWindowsBridge("window-a", channel),
    );
    openEpicTab(TAB, EPIC);
    try {
      // The live fan-out lands FIRST, with no window showing the epic.
      emit([]);
      // The slower snapshot resolves AFTER it, with a STALE map that would
      // otherwise regress the answer back to "visible elsewhere".
      resolveSnapshot([{ windowId: "window-b", epicIds: [EPIC] }]);
      await vi.advanceTimersByTimeAsync(0);

      // The live answer must win: the epic is not visible anywhere, so it
      // still parks on schedule.
      await vi.advanceTimersByTimeAsync(PARK_HIDDEN_EPIC_AFTER_MS);
      expect(isEpicParked(EPIC)).toBe(true);
    } finally {
      closeEpicTab(TAB);
      uninstall();
    }
  });
});

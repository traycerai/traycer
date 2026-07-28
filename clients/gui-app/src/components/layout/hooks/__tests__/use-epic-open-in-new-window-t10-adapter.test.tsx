/**
 * T10: grouped-move adapter (renderer-only; the move IPC itself is
 * UNCHANGED - `requestOpenEpicInNewWindow` stays exactly as it was). Drives
 * the real `useEpicOpenInNewWindowFlow` hook against real
 * `useTabsStore`/`useEpicCanvasStore` state and a REAL
 * `installDesktopTabsPersistence` controller (not a bare-function proxy),
 * with a controllable ownership bridge, to prove the adapter's race
 * guarantees at the actual production callsite:
 *  - cancel/wait-never-separates
 *  - separate-before-flush-before-move ordering (the T4 move barrier)
 *  - abort-on-ref-change-during-await
 *  - non-moved/failure leaves two valid ordinary tabs
 *  - post-success removal routes through the coordinator
 */
import "../../../../../__tests__/test-browser-apis";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useEpicOpenInNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";
import type { EpicNewWindowFlow } from "@/components/layout/hooks/use-epic-open-in-new-window";
import { setDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import type {
  DesktopOpenEpicInNewWindowResult,
  DesktopPerWindowSnapshot,
  DesktopPerWindowStateUpdateAcknowledgement,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";
import {
  clearDesktopTabsPersistence,
  installDesktopTabsPersistence,
  shouldApplyDesktopTabsSnapshot,
  updateDesktopTabsActiveRoute,
} from "@/stores/tabs/desktop-tabs-persistence";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  registerTabStructuralLockPredicate,
  resetTabStructuralLockForTesting,
} from "@/stores/tabs/tab-structural-lock";
import type { TabRef } from "@/stores/tabs/types";

const CAPABILITIES = {
  schemaVersion: 2,
  features: ["tab-strip-layout-v2", "active-route-v1"],
} as const;

const MOVING: TabRef = { kind: "epic", id: "moving-tab" };
const PARTNER: TabRef = { kind: "epic", id: "partner-tab" };
const MOVING_ROUTE = "/epics/epic-moving/moving-tab";

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function registerDirtySession(epicId: string): void {
  const handle = createOpenEpicStore({
    epicId,
    streamClientFactory: fakeStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
  handle.store.setState({ isDirty: true });
  __getOpenEpicRegistryForTests().acquire(epicId, () => handle);
}

function emptySnapshot(): DesktopPerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
    tabStripLayout: null,
    activeRoute: null,
  };
}

interface DeferredWrite {
  readonly resolve: (ack: DesktopPerWindowStateUpdateAcknowledgement) => void;
  readonly reject: (error: Error) => void;
}

/** A real, controllable T4 persistence bridge - `update()` stays pending
 * until the test explicitly resolves or rejects it, so ordering against the
 * move IPC - and genuine write-failure handling - can be observed directly
 * instead of inferred from timing. */
function installControllableDesktopTabsPersistence(): DeferredWrite {
  let resolveLatest:
    ((ack: DesktopPerWindowStateUpdateAcknowledgement) => void) | null = null;
  let rejectLatest: ((error: Error) => void) | null = null;
  installDesktopTabsPersistence(
    {
      perWindowState: {
        get: () => Promise.resolve(emptySnapshot()),
        capabilities: () => Promise.resolve(CAPABILITIES),
        update: () =>
          new Promise<DesktopPerWindowStateUpdateAcknowledgement>(
            (resolve, reject) => {
              resolveLatest = resolve;
              rejectLatest = reject;
            },
          ),
        onChange: () => ({ dispose: () => undefined }),
      },
    },
    0,
  );
  // The controller only schedules a write when the active route is
  // coherent with the current layout (`isProjectionCoherent`) - match the
  // harness's route so `separateBeforeMove`'s mutation genuinely engages
  // the debounce/flush machinery instead of the barrier silently
  // no-opping.
  updateDesktopTabsActiveRoute(MOVING_ROUTE);
  return {
    resolve: (ack) => resolveLatest?.(ack),
    reject: (error) => rejectLatest?.(error),
  };
}

interface ControllableWindowsBridge {
  readonly bridge: DesktopWindowsBridge;
  readonly openInNewWindowCalls: Array<{
    readonly epicId: string;
    readonly title: string;
    readonly tabId: string;
  }>;
  resolveOpenInNewWindow(result: DesktopOpenEpicInNewWindowResult): void;
}

function createControllableWindowsBridge(): ControllableWindowsBridge {
  const openInNewWindowCalls: ControllableWindowsBridge["openInNewWindowCalls"] =
    [];
  let resolveLatest:
    ((result: DesktopOpenEpicInNewWindowResult) => void) | null = null;
  const bridge: DesktopWindowsBridge = {
    windowId: "window-a",
    list: () => Promise.resolve([]),
    onChange: () => ({ dispose: () => undefined }),
    requestNew: () => Promise.resolve(),
    requestFocus: () => Promise.resolve(),
    requestClose: () => Promise.resolve(),
    requestOpenEpicInNewWindow: (
      epicId: string,
      title: string,
      tabId: string,
    ) => {
      openInNewWindowCalls.push({ epicId, title, tabId });
      return new Promise<DesktopOpenEpicInNewWindowResult>((resolve) => {
        resolveLatest = resolve;
      });
    },
    ownership: {
      snapshot: () => Promise.resolve([]),
      claim: () => Promise.resolve({ ok: true }),
      release: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    perWindowState: {
      get: () => Promise.resolve(emptySnapshot()),
      update: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
    authSession: {
      get: () =>
        Promise.resolve({ status: "signed-out", token: null, profile: null }),
      set: () => Promise.resolve(),
      onChange: () => ({ dispose: () => undefined }),
    },
  };
  return {
    bridge,
    openInNewWindowCalls,
    resolveOpenInNewWindow: (result) => resolveLatest?.(result),
  };
}

function seedPairedSplit(): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [MOVING.id]: { tabId: MOVING.id, epicId: "epic-moving", name: "Moving" },
      [PARTNER.id]: {
        tabId: PARTNER.id,
        epicId: "epic-partner",
        name: "Partner",
      },
    },
    openTabOrder: [MOVING.id, PARTNER.id],
    activeTabId: MOVING.id,
  });
  useTabsStore.setState({
    version: 2,
    items: [
      {
        kind: "split",
        id: "split-move",
        left: { kind: "tab", ref: MOVING },
        right: { kind: "tab", ref: PARTNER },
        focusedSide: "left",
        routeBackingSide: "left",
        leftRatio: 0.5,
      },
    ],
    activeItemId: "split-move",
    stripOrder: [MOVING, PARTNER],
    systemTabs: { history: null, settings: null },
  });
}

let flowRef: EpicNewWindowFlow | null = null;

function FlowHarness(): ReactNode {
  const flow = useEpicOpenInNewWindowFlow();
  useEffect(() => {
    flowRef = flow;
  });
  return null;
}

function renderFlow() {
  const rootRoute = createRootRoute({ component: FlowHarness });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({
      initialEntries: [MOVING_ROUTE],
    }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("T10: grouped-move adapter (use-epic-open-in-new-window-flow)", () => {
  beforeEach(() => {
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    __getOpenEpicRegistryForTests().disposeAll();
    resetTabStructuralLockForTesting();
    flowRef = null;
  });

  afterEach(() => {
    cleanup();
    setDesktopEpicOwnershipBridge(null);
    clearDesktopTabsPersistence();
    __getOpenEpicRegistryForTests().disposeAll();
    resetTabStructuralLockForTesting();
    vi.restoreAllMocks();
  });

  it("never separates a tab that is only pending or queued behind the unsynced-edit gate", async () => {
    seedPairedSplit();
    registerDirtySession("epic-moving");
    const windows = createControllableWindowsBridge();
    setDesktopEpicOwnershipBridge(windows.bridge);
    installControllableDesktopTabsPersistence();
    const separateSpy = vi.spyOn(tabCommandCoordinator, "separateBeforeMove");
    renderFlow();
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({
        epicId: "epic-moving",
        tabId: MOVING.id,
        title: "Moving",
      });
    });
    expect(flowRef?.pendingMove).toEqual({
      epicId: "epic-moving",
      tabId: MOVING.id,
      title: "Moving",
    });
    expect(separateSpy).not.toHaveBeenCalled();

    act(() => {
      flowRef?.waitForSync();
    });
    // Still dirty - queued, not executed.
    await flush();
    expect(separateSpy).not.toHaveBeenCalled();
    expect(windows.openInNewWindowCalls).toEqual([]);

    act(() => {
      flowRef?.cancelMove();
    });
    await flush();
    expect(separateSpy).not.toHaveBeenCalled();
  });

  it("separates synchronously and awaits the flush acknowledgement BEFORE the move IPC fires", async () => {
    seedPairedSplit();
    const windows = createControllableWindowsBridge();
    setDesktopEpicOwnershipBridge(windows.bridge);
    const persistence = installControllableDesktopTabsPersistence();

    renderFlow();
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({
        epicId: "epic-moving",
        tabId: MOVING.id,
        title: "Moving",
      });
    });

    // Step 2 (separate) is synchronous - the split is gone from the layout
    // immediately, before any await resolves.
    expect(useTabsStore.getState().items).toEqual([
      { kind: "tab", id: "tab:epic:moving-tab", ref: MOVING },
      { kind: "tab", id: "tab:epic:partner-tab", ref: PARTNER },
    ]);

    // Give the adapter's microtasks a few turns - it must still be waiting
    // on the (unresolved) flush, so the move IPC has NOT fired yet.
    await flush();
    expect(windows.openInNewWindowCalls).toEqual([]);

    // Acknowledge the flush - only now should the move IPC fire.
    act(() => {
      persistence.resolve({ capabilities: CAPABILITIES, revision: 1 });
    });
    await flush();
    expect(windows.openInNewWindowCalls).toEqual([
      { epicId: "epic-moving", title: "Moving", tabId: MOVING.id },
    ]);
  });

  it("aborts cleanly and never calls the move IPC if the tab is closed while the flush is in flight", async () => {
    seedPairedSplit();
    const windows = createControllableWindowsBridge();
    setDesktopEpicOwnershipBridge(windows.bridge);
    const persistence = installControllableDesktopTabsPersistence();

    renderFlow();
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({
        epicId: "epic-moving",
        tabId: MOVING.id,
        title: "Moving",
      });
    });
    await flush();
    expect(windows.openInNewWindowCalls).toEqual([]);

    // Something else closes the tab while the flush is still pending.
    act(() => {
      useEpicCanvasStore.getState().closeTab(MOVING.id);
    });

    act(() => {
      persistence.resolve({ capabilities: CAPABILITIES, revision: 1 });
    });
    await flush();

    // The revalidation must catch the closed ref and abort before spending
    // the move IPC round-trip.
    expect(windows.openInNewWindowCalls).toEqual([]);
  });

  it("aborts cleanly and never calls the move IPC if the tab becomes structurally locked while the flush is in flight", async () => {
    seedPairedSplit();
    const windows = createControllableWindowsBridge();
    setDesktopEpicOwnershipBridge(windows.bridge);
    const persistence = installControllableDesktopTabsPersistence();

    renderFlow();
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({
        epicId: "epic-moving",
        tabId: MOVING.id,
        title: "Moving",
      });
    });
    await flush();

    const unregister = registerTabStructuralLockPredicate(
      (ref) => ref.kind === MOVING.kind && ref.id === MOVING.id,
    );
    act(() => {
      persistence.resolve({ capabilities: CAPABILITIES, revision: 1 });
    });
    await flush();

    expect(windows.openInNewWindowCalls).toEqual([]);
    unregister();
  });

  it("a non-'moved' result leaves both tabs open and ordinary, and never removes anything", async () => {
    seedPairedSplit();
    const windows = createControllableWindowsBridge();
    setDesktopEpicOwnershipBridge(windows.bridge);
    const persistence = installControllableDesktopTabsPersistence();
    const removeMovedRefSpy = vi.spyOn(tabCommandCoordinator, "removeMovedRef");

    renderFlow();
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({
        epicId: "epic-moving",
        tabId: MOVING.id,
        title: "Moving",
      });
    });
    await flush();

    act(() => {
      persistence.resolve({ capabilities: CAPABILITIES, revision: 1 });
    });
    await flush();
    // The move IPC really was reached this time - not a vacuous pass.
    expect(windows.openInNewWindowCalls).toEqual([
      { epicId: "epic-moving", title: "Moving", tabId: MOVING.id },
    ]);

    act(() => {
      windows.resolveOpenInNewWindow({
        result: "focused",
        windowId: "window-existing",
      });
    });
    await flush();

    expect(removeMovedRefSpy).not.toHaveBeenCalled();
    expect(useEpicCanvasStore.getState().tabsById[MOVING.id]).toBeDefined();
    expect(useEpicCanvasStore.getState().tabsById[PARTNER.id]).toBeDefined();
    // Two valid ordinary (separated) tabs - not restored to the original
    // pairing, not removed.
    expect(useTabsStore.getState().items).toEqual([
      { kind: "tab", id: "tab:epic:moving-tab", ref: MOVING },
      { kind: "tab", id: "tab:epic:partner-tab", ref: PARTNER },
    ]);
  });

  it("a 'moved' result routes post-move removal through tabCommandCoordinator.removeMovedRef", async () => {
    seedPairedSplit();
    const windows = createControllableWindowsBridge();
    setDesktopEpicOwnershipBridge(windows.bridge);
    const persistence = installControllableDesktopTabsPersistence();
    const removeMovedRefSpy = vi.spyOn(tabCommandCoordinator, "removeMovedRef");

    renderFlow();
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({
        epicId: "epic-moving",
        tabId: MOVING.id,
        title: "Moving",
      });
    });
    await flush();

    act(() => {
      persistence.resolve({ capabilities: CAPABILITIES, revision: 1 });
    });
    await flush();

    act(() => {
      windows.resolveOpenInNewWindow({
        result: "moved",
        windowId: "window-b",
      });
    });
    await flush();

    expect(removeMovedRefSpy).toHaveBeenCalledWith(MOVING);
    expect(useEpicCanvasStore.getState().tabsById[MOVING.id]).toBeUndefined();
    expect(useTabsStore.getState().items).toEqual([
      { kind: "tab", id: "tab:epic:partner-tab", ref: PARTNER },
    ]);
  });

  it("aborts the move on a genuine flush failure, leaves two ordinary separated tabs, and blocks a later snapshot echo from restoring the pre-separation group", async () => {
    seedPairedSplit();
    const windows = createControllableWindowsBridge();
    setDesktopEpicOwnershipBridge(windows.bridge);
    const persistence = installControllableDesktopTabsPersistence();

    renderFlow();
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({
        epicId: "epic-moving",
        tabId: MOVING.id,
        title: "Moving",
      });
    });
    await flush();
    expect(windows.openInNewWindowCalls).toEqual([]);

    // The separation write genuinely fails (e.g. main rejected the IPC).
    act(() => {
      persistence.reject(new Error("perWindowState.update rejected"));
    });
    await flush();

    // The move never proceeds - no IPC call spent on an unconfirmed
    // separation.
    expect(windows.openInNewWindowCalls).toEqual([]);
    // The in-memory separation itself is NOT reverted - both tabs remain
    // open, ordinary, and un-regrouped.
    expect(useTabsStore.getState().items).toEqual([
      { kind: "tab", id: "tab:epic:moving-tab", ref: MOVING },
      { kind: "tab", id: "tab:epic:partner-tab", ref: PARTNER },
    ]);

    // A later main-pushed snapshot - even one carrying a revision far
    // beyond anything ever acknowledged - must never be eligible for
    // application. The controller permanently desyncs its sequence
    // counters after a failed write, which is exactly what stops a stale
    // snapshot from echoing the pre-separation pairing back through
    // `windows-bridge-provider.tsx`'s `shouldApplyDesktopTabsSnapshot`
    // gate.
    const staleSnapshot: DesktopPerWindowSnapshot = {
      ...emptySnapshot(),
      revision: 999,
    };
    expect(shouldApplyDesktopTabsSnapshot(staleSnapshot)).toBe(false);
  });

  it("proceeds with the move when no persistence controller is installed at all (protected-test parity)", async () => {
    seedPairedSplit();
    const windows = createControllableWindowsBridge();
    setDesktopEpicOwnershipBridge(windows.bridge);
    // Deliberately do NOT install a persistence controller - mirrors
    // `desktop-dialog-host.test.tsx`'s fixture, which never installs one.

    renderFlow();
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({
        epicId: "epic-moving",
        tabId: MOVING.id,
        title: "Moving",
      });
    });
    await flush();

    // No controller to wait on - the move IPC fires without ever blocking
    // on a flush.
    expect(windows.openInNewWindowCalls).toEqual([
      { epicId: "epic-moving", title: "Moving", tabId: MOVING.id },
    ]);
  });

  it("aborts cleanly and never calls the move IPC if the tab is re-paired into a new split while the flush is in flight", async () => {
    seedPairedSplit();
    const windows = createControllableWindowsBridge();
    setDesktopEpicOwnershipBridge(windows.bridge);
    const persistence = installControllableDesktopTabsPersistence();

    renderFlow();
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({
        epicId: "epic-moving",
        tabId: MOVING.id,
        title: "Moving",
      });
    });
    await flush();
    expect(windows.openInNewWindowCalls).toEqual([]);

    // Step 2 separated MOVING into a bare tab item. Something else re-pairs
    // it into a brand-new split with a third tab while the flush await is
    // still in flight.
    const THIRD: TabRef = { kind: "epic", id: "third-tab" };
    act(() => {
      useEpicCanvasStore.setState({
        tabsById: {
          [MOVING.id]: {
            tabId: MOVING.id,
            epicId: "epic-moving",
            name: "Moving",
          },
          [PARTNER.id]: {
            tabId: PARTNER.id,
            epicId: "epic-partner",
            name: "Partner",
          },
          [THIRD.id]: {
            tabId: THIRD.id,
            epicId: "epic-third",
            name: "Third",
          },
        },
        openTabOrder: [MOVING.id, PARTNER.id, THIRD.id],
      });
      useTabsStore.setState({
        items: [
          {
            kind: "split",
            id: "split-repaired",
            left: { kind: "tab", ref: MOVING },
            right: { kind: "tab", ref: THIRD },
            focusedSide: "left",
            routeBackingSide: "left",
            leftRatio: 0.5,
          },
          { kind: "tab", id: "tab:epic:partner-tab", ref: PARTNER },
        ],
        activeItemId: "split-repaired",
      });
    });

    act(() => {
      persistence.resolve({ capabilities: CAPABILITIES, revision: 1 });
    });
    await flush();

    // The revalidation must catch the re-pair and abort before spending
    // the move IPC round-trip.
    expect(windows.openInNewWindowCalls).toEqual([]);
  });

  it("aborts cleanly before the flush barrier if separateBeforeMove refuses because the split partner is structurally locked", async () => {
    seedPairedSplit();
    const windows = createControllableWindowsBridge();
    setDesktopEpicOwnershipBridge(windows.bridge);
    // Deliberately no persistence controller here: `separateBeforeMove`
    // refuses without mutating `useTabsStore`, so there is nothing this
    // test needs flushed - installing a controllable one (whose deferred
    // write is never resolved) would make the adapter hang on the flush
    // await instead, which would make this test pass vacuously rather than
    // by actually exercising step 4's grouped-ref check.
    const unregister = registerTabStructuralLockPredicate(
      (ref) => ref.kind === PARTNER.kind && ref.id === PARTNER.id,
    );

    renderFlow();
    await flush();

    act(() => {
      flowRef?.requestOpenInNewWindow({
        epicId: "epic-moving",
        tabId: MOVING.id,
        title: "Moving",
      });
    });
    await flush();

    // `separateBeforeMove` refused (the locked partner blocks it) - the
    // split is still intact, and the move never reaches the flush barrier
    // or the move IPC.
    expect(useTabsStore.getState().items).toEqual([
      {
        kind: "split",
        id: "split-move",
        left: { kind: "tab", ref: MOVING },
        right: { kind: "tab", ref: PARTNER },
        focusedSide: "left",
        routeBackingSide: "left",
        leftRatio: 0.5,
      },
    ]);
    expect(windows.openInNewWindowCalls).toEqual([]);

    unregister();
  });
});

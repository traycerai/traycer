/**
 * T2 intermediate-state tests for the tab command coordinator.
 *
 * Every affected store and the transaction ledger are subscribed during
 * commands. Each subscription-visible snapshot must keep visible refs unique
 * and cover every temporarily unplaced source ref with the reservation ledger
 * (including depth-0 notifications after deferred repair). Ordinary outer
 * commands finalize with exactly one normalize + one project; nested dirty
 * repair is an in-boundary deferred pass before projection/clear.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetTabSyncCoordinatorForTesting,
  installTabSyncCoordinator,
} from "@/lib/tab-sync/tab-sync-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  setLandingDraftDesktopProjectionBridge,
  useLandingDraftStore,
} from "@/stores/home/landing-draft-store";
import {
  flattenLayoutRefs,
  tabRefKey,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import {
  getTabCommandCoordinatorDiagnostics,
  getTabCommandLedger,
  subscribeToTabCommandLedger,
  tabCommandCoordinator,
  type TabCommandCoordinatorDiagnostics,
} from "@/stores/tabs/tab-command-coordinator";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

interface IntermediateSnapshot {
  readonly source: "tabs" | "canvas" | "drafts" | "ledger";
  readonly placedKeys: ReadonlyArray<string>;
  readonly stripKeys: ReadonlyArray<string>;
  readonly sourceKeys: ReadonlyArray<string>;
  readonly reservedKeys: ReadonlyArray<string>;
  readonly pendingKeys: ReadonlyArray<string>;
  readonly suppressionDepth: number;
  readonly reconciliationDirty: boolean;
}

interface CaptureSession {
  readonly snapshots: IntermediateSnapshot[];
  readonly dispose: () => void;
  readonly assertAllSafe: () => void;
  readonly diagnosticsDelta: () => TabCommandCoordinatorDiagnostics;
}

function layoutFromTabsState(): PersistedTabStripLayout {
  const state = useTabsStore.getState();
  return {
    version: 2,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
  };
}

function currentSourceKeys(): string[] {
  const canvas = useEpicCanvasStore.getState();
  const epicKeys = canvas.openTabOrder.flatMap((tabId) =>
    canvas.tabsById[tabId] === undefined ? [] : [`epic:${tabId}`],
  );
  const draftKeys = useLandingDraftStore
    .getState()
    .drafts.map((draft) => `draft:${draft.id}`);
  return [...epicKeys, ...draftKeys];
}

function uniqueOrThrow(keys: ReadonlyArray<string>, label: string): void {
  const seen = new Set<string>();
  for (const key of keys) {
    expect(seen.has(key), `${label} duplicated ${key}`).toBe(false);
    seen.add(key);
  }
}

function assertLedgerSafeSnapshot(snapshot: IntermediateSnapshot): void {
  uniqueOrThrow(snapshot.placedKeys, "layout items");
  uniqueOrThrow(snapshot.stripKeys, "stripOrder");

  // Coverage is required at every subscription-visible depth, including the
  // EMPTY_LEDGER notify after deferred in-boundary repair. Skipping depth 0
  // hid the pre-reconcile clear gap.
  for (const key of snapshot.sourceKeys) {
    const placed = snapshot.placedKeys.includes(key);
    const reserved = snapshot.reservedKeys.includes(key);
    const pending = snapshot.pendingKeys.includes(key);
    expect(
      placed || reserved || pending,
      `unplaced source ${key} missing from layout/ledger (depth=${snapshot.suppressionDepth})`,
    ).toBe(true);
  }
}

function captureSession(): CaptureSession {
  const snapshots: IntermediateSnapshot[] = [];
  const start = getTabCommandCoordinatorDiagnostics();

  const push = (source: IntermediateSnapshot["source"]): void => {
    const layout = layoutFromTabsState();
    const ledger = getTabCommandLedger();
    snapshots.push({
      source,
      placedKeys: flattenLayoutRefs(layout).map(tabRefKey),
      stripKeys: useTabsStore.getState().stripOrder.map(tabRefKey),
      sourceKeys: currentSourceKeys(),
      reservedKeys: [...ledger.reservedAdditions.keys()],
      pendingKeys: [...ledger.pendingRemovals.keys()],
      suppressionDepth: ledger.suppressionDepth,
      reconciliationDirty: ledger.reconciliationDirty,
    });
  };

  const unsubs = [
    useTabsStore.subscribe(() => push("tabs")),
    useEpicCanvasStore.subscribe(() => push("canvas")),
    useLandingDraftStore.subscribe(() => push("drafts")),
    subscribeToTabCommandLedger(() => push("ledger")),
  ];

  return {
    snapshots,
    dispose: () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
    },
    assertAllSafe: () => {
      expect(snapshots.length).toBeGreaterThan(0);
      snapshots.forEach(assertLedgerSafeSnapshot);
    },
    diagnosticsDelta: () => {
      const end = getTabCommandCoordinatorDiagnostics();
      return {
        normalizationCount: end.normalizationCount - start.normalizationCount,
        compatibilityProjectionCount:
          end.compatibilityProjectionCount - start.compatibilityProjectionCount,
        deferredReconciliationCount:
          end.deferredReconciliationCount - start.deferredReconciliationCount,
      };
    },
  };
}

function resetStores(): void {
  useTabsStore.setState({
    version: 2,
    items: [],
    activeItemId: null,
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  __resetTabSyncCoordinatorForTesting();
}

function seedCommittedLayout(layout: PersistedTabStripLayout): void {
  useTabsStore.setState({
    ...layout,
    stripOrder: flattenLayoutRefs(layout),
  });
}

function openEpicSource(
  epicId: string,
  name: string,
): { readonly tabId: string; readonly ref: TabRef } {
  const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, name);
  return { tabId, ref: { kind: "epic", id: tabId } };
}

function openDraftSource(): TabRef {
  const draftId = useLandingDraftStore.getState().createDraft(null);
  return { kind: "draft", id: draftId };
}

function expectFinalizedOnce(session: CaptureSession): void {
  expect(session.diagnosticsDelta()).toEqual({
    normalizationCount: 1,
    compatibilityProjectionCount: 1,
    deferredReconciliationCount: 0,
  });
  expect(getTabCommandLedger().suppressionDepth).toBe(0);
  expect(getTabCommandLedger().reservedAdditions.size).toBe(0);
  expect(getTabCommandLedger().pendingRemovals.size).toBe(0);
}

function expectSuppressedSnapshotWith(
  session: CaptureSession,
  predicate: (snapshot: IntermediateSnapshot) => boolean,
): IntermediateSnapshot {
  const match = session.snapshots.find(
    (snapshot) => snapshot.suppressionDepth > 0 && predicate(snapshot),
  );
  expect(match, "expected a suppressed intermediate snapshot").toBeDefined();
  return match as IntermediateSnapshot;
}

describe("tab command coordinator transactions", () => {
  beforeEach(async () => {
    resetStores();
    installTabSyncCoordinator({ readyPromise: Promise.resolve() });
    await Promise.resolve();
    await Promise.resolve();
  });

  afterEach(() => {
    resetStores();
  });

  it("createEmptySplit finalizes once without duplicate visible refs", () => {
    const { ref } = openEpicSource("epic-a", "A");
    expect(flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey)).toEqual([
      tabRefKey(ref),
    ]);

    const session = captureSession();
    const created = tabCommandCoordinator.createEmptySplit({
      ref,
      splitId: "split-empty",
      populatedSide: "left",
      focusedSide: "right",
      leftRatio: 0.5,
    });
    session.dispose();

    expect(created).toBe(true);
    session.assertAllSafe();
    expectFinalizedOnce(session);

    const item = useTabsStore.getState().items[0];
    expect(item).toMatchObject({
      kind: "split",
      id: "split-empty",
      left: { kind: "tab", ref },
      right: { kind: "empty" },
    });
  });

  it("createDraftForSplit reserves the new draft until layout consumes it", () => {
    const { ref: epicRef } = openEpicSource("epic-a", "A");
    expect(
      tabCommandCoordinator.createEmptySplit({
        ref: epicRef,
        splitId: "split-draft",
        populatedSide: "left",
        focusedSide: "right",
        leftRatio: 0.5,
      }),
    ).toBe(true);

    const before = getTabCommandCoordinatorDiagnostics();
    const session = captureSession();
    const draftRef = tabCommandCoordinator.createDraftForSplit({
      splitId: "split-draft",
      side: "right",
    });
    session.dispose();

    expect(draftRef).not.toBeNull();
    if (draftRef === null) return;

    session.assertAllSafe();
    expectSuppressedSnapshotWith(
      session,
      (snapshot) =>
        snapshot.reservedKeys.includes(tabRefKey(draftRef)) ||
        snapshot.placedKeys.includes(tabRefKey(draftRef)),
    );
    expect(session.diagnosticsDelta()).toEqual({
      normalizationCount: 1,
      compatibilityProjectionCount: 1,
      deferredReconciliationCount: 0,
    });
    expect(getTabCommandCoordinatorDiagnostics()).toEqual({
      normalizationCount: before.normalizationCount + 1,
      compatibilityProjectionCount: before.compatibilityProjectionCount + 1,
      deferredReconciliationCount: before.deferredReconciliationCount,
    });

    const split = useTabsStore.getState().items[0];
    expect(split.kind).toBe("split");
    if (split.kind === "split") {
      expect(split.right).toEqual({ kind: "tab", ref: draftRef });
    }
    expect(
      useLandingDraftStore
        .getState()
        .drafts.some((draft) => draft.id === draftRef.id),
    ).toBe(true);
  });

  it("fillSplitSide covers a pre-existing unplaced source via reservation", async () => {
    // Keep reconciliation gated so an open source can exist without strip placement.
    let resolveReady: () => void = () => undefined;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    resetStores();
    installTabSyncCoordinator({ readyPromise });

    const tabA = useEpicCanvasStore.getState().openEpicTab("epic-a", "A");
    const tabB = useEpicCanvasStore.getState().openEpicTab("epic-b", "B");
    const refA: TabRef = { kind: "epic", id: tabA };
    const refB: TabRef = { kind: "epic", id: tabB };

    seedCommittedLayout({
      version: 2,
      items: [
        {
          kind: "split",
          id: "split-fill",
          left: { kind: "tab", ref: refA },
          right: { kind: "empty" },
          focusedSide: "right",
          routeBackingSide: "left",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-fill",
      systemTabs: { history: null, settings: null },
    });

    const session = captureSession();
    const filled = tabCommandCoordinator.fillSplitSide({
      splitId: "split-fill",
      side: "right",
      ref: refB,
    });
    session.dispose();

    expect(filled).toBe(true);
    session.assertAllSafe();
    expectSuppressedSnapshotWith(
      session,
      (snapshot) =>
        snapshot.reservedKeys.includes(tabRefKey(refB)) ||
        snapshot.placedKeys.includes(tabRefKey(refB)),
    );
    expectFinalizedOnce(session);

    const split = useTabsStore.getState().items[0];
    expect(split.kind).toBe("split");
    if (split.kind === "split") {
      expect(split.right).toEqual({ kind: "tab", ref: refB });
    }

    resolveReady();
    await readyPromise;
    await Promise.resolve();
  });

  it("replaceDraftWithEpic keeps draft pending-removal and epic reserved mid-command", () => {
    const draftRef = openDraftSource();
    expect(flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey)).toContain(
      tabRefKey(draftRef),
    );

    const epicTabId = "epic-tab-from-draft";
    const session = captureSession();
    const nextRef = tabCommandCoordinator.replaceDraftWithEpic({
      draftId: draftRef.id,
      epicId: "epic-created",
      epicTabId,
      epicName: "Created",
    });
    session.dispose();

    expect(nextRef).toEqual({ kind: "epic", id: epicTabId });
    session.assertAllSafe();

    expectSuppressedSnapshotWith(session, (snapshot) =>
      snapshot.pendingKeys.includes(tabRefKey(draftRef)),
    );
    expectSuppressedSnapshotWith(
      session,
      (snapshot) =>
        snapshot.reservedKeys.includes(`epic:${epicTabId}`) ||
        snapshot.placedKeys.includes(`epic:${epicTabId}`),
    );
    expectFinalizedOnce(session);

    expect(flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey)).toEqual([
      `epic:${epicTabId}`,
    ]);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(epicTabId);
  });

  it("closeRef keeps the closed source under pendingRemovals until removal settles", () => {
    const { ref } = openEpicSource("epic-close", "Close me");
    const session = captureSession();
    const closed = tabCommandCoordinator.closeRef(ref);
    session.dispose();

    expect(closed).toBe(true);
    session.assertAllSafe();
    expectSuppressedSnapshotWith(session, (snapshot) =>
      snapshot.pendingKeys.includes(tabRefKey(ref)),
    );
    expectFinalizedOnce(session);

    expect(flattenLayoutRefs(layoutFromTabsState())).toEqual([]);
    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(ref.id);
  });

  it("closeRefAfterConfirmed is a single outer finalize (same critical section)", () => {
    const draftRef = openDraftSource();
    const session = captureSession();
    const closed = tabCommandCoordinator.closeRefAfterConfirmed(draftRef);
    session.dispose();

    expect(closed).toBe(true);
    session.assertAllSafe();
    expectSuppressedSnapshotWith(session, (snapshot) =>
      snapshot.pendingKeys.includes(tabRefKey(draftRef)),
    );
    expectFinalizedOnce(session);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
  });

  it("nested source write during applySources stays reserved, marks dirty, and defers placement", () => {
    const { ref: epicRef } = openEpicSource("epic-a", "A");
    expect(
      tabCommandCoordinator.createEmptySplit({
        ref: epicRef,
        splitId: "split-nested",
        populatedSide: "left",
        focusedSide: "right",
        leftRatio: 0.5,
      }),
    ).toBe(true);

    // Fire the unexpected nested write specifically during applySources: when
    // createDraftForSplit creates the draft source, synchronously open another
    // epic. Production reclassifies by membership so the nested ref lands in
    // reservedAdditions, dirty is set, and layout commit only drops reserved
    // keys that were actually placed — nested stays covered until deferred reconcile.
    const nestedEpicTabIds: string[] = [];
    const unsubscribeNested = useLandingDraftStore.subscribe((next, prev) => {
      if (next.drafts === prev.drafts || nestedEpicTabIds.length > 0) return;
      if (getTabCommandLedger().suppressionDepth === 0) return;
      nestedEpicTabIds.push(
        useEpicCanvasStore.getState().openEpicTab("epic-nested", "Nested"),
      );
    });

    const session = captureSession();
    const draftRef = tabCommandCoordinator.createDraftForSplit({
      splitId: "split-nested",
      side: "right",
    });
    unsubscribeNested();
    session.dispose();

    expect(draftRef).not.toBeNull();
    if (draftRef === null) {
      throw new Error("expected createDraftForSplit to return a draft ref");
    }
    expect(nestedEpicTabIds).toHaveLength(1);
    const nestedId = nestedEpicTabIds[0];
    expect(typeof nestedId).toBe("string");
    const nestedKey = `epic:${nestedId}`;

    // At least one mid-transaction snapshot must show the nested ref reserved
    // and dirty *while still unplaced* (proves applySources-phase coverage,
    // not only post-clear re-reservation).
    expectSuppressedSnapshotWith(
      session,
      (snapshot) =>
        snapshot.reconciliationDirty &&
        snapshot.reservedKeys.includes(nestedKey) &&
        !snapshot.placedKeys.includes(nestedKey) &&
        snapshot.sourceKeys.includes(nestedKey),
    );

    session.assertAllSafe();

    const delta = session.diagnosticsDelta();
    // Dirty repair is in-boundary (before projection / EMPTY clear), so the
    // outer command still finalizes once: one normalize, one deferred, one
    // explicit compatibility projection.
    expect(delta.deferredReconciliationCount).toBe(1);
    expect(delta.normalizationCount).toBe(1);
    expect(delta.compatibilityProjectionCount).toBe(1);

    const placed = flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey);
    expect(placed).toContain(tabRefKey(draftRef));
    expect(placed).toContain(nestedKey);
    uniqueOrThrow(placed, "final layout");
    expect(getTabCommandLedger().suppressionDepth).toBe(0);
    expect(getTabCommandLedger().reservedAdditions.size).toBe(0);
  });

  it("source create persistence throw still places the draft via deferred repair", () => {
    // Ensure local draft persistence is active (desktop bridge disables it).
    setLandingDraftDesktopProjectionBridge(null);

    const { ref: epicRef } = openEpicSource("epic-a", "A");
    expect(
      tabCommandCoordinator.createEmptySplit({
        ref: epicRef,
        splitId: "split-persist-fail",
        populatedSide: "left",
        focusedSide: "right",
        leftRatio: 0.5,
      }),
    ).toBe(true);

    const draftsBefore = useLandingDraftStore
      .getState()
      .drafts.map((d) => d.id);

    // Simulate the review failure mode: Zustand draft state is committed, then
    // the synchronous persistence write throws before layout apply. Wrapping
    // createDraftWithId is more reliable than localStorage spies under the
    // test env (and matches "in-memory source exists, applySources throws").
    const originalCreateDraftWithId =
      useLandingDraftStore.getState().createDraftWithId;
    let threwOnce = false;
    useLandingDraftStore.setState({
      createDraftWithId: (id, settings) => {
        const createdId = originalCreateDraftWithId(id, settings);
        if (!threwOnce) {
          threwOnce = true;
          const error = new Error("The quota has been exceeded.");
          error.name = "QuotaExceededError";
          throw error;
        }
        return createdId;
      },
    });

    const session = captureSession();
    let thrown: unknown = null;
    try {
      try {
        tabCommandCoordinator.createDraftForSplit({
          splitId: "split-persist-fail",
          side: "right",
        });
      } catch (error) {
        thrown = error;
      }
    } finally {
      session.dispose();
      useLandingDraftStore.setState({
        createDraftWithId: originalCreateDraftWithId,
      });
    }

    expect(threwOnce).toBe(true);
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("expected createDraftForSplit to throw");
    }
    expect(
      thrown.name === "QuotaExceededError" || /quota/i.test(thrown.message),
    ).toBe(true);

    session.assertAllSafe();
    expect(getTabCommandLedger().suppressionDepth).toBe(0);
    expect(getTabCommandLedger().reservedAdditions.size).toBe(0);

    const draftsAfter = useLandingDraftStore.getState().drafts;
    const created = draftsAfter.filter((d) => !draftsBefore.includes(d.id));
    expect(created.length).toBeGreaterThanOrEqual(1);
    const placed = flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey);
    for (const draft of created) {
      expect(placed).toContain(`draft:${draft.id}`);
    }
    const delta = session.diagnosticsDelta();
    expect(delta.deferredReconciliationCount).toBe(1);
    expect(delta.normalizationCount).toBe(1);
    // Failure path still projects when the outer command requested it.
    expect(delta.compatibilityProjectionCount).toBe(1);
  });

  it("nested closeTab during applySources is not restored by compatibility projection", () => {
    const a = openEpicSource("epic-a", "A");
    const b = openEpicSource("epic-b", "B");
    expect(
      tabCommandCoordinator.createEmptySplit({
        ref: a.ref,
        splitId: "split-close-nested",
        populatedSide: "left",
        focusedSide: "right",
        leftRatio: 0.5,
      }),
    ).toBe(true);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual(
      expect.arrayContaining([a.tabId, b.tabId]),
    );
    expect(flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey)).toEqual(
      expect.arrayContaining([tabRefKey(a.ref), tabRefKey(b.ref)]),
    );

    let closedB = false;
    const unsubscribeNested = useLandingDraftStore.subscribe((next, prev) => {
      if (next.drafts === prev.drafts || closedB) return;
      if (getTabCommandLedger().suppressionDepth === 0) return;
      closedB = true;
      // Canvas close keeps tabsById (the exact bug path): projection used to
      // rebuild openTabOrder from layout refs still present in tabsById.
      useEpicCanvasStore.getState().closeTab(b.tabId);
    });

    const session = captureSession();
    const draftRef = tabCommandCoordinator.createDraftForSplit({
      splitId: "split-close-nested",
      side: "right",
    });
    unsubscribeNested();
    session.dispose();

    expect(closedB).toBe(true);
    expect(draftRef).not.toBeNull();
    if (draftRef === null) {
      throw new Error("expected createDraftForSplit to return a draft ref");
    }

    session.assertAllSafe();
    const delta = session.diagnosticsDelta();
    expect(delta.deferredReconciliationCount).toBe(1);
    expect(delta.normalizationCount).toBe(1);
    expect(delta.compatibilityProjectionCount).toBe(1);

    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(b.tabId);
    expect(useEpicCanvasStore.getState().tabsById[b.tabId]).toBeDefined();
    const placed = flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey);
    expect(placed).not.toContain(tabRefKey(b.ref));
    expect(placed).toContain(tabRefKey(a.ref));
    expect(placed).toContain(tabRefKey(draftRef));
  });

  it("persistent quota including fallback persistence releases a coherent coordinator", () => {
    // Round-3 hazard: the recovery fallback writes all layout fields atomically,
    // but public `useTabsStore.setState` is persist-wrapped too. Its own
    // post-commit persistence failure used to escape finalization and retain
    // the depth-one ledger forever.
    setLandingDraftDesktopProjectionBridge(null);

    const { ref: epicRef } = openEpicSource("epic-a", "A");
    expect(
      tabCommandCoordinator.createEmptySplit({
        ref: epicRef,
        splitId: "split-persist-quota",
        populatedSide: "left",
        focusedSide: "right",
        leftRatio: 0.5,
      }),
    ).toBe(true);

    const draftsBefore = useLandingDraftStore
      .getState()
      .drafts.map((d) => d.id);

    const originalCreateDraftWithId =
      useLandingDraftStore.getState().createDraftWithId;
    const originalReplaceLayoutForTransaction =
      useTabsStore.getState().replaceLayoutForTransaction;
    const originalTabsSetState = useTabsStore.setState.bind(useTabsStore);
    let sourceCreateThrows = 0;
    let recoveryLayoutThrows = 0;
    let fallbackSetStateThrows = 0;

    useLandingDraftStore.setState({
      createDraftWithId: (id, settings) => {
        // Commit source state, then fail like a persistent quota write.
        originalCreateDraftWithId(id, settings);
        sourceCreateThrows += 1;
        const error = new Error("The quota has been exceeded.");
        error.name = "QuotaExceededError";
        throw error;
      },
    });
    useTabsStore.setState({
      replaceLayoutForTransaction: (layout) => {
        originalReplaceLayoutForTransaction(layout);
        recoveryLayoutThrows += 1;
        const error = new Error("The quota has been exceeded.");
        error.name = "QuotaExceededError";
        throw error;
      },
    });
    useTabsStore.setState = (partial) => {
      originalTabsSetState(partial);
      fallbackSetStateThrows += 1;
      const error = new Error("The quota has been exceeded.");
      error.name = "QuotaExceededError";
      throw error;
    };

    const session = captureSession();
    let thrown: unknown = null;
    try {
      try {
        tabCommandCoordinator.createDraftForSplit({
          splitId: "split-persist-quota",
          side: "right",
        });
      } catch (error) {
        thrown = error;
      }
    } finally {
      session.dispose();
      useTabsStore.setState = originalTabsSetState;
      useLandingDraftStore.setState({
        createDraftWithId: originalCreateDraftWithId,
      });
      useTabsStore.setState({
        replaceLayoutForTransaction: originalReplaceLayoutForTransaction,
      });
    }

    expect(sourceCreateThrows).toBeGreaterThanOrEqual(1);
    expect(recoveryLayoutThrows).toBeGreaterThanOrEqual(1);
    expect(fallbackSetStateThrows).toBeGreaterThanOrEqual(1);
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new Error("expected createDraftForSplit to throw");
    }
    expect(
      thrown.name === "QuotaExceededError" || /quota/i.test(thrown.message),
    ).toBe(true);

    session.assertAllSafe();
    expect(getTabCommandLedger().suppressionDepth).toBe(0);
    expect(getTabCommandLedger().reservedAdditions.size).toBe(0);

    const tabsState = useTabsStore.getState();
    const projectedKeys = flattenLayoutRefs({
      version: 2,
      items: tabsState.items,
      activeItemId: tabsState.activeItemId,
      systemTabs: tabsState.systemTabs,
    }).map(tabRefKey);
    // Coherent means stripOrder matches the items tree; mismatch is the
    // orphan path that makes currentLayout() discard the recovered placement.
    expect(tabsState.stripOrder.map(tabRefKey)).toEqual(projectedKeys);

    const draftsAfter = useLandingDraftStore.getState().drafts;
    const created = draftsAfter.filter((d) => !draftsBefore.includes(d.id));
    expect(created).toHaveLength(1);
    const draftRef: TabRef = { kind: "draft", id: created[0].id };
    expect(projectedKeys).toContain(tabRefKey(draftRef));

    // A later command must still see the draft as a placeable source ref.
    expect(
      tabCommandCoordinator.createEmptySplit({
        ref: draftRef,
        splitId: "split-after-quota",
        populatedSide: "left",
        focusedSide: "right",
        leftRatio: 0.5,
      }),
    ).toBe(true);
    const afterKeys = flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey);
    expect(afterKeys).toContain(tabRefKey(draftRef));
    uniqueOrThrow(afterKeys, "post-quota layout");
  });

  it("source background-open during projection reprojects final layout compatibility", () => {
    // Round-3 hazard: membership repair after the first projection can make X
    // the final active layout item, while source activeTabId remains the stale
    // null written before the repair.
    const a = openEpicSource("epic-a", "A");
    expect(useEpicCanvasStore.getState().activeTabId).toBe(a.tabId);

    const nestedEpicTabIds: string[] = [];
    const unsubscribeNested = useEpicCanvasStore.subscribe((next, prev) => {
      if (nestedEpicTabIds.length > 0) return;
      if (getTabCommandLedger().suppressionDepth === 0) return;
      // Compatibility projection clears activeTabId when the focused side is
      // empty (no epic ref selected). React only to that projection write.
      if (next.activeTabId === prev.activeTabId) return;
      if (next.activeTabId !== null) return;
      nestedEpicTabIds.push(
        useEpicCanvasStore.getState().openEpicTabInBackground("epic-x", "X"),
      );
    });

    const session = captureSession();
    const created = tabCommandCoordinator.createEmptySplit({
      ref: a.ref,
      splitId: "split-proj-nested-x",
      populatedSide: "left",
      focusedSide: "right",
      leftRatio: 0.5,
    });
    unsubscribeNested();
    session.dispose();

    expect(created).toBe(true);
    expect(nestedEpicTabIds).toHaveLength(1);
    const xId = nestedEpicTabIds[0];
    expect(typeof xId).toBe("string");
    const xKey = `epic:${xId}`;

    // Every subscription-visible snapshot must cover X (including the
    // EMPTY_LEDGER notify after release).
    session.assertAllSafe();
    expect(getTabCommandLedger().suppressionDepth).toBe(0);
    expect(getTabCommandLedger().reservedAdditions.size).toBe(0);

    const canvas = useEpicCanvasStore.getState();
    expect(canvas.openTabOrder).toContain(xId);
    expect(canvas.tabsById[xId]).toBeDefined();
    const layout = layoutFromTabsState();
    const placed = flattenLayoutRefs(layout).map(tabRefKey);
    expect(placed).toContain(tabRefKey(a.ref));
    expect(placed).toContain(xKey);
    uniqueOrThrow(placed, "final layout with X");
    const layoutEpicIds = flattenLayoutRefs(layout).flatMap((ref) =>
      ref.kind === "epic" ? [ref.id] : [],
    );
    expect(canvas.openTabOrder).toEqual(layoutEpicIds);
    expect(canvas.activeTabId).toBe(xId);
  });

  it("one-shot projection listener error still releases the ledger and permits another command", () => {
    const a = openEpicSource("epic-a", "A");
    const b = openEpicSource("epic-b", "B");
    const primaryError = new Error("projection listener failed once");
    let projectionThrows = 0;
    const unsubscribeThrowing = useEpicCanvasStore.subscribe((next, prev) => {
      if (projectionThrows > 0) return;
      if (next.activeTabId === prev.activeTabId || next.activeTabId !== null) {
        return;
      }
      projectionThrows += 1;
      throw primaryError;
    });

    let thrown: unknown = null;
    try {
      tabCommandCoordinator.createEmptySplit({
        ref: a.ref,
        splitId: "split-projection-error",
        populatedSide: "left",
        focusedSide: "right",
        leftRatio: 0.5,
      });
    } catch (error) {
      thrown = error;
    } finally {
      unsubscribeThrowing();
    }

    expect(projectionThrows).toBe(1);
    expect(thrown).toBe(primaryError);
    expect(getTabCommandLedger().suppressionDepth).toBe(0);
    expect(getTabCommandLedger().reconciliationDirty).toBe(false);
    expect(
      tabCommandCoordinator.createEmptySplit({
        ref: b.ref,
        splitId: "split-after-projection-error",
        populatedSide: "left",
        focusedSide: "right",
        leftRatio: 0.5,
      }),
    ).toBe(true);
  });

  it("primary layout error remains primary when fallback persistence also fails", () => {
    const { ref } = openEpicSource("epic-a", "A");
    const primaryError = new Error("primary layout listener failure");
    const fallbackError = new Error("fallback quota failure");
    fallbackError.name = "QuotaExceededError";
    const originalReplaceLayoutForTransaction =
      useTabsStore.getState().replaceLayoutForTransaction;
    const originalTabsSetState = useTabsStore.setState.bind(useTabsStore);
    let primaryThrows = 0;
    let fallbackThrows = 0;

    useTabsStore.setState({
      replaceLayoutForTransaction: (layout) => {
        originalReplaceLayoutForTransaction(layout);
        if (primaryThrows > 0) return;
        primaryThrows += 1;
        throw primaryError;
      },
    });
    useTabsStore.setState = (partial) => {
      originalTabsSetState(partial);
      fallbackThrows += 1;
      throw fallbackError;
    };

    let thrown: unknown = null;
    try {
      tabCommandCoordinator.createEmptySplit({
        ref,
        splitId: "split-primary-error",
        populatedSide: "left",
        focusedSide: "right",
        leftRatio: 0.5,
      });
    } catch (error) {
      thrown = error;
    } finally {
      useTabsStore.setState = originalTabsSetState;
      useTabsStore.setState({
        replaceLayoutForTransaction: originalReplaceLayoutForTransaction,
      });
    }

    expect(primaryThrows).toBe(1);
    expect(fallbackThrows).toBe(1);
    expect(thrown).toBe(primaryError);
    if (!(thrown instanceof Error)) {
      throw new Error("expected a primary error");
    }
    expect(thrown.cause).toBe(fallbackError);
    expect(getTabCommandLedger().suppressionDepth).toBe(0);
    expect(getTabCommandLedger().reconciliationDirty).toBe(false);
  });

  it("forbids nested outer commands during a transaction", () => {
    const { ref } = openEpicSource("epic-a", "A");
    const unsub = subscribeToTabCommandLedger(() => {
      if (getTabCommandLedger().suppressionDepth === 0) return;
      expect(() => tabCommandCoordinator.closeRef(ref)).toThrow(
        /cannot be re-entered/i,
      );
    });

    const session = captureSession();
    expect(
      tabCommandCoordinator.createEmptySplit({
        ref,
        splitId: "split-reenter",
        populatedSide: "left",
        focusedSide: "right",
        leftRatio: 0.5,
      }),
    ).toBe(true);
    unsub();
    session.dispose();
    session.assertAllSafe();
    expectFinalizedOnce(session);
  });

  it("handleEpicAccessLoss covers every affected ref in pendingRemovals for one finalize", () => {
    const a = openEpicSource("shared-epic", "A");
    const b = openEpicSource("shared-epic", "B");
    // openEpicTab reuses? Actually openEpicTab always creates a new tab id for
    // the same epicId. Ensure both tabs share epicId for access loss.
    // openEpicTab(epicId) creates distinct tabIds - good.
    const session = captureSession();
    tabCommandCoordinator.handleEpicAccessLoss(["shared-epic"]);
    session.dispose();

    session.assertAllSafe();
    expectSuppressedSnapshotWith(
      session,
      (snapshot) =>
        snapshot.pendingKeys.includes(tabRefKey(a.ref)) &&
        snapshot.pendingKeys.includes(tabRefKey(b.ref)),
    );
    expectFinalizedOnce(session);
    expect(flattenLayoutRefs(layoutFromTabsState())).toEqual([]);
  });

  it("separateBeforeMove and removeMovedRef are separate outer transactions", () => {
    const left = openEpicSource("epic-left", "Left");
    const right = openEpicSource("epic-right", "Right");

    useTabsStore.getState().pair({
      left: left.ref,
      right: right.ref,
      splitId: "split-move",
      leftRatio: 0.5,
    });
    expect(useTabsStore.getState().items[0]?.kind).toBe("split");

    const separateSession = captureSession();
    const separateResult = tabCommandCoordinator.separateBeforeMove(left.ref);
    separateSession.dispose();

    expect(separateResult).toEqual({
      separated: true,
      splitId: "split-move",
    });
    separateSession.assertAllSafe();
    expectFinalizedOnce(separateSession);
    expect(
      useTabsStore.getState().items.every((item) => item.kind === "tab"),
    ).toBe(true);

    const removeSession = captureSession();
    const removed = tabCommandCoordinator.removeMovedRef(left.ref);
    removeSession.dispose();

    expect(removed).toBe(true);
    removeSession.assertAllSafe();
    expectSuppressedSnapshotWith(removeSession, (snapshot) =>
      snapshot.pendingKeys.includes(tabRefKey(left.ref)),
    );
    expectFinalizedOnce(removeSession);

    expect(flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey)).toEqual([
      tabRefKey(right.ref),
    ]);
    expect(useEpicCanvasStore.getState().tabsById[left.tabId]).toBeUndefined();
  });

  it("reconcileFromSourceStores places unplaced sources with one finalize", async () => {
    let resolveReady: () => void = () => undefined;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    resetStores();
    installTabSyncCoordinator({ readyPromise });

    const tabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-hydrate", "H");
    expect(useTabsStore.getState().items).toEqual([]);

    const session = captureSession();
    resolveReady();
    await readyPromise;
    await Promise.resolve();
    await Promise.resolve();
    session.dispose();

    session.assertAllSafe();
    const delta = session.diagnosticsDelta();
    expect(delta.normalizationCount).toBe(1);
    // Passive hydration must not claim a source compatibility projection.
    expect(delta.compatibilityProjectionCount).toBe(0);
    expect(delta.deferredReconciliationCount).toBe(0);
    expect(flattenLayoutRefs(layoutFromTabsState()).map(tabRefKey)).toEqual([
      `epic:${tabId}`,
    ]);
  });

  it("pair via store remains operational; coordinator close still ledger-safe", () => {
    const left = openEpicSource("epic-l", "L");
    const right = openEpicSource("epic-r", "R");
    useTabsStore.getState().pair({
      left: left.ref,
      right: right.ref,
      splitId: "split-pair",
      leftRatio: 0.4,
    });

    const session = captureSession();
    expect(tabCommandCoordinator.closeRef(right.ref)).toBe(true);
    session.dispose();

    session.assertAllSafe();
    expectFinalizedOnce(session);
    const remaining = flattenLayoutRefs(layoutFromTabsState());
    expect(remaining.map(tabRefKey)).toEqual([tabRefKey(left.ref)]);
  });
});

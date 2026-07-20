import { v4 as uuidv4 } from "uuid";
import { releaseOpenEpicSessionIfUnused } from "@/lib/registries/epic-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  isRegisteredTabKind,
  tabSurfaceDescriptor,
} from "@/stores/tabs/registry";
import { useTabsStore } from "@/stores/tabs/store";
import {
  createEmptySplit,
  createLayoutItem,
  findStripItemForRef,
  flattenLayoutRefs,
  removeLayoutRef,
  repairLayout,
  replaceFillableSide,
  replaceLayoutRef,
  separateSplit,
  tabRefKey,
  type PersistedTabStripLayout,
  type CreateEmptySplitArgs,
  type SplitSide,
  type SplitSideName,
  type StripItem,
} from "@/stores/tabs/layout";
import type { TabRef } from "@/stores/tabs/types";

/**
 * The observable transaction ledger. A source-owned ref may be absent from
 * the layout only while it is recorded in one of these key-addressed maps.
 */
export interface TabCommandLedger {
  readonly reservedAdditions: ReadonlyMap<string, TabRef>;
  readonly pendingRemovals: ReadonlyMap<string, TabRef>;
  readonly suppressionDepth: number;
  readonly reconciliationDirty: boolean;
}

export interface TabCommandCoordinatorDiagnostics {
  readonly normalizationCount: number;
  readonly compatibilityProjectionCount: number;
  readonly deferredReconciliationCount: number;
}

export interface FillSplitSideCommand {
  readonly splitId: string;
  readonly side: SplitSideName;
  readonly ref: TabRef;
}

export interface CreateDraftForSplitCommand {
  readonly splitId: string;
  readonly side: SplitSideName;
}

export interface ReplaceDraftWithEpicCommand {
  readonly draftId: string;
  readonly epicId: string;
  readonly epicTabId: string;
  readonly epicName: string | undefined;
}

export interface SeparateBeforeMoveResult {
  readonly separated: boolean;
  readonly splitId: string | null;
}

type CoordinatorListener = () => void;

const EMPTY_LEDGER: TabCommandLedger = {
  reservedAdditions: new Map(),
  pendingRemovals: new Map(),
  suppressionDepth: 0,
  reconciliationDirty: false,
};

const EMPTY_DIAGNOSTICS: TabCommandCoordinatorDiagnostics = {
  normalizationCount: 0,
  compatibilityProjectionCount: 0,
  deferredReconciliationCount: 0,
};

const MAX_FINALIZATION_ITERATIONS = 8;

let transactionDepth = 0;

function currentLayout(): PersistedTabStripLayout {
  const state = useTabsStore.getState();
  const layout: PersistedTabStripLayout = {
    version: 2,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
  };
  const projected = flattenLayoutRefs(layout);
  const matchesProjection =
    projected.length === state.stripOrder.length &&
    projected.every(
      (ref, index) => tabRefKey(ref) === tabRefKey(state.stripOrder[index]),
    );
  if (transactionDepth > 0 || matchesProjection) return layout;
  // Existing tests and unconverted flat callers can still seed `stripOrder`
  // directly. Outside a coordinator transaction, treat that as the T1
  // compatibility write it is and rebuild the authoritative flat layout.
  return state.stripOrder.reduce(createLayoutItem, {
    version: 2,
    items: [],
    activeItemId: null,
    systemTabs: state.systemTabs,
  });
}

function refsToLedger(
  refs: ReadonlyArray<TabRef>,
): ReadonlyMap<string, TabRef> {
  return new Map(refs.map((ref) => [tabRefKey(ref), ref]));
}

function appendLedgerRefs(
  ledger: ReadonlyMap<string, TabRef>,
  refs: ReadonlyArray<TabRef>,
): ReadonlyMap<string, TabRef> {
  if (refs.every((ref) => ledger.has(tabRefKey(ref)))) return ledger;
  const next = new Map(ledger);
  refs.forEach((ref) => next.set(tabRefKey(ref), ref));
  return next;
}

function transactionError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error("Tab command transaction failed", { cause: error });
}

function recordFailure(failures: Error[], failure: Error | null): void {
  if (failure !== null) failures.push(failure);
}

function attachSecondaryFailure(
  primary: Error,
  secondary: Error | null,
): Error {
  if (secondary === null) return primary;
  const existingCause = primary.cause;
  const causes =
    existingCause === undefined ? [secondary] : [existingCause, secondary];
  Object.defineProperty(primary, "cause", {
    configurable: true,
    value:
      causes.length === 1
        ? causes[0]
        : new AggregateError(causes, "Tab command recovery failures"),
  });
  return primary;
}

function primaryFailure(failures: ReadonlyArray<Error>): Error | null {
  const primary = failures.at(0);
  if (primary === undefined) return null;
  const secondary = failures.slice(1);
  if (secondary.length === 0) return primary;
  const existingCause = primary.cause;
  const causes =
    existingCause === undefined ? secondary : [existingCause, ...secondary];
  Object.defineProperty(primary, "cause", {
    configurable: true,
    value:
      causes.length === 1
        ? causes[0]
        : new AggregateError(causes, "Tab command cleanup failures"),
  });
  return primary;
}

function sourceRefs(): ReadonlyArray<TabRef> {
  const canvas = useEpicCanvasStore.getState();
  const epicRefs = canvas.openTabOrder.flatMap<TabRef>((tabId) =>
    canvas.tabsById[tabId] === undefined ? [] : [{ kind: "epic", id: tabId }],
  );
  const draftRefs = useLandingDraftStore
    .getState()
    .drafts.map<TabRef>((draft) => ({ kind: "draft", id: draft.id }));
  return [...epicRefs, ...draftRefs];
}

function sourceHasRef(ref: TabRef): boolean {
  if (ref.kind === "epic") {
    const canvas = useEpicCanvasStore.getState();
    return (
      canvas.tabsById[ref.id] !== undefined &&
      canvas.openTabOrder.includes(ref.id)
    );
  }
  if (ref.kind === "draft") {
    return useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === ref.id);
  }
  return currentLayout().systemTabs[ref.kind] !== null;
}

function canSplitRef(ref: TabRef): boolean {
  return tabSurfaceDescriptor(ref.kind).splitEligibility === "eligible";
}

function focusedRef(layout: PersistedTabStripLayout): TabRef | null {
  const active = layout.items.find((item) => item.id === layout.activeItemId);
  if (active === undefined) return null;
  if (active.kind === "tab") return active.ref;
  const side = active.focusedSide === "left" ? active.left : active.right;
  return side.kind === "tab" ? side.ref : null;
}

function layoutWithRemovedRef(
  layout: PersistedTabStripLayout,
  ref: TabRef,
): PersistedTabStripLayout {
  const next = removeLayoutRef(layout, ref);
  if (ref.kind !== "history" && ref.kind !== "settings") return next;
  return {
    ...next,
    systemTabs: { ...next.systemTabs, [ref.kind]: null },
  };
}

function unavailableSide(ref: TabRef, label: string): SplitSide {
  return { kind: "unavailable", previousRef: ref, label };
}

function replaceLostSide(
  side: SplitSide,
  refs: ReadonlyMap<string, TabRef>,
  labelForRef: (ref: TabRef) => string,
): SplitSide {
  if (side.kind !== "tab" || !refs.has(tabRefKey(side.ref))) return side;
  return unavailableSide(side.ref, labelForRef(side.ref));
}

function routeBackingAfterLoss(
  routeBackingSide: SplitSideName,
  leftLost: boolean,
  rightLost: boolean,
): SplitSideName {
  if (leftLost && routeBackingSide === "left") return "right";
  if (rightLost && routeBackingSide === "right") return "left";
  return routeBackingSide;
}

function replaceLostEpicRefs(
  layout: PersistedTabStripLayout,
  refs: ReadonlyMap<string, TabRef>,
): PersistedTabStripLayout {
  const labelForRef = (ref: TabRef): string => {
    const tab = useEpicCanvasStore.getState().tabsById[ref.id];
    return tab === undefined ? "Epic unavailable" : `${tab.name} unavailable`;
  };
  const activeIndex = layout.items.findIndex(
    (item) => item.id === layout.activeItemId,
  );
  const items = layout.items.flatMap<StripItem>((item) => {
    if (item.kind === "tab") {
      return refs.has(tabRefKey(item.ref)) ? [] : [item];
    }
    const left = replaceLostSide(item.left, refs, labelForRef);
    const right = replaceLostSide(item.right, refs, labelForRef);
    const leftLost = left !== item.left;
    const rightLost = right !== item.right;
    if (leftLost && rightLost) return [];
    if (!leftLost && !rightLost) return [item];
    return [
      {
        ...item,
        left,
        right,
        routeBackingSide: routeBackingAfterLoss(
          item.routeBackingSide,
          leftLost,
          rightLost,
        ),
      },
    ];
  });
  const activeItemId = items.some((item) => item.id === layout.activeItemId)
    ? layout.activeItemId
    : (items[Math.min(Math.max(activeIndex, 0), items.length - 1)]?.id ?? null);
  return { ...layout, items, activeItemId };
}

/**
 * Owns every synchronous layout/source transaction. Async callers prepare
 * their work outside this boundary and invoke one of these commands only when
 * they have an exact, current source mutation to apply.
 */
export class TabCommandCoordinator {
  private installed = false;
  private ready = true;
  private ledger = EMPTY_LEDGER;
  private diagnostics = EMPTY_DIAGNOSTICS;
  private readonly listeners = new Set<CoordinatorListener>();

  getLedger(): TabCommandLedger {
    return this.ledger;
  }

  getDiagnostics(): TabCommandCoordinatorDiagnostics {
    return this.diagnostics;
  }

  subscribe(listener: CoordinatorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setReconciliationReadyPromise(readyPromise: Promise<void>): void {
    this.ready = false;
    void readyPromise.then(() => {
      this.ready = true;
      if (this.installed) this.reconcileFromSourceStores();
    });
  }

  resetReconciliationForTesting(): void {
    this.ready = true;
    this.ledger = EMPTY_LEDGER;
    this.diagnostics = EMPTY_DIAGNOSTICS;
    this.notify();
  }

  installSourceReconciliation(): void {
    if (this.installed) return;
    this.installed = true;
    if (this.ready) this.reconcileFromSourceStores();
    useEpicCanvasStore.subscribe((next, previous) => {
      if (
        next.openTabOrder === previous.openTabOrder &&
        next.tabsById === previous.tabsById
      ) {
        return;
      }
      this.onSourceStoreChange();
    });
    useLandingDraftStore.subscribe((next, previous) => {
      if (next.drafts === previous.drafts) return;
      this.onSourceStoreChange();
    });
  }

  fillSplitSide(command: FillSplitSideCommand): boolean {
    const layout = currentLayout();
    if (!sourceHasRef(command.ref)) return false;
    const next = replaceFillableSide(layout, command, canSplitRef);
    if (next === layout) return false;
    this.execute({
      layout: next,
      reservedAdditions: [command.ref],
      pendingRemovals: [],
      projectSourceCompatibility: true,
      applySources: () => undefined,
      applyRemovals: () => undefined,
    });
    return true;
  }

  createEmptySplit(args: CreateEmptySplitArgs): boolean {
    const layout = currentLayout();
    if (!sourceHasRef(args.ref)) return false;
    const next = createEmptySplit(layout, args, canSplitRef);
    if (next === layout) return false;
    this.execute({
      layout: next,
      reservedAdditions: [],
      pendingRemovals: [],
      projectSourceCompatibility: true,
      applySources: () => undefined,
      applyRemovals: () => undefined,
    });
    return true;
  }

  createDraftForSplit(command: CreateDraftForSplitCommand): TabRef | null {
    const ref: TabRef = { kind: "draft", id: uuidv4() };
    const layout = currentLayout();
    const next = replaceFillableSide(layout, { ...command, ref }, canSplitRef);
    if (next === layout) return null;
    this.execute({
      layout: next,
      reservedAdditions: [ref],
      pendingRemovals: [],
      projectSourceCompatibility: true,
      applySources: () => {
        this.applyExpectedSourceMutation(() => {
          useLandingDraftStore.getState().createDraftWithId(ref.id, null);
        });
      },
      applyRemovals: () => undefined,
    });
    return ref;
  }

  replaceDraftWithEpic(command: ReplaceDraftWithEpicCommand): TabRef | null {
    const previous: TabRef = { kind: "draft", id: command.draftId };
    const nextRef: TabRef = { kind: "epic", id: command.epicTabId };
    const layout = currentLayout();
    if (findStripItemForRef(layout, previous) === null) return null;
    const next = replaceLayoutRef(layout, { previous, next: nextRef });
    if (next === layout) return null;
    const epicExists = sourceHasRef(nextRef);
    this.execute({
      layout: next,
      reservedAdditions: [nextRef],
      pendingRemovals: [previous],
      projectSourceCompatibility: true,
      applySources: () => {
        if (epicExists) return;
        this.applyExpectedSourceMutation(() => {
          useEpicCanvasStore
            .getState()
            .openEpicTabWithId(
              command.epicTabId,
              command.epicId,
              command.epicName,
            );
        });
      },
      applyRemovals: () => {
        this.applyExpectedSourceMutation(() => {
          useLandingDraftStore.getState().closeDraft(command.draftId);
        });
      },
    });
    return nextRef;
  }

  closeRef(ref: TabRef): boolean {
    return this.closeRefAfterConfirmed(ref);
  }

  closeRefAfterConfirmed(ref: TabRef): boolean {
    const layout = currentLayout();
    if (findStripItemForRef(layout, ref) === null) return false;
    const next = layoutWithRemovedRef(layout, ref);
    this.execute({
      layout: next,
      reservedAdditions: [],
      pendingRemovals:
        ref.kind === "history" || ref.kind === "settings" ? [] : [ref],
      projectSourceCompatibility: true,
      applySources: () => undefined,
      applyRemovals: () => this.removeSourceRef(ref),
    });
    return true;
  }

  handleEpicAccessLoss(epicIds: ReadonlyArray<string>): void {
    const ids = new Set(epicIds);
    if (ids.size === 0) return;
    const canvas = useEpicCanvasStore.getState();
    const affected = flattenLayoutRefs(currentLayout()).flatMap<TabRef>(
      (ref) => {
        if (ref.kind !== "epic") return [];
        const tab = canvas.tabsById[ref.id];
        return tab !== undefined && ids.has(tab.epicId) ? [ref] : [];
      },
    );
    if (affected.length === 0) return;
    const refs = refsToLedger(affected);
    this.execute({
      layout: replaceLostEpicRefs(currentLayout(), refs),
      reservedAdditions: [],
      pendingRemovals: affected,
      projectSourceCompatibility: true,
      applySources: () => undefined,
      applyRemovals: () => {
        this.applyExpectedSourceMutation(() => {
          useEpicCanvasStore.getState().closeTabsForEpics(epicIds);
        });
        epicIds.forEach(releaseOpenEpicSessionIfUnused);
      },
    });
  }

  separateBeforeMove(ref: TabRef): SeparateBeforeMoveResult {
    const layout = currentLayout();
    const item = findStripItemForRef(layout, ref);
    if (item === null || item.kind === "tab") {
      return { separated: false, splitId: null };
    }
    this.execute({
      layout: separateSplit(layout, item.id),
      reservedAdditions: [],
      pendingRemovals: [],
      projectSourceCompatibility: true,
      applySources: () => undefined,
      applyRemovals: () => undefined,
    });
    return { separated: true, splitId: item.id };
  }

  removeMovedRef(ref: TabRef): boolean {
    if (ref.kind !== "epic") return false;
    const layout = currentLayout();
    if (findStripItemForRef(layout, ref) === null) return false;
    this.execute({
      layout: layoutWithRemovedRef(layout, ref),
      reservedAdditions: [],
      pendingRemovals: [ref],
      projectSourceCompatibility: true,
      applySources: () => undefined,
      applyRemovals: () => {
        this.applyExpectedSourceMutation(() => {
          useEpicCanvasStore.getState().discardTabState(ref.id);
        });
      },
    });
    return true;
  }

  reconcileFromSourceStores(): void {
    if (!this.ready || this.ledger.suppressionDepth > 0) return;
    const layout = currentLayout();
    const { next, additions, removals } = this.sourceReconciliationPlan(layout);
    if (next === layout) return;
    this.execute({
      layout: next,
      reservedAdditions: additions,
      pendingRemovals: removals,
      // Direct legacy source writers still own their active-id compatibility
      // fields until T3 converts every activation entry point. Hydration and
      // external source reconciliation therefore repair layout only; they
      // must not echo a source snapshot back through desktop persistence.
      projectSourceCompatibility: false,
      applySources: () => undefined,
      applyRemovals: () => undefined,
    });
  }

  private onSourceStoreChange(): void {
    if (!this.ready) return;
    if (this.ledger.suppressionDepth === 0) {
      this.reconcileFromSourceStores();
      return;
    }
    const layoutRefs = flattenLayoutRefs(currentLayout());
    const placed = new Set(layoutRefs.map(tabRefKey));
    const currentSources = sourceRefs();
    const sourceKeys = new Set(currentSources.map(tabRefKey));
    const newlyReserved = currentSources.filter(
      (ref) =>
        !placed.has(tabRefKey(ref)) &&
        !this.ledger.pendingRemovals.has(tabRefKey(ref)),
    );
    const unexpectedAdditions = newlyReserved.some(
      (ref) => !this.ledger.reservedAdditions.has(tabRefKey(ref)),
    );
    const unexpectedRemovals = layoutRefs.some(
      (ref) =>
        (ref.kind === "epic" || ref.kind === "draft") &&
        !sourceKeys.has(tabRefKey(ref)) &&
        !this.ledger.pendingRemovals.has(tabRefKey(ref)),
    );
    const reconciliationDirty =
      this.ledger.reconciliationDirty ||
      unexpectedAdditions ||
      unexpectedRemovals;
    this.ledger = {
      ...this.ledger,
      reservedAdditions: appendLedgerRefs(
        this.ledger.reservedAdditions,
        newlyReserved,
      ),
      reconciliationDirty,
    };
    this.notify();
  }

  private execute(input: {
    readonly layout: PersistedTabStripLayout;
    readonly reservedAdditions: ReadonlyArray<TabRef>;
    readonly pendingRemovals: ReadonlyArray<TabRef>;
    readonly projectSourceCompatibility: boolean;
    readonly applySources: () => void;
    readonly applyRemovals: () => void;
  }): void {
    if (this.ledger.suppressionDepth > 0) {
      throw new Error("Tab commands cannot be re-entered during a transaction");
    }
    const failures: Error[] = [];
    transactionDepth += 1;
    try {
      this.ledger = {
        reservedAdditions: refsToLedger(input.reservedAdditions),
        pendingRemovals: refsToLedger(input.pendingRemovals),
        suppressionDepth: 1,
        reconciliationDirty: false,
      };
      this.notify();
      input.applySources();
      const layoutFailure = this.replaceLayoutForTransaction(input.layout);
      if (layoutFailure !== null) throw layoutFailure;
      this.consumePlacedReservations(input.layout);
      this.notify();
      input.applyRemovals();
    } catch (error) {
      recordFailure(failures, transactionError(error));
      this.ledger = { ...this.ledger, reconciliationDirty: true };
    } finally {
      let converged = false;
      try {
        const finalization = this.finalize(input.projectSourceCompatibility);
        failures.push(...finalization.failures);
        converged = finalization.converged;
      } catch (error) {
        recordFailure(failures, transactionError(error));
      } finally {
        transactionDepth -= 1;
        if (converged) {
          this.ledger = EMPTY_LEDGER;
          try {
            this.notify();
          } catch (error) {
            recordFailure(failures, transactionError(error));
          }
        } else {
          failures.push(
            new Error(
              "Tab command finalization did not converge before ledger release",
            ),
          );
        }
      }
    }
    const failure = primaryFailure(failures);
    if (failure !== null) throw failure;
  }

  private applyExpectedSourceMutation(mutate: () => void): void {
    mutate();
  }

  private removeSourceRef(ref: TabRef): void {
    if (ref.kind === "epic") {
      this.applyExpectedSourceMutation(() => {
        useEpicCanvasStore.getState().closeTab(ref.id);
      });
      const tab = useEpicCanvasStore.getState().tabsById[ref.id];
      if (tab !== undefined) releaseOpenEpicSessionIfUnused(tab.epicId);
      return;
    }
    if (ref.kind === "draft") {
      this.applyExpectedSourceMutation(() => {
        useLandingDraftStore.getState().closeDraft(ref.id);
      });
    }
  }

  private finalize(projectSourceCompatibility: boolean): {
    readonly failures: ReadonlyArray<Error>;
    readonly converged: boolean;
  } {
    const failures: Error[] = [];
    let requiresCompatibilityProjection = projectSourceCompatibility;
    for (
      let iteration = 0;
      iteration < MAX_FINALIZATION_ITERATIONS;
      iteration += 1
    ) {
      this.runFinalizationStep(
        () => this.reconcileSuppressedLayoutIfDirty(),
        failures,
      );
      this.runFinalizationStep(
        () => this.normalizeTransactionLayout(),
        failures,
      );
      if (this.ledger.reconciliationDirty) continue;
      if (requiresCompatibilityProjection) {
        try {
          this.projectCompatibilityState();
          this.diagnostics = {
            ...this.diagnostics,
            compatibilityProjectionCount:
              this.diagnostics.compatibilityProjectionCount + 1,
          };
        } catch (error) {
          recordFailure(failures, transactionError(error));
          this.ledger = { ...this.ledger, reconciliationDirty: true };
        }
        requiresCompatibilityProjection = this.ledger.reconciliationDirty;
      }
      if (!this.ledger.reconciliationDirty) {
        return { failures, converged: true };
      }
    }
    return { failures, converged: false };
  }

  private runFinalizationStep(
    operation: () => Error | null,
    failures: Error[],
  ): void {
    try {
      recordFailure(failures, operation());
    } catch (error) {
      recordFailure(failures, transactionError(error));
      this.ledger = { ...this.ledger, reconciliationDirty: true };
    }
  }

  private reconcileSuppressedLayoutIfDirty(): Error | null {
    if (!this.ledger.reconciliationDirty) return null;
    this.ledger = { ...this.ledger, reconciliationDirty: false };
    this.diagnostics = {
      ...this.diagnostics,
      deferredReconciliationCount:
        this.diagnostics.deferredReconciliationCount + 1,
    };
    const layout = currentLayout();
    const { next } = this.sourceReconciliationPlan(layout);
    if (next === layout) return null;
    const layoutFailure = this.replaceLayoutForTransaction(next);
    this.consumePlacedReservations(next);
    return layoutFailure;
  }

  private replaceLayoutForTransaction(
    layout: PersistedTabStripLayout,
  ): Error | null {
    try {
      useTabsStore.getState().replaceLayoutForTransaction(layout);
      return null;
    } catch (error) {
      const primary = transactionError(error);
      const fallbackFailure = this.replaceLayoutWithoutPersistence(layout);
      return attachSecondaryFailure(primary, fallbackFailure);
    }
  }

  private normalizeTransactionLayout(): Error | null {
    try {
      useTabsStore.getState().finalizeTransactionLayout();
      this.diagnostics = {
        ...this.diagnostics,
        normalizationCount: this.diagnostics.normalizationCount + 1,
      };
      return null;
    } catch (error) {
      const primary = transactionError(error);
      const repaired = repairLayout(currentLayout(), isRegisteredTabKind);
      const fallbackFailure = this.replaceLayoutWithoutPersistence(repaired);
      this.diagnostics = {
        ...this.diagnostics,
        normalizationCount: this.diagnostics.normalizationCount + 1,
      };
      return attachSecondaryFailure(primary, fallbackFailure);
    }
  }

  private replaceLayoutWithoutPersistence(
    layout: PersistedTabStripLayout,
  ): Error | null {
    try {
      useTabsStore.setState({
        version: layout.version,
        items: layout.items,
        activeItemId: layout.activeItemId,
        systemTabs: layout.systemTabs,
        stripOrder: flattenLayoutRefs(layout),
      });
      return null;
    } catch (error) {
      return transactionError(error);
    }
  }

  private sourceReconciliationPlan(layout: PersistedTabStripLayout): {
    readonly next: PersistedTabStripLayout;
    readonly additions: ReadonlyArray<TabRef>;
    readonly removals: ReadonlyArray<TabRef>;
  } {
    const knownSources = sourceRefs();
    const knownKeys = new Set(knownSources.map(tabRefKey));
    const removals = flattenLayoutRefs(layout).filter(
      (ref) =>
        (ref.kind === "epic" || ref.kind === "draft") &&
        !knownKeys.has(tabRefKey(ref)),
    );
    const withoutMissing = removals.reduce(layoutWithRemovedRef, layout);
    const additions = knownSources.filter(
      (ref) => findStripItemForRef(withoutMissing, ref) === null,
    );
    return {
      next: additions.reduce(createLayoutItem, withoutMissing),
      additions,
      removals,
    };
  }

  private consumePlacedReservations(layout: PersistedTabStripLayout): void {
    const committedKeys = new Set(flattenLayoutRefs(layout).map(tabRefKey));
    this.ledger = {
      ...this.ledger,
      reservedAdditions: new Map(
        [...this.ledger.reservedAdditions].filter(
          ([key]) => !committedKeys.has(key),
        ),
      ),
    };
  }

  private projectCompatibilityState(): void {
    const layout = currentLayout();
    const currentCanvas = useEpicCanvasStore.getState();
    const layoutEpicIds = flattenLayoutRefs(layout).flatMap((ref) =>
      ref.kind === "epic" && currentCanvas.tabsById[ref.id] !== undefined
        ? [ref.id]
        : [],
    );
    const reservedEpicIds = [...this.ledger.reservedAdditions.values()].flatMap(
      (ref) =>
        ref.kind === "epic" && currentCanvas.tabsById[ref.id] !== undefined
          ? [ref.id]
          : [],
    );
    const openTabOrder = [...new Set([...layoutEpicIds, ...reservedEpicIds])];
    const selected = focusedRef(layout);
    const activeTabId =
      selected?.kind === "epic" && openTabOrder.includes(selected.id)
        ? selected.id
        : null;
    const orderChanged =
      openTabOrder.length !== currentCanvas.openTabOrder.length ||
      openTabOrder.some(
        (tabId, index) => tabId !== currentCanvas.openTabOrder[index],
      );
    if (orderChanged || activeTabId !== currentCanvas.activeTabId) {
      this.applyExpectedSourceMutation(() => {
        useEpicCanvasStore.setState({ openTabOrder, activeTabId });
      });
    }

    const currentDrafts = useLandingDraftStore.getState().drafts;
    const activeDraftId =
      selected?.kind === "draft" &&
      currentDrafts.some((draft) => draft.id === selected.id)
        ? selected.id
        : null;
    if (activeDraftId !== useLandingDraftStore.getState().activeDraftId) {
      this.applyExpectedSourceMutation(() => {
        useLandingDraftStore.setState({ activeDraftId });
      });
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const tabCommandCoordinator = new TabCommandCoordinator();

export function getTabCommandLedger(): TabCommandLedger {
  return tabCommandCoordinator.getLedger();
}

export function getTabCommandCoordinatorDiagnostics(): TabCommandCoordinatorDiagnostics {
  return tabCommandCoordinator.getDiagnostics();
}

export function subscribeToTabCommandLedger(
  listener: CoordinatorListener,
): () => void {
  return tabCommandCoordinator.subscribe(listener);
}

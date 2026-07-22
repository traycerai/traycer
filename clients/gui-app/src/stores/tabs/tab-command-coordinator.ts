import { v4 as uuidv4 } from "uuid";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { releaseOpenEpicSessionIfUnused } from "@/lib/registries/epic-session-registry";
import {
  resolveTabIdForEpic,
  resolveTabIdForPhaseMigration,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  isRegisteredTabKind,
  tabSurfaceDescriptor,
} from "@/stores/tabs/registry";
import {
  consumeLegacyTabsSourceActiveSelection,
  useTabsStore,
} from "@/stores/tabs/store";
import {
  createEmptySplit,
  createLayoutItem,
  findStripItemForRef,
  flattenLayoutRefs,
  focusLayoutRef,
  focusSplitSide,
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
import { canMutateTabSplits } from "@/stores/tabs/tab-split-compatibility";
import {
  isTabCloseLocked,
  isTabStructurallyLocked,
} from "@/stores/tabs/tab-structural-lock";

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

export interface CompletePhaseMigrationCommand {
  readonly tabId: string;
  readonly phaseId: string;
  readonly epicId: string;
}

export type CoordinatedTabActivationTarget =
  | { readonly kind: "ref"; readonly ref: TabRef }
  | {
      readonly kind: "draft";
      readonly draftId: string | null;
      readonly settings: ChatRunSettings | null;
      readonly create: boolean;
    }
  | {
      readonly kind: "epic";
      readonly epicId: string;
      readonly tabId: string | null;
      readonly name: string | undefined;
    }
  | {
      readonly kind: "phase-migration";
      readonly phaseId: string;
      readonly name: string | undefined;
    }
  | {
      readonly kind: "migrated-epic";
      readonly sourceEpicId: string;
      readonly epicId: string;
      readonly tabId: string;
    }
  | {
      readonly kind: "system";
      readonly systemKind: "history" | "settings";
      readonly name: string;
      readonly lastPath: string;
    };

export interface CoordinatedTabSelection {
  readonly items: ReadonlyArray<StripItem>;
  readonly activeItemId: string | null;
  readonly focusedSide: SplitSideName | null;
  readonly focusedRef: TabRef | null;
}

export interface CoordinatedTabActivation {
  readonly ref: TabRef;
  readonly priorSelection: CoordinatedTabSelection;
  readonly ownedSelection: CoordinatedTabSelection;
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
  return (
    canMutateTabSplits() &&
    !isTabStructurallyLocked(ref) &&
    tabSurfaceDescriptor(ref.kind).splitEligibility === "eligible"
  );
}

function focusedRef(layout: PersistedTabStripLayout): TabRef | null {
  const active = layout.items.find((item) => item.id === layout.activeItemId);
  if (active === undefined) return null;
  if (active.kind === "tab") return active.ref;
  const side = active.focusedSide === "left" ? active.left : active.right;
  return side.kind === "tab" ? side.ref : null;
}

function coordinatedSelection(
  layout: PersistedTabStripLayout,
): CoordinatedTabSelection {
  const active = layout.items.find((item) => item.id === layout.activeItemId);
  return {
    items: layout.items,
    activeItemId: layout.activeItemId,
    focusedSide: active?.kind === "split" ? active.focusedSide : null,
    focusedRef: focusedRef(layout),
  };
}

function selectionsEqual(
  left: CoordinatedTabSelection,
  right: CoordinatedTabSelection,
): boolean {
  const refsMatch =
    left.focusedRef === null
      ? right.focusedRef === null
      : right.focusedRef !== null &&
        tabRefKey(left.focusedRef) === tabRefKey(right.focusedRef);
  return (
    left.items === right.items &&
    left.activeItemId === right.activeItemId &&
    left.focusedSide === right.focusedSide &&
    refsMatch
  );
}

function restoreCoordinatedSelection(
  layout: PersistedTabStripLayout,
  selection: CoordinatedTabSelection,
): PersistedTabStripLayout | null {
  const priorItem = layout.items.find(
    (item) => item.id === selection.activeItemId,
  );
  if (priorItem === undefined) return null;
  if (selection.focusedSide !== null) {
    if (priorItem.kind !== "split") return null;
    return focusSplitSide(layout, {
      splitId: priorItem.id,
      side: selection.focusedSide,
    });
  }
  if (selection.focusedRef === null) return null;
  return focusLayoutRef(layout, selection.focusedRef);
}

interface ResolvedCoordinatedActivation {
  readonly ref: TabRef;
  readonly layout: PersistedTabStripLayout;
  readonly reservedAdditions: ReadonlyArray<TabRef>;
  readonly applySources: () => void;
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
      if (this.installed) {
        this.reconcileFromSourceStores();
        this.restoreLegacySourceActiveSelection();
      }
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
    if (this.ready) {
      this.reconcileFromSourceStores();
      this.restoreLegacySourceActiveSelection();
    }
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

  /**
   * Reservation-first activation boundary for ordinary top-level navigation.
   * Resolution is read-only until `execute` installs the ledger; a ref absent
   * from the prior layout is always present in `reservedAdditions` before its
   * source is created/reopened and before the layout can expose it.
   */
  activateTab(
    target: CoordinatedTabActivationTarget,
  ): CoordinatedTabActivation | null {
    const priorLayout = currentLayout();
    const priorSelection = coordinatedSelection(priorLayout);
    const resolved = this.resolveCoordinatedActivation(target, priorLayout);
    if (resolved === null) return null;
    this.execute({
      layout: resolved.layout,
      reservedAdditions: resolved.reservedAdditions,
      pendingRemovals: [],
      projectSourceCompatibility: true,
      applySources: () => {
        this.applyExpectedSourceMutation(resolved.applySources);
      },
      applyRemovals: () => undefined,
    });
    return {
      ref: resolved.ref,
      priorSelection,
      ownedSelection: coordinatedSelection(currentLayout()),
    };
  }

  /**
   * Restores selection only while the caller still owns the exact structural
   * result of `activateTab`. Newly-created membership intentionally remains.
   */
  restoreTabActivation(activation: CoordinatedTabActivation): boolean {
    const layout = currentLayout();
    if (
      !selectionsEqual(coordinatedSelection(layout), activation.ownedSelection)
    ) {
      return false;
    }
    const restored = restoreCoordinatedSelection(
      layout,
      activation.priorSelection,
    );
    if (restored === null) return false;
    this.execute({
      layout: restored,
      reservedAdditions: [],
      pendingRemovals: [],
      projectSourceCompatibility: true,
      applySources: () => undefined,
      applyRemovals: () => undefined,
    });
    return true;
  }

  private resolveCoordinatedActivation(
    target: CoordinatedTabActivationTarget,
    layout: PersistedTabStripLayout,
  ): ResolvedCoordinatedActivation | null {
    switch (target.kind) {
      case "system":
        return this.resolveSystemActivation(target, layout);
      case "draft":
        return this.resolveDraftActivation(target, layout);
      case "epic":
        return this.resolveEpicActivation(target, layout);
      case "phase-migration":
        return this.resolvePhaseMigrationActivation(target, layout);
      case "migrated-epic":
        return this.resolveMigratedEpicActivation(target, layout);
      case "ref":
        return this.resolveRefActivation(target.ref, layout);
    }
  }

  private resolveSystemActivation(
    target: Extract<CoordinatedTabActivationTarget, { kind: "system" }>,
    layout: PersistedTabStripLayout,
  ): ResolvedCoordinatedActivation {
    const ref: TabRef = {
      kind: target.systemKind,
      id: target.systemKind,
    };
    const withSystem = {
      ...layout,
      systemTabs: {
        ...layout.systemTabs,
        [target.systemKind]: {
          id: target.systemKind,
          kind: target.systemKind,
          name: target.name,
          lastPath: target.lastPath,
        },
      },
    };
    const wasPresent = findStripItemForRef(layout, ref) !== null;
    const next = focusLayoutRef(createLayoutItem(withSystem, ref), ref);
    return {
      ref,
      layout: next,
      reservedAdditions: wasPresent ? [] : [ref],
      applySources: () => undefined,
    };
  }

  private resolveDraftActivation(
    target: Extract<CoordinatedTabActivationTarget, { kind: "draft" }>,
    layout: PersistedTabStripLayout,
  ): ResolvedCoordinatedActivation | null {
    const draftId = target.draftId ?? (target.create ? uuidv4() : null);
    if (draftId === null) return null;
    const exists = useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === draftId);
    if (!target.create && !exists) return null;
    const ref: TabRef = { kind: "draft", id: draftId };
    return this.activationForRef(layout, ref, () => {
      if (!exists) {
        useLandingDraftStore
          .getState()
          .createDraftWithId(draftId, target.settings);
        return;
      }
      useLandingDraftStore.getState().setActiveDraft(draftId);
    });
  }

  private resolveEpicActivation(
    target: Extract<CoordinatedTabActivationTarget, { kind: "epic" }>,
    layout: PersistedTabStripLayout,
  ): ResolvedCoordinatedActivation | null {
    const canvas = useEpicCanvasStore.getState();
    const resolvedId =
      target.tabId ?? resolveTabIdForEpic(canvas, target.epicId) ?? uuidv4();
    const existing = canvas.tabsById[resolvedId];
    if (existing !== undefined && existing.epicId !== target.epicId)
      return null;
    const ref: TabRef = { kind: "epic", id: resolvedId };
    return this.activationForRef(layout, ref, () => {
      if (existing === undefined) {
        useEpicCanvasStore
          .getState()
          .openEpicTabWithId(
            resolvedId,
            target.epicId,
            target.name ?? "Untitled epic",
          );
        return;
      }
      useEpicCanvasStore.getState().setActiveTab(resolvedId);
    });
  }

  private resolveMigratedEpicActivation(
    target: Extract<CoordinatedTabActivationTarget, { kind: "migrated-epic" }>,
    layout: PersistedTabStripLayout,
  ): ResolvedCoordinatedActivation | null {
    const existing = useEpicCanvasStore.getState().tabsById[target.tabId];
    if (
      existing === undefined ||
      (existing.epicId !== target.sourceEpicId &&
        existing.epicId !== target.epicId)
    ) {
      return null;
    }
    const ref: TabRef = { kind: "epic", id: target.tabId };
    return this.activationForRef(layout, ref, () => {
      useEpicCanvasStore.setState((state) => {
        const current = state.tabsById[target.tabId];
        if (
          current === undefined ||
          (current.epicId !== target.sourceEpicId &&
            current.epicId !== target.epicId)
        ) {
          return state;
        }
        const mostRecentTabIdByEpicId = {
          ...state.mostRecentTabIdByEpicId,
          [target.epicId]: target.tabId,
        };
        if (
          target.sourceEpicId !== target.epicId &&
          mostRecentTabIdByEpicId[target.sourceEpicId] === target.tabId
        ) {
          delete mostRecentTabIdByEpicId[target.sourceEpicId];
        }
        return {
          tabsById: {
            ...state.tabsById,
            [target.tabId]: { ...current, epicId: target.epicId },
          },
          openTabOrder: state.openTabOrder.includes(target.tabId)
            ? state.openTabOrder
            : [...state.openTabOrder, target.tabId],
          activeTabId: target.tabId,
          mostRecentTabIdByEpicId,
        };
      });
    });
  }

  private resolvePhaseMigrationActivation(
    target: Extract<
      CoordinatedTabActivationTarget,
      { kind: "phase-migration" }
    >,
    layout: PersistedTabStripLayout,
  ): ResolvedCoordinatedActivation | null {
    const canvas = useEpicCanvasStore.getState();
    const resolvedId =
      resolveTabIdForPhaseMigration(canvas, target.phaseId) ?? uuidv4();
    const existing = canvas.tabsById[resolvedId];
    if (
      existing !== undefined &&
      (existing.surfaceMode?.kind !== "phase-migration" ||
        existing.surfaceMode.phaseId !== target.phaseId)
    ) {
      return null;
    }
    const ref: TabRef = { kind: "epic", id: resolvedId };
    return this.activationForRef(layout, ref, () => {
      if (existing === undefined) {
        useEpicCanvasStore
          .getState()
          .openPhaseMigrationTabWithId(resolvedId, target.phaseId, target.name);
        return;
      }
      useEpicCanvasStore.getState().setActiveTab(resolvedId);
    });
  }

  private resolveRefActivation(
    ref: TabRef,
    layout: PersistedTabStripLayout,
  ): ResolvedCoordinatedActivation | null {
    if (ref.kind === "epic") {
      const tab = useEpicCanvasStore.getState().tabsById[ref.id];
      if (tab === undefined) return null;
      return this.activationForRef(layout, ref, () => {
        useEpicCanvasStore.getState().setActiveTab(ref.id);
      });
    }
    if (ref.kind === "draft") {
      const exists = useLandingDraftStore
        .getState()
        .drafts.some((draft) => draft.id === ref.id);
      if (!exists) return null;
      return this.activationForRef(layout, ref, () => {
        useLandingDraftStore.getState().setActiveDraft(ref.id);
      });
    }
    if (layout.systemTabs[ref.kind] === null) return null;
    return this.activationForRef(layout, ref, () => undefined);
  }

  private activationForRef(
    layout: PersistedTabStripLayout,
    ref: TabRef,
    applySources: () => void,
  ): ResolvedCoordinatedActivation {
    const wasPresent = findStripItemForRef(layout, ref) !== null;
    const next = focusLayoutRef(createLayoutItem(layout, ref), ref);
    return {
      ref,
      layout: next,
      reservedAdditions: wasPresent ? [] : [ref],
      applySources,
    };
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

  /**
   * Converts the exact persisted migration ref without touching its layout
   * item, split side, ratio, or focused partner. Route ownership is decided by
   * the slot-local migration bridge after this source transaction commits.
   */
  completePhaseMigration(command: CompletePhaseMigrationCommand): boolean {
    const ref: TabRef = { kind: "epic", id: command.tabId };
    const layout = currentLayout();
    const existing = useEpicCanvasStore.getState().tabsById[command.tabId];
    if (
      findStripItemForRef(layout, ref) === null ||
      existing?.surfaceMode?.kind !== "phase-migration" ||
      existing.surfaceMode.phaseId !== command.phaseId
    ) {
      return false;
    }
    this.execute({
      layout,
      reservedAdditions: [],
      pendingRemovals: [],
      projectSourceCompatibility: true,
      applySources: () => {
        this.applyExpectedSourceMutation(() => {
          useEpicCanvasStore.setState((state) => {
            const current = state.tabsById[command.tabId];
            if (
              current?.surfaceMode?.kind !== "phase-migration" ||
              current.surfaceMode.phaseId !== command.phaseId
            ) {
              return state;
            }
            const mostRecentTabIdByEpicId = {
              ...state.mostRecentTabIdByEpicId,
              [command.epicId]: command.tabId,
            };
            if (
              command.phaseId !== command.epicId &&
              mostRecentTabIdByEpicId[command.phaseId] === command.tabId
            ) {
              delete mostRecentTabIdByEpicId[command.phaseId];
            }
            return {
              tabsById: {
                ...state.tabsById,
                [command.tabId]: {
                  ...current,
                  epicId: command.epicId,
                  surfaceMode: { kind: "epic" },
                },
              },
              mostRecentTabIdByEpicId,
            };
          });
        });
      },
      applyRemovals: () => undefined,
    });
    return true;
  }

  closeRef(ref: TabRef): boolean {
    return this.closeRefAfterConfirmed(ref);
  }

  closeRefAfterConfirmed(ref: TabRef): boolean {
    if (isTabCloseLocked(ref)) return false;
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
    if (
      flattenLayoutRefs({ ...layout, items: [item] }).some(
        isTabStructurallyLocked,
      )
    ) {
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
    if (isTabStructurallyLocked(ref)) return false;
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

  /**
   * Hydration-only layout installation. Source snapshots have already landed;
   * this command reserves every ref newly placed into the authoritative layout
   * before the normal transaction finalizer projects compatibility state.
   */
  restoreHydratedLayout(layout: PersistedTabStripLayout): void {
    const sourceKeys = new Set(sourceRefs().map(tabRefKey));
    const current = currentLayout();
    const missing = flattenLayoutRefs(layout).filter(
      (ref) =>
        ref.kind !== "history" &&
        ref.kind !== "settings" &&
        !sourceKeys.has(tabRefKey(ref)),
    );
    const repaired = repairLayout(
      missing.reduce(removeLayoutRef, layout),
      isRegisteredTabKind,
    );
    const currentKeys = new Set(flattenLayoutRefs(current).map(tabRefKey));
    const reservedAdditions = flattenLayoutRefs(repaired).filter(
      (ref) =>
        !currentKeys.has(tabRefKey(ref)) &&
        ref.kind !== "history" &&
        ref.kind !== "settings",
    );
    this.execute({
      layout: repaired,
      reservedAdditions,
      pendingRemovals: [],
      projectSourceCompatibility: false,
      applySources: () => undefined,
      applyRemovals: () => undefined,
    });
  }

  private restoreLegacySourceActiveSelection(): void {
    if (!consumeLegacyTabsSourceActiveSelection()) return;
    const layout = currentLayout();
    const canvasActiveId = useEpicCanvasStore.getState().activeTabId;
    const draftActiveId = useLandingDraftStore.getState().activeDraftId;
    const sourceActive = flattenLayoutRefs(layout)
      .filter(
        (ref) =>
          (ref.kind === "epic" && ref.id === canvasActiveId) ||
          (ref.kind === "draft" && ref.id === draftActiveId),
      )
      .at(-1);
    if (sourceActive === undefined) return;
    this.execute({
      layout: focusLayoutRef(layout, sourceActive),
      reservedAdditions: [],
      pendingRemovals: [],
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

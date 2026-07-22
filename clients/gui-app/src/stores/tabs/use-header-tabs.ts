import { useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicViewTab } from "@/stores/epics/canvas/types";
import {
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { TAB_KINDS } from "@/stores/tabs/registry";
import type { HeaderTab, SystemTab, TabRef } from "@/stores/tabs/types";
import {
  getTabStructuralLockRevision,
  isTabCloseLocked,
  isTabStructurallyLocked,
  subscribeTabStructuralLocks,
} from "@/stores/tabs/tab-structural-lock";

/**
 * Projects the canonical strip order into render-ready `HeaderTab[]`.
 * Each `TabRef` is resolved against the source store for its kind;
 * the kind module's `build()` factory flattens the source record into
 * the self-contained `HeaderTab` variant. Refs whose source no longer
 * exists are filtered out (reconciliation should keep them in sync).
 */
export function useHeaderTabs(): ReadonlyArray<HeaderTab> {
  const structuralLockRevision = useSyncExternalStore(
    subscribeTabStructuralLocks,
    getTabStructuralLockRevision,
    getTabStructuralLockRevision,
  );
  const stripOrder = useTabsStore(useShallow((s) => s.stripOrder));
  const epicTabs = useEpicCanvasStore(
    useShallow((s) =>
      s.openTabOrder.flatMap((tabId) => {
        const tab = s.tabsById[tabId];
        return tab === undefined ? [] : [tab];
      }),
    ),
  );
  const draftTabs = useLandingDraftStore(useShallow((s) => s.drafts));
  const systemTabs = useTabsStore(useShallow((s) => s.systemTabs));

  const epicTabsById = useMemo(
    () => new Map<string, EpicViewTab>(epicTabs.map((t) => [t.tabId, t])),
    [epicTabs],
  );

  const draftTabsById = useMemo(
    () => new Map<string, LandingDraftTab>(draftTabs.map((t) => [t.id, t])),
    [draftTabs],
  );

  return useMemo<ReadonlyArray<HeaderTab>>(
    () =>
      stripOrder.flatMap<HeaderTab>((ref) =>
        resolveRef(ref, {
          epicTabsById,
          draftTabsById,
          systemTabs,
          structuralLockRevision,
        }),
      ),
    [
      draftTabsById,
      epicTabsById,
      stripOrder,
      structuralLockRevision,
      systemTabs,
    ],
  );
}

// `build()` mints a fresh `HeaderTab` on every call, so without memoization any
// `useHeaderTabs` recompute (a tab open/close, or unrelated input churn)
// rebuilt EVERY non-Epic tab and re-rendered every header `TabItem`. Epic tabs
// have cache entries for every exact-ref combination of structural and close
// lock. A revision still re-runs projection so a lock transition is visible,
// while unrelated lock churn preserves the referential identity of every
// unlocked Epic header.
type EpicHeaderTabLockState =
  | "unlocked"
  | "close-locked"
  | "structurally-locked"
  | "structurally-and-close-locked";

const epicHeaderTabCache = new WeakMap<
  EpicViewTab,
  Map<EpicHeaderTabLockState, HeaderTab>
>();
const draftHeaderTabCache = new WeakMap<LandingDraftTab, HeaderTab>();
const historyHeaderTabCache = new WeakMap<SystemTab, HeaderTab>();
const settingsHeaderTabCache = new WeakMap<SystemTab, HeaderTab>();

function memoizedHeaderTab<S extends object>(
  cache: WeakMap<S, HeaderTab>,
  source: S,
  build: (source: S) => HeaderTab,
): HeaderTab {
  const cached = cache.get(source);
  if (cached !== undefined) return cached;
  const tab = build(source);
  cache.set(source, tab);
  return tab;
}

interface HeaderTabSources {
  readonly epicTabsById: ReadonlyMap<string, EpicViewTab>;
  readonly draftTabsById: ReadonlyMap<string, LandingDraftTab>;
  readonly systemTabs: {
    readonly history: SystemTab | null;
    readonly settings: SystemTab | null;
  };
  readonly structuralLockRevision: number;
}

function memoizedEpicHeaderTab(source: EpicViewTab): HeaderTab {
  const lockState = epicHeaderTabLockState(source);
  const cached = epicHeaderTabCache.get(source);
  const cachedTab = cached?.get(lockState);
  if (cachedTab !== undefined) return cachedTab;
  const tab = TAB_KINDS.epic.build(source);
  const next = cached ?? new Map<EpicHeaderTabLockState, HeaderTab>();
  next.set(lockState, tab);
  epicHeaderTabCache.set(source, next);
  return tab;
}

function epicHeaderTabLockState(source: EpicViewTab): EpicHeaderTabLockState {
  const ref = { kind: "epic" as const, id: source.tabId };
  const structurallyLocked = isTabStructurallyLocked(ref);
  const closeLocked = isTabCloseLocked(ref);
  if (structurallyLocked && closeLocked) {
    return "structurally-and-close-locked";
  }
  if (structurallyLocked) return "structurally-locked";
  if (closeLocked) return "close-locked";
  return "unlocked";
}

function resolveRef(
  ref: TabRef,
  sources: HeaderTabSources,
): ReadonlyArray<HeaderTab> {
  const { epicTabsById, draftTabsById, systemTabs } = sources;
  if (ref.kind === "epic") {
    const source = epicTabsById.get(ref.id);
    if (source === undefined) return [];
    return [memoizedEpicHeaderTab(source)];
  }
  if (ref.kind === "draft") {
    const source = draftTabsById.get(ref.id);
    if (source === undefined) return [];
    return [
      memoizedHeaderTab(draftHeaderTabCache, source, TAB_KINDS.draft.build),
    ];
  }
  if (ref.kind === "history") {
    const source = systemTabs.history;
    if (source === null) return [];
    return [
      memoizedHeaderTab(historyHeaderTabCache, source, TAB_KINDS.history.build),
    ];
  }
  // settings
  const source = systemTabs.settings;
  if (source === null) return [];
  return [
    memoizedHeaderTab(settingsHeaderTabCache, source, TAB_KINDS.settings.build),
  ];
}

/** Non-hook variant for keybinding dispatch and close-flow. */
export function getHeaderTabs(): ReadonlyArray<HeaderTab> {
  const stripOrder = useTabsStore.getState().stripOrder;
  const canvasState = useEpicCanvasStore.getState();
  const epicTabs = canvasState.openTabOrder.flatMap((tabId) => {
    const tab = canvasState.tabsById[tabId];
    return tab === undefined ? [] : [tab];
  });
  const draftTabs = useLandingDraftStore.getState().drafts;
  const systemTabs = useTabsStore.getState().systemTabs;
  const epicTabsById = new Map<string, EpicViewTab>(
    epicTabs.map((t) => [t.tabId, t]),
  );
  const draftTabsById = new Map<string, LandingDraftTab>(
    draftTabs.map((t) => [t.id, t]),
  );
  return stripOrder.flatMap((ref) =>
    resolveRef(ref, {
      epicTabsById,
      draftTabsById,
      systemTabs,
      structuralLockRevision: getTabStructuralLockRevision(),
    }),
  );
}

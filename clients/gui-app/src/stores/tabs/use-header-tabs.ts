import { useMemo } from "react";
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

/**
 * Projects the canonical strip order into render-ready `HeaderTab[]`.
 * Each `TabRef` is resolved against the source store for its kind;
 * the kind module's `build()` factory flattens the source record into
 * the self-contained `HeaderTab` variant. Refs whose source no longer
 * exists are filtered out (reconciliation should keep them in sync).
 */
export function useHeaderTabs(): ReadonlyArray<HeaderTab> {
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
        resolveRef(ref, epicTabsById, draftTabsById, systemTabs),
      ),
    [draftTabsById, epicTabsById, stripOrder, systemTabs],
  );
}

// `build()` mints a fresh `HeaderTab` on every call, so without memoization any
// `useHeaderTabs` recompute (a tab open/close, or unrelated input churn)
// rebuilt EVERY tab and re-rendered every header `TabItem`. These caches key the
// built tab on its SOURCE record's identity - `build()` is pure over the source,
// so a stable source yields an identical, reusable tab; only the changed tab's
// `TabItem` re-renders. Keyed on object identity via WeakMap, so closed tabs'
// entries are reclaimed automatically.
const epicHeaderTabCache = new WeakMap<EpicViewTab, HeaderTab>();
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

function resolveRef(
  ref: TabRef,
  epicTabsById: ReadonlyMap<string, EpicViewTab>,
  draftTabsById: ReadonlyMap<string, LandingDraftTab>,
  systemTabs: {
    readonly history: SystemTab | null;
    readonly settings: SystemTab | null;
  },
): ReadonlyArray<HeaderTab> {
  if (ref.kind === "epic") {
    const source = epicTabsById.get(ref.id);
    if (source === undefined) return [];
    return [
      memoizedHeaderTab(epicHeaderTabCache, source, TAB_KINDS.epic.build),
    ];
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
    resolveRef(ref, epicTabsById, draftTabsById, systemTabs),
  );
}

import { useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicViewTab } from "@/stores/epics/canvas/types";
import {
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import {
  makeSelectHeaderItem,
  selectHeaderStripItemIds,
} from "@/stores/tabs/selectors";
import { TAB_KINDS } from "@/stores/tabs/registry";
import type { HeaderTab, SystemTab, TabRef } from "@/stores/tabs/types";
import type { SplitSide, StripItem } from "@/stores/tabs/layout";
import {
  getTabStructuralLockRevision,
  isTabCloseLocked,
  isTabStructurallyLocked,
  subscribeTabStructuralLocks,
} from "@/stores/tabs/tab-structural-lock";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { activeHostIdOrNull } from "@/lib/host/runtime";
import { scopeHeaderTabsToActiveProject } from "@/hooks/workspace/use-project-scoped-header-strip";
import {
  selectActiveProjectProfile,
  useProjectProfilesStore,
} from "@/stores/workspace/project-profiles-store";

/**
 * Revision over "which host serves which open epic".
 *
 * The epic tab's `hostId` is projected from the live session at `build()`
 * time, and a session RE-POINT (failover, retry, open-on-original-host)
 * replaces the registry's handle without touching the canvas store - so
 * nothing in the source-store subscriptions above would re-run the
 * projection, and the strip would keep serving the previous host's id.
 *
 * Same shape as `structuralLockRevision`: an external revision that forces
 * re-projection, with the per-source cache below keyed on the derived value so
 * a bump that changed nothing keeps every tab's referential identity. The
 * registry's own emit is already gated on an eligibility key, so per-keystroke
 * store churn does not reach this.
 */
let epicSessionHostRevision = 0;
const epicSessionHostListeners = new Set<() => void>();
let epicSessionHostSubscription: (() => void) | null = null;

function subscribeEpicSessionHosts(listener: () => void): () => void {
  epicSessionHostListeners.add(listener);
  epicSessionHostSubscription ??= getOpenEpicRegistry().subscribe(() => {
    epicSessionHostRevision += 1;
    for (const each of epicSessionHostListeners) each();
  });
  return () => {
    epicSessionHostListeners.delete(listener);
  };
}

function getEpicSessionHostRevision(): number {
  return epicSessionHostRevision;
}

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
  const epicSessionHostRevisionValue = useSyncExternalStore(
    subscribeEpicSessionHosts,
    getEpicSessionHostRevision,
    getEpicSessionHostRevision,
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
  const hostId = useAddressableHostId();
  const activeProfileId = useProjectProfilesStore(
    (state) => selectActiveProjectProfile(state, hostId)?.id ?? null,
  );

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
      scopeHeaderTabsToActiveProject(
        stripOrder.flatMap<HeaderTab>((ref) =>
          resolveRef(ref, {
            epicTabsById,
            draftTabsById,
            systemTabs,
            structuralLockRevision,
            epicSessionHostRevision: epicSessionHostRevisionValue,
          }),
        ),
        hostId,
      ),
    [
      activeProfileId,
      draftTabsById,
      epicSessionHostRevisionValue,
      epicTabsById,
      hostId,
      stripOrder,
      structuralLockRevision,
      systemTabs,
    ],
  );
}

/**
 * Header-only projection which preserves the authoritative strip-item
 * grouping. `useHeaderTabs` remains the deliberate flattened compatibility
 * projection for keyboard traversal, close flows, and surface lookup; only the
 * strip renderer consumes this projection.
 */
export type HeaderStripItem =
  | {
      readonly kind: "tab";
      readonly id: string;
      readonly tab: HeaderTab;
    }
  | {
      readonly kind: "split";
      readonly id: string;
      readonly focusedSide: "left" | "right";
      readonly left: HeaderStripMember;
      readonly right: HeaderStripMember;
    };

export type HeaderStripMember =
  | { readonly kind: "tab"; readonly tab: HeaderTab }
  | {
      readonly kind: "fillable";
      readonly slot: Exclude<SplitSide, { readonly kind: "tab" }>;
    };

export function useHeaderStripItems(): ReadonlyArray<HeaderStripItem> {
  const structuralLockRevision = useSyncExternalStore(
    subscribeTabStructuralLocks,
    getTabStructuralLockRevision,
    getTabStructuralLockRevision,
  );
  const epicSessionHostRevisionValue = useSyncExternalStore(
    subscribeEpicSessionHosts,
    getEpicSessionHostRevision,
    getEpicSessionHostRevision,
  );
  const items = useTabsStore(useShallow((s) => s.items));
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
    () => new Map<string, EpicViewTab>(epicTabs.map((tab) => [tab.tabId, tab])),
    [epicTabs],
  );
  const draftTabsById = useMemo(
    () =>
      new Map<string, LandingDraftTab>(draftTabs.map((tab) => [tab.id, tab])),
    [draftTabs],
  );

  return useMemo(
    () =>
      items.flatMap((item) =>
        projectHeaderStripItem(item, {
          epicTabsById,
          draftTabsById,
          systemTabs,
          structuralLockRevision,
          epicSessionHostRevision: epicSessionHostRevisionValue,
        }),
      ),
    [
      draftTabsById,
      epicSessionHostRevisionValue,
      epicTabsById,
      items,
      structuralLockRevision,
      systemTabs,
    ],
  );
}

function projectHeaderStripItem(
  item: StripItem,
  sources: HeaderTabSources,
): ReadonlyArray<HeaderStripItem> {
  if (item.kind === "tab") {
    return resolveRef(item.ref, sources).map((tab) => ({
      kind: "tab" as const,
      id: item.id,
      tab,
    }));
  }
  return [
    {
      kind: "split",
      id: item.id,
      focusedSide: item.focusedSide,
      left: projectHeaderStripMember(item.left, sources),
      right: projectHeaderStripMember(item.right, sources),
    },
  ];
}

function projectHeaderStripMember(
  side: SplitSide,
  sources: HeaderTabSources,
): HeaderStripMember {
  if (side.kind !== "tab") return { kind: "fillable", slot: side };
  const tab = resolveRef(side.ref, sources).at(0);
  if (tab !== undefined) return { kind: "tab", tab };
  return {
    kind: "fillable",
    slot: {
      kind: "unavailable",
      previousRef: side.ref,
      label: "Tab unavailable",
    },
  };
}

/** IDs-only parent subscription; each group resolves its own live sources. */
export function useHeaderStripItemIds(): ReadonlyArray<string> {
  return useTabsStore(useShallow(selectHeaderStripItemIds));
}

/**
 * Per-item projection for the strip renderer. Unlike the flattened legacy
 * hook, metadata and lock churn for another ref never changes this hook's
 * return value, keeping group frames and member controls isolated.
 */
export function useHeaderStripItem(itemId: string): HeaderStripItem | null {
  const selector = useMemo(() => makeSelectHeaderItem(itemId), [itemId]);
  const item = useTabsStore(selector);
  const leftRef =
    item?.kind === "split" && item.left.kind === "tab" ? item.left.ref : null;
  const rightRef =
    item?.kind === "split" && item.right.kind === "tab" ? item.right.ref : null;
  const tabRef = item?.kind === "tab" ? item.ref : null;
  const tab = useHeaderTabForRef(tabRef);
  const left = useHeaderTabForRef(leftRef);
  const right = useHeaderTabForRef(rightRef);
  return useMemo(() => {
    if (item === null) return null;
    if (item.kind === "tab") {
      return tab === null ? null : { kind: "tab", id: item.id, tab };
    }
    return {
      kind: "split",
      id: item.id,
      focusedSide: item.focusedSide,
      left:
        item.left.kind === "tab" && left !== null
          ? { kind: "tab", tab: left }
          : { kind: "fillable", slot: fillableSide(item.left) },
      right:
        item.right.kind === "tab" && right !== null
          ? { kind: "tab", tab: right }
          : { kind: "fillable", slot: fillableSide(item.right) },
    } satisfies HeaderStripItem;
  }, [item, left, right, tab]);
}

function useHeaderTabForRef(ref: TabRef | null): HeaderTab | null {
  const epic = useEpicCanvasStore((state) =>
    ref?.kind === "epic" ? (state.tabsById[ref.id] ?? null) : null,
  );
  const draft = useLandingDraftStore((state) =>
    ref?.kind === "draft"
      ? (state.drafts.find((candidate) => candidate.id === ref.id) ?? null)
      : null,
  );
  const system = useTabsStore((state) => {
    if (ref?.kind === "history") return state.systemTabs.history;
    if (ref?.kind === "settings") return state.systemTabs.settings;
    return null;
  });
  const lockSnapshot = useExactRefLockSnapshot(ref);
  return useMemo(() => {
    if (ref === null) return null;
    if (ref.kind === "epic") {
      if (epic === null || lockSnapshot === "none") return null;
      return memoizedEpicHeaderTab(epic);
    }
    if (ref.kind === "draft") {
      return draft === null
        ? null
        : memoizedHeaderTab(draftHeaderTabCache, draft, TAB_KINDS.draft.build);
    }
    if (ref.kind === "history") {
      return system === null
        ? null
        : memoizedHeaderTab(
            historyHeaderTabCache,
            system,
            TAB_KINDS.history.build,
          );
    }
    return system === null
      ? null
      : memoizedHeaderTab(
          settingsHeaderTabCache,
          system,
          TAB_KINDS.settings.build,
        );
  }, [draft, epic, lockSnapshot, ref, system]);
}

function useExactRefLockSnapshot(ref: TabRef | null): string {
  const snapshot = (): string => {
    if (ref === null) return "none";
    return `${isTabStructurallyLocked(ref)}:${isTabCloseLocked(ref)}`;
  };
  return useSyncExternalStore(subscribeTabStructuralLocks, snapshot, snapshot);
}

function fillableSide(
  side: SplitSide,
): Exclude<SplitSide, { readonly kind: "tab" }> {
  if (side.kind !== "tab") return side;
  return {
    kind: "unavailable",
    previousRef: side.ref,
    label: "Tab unavailable",
  };
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

/**
 * Cache key for one epic tab's projection: its lock state and the host its
 * session is on. Both are derived rather than stored on the source, so both
 * have to be in the key - a re-point that kept the same `EpicViewTab` object
 * would otherwise be memoized away and the strip would serve the old host id
 * forever.
 */
type EpicHeaderTabCacheKey = string;

function epicHeaderTabCacheKey(
  lockState: EpicHeaderTabLockState,
  hostId: string | null,
): EpicHeaderTabCacheKey {
  return `${lockState}\u001f${hostId ?? ""}`;
}

const epicHeaderTabCache = new WeakMap<
  EpicViewTab,
  Map<EpicHeaderTabCacheKey, HeaderTab>
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
  /**
   * Forces re-projection when a session re-points. Not read by `build()` -
   * the projection reads the registry directly; this only invalidates the
   * memo above it, exactly as `structuralLockRevision` does for the locks.
   */
  readonly epicSessionHostRevision: number;
}

function memoizedEpicHeaderTab(source: EpicViewTab): HeaderTab {
  // Built FIRST, then keyed on what it turned out to be: the host is the
  // projection's own output, so there is nothing to look it up by until the
  // build has run. The build is a store read and an object literal; the cache
  // exists to preserve referential identity for the header rows, not to avoid
  // that cost.
  const tab = TAB_KINDS.epic.build(source);
  const key = epicHeaderTabCacheKey(epicHeaderTabLockState(source), tab.hostId);
  const cached = epicHeaderTabCache.get(source);
  const cachedTab = cached?.get(key);
  if (cachedTab !== undefined) return cachedTab;
  const next = cached ?? new Map<EpicHeaderTabCacheKey, HeaderTab>();
  next.set(key, tab);
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
  return scopeHeaderTabsToActiveProject(
    stripOrder.flatMap((ref) =>
      resolveRef(ref, {
        epicTabsById,
        draftTabsById,
        systemTabs,
        structuralLockRevision: getTabStructuralLockRevision(),
        epicSessionHostRevision: getEpicSessionHostRevision(),
      }),
    ),
    activeHostIdOrNull(),
  );
}

import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  DEFAULT_ARRANGEMENT,
  statusBarShown,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import {
  normalizeArrangement,
  resolvePersistedArrangement,
} from "@/lib/layout/arrangement-persist";
import {
  normalizeRail,
  RAIL_REGION_BY_PANEL,
  railFromPanelIdOrder,
  railStackId,
  railVisibilityFor,
  type RailEntry,
} from "@/lib/layout/rail";
import type { RailRegionId } from "@/lib/layout/region-id";
import {
  sameRegionValue,
  type LayoutOverrides,
  type LayoutValues,
  type ReadingStyle,
  type RegionSize,
  type Visibility,
} from "@/lib/layout/layout-values";
import {
  LAYOUT_PRESET_IDS,
  PRESET_VALUES,
  SHIPPED_DEFAULT_VALUES,
  type LayoutPresetId,
} from "@/lib/layout/layout-presets";
import {
  resolvePersistedOverrides,
  resolvePersistedRecordOverrides,
} from "@/lib/layout/layout-values-persist";
import {
  legacyLeftPanelRecord,
  legacySettingsRecord,
} from "@/lib/layout/legacy-layout-records";
import type {
  LayoutSnapshot,
  LayoutValuePatches,
} from "@/lib/layout/layout-snapshot";
import type { RegionId } from "@/lib/layout/region-id";
import {
  basePersistOptions,
  installCrossWindowRehydrate,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist";

/**
 * The one store the layout editor writes and every chrome surface reads
 * (L-21): the last-applied preset, the user's own per-region delta on top of
 * it and where things live - the {@link LayoutSnapshot} triple, plus the
 * writers for it. Which values are a CHANGE is answered by difference against
 * the last-applied preset (`layout-diff.ts`).
 */
export interface LayoutStoreState extends LayoutSnapshot {
  /**
   * Every value replaced by the preset's, the arrangement untouched: the
   * delta is cleared and `basePreset` becomes the last-applied preset.
   */
  readonly applyPreset: (preset: LayoutPresetId) => void;
  readonly setRegionValues: <K extends RegionId>(
    region: K,
    patch: Partial<LayoutValues[K]>,
  ) => void;
  /**
   * Those keys taken OUT of one region's delta, which is what a revert is:
   * the value falls back to the last-applied preset's.
   */
  readonly clearRegionValues: (
    region: RegionId,
    keys: ReadonlyArray<string>,
  ) => void;
  readonly setArrangement: (arrangement: LayoutArrangement) => void;
  readonly replaceAll: (next: LayoutSnapshot) => void;
}

export const DEFAULT_LAYOUT_SNAPSHOT: LayoutSnapshot = {
  basePreset: "default",
  overrides: {},
  arrangement: DEFAULT_ARRANGEMENT,
};

const LAYOUT_PERSIST_KEY = persistKey(STORE_KEYS.layout);

/**
 * The versions a stored record can carry, each with exactly one translation
 * to this build's shape (`migrateLayoutPersistedState`).
 *
 * - 0: no layout record at all. Not a version anyone wrote: it is seeded
 *   (`seedMissingLayoutRecord`) so a fresh install and an install from before
 *   the layout store take the same migrate-and-write-back path as everyone
 *   else, rather than an implicit fallback.
 * - 1: the one version that shipped (desktop-v1.4.0), `{ statusBar, composer }`.
 * - 7: this shape. 2 to 6 were written only by pre-release builds of this
 *   store and are deliberately NOT reused: zustand skips `migrate` when the
 *   stored version equals the current one, so reusing one would load a
 *   development record as-is.
 */
const MISSING_LAYOUT_VERSION = 0;
const SHIPPED_LAYOUT_VERSION = 1;
const LAYOUT_PERSIST_VERSION = 7;

seedMissingLayoutRecord();

export const useLayoutStore = create<LayoutStoreState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_LAYOUT_SNAPSHOT,
      applyPreset: (basePreset) => {
        // Re-applying the untouched current preset writes nothing: a set here
        // would still persist and rehydrate every other window.
        const current = get();
        if (
          current.basePreset === basePreset &&
          Object.keys(current.overrides).length === 0
        )
          return;
        set({ basePreset, overrides: {} });
      },
      setRegionValues: (region, patch) => {
        set(nextOverrides(get(), { [region]: patch }));
      },
      clearRegionValues: (region, keys) => {
        const next = clearedOverrides(get(), { [region]: keys });
        if (next !== null) set(next);
      },
      setArrangement: (arrangement) => {
        set({ arrangement: normalizeArrangement(arrangement) });
      },
      replaceAll: (next) => {
        set({
          basePreset: next.basePreset,
          // Verbatim, because this is the seam Undo, Redo and Discard restore
          // a whole snapshot through: minimizing here would make a history
          // step that crosses a preset boundary lossy, which is the same
          // defect L-133 closed one level up.
          overrides: next.overrides,
          arrangement: normalizeArrangement(next.arrangement),
        });
      },
    }),
    {
      ...basePersistOptions(LAYOUT_PERSIST_KEY),
      version: LAYOUT_PERSIST_VERSION,
      migrate: migrateLayoutPersistedState,
      storage: createJSONStorage(() => localStorage),
      // Field by field against the defaults, like every resolver in this app:
      // a corrupt arrangement cannot reach the values, and a value union this
      // build no longer has cannot reach a render path.
      merge: (persistedState, currentState) => {
        const persisted: Record<string, unknown> = isRecord(persistedState)
          ? persistedState
          : {};
        const basePreset = isLayoutPresetId(persisted.basePreset)
          ? persisted.basePreset
          : DEFAULT_LAYOUT_SNAPSHOT.basePreset;
        return {
          ...currentState,
          basePreset,
          overrides: resolvePersistedRecordOverrides(
            persisted.overrides,
            basePreset,
          ),
          arrangement: resolvePersistedArrangement(persisted.arrangement),
        };
      },
      partialize: (state) => ({
        basePreset: state.basePreset,
        overrides: state.overrides,
        arrangement: state.arrangement,
      }),
    },
  ),
);

/**
 * One or more regions' patches merged into the delta, through the SAME total
 * resolver a rehydrate runs.
 *
 * The resolver on the write path is what makes the registry's stringly-typed
 * control seam sound about the VALUE as well as the key (G1-08): a registry
 * typo like `"ringonly"` cannot reach the store, be drawn from a default
 * branch for a session and then vanish on the next launch when the read-side
 * resolver drops it. Write and read are now the same parse.
 */
/**
 * One or more regions' keys taken back OUT of the delta, through that same
 * resolver - which is also what drops a region entirely once nothing of it is
 * left.
 *
 * `null` rather than an unchanged object when no named region holds a delta at
 * all: the resolver mints a fresh object every call, so a `set` on that path
 * would notify every subscriber for a revert that reverted nothing.
 */
function clearedOverrides(
  state: LayoutSnapshot,
  keysByRegion: Readonly<Record<string, ReadonlyArray<string> | undefined>>,
): Pick<LayoutSnapshot, "overrides"> | null {
  const merged: Record<string, unknown> = { ...state.overrides };
  let touched = false;
  for (const [region, keys] of Object.entries(keysByRegion)) {
    const current = merged[region];
    if (keys === undefined || !isRecord(current)) continue;
    const kept: Record<string, unknown> = { ...current };
    for (const key of keys) delete kept[key];
    merged[region] = kept;
    touched = true;
  }
  if (!touched) return null;
  return { overrides: resolvePersistedOverrides(merged) };
}

function nextOverrides(
  state: LayoutSnapshot,
  patches: LayoutValuePatches,
): Pick<LayoutSnapshot, "overrides"> {
  const merged: Record<string, unknown> = { ...state.overrides };
  for (const [region, patch] of Object.entries(patches)) {
    const current = merged[region];
    merged[region] = { ...(isRecord(current) ? current : {}), ...patch };
  }
  return { overrides: resolvePersistedOverrides(merged) };
}

/**
 * Another window's layout write reaches this one live (L-32): every surface
 * this store drives is read at first paint, so a window that hydrated before
 * the write has to be told.
 */
installCrossWindowRehydrate(useLayoutStore, LAYOUT_PERSIST_KEY);

/** The persisted triple, for the seams that hold a snapshot rather than subscribe. */
export function getLayoutSnapshot(): LayoutSnapshot {
  const state = useLayoutStore.getState();
  return {
    basePreset: state.basePreset,
    overrides: state.overrides,
    arrangement: state.arrangement,
  };
}

/**
 * The persisted triple as one subscribed value, for the editor's own surfaces.
 *
 * Three selectors rather than one returning `{ ... }`: a selector that
 * allocates defeats `useSyncExternalStore`'s caching and free-runs the
 * component (React's "getSnapshot should be cached" loop). The `useMemo` is
 * what makes the RESULT stable for a consumer that passes it on.
 */
export function useLayoutSnapshot(): LayoutSnapshot {
  const basePreset = useLayoutStore((state) => state.basePreset);
  const overrides = useLayoutStore((state) => state.overrides);
  const arrangement = useLayoutStore((state) => state.arrangement);
  return useMemo(
    () => ({ basePreset, overrides, arrangement }),
    [basePreset, overrides, arrangement],
  );
}

/**
 * `statusBarShown` over the live store and the live viewport - the mount
 * decision the shell and the strip's own controls share.
 */
export function useStatusBarShown(): boolean {
  const isMobileViewport = useIsMobileViewport();
  return useLayoutStore((state) =>
    statusBarShown(state.arrangement, isMobileViewport),
  );
}

/**
 * Non-hook read of the Home tab, for the framework-free seams that gate on it
 * (route guards, the tab command coordinator, the keybinding dispatcher).
 */
export function isHomeTabEnabled(): boolean {
  const state = useLayoutStore.getState();
  return (
    (state.overrides.homeTab?.shown ??
      PRESET_VALUES[state.basePreset].homeTab.shown) === "shown"
  );
}

/**
 * Non-hook read of Thinking's Shown, for the lazy transcript projections (Find,
 * a block reveal) that must group runs exactly as the renderer does.
 */
export function isThinkingShown(): boolean {
  const state = useLayoutStore.getState();
  return (
    (state.overrides.thinking?.shown ??
      PRESET_VALUES[state.basePreset].thinking.shown) === "shown"
  );
}

/**
 * A launch that finds no layout record at all is version 0, written down
 * before the store hydrates so zustand's own `migrate` translates it and
 * writes the result back: the same one-shot path every stored version takes,
 * which is why no "carry done" flag exists.
 *
 * It only ever fills an ABSENT key. A record that exists, whatever it holds,
 * is left for `migrate` to read.
 */
function seedMissingLayoutRecord(): void {
  try {
    if (window.localStorage.getItem(LAYOUT_PERSIST_KEY) !== null) return;
    window.localStorage.setItem(
      LAYOUT_PERSIST_KEY,
      JSON.stringify({ state: {}, version: MISSING_LAYOUT_VERSION }),
    );
  } catch {
    // Unreadable or full storage: the store starts on the defaults, as it
    // does for any record it cannot read.
  }
}

/**
 * One translation per stored version, straight to this build's shape.
 *
 * 0 and 1 are the same translation: a missing record is a shipped record
 * with no layout data in it, and both take the values that shipped in the
 * settings and sidebar records alongside. Anything else - a pre-release 2 to
 * 6, or a newer build's record after a downgrade - resets to the defaults
 * rather than guessing at a shape this build never defined.
 */
function migrateLayoutPersistedState(
  persistedState: unknown,
  version: number,
): LayoutSnapshot {
  if (
    version === MISSING_LAYOUT_VERSION ||
    version === SHIPPED_LAYOUT_VERSION
  ) {
    return fromShippedRecords(isRecord(persistedState) ? persistedState : {});
  }
  return DEFAULT_LAYOUT_SNAPSHOT;
}

/**
 * Everything desktop-v1.4.0 persisted about the chrome, as this build's
 * snapshot: its own layout record (`{ statusBar, composer }`, empty for
 * version 0), the settings record and the sidebar record.
 *
 * Each value is renamed into its new home and handed UNPARSED to the same
 * total resolvers a rehydrate runs, so a corrupt field carries nothing rather
 * than something malformed. A value is then kept only where it differs from
 * the shipped Default (`withoutShippedDefaults`): the old records hold every
 * field whether or not anyone touched it, and the delta is the user's own
 * picks (L-133).
 *
 * Two things do not survive, deliberately:
 * - A provider on Automatic AND explicit limits keeps only the explicit keys.
 *   The two are exclusive now (R1-15), and the explicit picks are the more
 *   specific answer.
 * - The resource monitor's Scope (host tree or this app) has no equivalent:
 *   the monitor always reads the host.
 */
function fromShippedRecords(layout: Record<string, unknown>): LayoutSnapshot {
  const settings = legacySettingsRecord();
  const leftPanel = legacyLeftPanelRecord();
  const statusBar = recordOrEmpty(layout.statusBar);
  const rateLimits = recordOrEmpty(statusBar.rateLimits);
  const composer = recordOrEmpty(layout.composer);
  const overrides = {
    homeTab: { shown: shownIf(settings.homeTabEnabled) },
    usageLimits: carriedUsageLimits(statusBar),
    resourceMonitor: carriedResourceMonitor(statusBar, settings),
    minimap: {
      shown: settings.chatTurnMinimapSide === "hide" ? "hidden" : undefined,
    },
    contextUsage: {
      style: settings.contextIndicatorStyle,
      pinBreakdown: settings.pinContextUsageBreakdown,
      pinnedFields: settings.pinnedContextBreakdownFields,
      compactButton: hideableShown(composer.compactButton),
    },
    changedFiles: { size: compactableSize(composer.filesChanged) },
    runningAgents: { size: compactableSize(composer.activeAgents) },
    background: { size: compactableSize(composer.background) },
    access: { size: compactableSize(composer.access) },
    attachImage: { shown: hideableShown(composer.attachImage) },
    mic: { shown: hideableShown(composer.mic) },
    model: {
      style: composer.reasoningIndicator,
      reasoningControl: composer.reasoningFooterControl,
    },
    ...carriedRailVisibility(leftPanel.panelVisibilityOverrideById),
  };
  return {
    basePreset: DEFAULT_LAYOUT_SNAPSHOT.basePreset,
    overrides: withoutShippedDefaults(resolvePersistedOverrides(overrides)),
    arrangement: resolvePersistedArrangement({
      // One placement for both readings, which is exactly what a lone
      // `usageHost` means to the resolver (L-161): `header` puts the pair up
      // at the right end, where v1.4.0 drew it.
      usageHost: statusBar.placement,
      mobileFooter: statusBar.mobileFooter,
      hiddenProviders: rateLimits.hiddenProviders,
      // The resolver reads `limitKeys` alone, which IS the explicit-keys-win
      // rule above: an `automatic` beside a non-empty list is dropped, and a
      // selection with no keys is Automatic.
      providerLimits: rateLimits.providers,
      shownProfiles: rateLimits.shownProfiles,
      // `"hide"` is not a side, so the resolver falls back to the default one
      // and the minimap's Shown above is what carries the hidden state.
      minimapSide: settings.chatTurnMinimapSide,
      rail: carriedRail(leftPanel.panelGroups),
      taskTabLayout: settings.taskTabLayout,
    }),
  };
}

/**
 * The usage reading's display picks. `enabled` is carried only while the
 * readings lived in the strip: in the header, v1.4.0 drew the usage button
 * whatever it said, so there it never spoke for anything on screen. `reset`,
 * `amount` and the reading style are carried whichever placement drew them:
 * they describe what a reading says, not where it sits.
 */
function carriedUsageLimits(
  statusBar: Record<string, unknown>,
): Record<string, unknown> {
  const rateLimits = recordOrEmpty(statusBar.rateLimits);
  return {
    shown:
      statusBar.placement === "header"
        ? undefined
        : shownIf(rateLimits.enabled),
    reset: rateLimits.showTimer,
    amount: rateLimits.percentMode,
    readingStyle: carriedReadingStyle(rateLimits),
  };
}

/**
 * v1.4.0's `showBar` and `showModeWord` as the one reading style that replaced
 * them (`bar` | `percent` | `both` | `full`).
 *
 * v1.4.0 always drew the percent, so a reader who turned the bar off had chosen
 * a percent reading: `percent`. The mode word (the used/remaining word) has no
 * home outside `full`, so with the bar off `percent` is the closest reading
 * that exists. A bar with the word off is `both`: bar and percent, no word.
 *
 * Bar and word both on carries nothing, and that is a limit of the data, not a
 * choice: the old records store every field, so a user who never touched the
 * two cannot be told apart from one who set exactly this. It is left to the
 * shipped default rather than guessed at. A `showBar` that is not a boolean
 * says nothing either.
 */
function carriedReadingStyle(
  rateLimits: Record<string, unknown>,
): ReadingStyle | undefined {
  if (rateLimits.showBar === false) return "percent";
  if (rateLimits.showBar === true && rateLimits.showModeWord === false) {
    return "both";
  }
  return undefined;
}

/**
 * The monitor, from whichever switch drew it: v1.4.0 put the header's monitor
 * behind `showGlobalResourceMonitor` and the strip's behind the strip's own
 * `resources.enabled`. A record with no strip slice answers from the global
 * switch, the one a build before the strip had.
 *
 * Its readings are the strip's own list when there is one, except under the
 * header placement. There the strip's list was never on screen, so nobody
 * picked it: the only metrics that user saw and chose were the sidebar's
 * chips, and in this build the metric booleans are what the agent rows draw
 * (`useNavigatorResourceMetrics`). A non-empty chip list therefore wins under
 * the header. Under the status bar the strip's list stays the answer, and the
 * chips stand in only for a record with no strip list, written before the
 * strip existed. The chips themselves became `agentRows`, and an empty list,
 * the old default, is an answer: no readings on the rows.
 */
function carriedResourceMonitor(
  statusBar: Record<string, unknown>,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const resources = recordOrEmpty(statusBar.resources);
  const chips = Array.isArray(settings.navigatorResourceMetrics)
    ? settings.navigatorResourceMetrics
    : null;
  const chipMetrics = chips !== null && chips.length > 0 ? chips : null;
  const stripMetrics = Array.isArray(resources.metrics)
    ? resources.metrics
    : null;
  const metrics =
    statusBar.placement === "header" && chipMetrics !== null
      ? chipMetrics
      : (stripMetrics ?? chipMetrics);
  const stripDrawsIt =
    statusBar.placement !== "header" && typeof resources.enabled === "boolean";
  return {
    shown: shownIf(
      stripDrawsIt ? resources.enabled : settings.showGlobalResourceMonitor,
    ),
    ...(metrics === null
      ? {}
      : {
          cpu: metrics.includes("cpu"),
          memory: metrics.includes("memory"),
          processes: metrics.includes("processes"),
          ramShare: metrics.includes("ramShare"),
        }),
    agentRows: chips === null ? undefined : chips.length > 0,
  };
}

/**
 * The delta with every value the shipped Default already has taken out, so
 * an untouched v1.4.0 field is not recorded as a pick nobody made.
 */
function withoutShippedDefaults(overrides: LayoutOverrides): LayoutOverrides {
  const defaults: Record<string, unknown> = { ...SHIPPED_DEFAULT_VALUES };
  const kept: Record<string, unknown> = {};
  for (const [region, patch] of Object.entries(overrides)) {
    const base = defaults[region];
    if (!isRecord(patch) || !isRecord(base)) continue;
    kept[region] = Object.fromEntries(
      Object.entries(patch).filter(
        ([key, value]) => !sameRegionValue(key, value, base[key]),
      ),
    );
  }
  return resolvePersistedOverrides(kept);
}

function shownIf(value: unknown): Visibility | undefined {
  if (typeof value !== "boolean") return undefined;
  return value ? "shown" : "hidden";
}

/** A v1.4.0 composer row that compacts: `compact` is the chip. */
function compactableSize(mode: unknown): RegionSize | undefined {
  if (mode === "visible") return "full";
  if (mode === "compact") return "chip";
  return undefined;
}

/** A v1.4.0 composer element that hides. */
function hideableShown(mode: unknown): Visibility | undefined {
  if (mode === "visible") return "shown";
  if (mode === "hidden") return "hidden";
  return undefined;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * The rail's per-panel Hide/Show as the nine rail regions' tri-state `shown`
 * (L-61). An absent entry is `auto`, which is the default, so it carries
 * nothing and the resolver drops it.
 */
function carriedRailVisibility(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const overrides: Record<string, unknown> = {};
  for (const [panelId, regionId] of Object.entries(RAIL_REGION_BY_PANEL)) {
    const override = value[panelId];
    if (typeof override !== "boolean") continue;
    overrides[regionId] = { shown: railVisibilityFor(override) };
  }
  return overrides;
}

/**
 * The sidebar's persisted grouping, as the rail's panel ORDER and its stacks
 * (L-155, L-166).
 *
 * The order is the user's and so is a group that actually drew two panels
 * together, which is what a stack IS. What does not come across is a group of
 * ONE: the shipped sidebar put every lone panel in a group of its own and a
 * divider between every pair, and neither of those was a thing anybody placed.
 *
 * A group becomes one stack of every member this build still has (L-181):
 * the shipped groups had no cap, and neither has a stack.
 */
function carriedRail(value: unknown): ReadonlyArray<RailEntry> {
  if (!Array.isArray(value)) return DEFAULT_ARRANGEMENT.rail;
  const groups = value.flatMap(
    (group): ReadonlyArray<ReadonlyArray<string>> => {
      if (!isRecord(group) || !Array.isArray(group.panelIds)) return [];
      return [
        group.panelIds.filter(
          (panelId): panelId is string => typeof panelId === "string",
        ),
      ];
    },
  );
  const panelIds = groups.flat();
  if (panelIds.length === 0) return DEFAULT_ARRANGEMENT.rail;
  const rail = railFromPanelIdOrder(panelIds);
  const links = groups.flatMap((group): RailEntry[] => {
    const members = group.flatMap((panelId) => {
      const regionId = carriedRailRegion(panelId);
      return regionId === null ? [] : [regionId];
    });
    return members.length < 2
      ? []
      : [{ kind: "stack", id: railStackId(members) }];
  });
  // Appended rather than threaded in: a stack IS the members its id names, so
  // `normalizeRail` puts each one where it belongs and keeps only the members
  // this build ended up placing side by side.
  return normalizeRail([...rail, ...links]);
}

/** One `panelGroups` id as a rail region, or `null` for one this build retired. */
function carriedRailRegion(panelId: string): RailRegionId | null {
  const match = Object.entries(RAIL_REGION_BY_PANEL).find(
    ([candidate]) => candidate === panelId,
  );
  return match === undefined ? null : match[1];
}

function isLayoutPresetId(value: unknown): value is LayoutPresetId {
  return LAYOUT_PRESET_IDS.some((presetId) => presetId === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

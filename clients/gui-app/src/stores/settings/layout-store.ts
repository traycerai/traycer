import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * Every persisted preference about the app's own chrome — where a surface
 * lives and what it renders — under one key, one slice per surface.
 *
 * A slice is self-contained: its defaults, its type guards, its resolver, and
 * the setters that write it. Adding one is a field on `LayoutState`, a
 * `resolvePersisted<Slice>` composed into `merge`, and its setters — no edit to
 * a slice already here. That is the whole reason these live together rather
 * than as one store per surface: chrome preferences are small, they are read at
 * first paint, and each one as its own localStorage key is a rehydration and a
 * registry entry per checkbox.
 */

/**
 * Which surface owns the usage gauge and the resource monitor. Exactly one is
 * live at a time: the status bar exists only to host these two things, so a
 * separate on/off toggle would express nothing this does not.
 */
export type UsageControlsPlacement = "header" | "status-bar";

/** Whether a window reads as consumed or as headroom. */
export type PercentMode = "used" | "remaining";

export type ResourceMetric = "cpu" | "memory" | "processes" | "ramShare";

/** Traycer's processes on the watched host, or this desktop app's own. */
export type ResourceScope = "host-tree" | "desktop-app";

export interface StatusBarRateLimitPreferences {
  readonly enabled: boolean;
  /**
   * Deny-lists, not allow-lists, on both axes: a provider connected later, or
   * a model window a provider only starts reporting, shows up without a visit
   * to Settings. An entry whose provider is no longer configured is kept - it
   * is cheap, and the intent survives reconnecting.
   */
  readonly hiddenProviders: ReadonlyArray<RateLimitProviderId>;
  readonly hiddenWindowKeys: ReadonlyArray<string>;
  readonly percentMode: PercentMode;
  readonly showTimer: boolean;
  readonly showBar: boolean;
}

export interface StatusBarResourcePreferences {
  readonly enabled: boolean;
  /** Allow-list, held in canonical order rather than in toggle order. */
  readonly metrics: ReadonlyArray<ResourceMetric>;
  readonly scope: ResourceScope;
}

export interface StatusBarLayoutPreferences {
  readonly placement: UsageControlsPlacement;
  readonly rateLimits: StatusBarRateLimitPreferences;
  readonly resources: StatusBarResourcePreferences;
}

interface LayoutStoreState {
  readonly statusBar: StatusBarLayoutPreferences;
  // Setters stay flat and are namespaced by their slice, so a call site names
  // the surface it is configuring and two slices can never collide on a verb.
  readonly setStatusBarPlacement: (placement: UsageControlsPlacement) => void;
  readonly setStatusBarRateLimitsEnabled: (enabled: boolean) => void;
  /** Flips one provider's membership in the deny-list. */
  readonly toggleStatusBarProvider: (providerId: RateLimitProviderId) => void;
  /** Flips one window's membership in the deny-list, keyed by `windowKey`. */
  readonly toggleStatusBarWindow: (windowKey: string) => void;
  readonly setStatusBarPercentMode: (percentMode: PercentMode) => void;
  readonly setStatusBarShowTimer: (showTimer: boolean) => void;
  readonly setStatusBarShowBar: (showBar: boolean) => void;
  readonly setStatusBarResourcesEnabled: (enabled: boolean) => void;
  readonly toggleStatusBarResourceMetric: (metric: ResourceMetric) => void;
  readonly setStatusBarResourceScope: (scope: ResourceScope) => void;
}

/**
 * Display order for the resource segment. A toggled-on metric is re-inserted
 * here rather than appended, so the segment reads the same regardless of the
 * order the user switched things on in.
 */
const RESOURCE_METRIC_ORDER: ReadonlyArray<ResourceMetric> = [
  "cpu",
  "memory",
  "processes",
  "ramShare",
];

const DEFAULT_STATUS_BAR_RATE_LIMITS: StatusBarRateLimitPreferences = {
  enabled: true,
  hiddenProviders: [],
  hiddenWindowKeys: [],
  percentMode: "used",
  showTimer: true,
  showBar: true,
};

const DEFAULT_STATUS_BAR_RESOURCES: StatusBarResourcePreferences = {
  enabled: true,
  metrics: ["cpu", "memory", "processes"],
  scope: "host-tree",
};

export const DEFAULT_STATUS_BAR_LAYOUT: StatusBarLayoutPreferences = {
  placement: "header",
  rateLimits: DEFAULT_STATUS_BAR_RATE_LIMITS,
  resources: DEFAULT_STATUS_BAR_RESOURCES,
};

const LAYOUT_PERSIST_KEY = persistKey(STORE_KEYS.layout);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function persistedBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// ── status bar slice ────────────────────────────────────────────────────────

function isUsageControlsPlacement(
  value: unknown,
): value is UsageControlsPlacement {
  return value === "header" || value === "status-bar";
}

function isPercentMode(value: unknown): value is PercentMode {
  return value === "used" || value === "remaining";
}

function isResourceMetric(value: unknown): value is ResourceMetric {
  return (
    value === "cpu" ||
    value === "memory" ||
    value === "processes" ||
    value === "ramShare"
  );
}

function isResourceScope(value: unknown): value is ResourceScope {
  return value === "host-tree" || value === "desktop-app";
}

/**
 * A deny-list of opaque window keys. Nothing here can decide whether a key
 * still names a window some provider reports - only that it is the kind of
 * string the catalog produces - so the only work is dropping non-strings and
 * duplicates, which would otherwise make a toggle read as on and off at once.
 */
function persistedWindowKeys(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return DEFAULT_STATUS_BAR_RATE_LIMITS.hiddenWindowKeys;
  }
  const keys = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return [...new Set(keys)];
}

/**
 * Provider ids ARE checkable against the protocol enum, and an unrecognized one
 * has to go: it reaches an exhaustive switch on the render path, and a hidden
 * provider that no build knows about hides nothing anyway.
 */
function persistedProviderIds(
  value: unknown,
): ReadonlyArray<RateLimitProviderId> {
  if (!Array.isArray(value)) {
    return DEFAULT_STATUS_BAR_RATE_LIMITS.hiddenProviders;
  }
  const providerIds = value.flatMap((entry): RateLimitProviderId[] => {
    const result = rateLimitCapableProviderIdSchema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
  return [...new Set(providerIds)];
}

function persistedRateLimits(value: unknown): StatusBarRateLimitPreferences {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    enabled: persistedBoolean(
      stored.enabled,
      DEFAULT_STATUS_BAR_RATE_LIMITS.enabled,
    ),
    hiddenProviders: persistedProviderIds(stored.hiddenProviders),
    hiddenWindowKeys: persistedWindowKeys(stored.hiddenWindowKeys),
    percentMode: isPercentMode(stored.percentMode)
      ? stored.percentMode
      : DEFAULT_STATUS_BAR_RATE_LIMITS.percentMode,
    showTimer: persistedBoolean(
      stored.showTimer,
      DEFAULT_STATUS_BAR_RATE_LIMITS.showTimer,
    ),
    showBar: persistedBoolean(
      stored.showBar,
      DEFAULT_STATUS_BAR_RATE_LIMITS.showBar,
    ),
  };
}

/**
 * An empty selection is a legitimate state (the segment then shows nothing but
 * still reserves its slot), so an array that survives filtering to nothing is
 * kept. Only a value that was never an array falls back to the default set.
 */
function persistedMetrics(value: unknown): ReadonlyArray<ResourceMetric> {
  if (!Array.isArray(value)) return DEFAULT_STATUS_BAR_RESOURCES.metrics;
  const selected = new Set(value.filter(isResourceMetric));
  return RESOURCE_METRIC_ORDER.filter((metric) => selected.has(metric));
}

function persistedResources(value: unknown): StatusBarResourcePreferences {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    enabled: persistedBoolean(
      stored.enabled,
      DEFAULT_STATUS_BAR_RESOURCES.enabled,
    ),
    metrics: persistedMetrics(stored.metrics),
    scope: isResourceScope(stored.scope)
      ? stored.scope
      : DEFAULT_STATUS_BAR_RESOURCES.scope,
  };
}

/**
 * The status bar slice, re-derived field by field rather than shallow-merged,
 * because each value reaches a switch statement or a render path that assumes
 * its union: a hand-edited `placement` would otherwise mount neither surface,
 * and a stale metric name would ask the resource segment for a number it has no
 * case for.
 */
function resolvePersistedStatusBar(value: unknown): StatusBarLayoutPreferences {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    placement: isUsageControlsPlacement(stored.placement)
      ? stored.placement
      : DEFAULT_STATUS_BAR_LAYOUT.placement,
    rateLimits: persistedRateLimits(stored.rateLimits),
    resources: persistedResources(stored.resources),
  };
}

function toggledMembership<T>(
  entries: ReadonlyArray<T>,
  entry: T,
): ReadonlyArray<T> {
  return entries.includes(entry)
    ? entries.filter((candidate) => candidate !== entry)
    : [...entries, entry];
}

export const useLayoutStore = create<LayoutStoreState>()(
  persist(
    (set, get) => ({
      statusBar: DEFAULT_STATUS_BAR_LAYOUT,
      setStatusBarPlacement: (placement) => {
        const statusBar = get().statusBar;
        if (statusBar.placement === placement) return;
        set({ statusBar: { ...statusBar, placement } });
      },
      setStatusBarRateLimitsEnabled: (enabled) => {
        const statusBar = get().statusBar;
        if (statusBar.rateLimits.enabled === enabled) return;
        set({
          statusBar: {
            ...statusBar,
            rateLimits: { ...statusBar.rateLimits, enabled },
          },
        });
      },
      toggleStatusBarProvider: (providerId) => {
        const statusBar = get().statusBar;
        set({
          statusBar: {
            ...statusBar,
            rateLimits: {
              ...statusBar.rateLimits,
              hiddenProviders: toggledMembership(
                statusBar.rateLimits.hiddenProviders,
                providerId,
              ),
            },
          },
        });
      },
      toggleStatusBarWindow: (windowKey) => {
        const statusBar = get().statusBar;
        set({
          statusBar: {
            ...statusBar,
            rateLimits: {
              ...statusBar.rateLimits,
              hiddenWindowKeys: toggledMembership(
                statusBar.rateLimits.hiddenWindowKeys,
                windowKey,
              ),
            },
          },
        });
      },
      setStatusBarPercentMode: (percentMode) => {
        const statusBar = get().statusBar;
        if (statusBar.rateLimits.percentMode === percentMode) return;
        set({
          statusBar: {
            ...statusBar,
            rateLimits: { ...statusBar.rateLimits, percentMode },
          },
        });
      },
      setStatusBarShowTimer: (showTimer) => {
        const statusBar = get().statusBar;
        if (statusBar.rateLimits.showTimer === showTimer) return;
        set({
          statusBar: {
            ...statusBar,
            rateLimits: { ...statusBar.rateLimits, showTimer },
          },
        });
      },
      setStatusBarShowBar: (showBar) => {
        const statusBar = get().statusBar;
        if (statusBar.rateLimits.showBar === showBar) return;
        set({
          statusBar: {
            ...statusBar,
            rateLimits: { ...statusBar.rateLimits, showBar },
          },
        });
      },
      setStatusBarResourcesEnabled: (enabled) => {
        const statusBar = get().statusBar;
        if (statusBar.resources.enabled === enabled) return;
        set({
          statusBar: {
            ...statusBar,
            resources: { ...statusBar.resources, enabled },
          },
        });
      },
      toggleStatusBarResourceMetric: (metric) => {
        const statusBar = get().statusBar;
        const selected = new Set(statusBar.resources.metrics);
        if (selected.has(metric)) {
          selected.delete(metric);
        } else {
          selected.add(metric);
        }
        set({
          statusBar: {
            ...statusBar,
            resources: {
              ...statusBar.resources,
              metrics: RESOURCE_METRIC_ORDER.filter((candidate) =>
                selected.has(candidate),
              ),
            },
          },
        });
      },
      setStatusBarResourceScope: (scope) => {
        const statusBar = get().statusBar;
        if (statusBar.resources.scope === scope) return;
        set({
          statusBar: {
            ...statusBar,
            resources: { ...statusBar.resources, scope },
          },
        });
      },
    }),
    {
      ...basePersistOptions(LAYOUT_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      // One resolver per slice, composed here. A corrupt slice falls back to
      // its own defaults and cannot reach across into another's.
      merge: (persistedState, currentState) => {
        const persisted: Record<string, unknown> = isRecord(persistedState)
          ? persistedState
          : {};
        return {
          ...currentState,
          statusBar: resolvePersistedStatusBar(persisted.statusBar),
        };
      },
      partialize: (state) => ({ statusBar: state.statusBar }),
    },
  ),
);

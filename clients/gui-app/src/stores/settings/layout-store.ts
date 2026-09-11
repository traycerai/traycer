import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { fixedProviderWindowKeys } from "@/lib/rate-limits/rate-limit-window-catalog";

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

/**
 * Which of one provider's limits its segment draws.
 *
 * `automatic` is the tightest limit at the moment of drawing - whichever window
 * currently binds hardest - so it can name a different window from one reading
 * to the next. `limitKeys` are explicit picks by `windowKey`. The segment
 * draws the union, and the two cannot double up: the tightest window is drawn
 * once whether or not it is also picked. A key that names a window the
 * provider is not currently reporting (a model since renamed, a limit not yet
 * read) is kept and simply matches nothing until it is.
 *
 * At least one of the two is always on. A selection with `automatic` off and
 * no keys would draw nothing, which is what the provider switch is for.
 */
export interface StatusBarProviderLimitSelection {
  readonly automatic: boolean;
  readonly limitKeys: ReadonlyArray<string>;
}

/**
 * Per provider, keyed by id. A provider with no entry is on the default
 * selection (`AUTOMATIC_LIMIT_SELECTION`), which is how a provider connected
 * later shows its tightest limit without a visit to Settings. An entry whose
 * provider is no longer configured is kept - it is cheap, and the intent
 * survives reconnecting.
 */
export type StatusBarProviderLimitSelections = Readonly<
  Partial<Record<RateLimitProviderId, StatusBarProviderLimitSelection>>
>;

export interface StatusBarRateLimitPreferences {
  readonly enabled: boolean;
  /**
   * A deny-list, not an allow-list: a provider connected later shows up
   * without a visit to Settings. An entry whose provider is no longer
   * configured is kept - it is cheap, and the intent survives reconnecting.
   */
  readonly hiddenProviders: ReadonlyArray<RateLimitProviderId>;
  readonly providers: StatusBarProviderLimitSelections;
  readonly percentMode: PercentMode;
  readonly showTimer: boolean;
  readonly showBar: boolean;
  /** Whether `used` / `remaining` is spelled out after the percentage. */
  readonly showModeWord: boolean;
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

/**
 * An element that shrinks rather than disappears. Its `compact` form still
 * carries every verb the full form does - a dock row folds to a chip that
 * opens it, the permission picker to the icon that names the active mode - so
 * this union has no third member by design.
 */
export type ComposerCompactableMode = "visible" | "compact";

/**
 * An element that can go away entirely, because the thing it does has another
 * route: paste and drag-drop attach images, the dictation chord starts voice
 * input, the palette and `/compact` compact a conversation.
 */
export type ComposerHideableMode = "visible" | "hidden";

/**
 * How the model chip shows the thinking effort: the level's name, a
 * signal-bars glyph (one bar per level the model exposes, filled up to the
 * current one), or both. A third shape rather than a hide switch, because the
 * effort is something a send runs under, and the glyph is the compact form.
 */
export type ComposerReasoningIndicator = "text" | "bars" | "bars-text";

export interface ComposerLayoutPreferences {
  readonly filesChanged: ComposerCompactableMode;
  readonly activeAgents: ComposerCompactableMode;
  readonly background: ComposerCompactableMode;
  readonly attachImage: ComposerHideableMode;
  readonly access: ComposerCompactableMode;
  readonly mic: ComposerHideableMode;
  readonly compactButton: ComposerHideableMode;
  readonly reasoningIndicator: ComposerReasoningIndicator;
}

/**
 * Which of the Home tab's two readings is showing. `focus` is the flat page -
 * Needs you, Running, Background; `tasks` keeps Needs you global and first and
 * regroups the rest under one collapsible row per task.
 *
 * Persisted even though it has no Settings row: the in-page control is the only
 * writer, and "the view I left Home in" is the thing a user expects back, not a
 * preference they went looking for.
 */
export type HomeView = "focus" | "tasks";

/**
 * How much room a Home row takes. `compact` tightens the DESKTOP row only - the
 * touch chrome a coarse pointer needs is restored by the row's own
 * `pointer-coarse:` variants, so this is a pointer-precision preference rather
 * than a global shrink.
 */
export type HomeDensity = "comfortable" | "compact";

export interface HomeLayoutPreferences {
  readonly view: HomeView;
  readonly density: HomeDensity;
}

interface LayoutStoreState {
  readonly statusBar: StatusBarLayoutPreferences;
  readonly composer: ComposerLayoutPreferences;
  readonly home: HomeLayoutPreferences;
  // Setters stay flat and are namespaced by their slice, so a call site names
  // the surface it is configuring and two slices can never collide on a verb.
  readonly setStatusBarPlacement: (placement: UsageControlsPlacement) => void;
  readonly setStatusBarRateLimitsEnabled: (enabled: boolean) => void;
  /** Flips one provider's membership in the deny-list. */
  readonly toggleStatusBarProvider: (providerId: RateLimitProviderId) => void;
  /**
   * Whether one provider's segment draws its tightest limit. Refused when it
   * would leave the provider with nothing selected.
   */
  readonly setStatusBarProviderAutomatic: (
    providerId: RateLimitProviderId,
    automatic: boolean,
  ) => void;
  /**
   * Flips one explicit pick for one provider, keyed by `windowKey`. Refused when
   * it would leave the provider with nothing selected.
   */
  readonly toggleStatusBarProviderLimit: (
    providerId: RateLimitProviderId,
    limitKey: string,
  ) => void;
  readonly setStatusBarPercentMode: (percentMode: PercentMode) => void;
  readonly setStatusBarShowTimer: (showTimer: boolean) => void;
  readonly setStatusBarShowBar: (showBar: boolean) => void;
  readonly setStatusBarShowModeWord: (showModeWord: boolean) => void;
  readonly setStatusBarResourcesEnabled: (enabled: boolean) => void;
  readonly toggleStatusBarResourceMetric: (metric: ResourceMetric) => void;
  readonly setStatusBarResourceScope: (scope: ResourceScope) => void;
  readonly setComposerFilesChanged: (mode: ComposerCompactableMode) => void;
  readonly setComposerActiveAgents: (mode: ComposerCompactableMode) => void;
  readonly setComposerBackground: (mode: ComposerCompactableMode) => void;
  readonly setComposerAttachImage: (mode: ComposerHideableMode) => void;
  readonly setComposerAccess: (mode: ComposerCompactableMode) => void;
  readonly setComposerMic: (mode: ComposerHideableMode) => void;
  readonly setComposerCompactButton: (mode: ComposerHideableMode) => void;
  readonly setComposerReasoningIndicator: (
    indicator: ComposerReasoningIndicator,
  ) => void;
  readonly setHomeView: (view: HomeView) => void;
  readonly setHomeDensity: (density: HomeDensity) => void;
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

/** What a provider draws until told otherwise: its tightest limit, and only that. */
const AUTOMATIC_LIMIT_SELECTION: StatusBarProviderLimitSelection = {
  automatic: true,
  limitKeys: [],
};

const DEFAULT_STATUS_BAR_RATE_LIMITS: StatusBarRateLimitPreferences = {
  enabled: true,
  hiddenProviders: [],
  providers: {},
  percentMode: "used",
  showTimer: true,
  showBar: true,
  showModeWord: true,
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

/** Every element as it renders today, so an untouched install sees no change. */
export const DEFAULT_COMPOSER_LAYOUT: ComposerLayoutPreferences = {
  filesChanged: "visible",
  activeAgents: "visible",
  background: "visible",
  attachImage: "visible",
  access: "visible",
  mic: "visible",
  compactButton: "visible",
  reasoningIndicator: "text",
};

/**
 * Home as it reads today: the flat Focus page at comfortable spacing. `focus`
 * is also the FIRST PAINT rather than merely the initial value - an install
 * that has never touched the control sees exactly the page it saw before this
 * slice existed.
 */
export const DEFAULT_HOME_LAYOUT: HomeLayoutPreferences = {
  view: "focus",
  density: "comfortable",
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
 * A list of opaque window keys. Nothing here can decide whether a key still
 * names a window some provider reports - only that it is the kind of string
 * the catalog produces - so the only work is dropping non-strings and
 * duplicates, which would otherwise make a toggle read as on and off at once.
 */
function persistedWindowKeys(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const keys = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return [...new Set(keys)];
}

/** Whether a selection still draws something. The floor every write is held to. */
function isDrawableSelection(
  selection: StatusBarProviderLimitSelection,
): boolean {
  return selection.automatic || selection.limitKeys.length > 0;
}

/**
 * The selection one provider is on, with the default standing in for a
 * provider that has never been configured.
 */
export function statusBarProviderLimitSelection(
  providers: StatusBarProviderLimitSelections,
  providerId: RateLimitProviderId,
): StatusBarProviderLimitSelection {
  return providers[providerId] ?? AUTOMATIC_LIMIT_SELECTION;
}

/**
 * One persisted selection. A shape that has been hand-edited down to nothing
 * drawable falls back to the default rather than to an empty segment.
 */
function persistedLimitSelection(
  value: unknown,
): StatusBarProviderLimitSelection {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  const selection: StatusBarProviderLimitSelection = {
    automatic: persistedBoolean(
      stored.automatic,
      AUTOMATIC_LIMIT_SELECTION.automatic,
    ),
    limitKeys: persistedWindowKeys(stored.limitKeys),
  };
  return isDrawableSelection(selection) ? selection : AUTOMATIC_LIMIT_SELECTION;
}

/**
 * The per-provider selections, or their one-time migration from the two lists
 * they replaced.
 *
 * The old shape was a deny-list of window keys plus an allow-list of "expanded"
 * providers - a provider drew its tightest window, or every window not hidden.
 * That maps onto the new shape only for the expanded providers: each becomes an
 * explicit pick of every window the build can name for it, less the hidden
 * ones, with `automatic` off. A provider that was not expanded drew its
 * tightest alone, which is the default and needs no entry - its hidden keys
 * are dropped, since a default selection has no list to remove them from. The
 * migration runs only while `providers` is absent: once written, the new shape
 * is authoritative and the old lists are ignored.
 *
 * Hydration alone does NOT rewrite storage - zustand's persist only writes back
 * after hydration when a VERSION migration ran, and this store resolves in
 * `merge` instead (a version bump with no `migrate` discards the blob). So the
 * old keys survive in `localStorage` and are re-migrated on every start until
 * the first write of any layout preference, which serialises the re-derived
 * slice without them. That is safe because this is a pure function of two
 * build-constant inputs, so every re-run produces the same selections.
 *
 * Only FIXED keys can be carried across (`fixedProviderWindowKeys`): a
 * model-scoped or extra window's key exists only in a snapshot, and the store
 * has none to ask.
 */
function persistedProviderSelections(
  stored: Record<string, unknown>,
): StatusBarProviderLimitSelections {
  const selections: Partial<
    Record<RateLimitProviderId, StatusBarProviderLimitSelection>
  > = {};
  if (isRecord(stored.providers)) {
    for (const [key, value] of Object.entries(stored.providers)) {
      const providerId = rateLimitCapableProviderIdSchema.safeParse(key);
      if (!providerId.success) continue;
      selections[providerId.data] = persistedLimitSelection(value);
    }
    return selections;
  }
  const hidden = new Set(persistedWindowKeys(stored.hiddenWindowKeys));
  for (const providerId of persistedProviderIds(stored.expandedProviders, [])) {
    const limitKeys = fixedProviderWindowKeys(providerId).filter(
      (limitKey) => !hidden.has(limitKey),
    );
    // Every fixed window hidden leaves nothing to pick, and the default is
    // the only drawable answer left.
    if (limitKeys.length === 0) continue;
    selections[providerId] = { automatic: false, limitKeys };
  }
  return selections;
}

/**
 * Provider ids ARE checkable against the protocol enum, and an unrecognized one
 * has to go: it reaches an exhaustive switch on the render path, and a hidden
 * provider that no build knows about hides nothing anyway.
 */
function persistedProviderIds(
  value: unknown,
  fallback: ReadonlyArray<RateLimitProviderId>,
): ReadonlyArray<RateLimitProviderId> {
  if (!Array.isArray(value)) return fallback;
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
    hiddenProviders: persistedProviderIds(
      stored.hiddenProviders,
      DEFAULT_STATUS_BAR_RATE_LIMITS.hiddenProviders,
    ),
    providers: persistedProviderSelections(stored),
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
    showModeWord: persistedBoolean(
      stored.showModeWord,
      DEFAULT_STATUS_BAR_RATE_LIMITS.showModeWord,
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

// ── composer slice ──────────────────────────────────────────────────────────

function isComposerCompactableMode(
  value: unknown,
): value is ComposerCompactableMode {
  return value === "visible" || value === "compact";
}

function isComposerHideableMode(value: unknown): value is ComposerHideableMode {
  return value === "visible" || value === "hidden";
}

function compactable(
  value: unknown,
  fallback: ComposerCompactableMode,
): ComposerCompactableMode {
  return isComposerCompactableMode(value) ? value : fallback;
}

function hideable(
  value: unknown,
  fallback: ComposerHideableMode,
): ComposerHideableMode {
  return isComposerHideableMode(value) ? value : fallback;
}

function isComposerReasoningIndicator(
  value: unknown,
): value is ComposerReasoningIndicator {
  return value === "text" || value === "bars" || value === "bars-text";
}

function reasoningIndicator(
  value: unknown,
  fallback: ComposerReasoningIndicator,
): ComposerReasoningIndicator {
  return isComposerReasoningIndicator(value) ? value : fallback;
}

/**
 * Field by field, like the status bar slice above and for the same reason: each
 * value picks a branch on a render path, and the two unions are NOT
 * interchangeable - a persisted `"hidden"` on a row that only compacts would
 * erase a surface whose Stop all / Review all / Undo all have no other home.
 */
function resolvePersistedComposer(value: unknown): ComposerLayoutPreferences {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    filesChanged: compactable(
      stored.filesChanged,
      DEFAULT_COMPOSER_LAYOUT.filesChanged,
    ),
    activeAgents: compactable(
      stored.activeAgents,
      DEFAULT_COMPOSER_LAYOUT.activeAgents,
    ),
    background: compactable(
      stored.background,
      DEFAULT_COMPOSER_LAYOUT.background,
    ),
    attachImage: hideable(
      stored.attachImage,
      DEFAULT_COMPOSER_LAYOUT.attachImage,
    ),
    access: compactable(stored.access, DEFAULT_COMPOSER_LAYOUT.access),
    mic: hideable(stored.mic, DEFAULT_COMPOSER_LAYOUT.mic),
    compactButton: hideable(
      stored.compactButton,
      DEFAULT_COMPOSER_LAYOUT.compactButton,
    ),
    reasoningIndicator: reasoningIndicator(
      stored.reasoningIndicator,
      DEFAULT_COMPOSER_LAYOUT.reasoningIndicator,
    ),
  };
}

// ── home slice ──────────────────────────────────────────────────────────────

function isHomeView(value: unknown): value is HomeView {
  return value === "focus" || value === "tasks";
}

function isHomeDensity(value: unknown): value is HomeDensity {
  return value === "comfortable" || value === "compact";
}

/**
 * Field by field, like the two slices above. Both values pick a branch on the
 * render path - an unrecognized `view` would mount neither reading of the page,
 * and an unrecognized `density` would leave the rows with no spacing class at
 * all.
 */
function resolvePersistedHome(value: unknown): HomeLayoutPreferences {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  return {
    view: isHomeView(stored.view) ? stored.view : DEFAULT_HOME_LAYOUT.view,
    density: isHomeDensity(stored.density)
      ? stored.density
      : DEFAULT_HOME_LAYOUT.density,
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
      composer: DEFAULT_COMPOSER_LAYOUT,
      home: DEFAULT_HOME_LAYOUT,
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
      setStatusBarProviderAutomatic: (providerId, automatic) => {
        const statusBar = get().statusBar;
        const current = statusBarProviderLimitSelection(
          statusBar.rateLimits.providers,
          providerId,
        );
        if (current.automatic === automatic) return;
        const next = { ...current, automatic };
        if (!isDrawableSelection(next)) return;
        set({
          statusBar: {
            ...statusBar,
            rateLimits: {
              ...statusBar.rateLimits,
              providers: {
                ...statusBar.rateLimits.providers,
                [providerId]: next,
              },
            },
          },
        });
      },
      toggleStatusBarProviderLimit: (providerId, limitKey) => {
        const statusBar = get().statusBar;
        const current = statusBarProviderLimitSelection(
          statusBar.rateLimits.providers,
          providerId,
        );
        const next = {
          ...current,
          limitKeys: toggledMembership(current.limitKeys, limitKey),
        };
        if (!isDrawableSelection(next)) return;
        set({
          statusBar: {
            ...statusBar,
            rateLimits: {
              ...statusBar.rateLimits,
              providers: {
                ...statusBar.rateLimits.providers,
                [providerId]: next,
              },
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
      setStatusBarShowModeWord: (showModeWord) => {
        const statusBar = get().statusBar;
        if (statusBar.rateLimits.showModeWord === showModeWord) return;
        set({
          statusBar: {
            ...statusBar,
            rateLimits: { ...statusBar.rateLimits, showModeWord },
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
      setComposerFilesChanged: (mode) => {
        const composer = get().composer;
        if (composer.filesChanged === mode) return;
        set({ composer: { ...composer, filesChanged: mode } });
      },
      setComposerActiveAgents: (mode) => {
        const composer = get().composer;
        if (composer.activeAgents === mode) return;
        set({ composer: { ...composer, activeAgents: mode } });
      },
      setComposerBackground: (mode) => {
        const composer = get().composer;
        if (composer.background === mode) return;
        set({ composer: { ...composer, background: mode } });
      },
      setComposerAttachImage: (mode) => {
        const composer = get().composer;
        if (composer.attachImage === mode) return;
        set({ composer: { ...composer, attachImage: mode } });
      },
      setComposerAccess: (mode) => {
        const composer = get().composer;
        if (composer.access === mode) return;
        set({ composer: { ...composer, access: mode } });
      },
      setComposerMic: (mode) => {
        const composer = get().composer;
        if (composer.mic === mode) return;
        set({ composer: { ...composer, mic: mode } });
      },
      setComposerCompactButton: (mode) => {
        const composer = get().composer;
        if (composer.compactButton === mode) return;
        set({ composer: { ...composer, compactButton: mode } });
      },
      setComposerReasoningIndicator: (indicator) => {
        const composer = get().composer;
        if (composer.reasoningIndicator === indicator) return;
        set({ composer: { ...composer, reasoningIndicator: indicator } });
      },
      setHomeView: (view) => {
        const home = get().home;
        if (home.view === view) return;
        set({ home: { ...home, view } });
      },
      setHomeDensity: (density) => {
        const home = get().home;
        if (home.density === density) return;
        set({ home: { ...home, density } });
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
          composer: resolvePersistedComposer(persisted.composer),
          home: resolvePersistedHome(persisted.home),
        };
      },
      partialize: (state) => ({
        statusBar: state.statusBar,
        composer: state.composer,
        home: state.home,
      }),
    },
  ),
);

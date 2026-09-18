import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { rateLimitCapableProviderIdSchema } from "@traycer/protocol/host/rate-limit";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { mergeOrder } from "@/lib/order-merge";
import {
  basePersistOptions,
  installCrossWindowRehydrate,
  persistKey,
  STORE_KEYS,
} from "@/lib/persist";
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
 *
 * Four fields here are ORDER rather than detail - `composer.toolbar`,
 * `composer.dockOrder`, `statusBar.segmentOrder`, `statusBar.resourceSide` -
 * and they are STRUCTURAL: no density preset carries one, `matchLayoutPreset`
 * ignores them, and `resetLayoutToDefaults` is the only thing that puts them
 * back (`lib/layout-presets.ts`). Every one of them reconciles a stored list
 * with this build's canonical one through `mergeOrder` (`lib/order-merge.ts`),
 * so an element this build added lands beside its neighbours rather than at the
 * end. The fifth order field, the pinned context-breakdown rows, lives in
 * `settings-store` beside the SET it orders.
 */

/**
 * Which surface owns the usage gauge and the resource monitor. Exactly one is
 * live at a time: the status bar exists only to host these two things, so a
 * separate on/off toggle would express nothing this does not.
 *
 * `status-bar` is the default (`DEFAULT_STATUS_BAR_LAYOUT.placement`). Nothing
 * outside that constant may restate which member that is - the resolver, the
 * reset and the "is this page default" check all read it.
 */
export type UsageControlsPlacement = "header" | "status-bar";

/** Whether a window reads as consumed or as headroom. */
export type PercentMode = "used" | "remaining";

export type ResourceMetric = "cpu" | "memory" | "processes" | "ramShare";

/** Traycer's processes on the watched host, or this desktop app's own. */
export type ResourceScope = "host-tree" | "desktop-app";

/** Which end of the status bar a segment sits at. */
export type StatusBarSide = "left" | "right";

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

/**
 * The accounts one provider's strip segments describe, on one host: a list of
 * profile ids, with `null` standing for the provider's ambient login. Order is
 * not meaningful here - the strip draws them in the provider's own profile
 * order, ambient last - so this is a set written as a list.
 */
export type StatusBarShownProfileIds = ReadonlyArray<string | null>;

/** Per provider, for one host. A provider with no entry has nothing checked. */
export type StatusBarHostShownProfiles = Readonly<
  Partial<Record<RateLimitProviderId, StatusBarShownProfileIds>>
>;

/**
 * Per host, then per provider. Keyed by `hostId` because a profile id names a
 * credential on ONE machine - the same id on another host is a different
 * account, or nothing at all - so a flat map would silently show one host's
 * pick under another's name. Device-local like every other key in this store.
 *
 * A checked id whose profile no longer exists is kept and skipped at read
 * time rather than pruned: this store never sees the provider inventory, and
 * the intent survives a credential being removed and re-added.
 */
export type StatusBarShownProfiles = Readonly<
  Record<string, StatusBarHostShownProfiles>
>;

/**
 * The strip's usage preferences that a density preset carries
 * (`lib/layout-presets.ts`): what a reading looks like and which limits it
 * draws. Split from `StatusBarRateLimitPreferences` so a bundle can be a
 * complete assignment of exactly these and nothing else.
 */
export interface StatusBarRateLimitDisplayPreferences {
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

export interface StatusBarRateLimitPreferences extends StatusBarRateLimitDisplayPreferences {
  /**
   * Which ACCOUNTS the strip draws, per host and provider - written from the
   * usage panel's profile cards, never from Layout, because accounts are
   * host-scoped and Layout is not. Not a display preference: no preset
   * carries it, and only `resetLayoutToDefaults` clears it.
   */
  readonly shownProfiles: StatusBarShownProfiles;
}

export interface StatusBarResourcePreferences {
  readonly enabled: boolean;
  /** Allow-list, held in canonical order rather than in toggle order. */
  readonly metrics: ReadonlyArray<ResourceMetric>;
  readonly scope: ResourceScope;
}

export interface StatusBarLayoutPreferences {
  readonly placement: UsageControlsPlacement;
  /**
   * The order the usage segments are drawn in, by provider id. STRUCTURAL: no
   * density bundle carries it, `matchLayoutPreset` ignores it, and only
   * `resetLayoutToDefaults` puts it back.
   *
   * The empty list means "canonical", which is also the default - a provider
   * that connects later is merged into whatever arrangement exists
   * (`mergeOrder`) rather than appended, so it appears where the provider order
   * would have put it. A stored id for a provider this build does not know is
   * dropped by the resolver.
   */
  readonly segmentOrder: ReadonlyArray<RateLimitProviderId>;
  /**
   * Which end of the strip the resource segment sits at. Structural for the
   * same reason `placement` is: it says where a thing LIVES, not how much of it
   * is spelled out.
   */
  readonly resourceSide: StatusBarSide;
  /**
   * Whether the footer strip is drawn on a mobile VIEWPORT, where the shell
   * otherwise withholds it whatever `placement` says. Off by default: the
   * footer competes with the software keyboard and the nav drawer, and the
   * mobile header already carries the usage gauge and the resource monitor,
   * so a phone that never opens Settings keeps exactly the chrome it has.
   *
   * Device-local like every other key here, so the phone answers this for
   * itself and a flip made on a desktop never reaches it.
   */
  readonly mobileFooter: boolean;
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

/**
 * Which control the model picker's footer offers for the thinking effort: a
 * stepped slider with one stop per level, or the horizontal list of buttons it
 * offered before. A shape rather than an amount of detail - the same catalog,
 * the same setter and the same selected level reach the harness either way -
 * which is why no density preset carries it (see `lib/layout-presets.ts`).
 */
export type ComposerReasoningFooterControl = "slider" | "list";

/**
 * A toolbar element that can be moved. Send is deliberately NOT one: it always
 * renders last on the right, because a composer whose submit button wandered is
 * a composer a reader has to look for the way out of.
 */
export type ToolbarItemId =
  | "attachImage"
  | "access"
  | "harness"
  | "model"
  | "mic";

/**
 * The toolbar as TWO lists rather than one with a side per item: the two
 * clusters are separate grid columns, so "which column" and "where in it" are
 * the same question asked once, and a single list would need a parallel side
 * map that could disagree with it.
 *
 * Every `ToolbarItemId` appears exactly once across the two, and `model` is
 * always in `right` - the picker anchors the footer controls that hang off it.
 * The resolver enforces both.
 */
export interface ComposerToolbarOrder {
  readonly left: ReadonlyArray<ToolbarItemId>;
  readonly right: ReadonlyArray<ToolbarItemId>;
}

/** One dock row. The same three ids the visibility fields above name. */
export type DockSection = "filesChanged" | "activeAgents" | "background";

export interface ComposerLayoutPreferences {
  readonly filesChanged: ComposerCompactableMode;
  readonly activeAgents: ComposerCompactableMode;
  readonly background: ComposerCompactableMode;
  readonly attachImage: ComposerHideableMode;
  readonly access: ComposerCompactableMode;
  readonly mic: ComposerHideableMode;
  readonly compactButton: ComposerHideableMode;
  readonly reasoningIndicator: ComposerReasoningIndicator;
  readonly reasoningFooterControl: ComposerReasoningFooterControl;
  /**
   * Where each toolbar element sits. STRUCTURAL, like the status bar's
   * `segmentOrder`: carried by no density bundle, ignored by
   * `matchLayoutPreset`, restored by `resetLayoutToDefaults` alone. An
   * arrangement is not an amount of detail.
   */
  readonly toolbar: ComposerToolbarOrder;
  /**
   * The order of the dock rows, which drives both the expanded rows and the
   * compact chips - one order, so folding a row does not move it.
   */
  readonly dockOrder: ReadonlyArray<DockSection>;
}

interface LayoutStoreState {
  readonly statusBar: StatusBarLayoutPreferences;
  readonly composer: ComposerLayoutPreferences;
  // Setters stay flat and are namespaced by their slice, so a call site names
  // the surface it is configuring and two slices can never collide on a verb.
  /**
   * The whole status-bar slice at once, for a caller that has a complete
   * assignment of it rather than one row's answer - Layout's presets and its
   * reset (`lib/layout-presets.ts`).
   *
   * A slice setter rather than a walk over the row setters, because two of
   * this slice's values are not reachable that way: `providers` and
   * `hiddenProviders` have only TOGGLES (a deny-list and a per-provider
   * selection), so "every provider on automatic, none hidden" would have to be
   * expressed as a diff against whatever is there - several writes, several
   * persists, and an ordering that matters because those toggles refuse to
   * leave a provider with nothing selected.
   */
  readonly setStatusBarPreferences: (
    preferences: StatusBarLayoutPreferences,
  ) => void;
  /** The whole composer slice at once. Same caller, same reason. */
  readonly setComposerPreferences: (
    preferences: ComposerLayoutPreferences,
  ) => void;
  readonly setStatusBarPlacement: (placement: UsageControlsPlacement) => void;
  readonly setStatusBarMobileFooter: (mobileFooter: boolean) => void;
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
  /**
   * Checks or unchecks one account for the strip on one host. `null` is the
   * provider's ambient login. A no-op when the entry already says so.
   */
  readonly setStatusBarProfileShown: (
    hostId: string,
    providerId: RateLimitProviderId,
    profileId: string | null,
    shown: boolean,
  ) => void;
  /** Every host's checked accounts, gone - `resetLayoutToDefaults` only. */
  readonly clearStatusBarShownProfiles: () => void;
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
  readonly setComposerReasoningFooterControl: (
    control: ComposerReasoningFooterControl,
  ) => void;
  /**
   * Both clusters at once, because a move BETWEEN them changes two lists and
   * two writes would leave an element briefly in neither or in both. Held to
   * the same invariants the resolver enforces.
   */
  readonly setComposerToolbarOrder: (order: ComposerToolbarOrder) => void;
  readonly setComposerDockOrder: (order: ReadonlyArray<DockSection>) => void;
  readonly setStatusBarSegmentOrder: (
    order: ReadonlyArray<RateLimitProviderId>,
  ) => void;
  readonly setStatusBarResourceSide: (side: StatusBarSide) => void;
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

/** Nothing checked anywhere: every provider follows its last-used account. */
const NO_SHOWN_PROFILES: StatusBarShownProfiles = {};

/**
 * The preset-able half of the usage defaults, exported on its own so the
 * Default bundle (`lib/layout-presets.ts`) can read it without restating it
 * and without carrying the accounts map a bundle has no opinion about.
 */
export const DEFAULT_STATUS_BAR_RATE_LIMIT_DISPLAY: StatusBarRateLimitDisplayPreferences =
  {
    enabled: true,
    hiddenProviders: [],
    providers: {},
    percentMode: "used",
    showTimer: true,
    showBar: true,
    showModeWord: true,
  };

const DEFAULT_STATUS_BAR_RATE_LIMITS: StatusBarRateLimitPreferences = {
  ...DEFAULT_STATUS_BAR_RATE_LIMIT_DISPLAY,
  shownProfiles: NO_SHOWN_PROFILES,
};

/**
 * CPU and process count, not memory: on a fresh install the footer's memory
 * figure is the one a reader cannot act on (it is the host's, not a
 * budget), and it cost the scarcest row in the app a third chip. No
 * migration off a persisted list - a list that was saved is a choice.
 */
const DEFAULT_STATUS_BAR_RESOURCES: StatusBarResourcePreferences = {
  enabled: true,
  metrics: ["cpu", "processes"],
  scope: "host-tree",
};

/**
 * The footer is where an install that has never chosen lands: the strip is the
 * surface built for these two subjects, and the header's cluster is the
 * fallback for a reader who wants the chrome in one band.
 *
 * There is deliberately no migration off a persisted `"header"`. The resolver
 * reaches this constant only when the stored value is absent or unreadable, so
 * an explicit pick made under the old default survives - it is a choice, and
 * rewriting it would be the store overruling the user. Reset and the footer
 * option are the two ways back.
 *
 * None of that reaches a PHONE, which does not read `placement` at all: below
 * `md` the shell asks `mobileFooter`, and that one starts off. A default about
 * which of two surfaces hosts the gauge has nothing to say on a viewport with
 * only one of them.
 */
export const DEFAULT_STATUS_BAR_LAYOUT: StatusBarLayoutPreferences = {
  placement: "status-bar",
  mobileFooter: false,
  // Empty means canonical: the strip already sorts providers for itself, so
  // the default is "however the strip would have ordered them" rather than a
  // snapshot of today's provider list frozen into a preference.
  segmentOrder: [],
  resourceSide: "right",
  rateLimits: DEFAULT_STATUS_BAR_RATE_LIMITS,
  resources: DEFAULT_STATUS_BAR_RESOURCES,
};

/**
 * Every toolbar id in VISUAL READING ORDER across both clusters, which is what
 * `mergeOrder` needs as its canonical sequence: an id that has to be
 * re-inserted lands beside the neighbours it renders beside, whichever cluster
 * it belongs to.
 */
const TOOLBAR_ITEM_IDS: ReadonlyArray<ToolbarItemId> = [
  "attachImage",
  "access",
  "harness",
  "model",
  "mic",
];

/** Today's render order, so an untouched install draws exactly what it drew. */
export const DEFAULT_COMPOSER_TOOLBAR_ORDER: ComposerToolbarOrder = {
  left: ["attachImage", "access", "harness"],
  right: ["model", "mic"],
};

/** Today's dock order, top to bottom. */
export const DOCK_SECTION_IDS: ReadonlyArray<DockSection> = [
  "filesChanged",
  "activeAgents",
  "background",
];

/**
 * Every element as it renders today, so an untouched install sees no change -
 * with the one deliberate exception of `reasoningFooterControl`, whose default
 * is the NEW control. The footer's list is what an install that wants the old
 * shape switches back to.
 */
export const DEFAULT_COMPOSER_LAYOUT: ComposerLayoutPreferences = {
  filesChanged: "visible",
  activeAgents: "visible",
  background: "visible",
  attachImage: "visible",
  access: "visible",
  mic: "visible",
  compactButton: "visible",
  reasoningIndicator: "text",
  reasoningFooterControl: "slider",
  toolbar: DEFAULT_COMPOSER_TOOLBAR_ORDER,
  dockOrder: DOCK_SECTION_IDS,
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

function isStatusBarSide(value: unknown): value is StatusBarSide {
  return value === "left" || value === "right";
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

/** One shared empty list, so an unchecked provider never allocates. */
const NO_SHOWN_PROFILE_IDS: StatusBarShownProfileIds = [];

/**
 * The checked accounts one provider has on one host, or the empty list. The
 * one read path, so nothing else has to know the map is two levels deep.
 */
export function statusBarShownProfileIds(
  shownProfiles: StatusBarShownProfiles,
  hostId: string | null,
  providerId: RateLimitProviderId,
): StatusBarShownProfileIds {
  if (hostId === null) return NO_SHOWN_PROFILE_IDS;
  return shownProfiles[hostId]?.[providerId] ?? NO_SHOWN_PROFILE_IDS;
}

/**
 * One provider's checked list. Profile ids are opaque strings and `null` is
 * the ambient login; anything else is dropped, as are duplicates, which would
 * otherwise make one account read as checked twice.
 */
function persistedShownProfileIds(value: unknown): StatusBarShownProfileIds {
  if (!Array.isArray(value)) return NO_SHOWN_PROFILE_IDS;
  const ids = value.filter(
    (entry): entry is string | null =>
      entry === null || (typeof entry === "string" && entry.length > 0),
  );
  return [...new Set(ids)];
}

/**
 * The whole two-level map, re-derived entry by entry: a host key is any
 * non-empty string (host ids are opaque), a provider key has to be one the
 * build knows, and an entry that resolves to nothing checked is dropped rather
 * than kept as an empty list - absent and empty mean the same thing at read
 * time, and only one of them should be able to exist.
 */
function persistedShownProfiles(value: unknown): StatusBarShownProfiles {
  if (!isRecord(value)) return NO_SHOWN_PROFILES;
  const shownProfiles: Record<string, StatusBarHostShownProfiles> = {};
  for (const [hostId, hostValue] of Object.entries(value)) {
    if (hostId.length === 0 || !isRecord(hostValue)) continue;
    const hostShown: Partial<
      Record<RateLimitProviderId, StatusBarShownProfileIds>
    > = {};
    for (const [key, ids] of Object.entries(hostValue)) {
      const providerId = rateLimitCapableProviderIdSchema.safeParse(key);
      if (!providerId.success) continue;
      const shown = persistedShownProfileIds(ids);
      if (shown.length === 0) continue;
      hostShown[providerId.data] = shown;
    }
    if (Object.keys(hostShown).length === 0) continue;
    shownProfiles[hostId] = hostShown;
  }
  return shownProfiles;
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
    shownProfiles: persistedShownProfiles(stored.shownProfiles),
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
    mobileFooter: persistedBoolean(
      stored.mobileFooter,
      DEFAULT_STATUS_BAR_LAYOUT.mobileFooter,
    ),
    // `persistedProviderIds` already drops unknown ids and duplicates, and an
    // empty result is the meaningful "canonical" value rather than a failure -
    // so no `mergeOrder` here. The STRIP merges this against the provider order
    // it actually has at read time, which is the only place that list exists.
    segmentOrder: persistedProviderIds(
      stored.segmentOrder,
      DEFAULT_STATUS_BAR_LAYOUT.segmentOrder,
    ),
    resourceSide: isStatusBarSide(stored.resourceSide)
      ? stored.resourceSide
      : DEFAULT_STATUS_BAR_LAYOUT.resourceSide,
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

function isComposerReasoningFooterControl(
  value: unknown,
): value is ComposerReasoningFooterControl {
  return value === "slider" || value === "list";
}

function reasoningFooterControl(
  value: unknown,
  fallback: ComposerReasoningFooterControl,
): ComposerReasoningFooterControl {
  return isComposerReasoningFooterControl(value) ? value : fallback;
}

/**
 * One cluster's stored list, reduced to ids this build knows, in stored order,
 * with anything already claimed by the other cluster skipped - so an id written
 * into both lists lands in exactly one, the first that names it.
 */
function persistedToolbarItems(
  value: unknown,
  claimed: Set<ToolbarItemId>,
): ReadonlyArray<ToolbarItemId> {
  if (!Array.isArray(value)) return [];
  const items: ToolbarItemId[] = [];
  for (const entry of value) {
    const id = TOOLBAR_ITEM_IDS.find((candidate) => candidate === entry);
    if (id === undefined || claimed.has(id)) continue;
    claimed.add(id);
    items.push(id);
  }
  return items;
}

/**
 * One cluster, with the ids that belong here and are missing entirely merged
 * back in at their canonical positions.
 *
 * The canonical sequence is built PER CLUSTER and per resolve, from what is
 * actually on this side plus the missing ids whose default home is this side.
 * Using the default cluster list as the canonical directly would be wrong in
 * the ordinary case: an element the user moved to the other cluster is not
 * missing, and `mergeOrder` against the default list would helpfully put it
 * back.
 */
function resolveToolbarSide(
  stored: ReadonlyArray<ToolbarItemId>,
  missing: ReadonlyArray<ToolbarItemId>,
  side: StatusBarSide,
): ReadonlyArray<ToolbarItemId> {
  const canonical = TOOLBAR_ITEM_IDS.filter(
    (id) =>
      stored.includes(id) ||
      (missing.includes(id) &&
        DEFAULT_COMPOSER_TOOLBAR_ORDER[side].includes(id)),
  );
  return mergeOrder(stored, canonical);
}

/**
 * Both clusters, holding the two invariants the type states: every id exactly
 * once across them, and `model` in `right`.
 *
 * `model` is stripped from `left` rather than swapped in place, which leaves it
 * unclaimed and therefore MISSING - so it is re-inserted into `right` at its
 * canonical position instead of appended. Same path a genuinely absent id
 * takes, so there is one rule to reason about rather than two.
 */
function resolvePersistedToolbarOrder(value: unknown): ComposerToolbarOrder {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  const claimed = new Set<ToolbarItemId>();
  const storedLeft = persistedToolbarItems(stored.left, claimed).filter(
    (id) => id !== "model",
  );
  const storedRight = persistedToolbarItems(stored.right, claimed);
  const present = new Set([...storedLeft, ...storedRight]);
  const missing = TOOLBAR_ITEM_IDS.filter((id) => !present.has(id));
  return {
    left: resolveToolbarSide(storedLeft, missing, "left"),
    right: resolveToolbarSide(storedRight, missing, "right"),
  };
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
    reasoningFooterControl: reasoningFooterControl(
      stored.reasoningFooterControl,
      DEFAULT_COMPOSER_LAYOUT.reasoningFooterControl,
    ),
    toolbar: resolvePersistedToolbarOrder(stored.toolbar),
    dockOrder: mergeOrder(
      Array.isArray(stored.dockOrder) ? stored.dockOrder : [],
      DOCK_SECTION_IDS,
    ),
  };
}

/**
 * The array counterpart of the `===` guard every scalar setter here uses: an
 * order setter is called on every drag frame's end and on every preset apply,
 * and a fresh array with the same ids in the same places is not a change worth
 * a persist and a re-render.
 */
function sameOrder<T extends string>(
  left: ReadonlyArray<T>,
  right: ReadonlyArray<T>,
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
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
      setStatusBarPreferences: (preferences) => {
        set({ statusBar: preferences });
      },
      setComposerPreferences: (preferences) => {
        set({ composer: preferences });
      },
      setStatusBarPlacement: (placement) => {
        const statusBar = get().statusBar;
        if (statusBar.placement === placement) return;
        set({ statusBar: { ...statusBar, placement } });
      },
      setStatusBarMobileFooter: (mobileFooter) => {
        const statusBar = get().statusBar;
        if (statusBar.mobileFooter === mobileFooter) return;
        set({ statusBar: { ...statusBar, mobileFooter } });
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
      setStatusBarProfileShown: (hostId, providerId, profileId, shown) => {
        const statusBar = get().statusBar;
        const { shownProfiles } = statusBar.rateLimits;
        const current = statusBarShownProfileIds(
          shownProfiles,
          hostId,
          providerId,
        );
        if (current.includes(profileId) === shown) return;
        const next = shown
          ? [...current, profileId]
          : current.filter((candidate) => candidate !== profileId);
        // An emptied entry is removed rather than left as `[]`, matching what
        // the resolver does on rehydration: one shape for "nothing checked".
        const hostShown: Partial<
          Record<RateLimitProviderId, StatusBarShownProfileIds>
        > = { ...shownProfiles[hostId] };
        if (next.length === 0) {
          delete hostShown[providerId];
        } else {
          hostShown[providerId] = next;
        }
        const nextShownProfiles: Record<string, StatusBarHostShownProfiles> = {
          ...shownProfiles,
        };
        if (Object.keys(hostShown).length === 0) {
          delete nextShownProfiles[hostId];
        } else {
          nextShownProfiles[hostId] = hostShown;
        }
        set({
          statusBar: {
            ...statusBar,
            rateLimits: {
              ...statusBar.rateLimits,
              shownProfiles: nextShownProfiles,
            },
          },
        });
      },
      clearStatusBarShownProfiles: () => {
        const statusBar = get().statusBar;
        if (Object.keys(statusBar.rateLimits.shownProfiles).length === 0) {
          return;
        }
        set({
          statusBar: {
            ...statusBar,
            rateLimits: {
              ...statusBar.rateLimits,
              shownProfiles: NO_SHOWN_PROFILES,
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
      setComposerReasoningFooterControl: (control) => {
        const composer = get().composer;
        if (composer.reasoningFooterControl === control) return;
        set({ composer: { ...composer, reasoningFooterControl: control } });
      },
      setComposerToolbarOrder: (order) => {
        const composer = get().composer;
        // Through the resolver rather than trusted: a drag that lands
        // impossibly (`model` dropped into the left cluster) is repaired here,
        // where a persisted blob would be, rather than only on the next start.
        const toolbar = resolvePersistedToolbarOrder(order);
        if (
          sameOrder(composer.toolbar.left, toolbar.left) &&
          sameOrder(composer.toolbar.right, toolbar.right)
        ) {
          return;
        }
        set({ composer: { ...composer, toolbar } });
      },
      setComposerDockOrder: (order) => {
        const composer = get().composer;
        const dockOrder = mergeOrder(order, DOCK_SECTION_IDS);
        if (sameOrder(composer.dockOrder, dockOrder)) return;
        set({ composer: { ...composer, dockOrder } });
      },
      setStatusBarSegmentOrder: (order) => {
        const statusBar = get().statusBar;
        const segmentOrder = persistedProviderIds(order, []);
        if (sameOrder(statusBar.segmentOrder, segmentOrder)) return;
        set({ statusBar: { ...statusBar, segmentOrder } });
      },
      setStatusBarResourceSide: (resourceSide) => {
        const statusBar = get().statusBar;
        if (statusBar.resourceSide === resourceSide) return;
        set({ statusBar: { ...statusBar, resourceSide } });
      },
    }),
    {
      ...basePersistOptions(LAYOUT_PERSIST_KEY),
      storage: createJSONStorage(() => localStorage),
      // One resolver per slice, composed here. A corrupt slice falls back to
      // its own defaults and cannot reach across into another's.
      //
      // A persisted `home` from the Home-density build is READ PAST rather
      // than migrated: Home has one spacing now, so there is nothing for the
      // old value to select, and naming the key here to delete it would keep a
      // slice alive that nothing in the app can still mean. It survives in
      // `localStorage` until the next write to any layout preference
      // re-serialises the store from `partialize` without it - harmless, since
      // an unknown key in a persisted blob has never been an error here.
      merge: (persistedState, currentState) => {
        const persisted: Record<string, unknown> = isRecord(persistedState)
          ? persistedState
          : {};
        return {
          ...currentState,
          statusBar: resolvePersistedStatusBar(persisted.statusBar),
          composer: resolvePersistedComposer(persisted.composer),
        };
      },
      partialize: (state) => ({
        statusBar: state.statusBar,
        composer: state.composer,
      }),
    },
  ),
);

/**
 * Another window's Layout write reaches this one live, the same way the
 * settings store's has since it shipped. Load-time rather than on demand: the
 * strip and the composer read this store at first paint, so a window that
 * hydrated before the write has to be told, and there is no later moment that
 * is reliably earlier than the first read.
 */
installCrossWindowRehydrate(useLayoutStore, LAYOUT_PERSIST_KEY);

/**
 * Whether the status bar strip is on screen: the ONE answer to that question,
 * read by the shell that mounts it and by every control that only makes sense
 * while it is mounted (the usage panel's per-account eye, the header glyph's
 * account rule).
 *
 * A mobile VIEWPORT, not a mobile build: a narrow desktop window behaves the
 * same way. Mobile ignores `placement` entirely and answers with its own
 * switch, which is off by default. `placement` names which of two surfaces
 * hosts the usage gauge and the resource monitor, and on a phone that question
 * has no second answer: `MobileAppHeader` keeps both controls whatever the
 * strip does, so a phone reading `placement` would be reading a preference
 * about a surface it does not have. The footer still competes with the
 * software keyboard and the nav drawer, which is what `MobileAppStatusBar`
 * gates on and why it is off until asked for.
 */
export function selectStatusBarShown(
  state: Pick<LayoutStoreState, "statusBar">,
  isMobileViewport: boolean,
): boolean {
  return isMobileViewport
    ? state.statusBar.mobileFooter
    : state.statusBar.placement === "status-bar";
}

/** `selectStatusBarShown` over the live store and the live viewport. */
export function useStatusBarShown(): boolean {
  const isMobileViewport = useIsMobileViewport();
  return useLayoutStore((state) =>
    selectStatusBarShown(state, isMobileViewport),
  );
}

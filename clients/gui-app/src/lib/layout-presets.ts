import { CONTEXT_USAGE_ROW_KEYS } from "@/components/chat/context-usage";
import {
  DEFAULT_LEFT_PANEL_GROUPS,
  useLeftPanelStore,
} from "@/stores/epics/left-panel-store";
import {
  DEFAULT_COMPOSER_LAYOUT,
  DEFAULT_STATUS_BAR_LAYOUT,
  useLayoutStore,
  type ComposerLayoutPreferences,
  type StatusBarProviderLimitSelections,
  type StatusBarRateLimitPreferences,
  type StatusBarResourcePreferences,
  type ResourceMetric,
} from "@/stores/settings/layout-store";
import {
  DEFAULT_CONTEXT_INDICATOR_STYLE,
  DEFAULT_MINIMAP_SIDE,
  DEFAULT_NAVIGATOR_RESOURCE_METRICS,
  DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
  DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
  NAVIGATOR_RESOURCE_METRICS,
  useSettingsStore,
  type ContextBreakdownField,
  type ContextIndicatorStyle,
  type MinimapPlacement,
  type NavigatorResourceMetric,
} from "@/stores/settings/settings-store";

/**
 * The three ready-made answers to "how much of the app's chrome do I want",
 * plus the one that says none of them.
 *
 * `custom` is a STATE rather than a preset: it is what the page reports when
 * the current values match no bundle, and it is never something a user picks.
 */
export type LayoutPresetId = "default" | "compact" | "detailed";
export type LayoutPresetMatch = LayoutPresetId | "custom";

export const LAYOUT_PRESET_IDS: ReadonlyArray<LayoutPresetId> = [
  "default",
  "compact",
  "detailed",
];

/**
 * The status bar's contribution, which is its two subjects and NOT its
 * `placement`.
 *
 * Placement is a structural choice - which surface hosts the usage gauge and
 * the resource monitor - rather than a level of detail, so it is treated
 * exactly as the sidebar's panel order is: carried by no bundle, `default`
 * included, restored by `resetLayoutToDefaults` alone, and not part of the
 * match. A user who moved the strip to the footer and then asks for a density
 * gets that density, not their header back.
 */
export interface LayoutPresetStatusBarValues {
  readonly rateLimits: StatusBarRateLimitPreferences;
  readonly resources: StatusBarResourcePreferences;
}

/** The Chat group's rows, all four of them `settings-store` keys. */
export interface LayoutPresetChatValues {
  readonly pinContextUsageBreakdown: boolean;
  readonly pinnedContextBreakdownFields: ReadonlyArray<ContextBreakdownField>;
  readonly contextIndicatorStyle: ContextIndicatorStyle;
  readonly chatTurnMinimapSide: MinimapPlacement;
}

/**
 * The Sidebar group's one PRESET-able row. Panel order and per-panel
 * visibility are in the group too but are not values a bundle carries - see
 * `applyLayoutPreset`.
 */
export interface LayoutPresetSidebarValues {
  readonly navigatorResourceMetrics: ReadonlyArray<NavigatorResourceMetric>;
}

/**
 * One preset, as a COMPLETE assignment of every Layout-page value it covers.
 *
 * Complete is what makes `matchLayoutPreset` a plain equality: a bundle that
 * left a value unstated would have to be matched by "the fields it mentions",
 * and two presets could then both match at once.
 *
 * **One object per surface, and each surface's object comes from exactly one
 * store** - `statusBar` and `composer` from `layout-store`, `chat` and
 * `sidebar` from `settings-store`. That split is not cosmetic, and the `home`
 * surface is what proved it: it carried Home's density here, and removing that
 * setting took three lines from each bundle plus its entry in the equality,
 * rather than unpicking a field from a flat object on every branch this file
 * is cherry-picked onto.
 */
export interface LayoutPresetBundle {
  readonly statusBar: LayoutPresetStatusBarValues;
  readonly composer: ComposerLayoutPreferences;
  readonly chat: LayoutPresetChatValues;
  readonly sidebar: LayoutPresetSidebarValues;
}

/**
 * What the page currently holds, in the bundle's own shape. The same type
 * rather than a parallel one, so a field added to a preset is a field the
 * caller must read.
 */
export type LayoutPresetSnapshot = LayoutPresetBundle;

/** Every provider on its tightest limit alone, which is the empty map. */
const AUTOMATIC_PROVIDER_SELECTIONS: StatusBarProviderLimitSelections = {};

/** No provider hidden from the strip. */
const NO_HIDDEN_PROVIDERS: ReadonlyArray<never> = [];

const COMPACT_RESOURCE_METRICS: ReadonlyArray<ResourceMetric> = ["cpu"];

const DETAILED_RESOURCE_METRICS: ReadonlyArray<ResourceMetric> = [
  "cpu",
  "memory",
  "processes",
  "ramShare",
];

/**
 * **Default reads the `DEFAULT_*` constants rather than restating them**, so a
 * default that changes carries this preset with it and the suite's "Default is
 * the defaults" assertion cannot be satisfied by a copy that drifted.
 */
const DEFAULT_PRESET: LayoutPresetBundle = {
  statusBar: {
    rateLimits: DEFAULT_STATUS_BAR_LAYOUT.rateLimits,
    resources: DEFAULT_STATUS_BAR_LAYOUT.resources,
  },
  composer: DEFAULT_COMPOSER_LAYOUT,
  chat: {
    pinContextUsageBreakdown: DEFAULT_PIN_CONTEXT_USAGE_BREAKDOWN,
    pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    contextIndicatorStyle: DEFAULT_CONTEXT_INDICATOR_STYLE,
    chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE,
  },
  sidebar: { navigatorResourceMetrics: DEFAULT_NAVIGATOR_RESOURCE_METRICS },
};

/**
 * The least chrome that still says everything: every reading present, none of
 * it spelled out.
 *
 * The status bar keeps its usage cluster and drops the three things that make
 * a reading long (the mode word, the mini bar, the countdown), which is the
 * strip's own `percent-only` shape expressed as preferences. The composer
 * folds its three dock rows and its access picker to chips - each keeps every
 * verb it had - and hides the two elements that have a full route elsewhere:
 * the dictation chord starts voice input, and the command palette and
 * `/compact` compact a conversation.
 *
 * **Attach image stays visible** (user ruling, 2026-09-12), alone among the
 * composer's buttons. Paste and drag-drop look like the same escape hatch the
 * other two have, but they are not: both need the image already in hand, and
 * neither opens a file picker - so hiding the button removes the only way to
 * attach a file from disk. Density is meant to shorten a reading, not to cost
 * a gesture.
 */
const COMPACT_PRESET: LayoutPresetBundle = {
  statusBar: {
    rateLimits: {
      enabled: true,
      hiddenProviders: NO_HIDDEN_PROVIDERS,
      providers: AUTOMATIC_PROVIDER_SELECTIONS,
      percentMode: "used",
      showTimer: false,
      showBar: false,
      showModeWord: false,
    },
    resources: {
      enabled: true,
      metrics: COMPACT_RESOURCE_METRICS,
      scope: "host-tree",
    },
  },
  composer: {
    filesChanged: "compact",
    activeAgents: "compact",
    background: "compact",
    attachImage: "visible",
    access: "compact",
    mic: "hidden",
    compactButton: "hidden",
    reasoningIndicator: "bars",
  },
  chat: {
    pinContextUsageBreakdown: false,
    // Kept at the full set even though the strip is unpinned: the fields row
    // only reads while the pin is on, so narrowing it here would be a change
    // nothing on screen shows and one a user would meet later, unexplained.
    pinnedContextBreakdownFields: DEFAULT_PINNED_CONTEXT_BREAKDOWN_FIELDS,
    contextIndicatorStyle: "ring-only",
    chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE,
  },
  sidebar: { navigatorResourceMetrics: [] },
};

/**
 * Everything the chrome can say, said: every reading in its long form, and
 * every element the composer can show shown.
 *
 * It does not move the strip to the footer, however much room the footer has
 * for that long form. Placement is where the controls LIVE, and a preset that
 * relocated a surface would be answering a question the reader did not ask.
 */
const DETAILED_PRESET: LayoutPresetBundle = {
  statusBar: {
    rateLimits: {
      enabled: true,
      hiddenProviders: NO_HIDDEN_PROVIDERS,
      providers: AUTOMATIC_PROVIDER_SELECTIONS,
      percentMode: "used",
      showTimer: true,
      showBar: true,
      showModeWord: true,
    },
    resources: {
      enabled: true,
      metrics: DETAILED_RESOURCE_METRICS,
      scope: "host-tree",
    },
  },
  composer: {
    filesChanged: "visible",
    activeAgents: "visible",
    background: "visible",
    attachImage: "visible",
    access: "visible",
    mic: "visible",
    compactButton: "visible",
    reasoningIndicator: "bars-text",
  },
  chat: {
    pinContextUsageBreakdown: true,
    pinnedContextBreakdownFields: CONTEXT_USAGE_ROW_KEYS,
    contextIndicatorStyle: "text",
    chatTurnMinimapSide: DEFAULT_MINIMAP_SIDE,
  },
  sidebar: { navigatorResourceMetrics: NAVIGATOR_RESOURCE_METRICS },
};

export const LAYOUT_PRESETS: Readonly<
  Record<LayoutPresetId, LayoutPresetBundle>
> = {
  default: DEFAULT_PRESET,
  compact: COMPACT_PRESET,
  detailed: DETAILED_PRESET,
};

export const LAYOUT_PRESET_LABELS: Readonly<Record<LayoutPresetMatch, string>> =
  {
    default: "Default",
    compact: "Compact",
    detailed: "Detailed",
    custom: "Custom",
  };

/**
 * Applies one bundle through the stores' own setters - the DENSITY half of the
 * page, and nothing else.
 *
 * This includes `default`: the Default preset is the third density bundle, not
 * a reset, so it leaves the two STRUCTURAL settings exactly where they are -
 * the status bar's `placement`, and the rail's panel order and per-panel
 * visibility. Those answer which surface hosts a thing and how the rail is
 * arranged, which is a different question from how much of it shows, and
 * `resetLayoutToDefaults` is the gesture that answers it.
 *
 * That is also why all three are absent from the bundle and from the match: a
 * preset only claims the values it assigns, so a Compact install with the
 * strip in the footer and a reordered rail is still Compact - and a page on
 * default densities reads Default wherever its strip lives.
 */
export function applyLayoutPreset(id: LayoutPresetId): void {
  const bundle = LAYOUT_PRESETS[id];
  const layout = useLayoutStore.getState();
  layout.setStatusBarPreferences({
    // Carried over rather than assigned: no bundle has an opinion about which
    // surface hosts the strip. Only `resetLayoutToDefaults` restores it.
    placement: layout.statusBar.placement,
    rateLimits: bundle.statusBar.rateLimits,
    resources: bundle.statusBar.resources,
  });
  layout.setComposerPreferences(bundle.composer);
  const settings = useSettingsStore.getState();
  settings.setPinContextUsageBreakdown(bundle.chat.pinContextUsageBreakdown);
  settings.setPinnedContextBreakdownFields(
    bundle.chat.pinnedContextBreakdownFields,
  );
  settings.setContextIndicatorStyle(bundle.chat.contextIndicatorStyle);
  settings.setMinimapSide(bundle.chat.chatTurnMinimapSide);
  settings.setNavigatorResourceMetrics(bundle.sidebar.navigatorResourceMetrics);
}

/**
 * Every Layout value back to its default: the Default bundle, PLUS the two
 * structural settings no bundle carries.
 *
 * This is where the button and the `Default` segment deliberately part
 * company. The segment answers "which density bundle am I on", so it has to
 * leave a footer strip in the footer - a reader asking for default DENSITIES
 * has not asked to have their surfaces moved, and the segment reading
 * `Default` for that page is the same claim `matchLayoutPreset` makes. The
 * button says "put the whole page back", which plainly includes where the
 * strip lives and how the rail is arranged; the rail half goes through the
 * same two resets the Sidebar group's own buttons call.
 *
 * The consequence is deliberate and worth stating: after Reset the page reads
 * `Default`, and after clicking `Default` it also reads `Default` - but only
 * the first of those moved the strip.
 */
export function resetLayoutToDefaults(): void {
  applyLayoutPreset("default");
  useLayoutStore
    .getState()
    .setStatusBarPlacement(DEFAULT_STATUS_BAR_LAYOUT.placement);
  const panels = useLeftPanelStore.getState();
  panels.applyPanelGroups(DEFAULT_LEFT_PANEL_GROUPS);
  panels.clearPanelVisibilityOverrides();
}

/**
 * Which preset the page is currently on, or `custom`.
 *
 * Pure, and over a snapshot rather than over the stores, so the control that
 * renders it re-derives on every render from the same values it is drawing -
 * no "selected preset" to fall out of step with a row the user just changed.
 */
export function matchLayoutPreset(
  snapshot: LayoutPresetSnapshot,
): LayoutPresetMatch {
  return (
    LAYOUT_PRESET_IDS.find((id) =>
      bundlesEqual(LAYOUT_PRESETS[id], snapshot),
    ) ?? "custom"
  );
}

function bundlesEqual(
  bundle: LayoutPresetBundle,
  snapshot: LayoutPresetSnapshot,
): boolean {
  return (
    statusBarEqual(bundle.statusBar, snapshot.statusBar) &&
    composerEqual(bundle.composer, snapshot.composer) &&
    chatEqual(bundle.chat, snapshot.chat) &&
    listsEqual(
      bundle.sidebar.navigatorResourceMetrics,
      snapshot.sidebar.navigatorResourceMetrics,
    )
  );
}

function statusBarEqual(
  bundle: LayoutPresetStatusBarValues,
  snapshot: LayoutPresetStatusBarValues,
): boolean {
  return (
    bundle.rateLimits.enabled === snapshot.rateLimits.enabled &&
    bundle.rateLimits.percentMode === snapshot.rateLimits.percentMode &&
    bundle.rateLimits.showTimer === snapshot.rateLimits.showTimer &&
    bundle.rateLimits.showBar === snapshot.rateLimits.showBar &&
    bundle.rateLimits.showModeWord === snapshot.rateLimits.showModeWord &&
    listsEqual(
      bundle.rateLimits.hiddenProviders,
      snapshot.rateLimits.hiddenProviders,
    ) &&
    providerSelectionsEqual(
      bundle.rateLimits.providers,
      snapshot.rateLimits.providers,
    ) &&
    bundle.resources.enabled === snapshot.resources.enabled &&
    bundle.resources.scope === snapshot.resources.scope &&
    listsEqual(bundle.resources.metrics, snapshot.resources.metrics)
  );
}

/**
 * Two provider maps agree when every provider draws the same limits.
 *
 * An ABSENT entry and an explicit `{automatic: true, limitKeys: []}` are the
 * same drawing - the map is a deny-list of "not the default" - so this
 * compares what each provider named in EITHER map resolves to, rather than
 * comparing key sets. Without that, a provider switched off automatic and back
 * on would leave the page reading `Custom` with nothing on screen to undo.
 */
function providerSelectionsEqual(
  bundle: StatusBarProviderLimitSelections,
  snapshot: StatusBarProviderLimitSelections,
): boolean {
  const providerIds = new Set([
    ...Object.keys(bundle),
    ...Object.keys(snapshot),
  ]);
  return [...providerIds].every((providerId) => {
    const left = selectionFor(bundle, providerId);
    const right = selectionFor(snapshot, providerId);
    return (
      left.automatic === right.automatic &&
      listsEqual(left.limitKeys, right.limitKeys)
    );
  });
}

const AUTOMATIC_ONLY = { automatic: true, limitKeys: [] } as const;

function selectionFor(
  selections: StatusBarProviderLimitSelections,
  providerId: string,
): { readonly automatic: boolean; readonly limitKeys: ReadonlyArray<string> } {
  const entry = Object.entries(selections).find(([key]) => key === providerId);
  return entry === undefined ? AUTOMATIC_ONLY : entry[1];
}

function composerEqual(
  bundle: ComposerLayoutPreferences,
  snapshot: ComposerLayoutPreferences,
): boolean {
  return (
    bundle.filesChanged === snapshot.filesChanged &&
    bundle.activeAgents === snapshot.activeAgents &&
    bundle.background === snapshot.background &&
    bundle.attachImage === snapshot.attachImage &&
    bundle.access === snapshot.access &&
    bundle.mic === snapshot.mic &&
    bundle.compactButton === snapshot.compactButton &&
    bundle.reasoningIndicator === snapshot.reasoningIndicator
  );
}

function chatEqual(
  bundle: LayoutPresetChatValues,
  snapshot: LayoutPresetChatValues,
): boolean {
  return (
    bundle.pinContextUsageBreakdown === snapshot.pinContextUsageBreakdown &&
    bundle.contextIndicatorStyle === snapshot.contextIndicatorStyle &&
    bundle.chatTurnMinimapSide === snapshot.chatTurnMinimapSide &&
    listsEqual(
      bundle.pinnedContextBreakdownFields,
      snapshot.pinnedContextBreakdownFields,
    )
  );
}

/**
 * Order-sensitive, because every list a preset carries is held in a canonical
 * order by the store that owns it (`RESOURCE_METRIC_ORDER`,
 * `NAVIGATOR_RESOURCE_METRICS`, `CONTEXT_USAGE_ROW_KEYS`). Two lists with the
 * same members in a different order cannot arise; if one did, it would draw
 * differently and `Custom` is the honest answer.
 */
function listsEqual<Item extends string>(
  bundle: ReadonlyArray<Item>,
  snapshot: ReadonlyArray<Item>,
): boolean {
  return (
    bundle.length === snapshot.length &&
    bundle.every((item, index) => item === snapshot[index])
  );
}

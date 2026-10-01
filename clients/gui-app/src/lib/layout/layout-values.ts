import type { ContextUsageRowKey } from "@/lib/context-usage-rows";
import type { RegionId } from "@/lib/layout/region-id";

/**
 * What every region SHOWS, as one value per region: how much of itself it
 * spells out, and whether it is there at all.
 *
 * The line this file draws is the one that makes L-20 a type-level fact rather
 * than a promise: a preset is a complete `LayoutValues`, and `LayoutValues`
 * contains no order, no side and no host - so a density can only ever change
 * how much a region says, never where it lives. Everything positional is in
 * `layout-arrangement.ts`.
 *
 * The shapes and the per-key comparisons only. The three presets and the
 * effective value are in `layout-presets.ts`, and reading a stored delta back
 * is `layout-values-persist.ts`.
 */

export type Visibility = "shown" | "hidden";

/**
 * The two rail panels with a real presence rule (L-47): Pull requests and
 * Comments. `auto` follows that rule - a Pull requests icon that appears once
 * the task has pull requests - and is their default. The other seven panels'
 * rule was "always", so Auto was Shown under another name and they are plain
 * `Visibility` (L-93 overturned); a stored `auto` on one of them reads as
 * `shown`.
 */
export type RailVisibility = "auto" | "shown" | "hidden";

/** An element that shrinks rather than disappears: the chip keeps every verb. */
export type RegionSize = "full" | "chip";

/** How the model chip draws the thinking effort. */
export type ModelStyle = "text" | "bars" | "bars-text";

/**
 * The composer toolbar's chrome: a bordered chip on the app's own background,
 * or flat with just a hover highlight. One setting for the whole row (attach,
 * access, model, mic) rather than a field on each of the four regions - see
 * `TOOLBAR_CHIP_CLASS` in `toolbar-buttons.tsx`, the row's one reader.
 */
export type ToolbarStyle = "flat" | "bordered";

/** How the model picker's footer sets the thinking effort. */
export type ReasoningControl = "slider" | "list";

/** How the context chip draws what is left of the window. */
export type ContextStyle = "text" | "ring" | "ring-only";

/** Whether a usage reading is consumed or headroom. */
export type AmountMode = "used" | "remaining";

/**
 * Whether a bar reading draws its full text or just its icon. Distinct from
 * `RegionSize` (`full` / `chip`) because that pair IS a region's own header
 * control (`RegionDisplayControl`'s `"size" in ...` branch, L-128) - this one
 * is a fine-tune row instead, and only means something in the Tab strip: the
 * Status bar has the room for the full reading (`status-bar-regions.ts`).
 */
export type ReadingDisplay = "full" | "icon";

/**
 * One row of the pinned context breakdown. The breakdown's own row keys, so
 * the picker can only name a row the strip knows how to draw.
 */
export type ContextBreakdownField = ContextUsageRowKey;

/**
 * Every enum value some `LayoutValues` leaf can hold, as one list.
 *
 * A `Record` per enum rather than an array of each union, because a `Record`
 * is what makes a new member a COMPILE error here - an array typed as the
 * union does not have to be complete. The keys merge, so a value two enums
 * share is named once.
 *
 * `lib/analytics.ts` validates every `layout_<region>_<key>` property against
 * this set. Hand-listing it there let a fourth `ModelStyle` land with the
 * allowlist behind, and a declared value that fails its validator drops the
 * WHOLE `layout_snapshot` event for every user with nothing red anywhere
 * (G3-03).
 */
export const LAYOUT_VALUE_ENUM_MEMBERS: ReadonlyArray<string> = Object.keys({
  ...({ shown: true, hidden: true } satisfies Record<Visibility, true>),
  ...({ auto: true, shown: true, hidden: true } satisfies Record<
    RailVisibility,
    true
  >),
  ...({ full: true, chip: true } satisfies Record<RegionSize, true>),
  ...({ text: true, bars: true, "bars-text": true } satisfies Record<
    ModelStyle,
    true
  >),
  ...({ flat: true, bordered: true } satisfies Record<ToolbarStyle, true>),
  ...({ slider: true, list: true } satisfies Record<ReasoningControl, true>),
  ...({ text: true, ring: true, "ring-only": true } satisfies Record<
    ContextStyle,
    true
  >),
  ...({ used: true, remaining: true } satisfies Record<AmountMode, true>),
  ...({ full: true, icon: true } satisfies Record<ReadingDisplay, true>),
});

export interface ShownValues {
  readonly shown: Visibility;
}

export interface SizedValues extends ShownValues {
  readonly size: RegionSize;
}

/**
 * The permission picker: a size and no Shown. It reports the permission the
 * next send runs under, so the chip is its floor and it is never hidden (G6).
 */
export interface AccessValues {
  readonly size: RegionSize;
}

/**
 * Tool activity: a size and no Shown. `full` is Expanded and `chip` is
 * Collapsed. It never hides, because approvals, failures and file edits ride
 * the same rows and hiding them would hide what the user must act on.
 */
export interface ToolActivityValues {
  readonly size: RegionSize;
}

/** Pull requests and Comments: shown only while their rule holds, by default. */
export interface AutoRailValues {
  readonly shown: RailVisibility;
}

export interface UsageLimitsValues extends ShownValues {
  readonly bar: boolean;
  readonly percent: boolean;
  readonly word: boolean;
  readonly reset: boolean;
  readonly amount: AmountMode;
  readonly display: ReadingDisplay;
}

/**
 * Shipped default is cpu + processes on, memory and ramShare off.
 *
 * `shown` is the monitor itself, in whichever bar it lives. `agentRows` is the
 * readings on each agent and terminal row in the sidebar, which used to ride
 * `shown` and could not be turned off without losing the monitor too (G7).
 */
export interface ResourceMonitorValues extends ShownValues {
  readonly cpu: boolean;
  readonly memory: boolean;
  readonly processes: boolean;
  readonly ramShare: boolean;
  readonly agentRows: boolean;
  readonly display: ReadingDisplay;
}

/** The four readings the monitor can print, in the order it prints them. */
export type ResourceMetric = "cpu" | "memory" | "processes" | "ramShare";

const RESOURCE_METRIC_IDS: ReadonlyArray<ResourceMetric> = [
  "cpu",
  "memory",
  "processes",
  "ramShare",
];

/**
 * Which readings are on, in canonical order rather than in toggle order, so
 * the segment reads the same whichever order they were switched on in.
 */
export function shownResourceMetrics(
  values: ResourceMonitorValues,
): ReadonlyArray<ResourceMetric> {
  return RESOURCE_METRIC_IDS.filter((metric) => values[metric]);
}

export interface ContextUsageValues extends ShownValues {
  readonly style: ContextStyle;
  readonly pinBreakdown: boolean;
  readonly pinnedFields: ReadonlyArray<ContextBreakdownField>;
  readonly compactButton: Visibility;
}

/**
 * The model picker: a style and no Shown. It always draws - it also owns the
 * picker shortcut and the palette's Pick model - so a Shown switch here had no
 * reader (G6).
 *
 * `toolbarStyle` is the odd one out: it is not about the model chip, it is
 * the whole toolbar row's chrome (attach, access, model, mic). It lives here
 * because Model is the one toolbar region that never hides (G6), so its row
 * is always reachable - not because the setting is about Model.
 */
export interface ModelValues {
  readonly style: ModelStyle;
  readonly reasoningControl: ReasoningControl;
  readonly toolbarStyle: ToolbarStyle;
}

export interface LayoutValues {
  readonly homeTab: ShownValues;
  readonly usageLimits: UsageLimitsValues;
  readonly resourceMonitor: ResourceMonitorValues;
  readonly minimap: ShownValues;
  readonly contextUsage: ContextUsageValues;
  /** Whether a settled activity row opens by default. */
  readonly toolActivity: ToolActivityValues;
  /** Reasoning blocks: open by default, folded, or not drawn at all. */
  readonly thinking: SizedValues;
  readonly timestamps: ShownValues;
  readonly runningAgents: SizedValues;
  readonly changedFiles: SizedValues;
  readonly background: SizedValues;
  readonly todo: SizedValues;
  readonly attachImage: ShownValues;
  readonly access: AccessValues;
  readonly model: ModelValues;
  readonly mic: ShownValues;
  readonly railAgents: ShownValues;
  readonly railTerminals: ShownValues;
  readonly railBrowsers: ShownValues;
  readonly railArtifacts: ShownValues;
  readonly railGitDiff: ShownValues;
  readonly railPullRequests: AutoRailValues;
  readonly railFileTree: ShownValues;
  readonly railSharing: ShownValues;
  readonly railComments: AutoRailValues;
}

/**
 * The regions that can be hidden: every one with a `shown` leaf. Access, Model
 * and Tool activity are the three without - each is a floor that always draws
 * (G6).
 */
export type HideableRegionId = {
  [K in RegionId]: LayoutValues[K] extends { readonly shown: unknown }
    ? K
    : never;
}[RegionId];

/** Whether a region's values say Hidden; a region with no Shown never is. */
export function regionValuesHidden(values: LayoutValues[RegionId]): boolean {
  return "shown" in values && values.shown === "hidden";
}

/**
 * The delta against the base preset, and only the delta: a key whose value
 * equals the base's is dropped rather than written, both on the setter and on
 * rehydration. That is what makes the change count a count of this map's keys
 * and per-row revert a `delete`.
 */
export type LayoutOverrides = {
  readonly [K in RegionId]?: Partial<LayoutValues[K]>;
};

/**
 * Every key some region's value bag has, as one union.
 *
 * The UNION and not the intersection, which is what `keyof LayoutValues[RegionId]`
 * gives (`shown`, the only key all twenty-six share). It is the type a caller
 * walking every region can still name a control's key with - the registry's
 * own `ControlSpec<K>.key` stays tied to its region - so `region-control-io.ts`
 * takes this rather than a bare `string` and a typo cannot be passed at all
 * (G1-08).
 */
export type RegionValueKey = {
  readonly [K in RegionId]: keyof LayoutValues[K] & string;
}[RegionId];

/** The one non-scalar leaf's comparator, order-sensitive because it is drawn in order. */
export function sameFieldList(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((field, index) => field === right[index])
  );
}

/**
 * Per-key equality over a region's value bag.
 *
 * Every leaf but `pinnedFields` is a scalar, which is the whole reason the
 * four resource metrics are booleans rather than a list (C-10), so `===` is
 * the rule and the one list gets the one declared comparator.
 */
export function sameRegionValue(
  key: string,
  left: unknown,
  right: unknown,
): boolean {
  if (key !== "pinnedFields") return left === right;
  return isStringList(left) && isStringList(right)
    ? sameFieldList(left, right)
    : left === right;
}

/**
 * The keys a patch actually carries.
 *
 * A patch is only ever built from parsed values - a setter's argument, or the
 * persisted resolver's output - so its keys ARE that value bag's keys; the
 * predicate states that, because `Object.keys` cannot.
 */
export function overrideKeys<Values extends object>(
  patch: Partial<Values>,
): ReadonlyArray<keyof Values & string> {
  return Object.keys(patch).filter(
    (key): key is keyof Values & string => key in patch,
  );
}

export function isStringList(value: unknown): value is ReadonlyArray<string> {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

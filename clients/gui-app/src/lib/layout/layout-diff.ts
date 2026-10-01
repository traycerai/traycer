import {
  DEFAULT_ARRANGEMENT,
  isAutomaticLimitSelection,
  USAGE_PROVIDER_IDS,
  ORDER_GROUP_IDS,
  type BarHost,
  type EdgeSide,
  type LayoutArrangement,
  type OrderGroupId,
  type SideStripView,
  type StatusBarProviderLimitSelection,
  type TabStripPlacement,
} from "@/lib/layout/layout-arrangement";
import {
  overrideKeys,
  sameFieldList,
  isStringList,
  sameRegionValue,
  type LayoutValues,
  type RegionValueKey,
} from "@/lib/layout/layout-values";
import { resolvePersistedOverrides } from "@/lib/layout/layout-values-persist";
import {
  effectiveLayoutValues,
  PRESET_VALUES,
  type LayoutPresetId,
} from "@/lib/layout/layout-presets";
import type { RegionId } from "@/lib/layout/region-id";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";

/**
 * What is different from the last-applied preset, and the way back.
 *
 * `basePreset` is the preset last APPLIED, and an apply replaces every value
 * with that preset's (`applyPreset`), so a value is a change exactly when it
 * differs from it. Where things live has no preset, so the arrangement is
 * measured against the shipped one. The two together are the change list
 * (`layoutChanges`), grouped Styles and Arrangement, and `<Preset> · Modified`
 * reads whether that list has anything in it.
 */

/** Which keys of one region differ from the last-applied preset, in the patch's order. */
function changedKeys<K extends RegionId>(
  snapshot: LayoutSnapshot,
  region: K,
): ReadonlyArray<keyof LayoutValues[K] & string> {
  const patch = snapshot.overrides[region];
  if (patch === undefined) return [];
  const base = PRESET_VALUES[snapshot.basePreset][region];
  return overrideKeys(patch).filter(
    (key) => !sameRegionValue(key, patch[key], base[key]),
  );
}

/** Whether a region has anything to revert, which is what its dot draws. */
export function regionChanged(
  snapshot: LayoutSnapshot,
  region: RegionId,
): boolean {
  return changedKeys(snapshot, region).length > 0;
}

/**
 * Every region id, from the one object that has to name them all.
 *
 * `PRESET_VALUES.default` is typed as `LayoutValues`, so adding a region
 * widens that interface and this list follows without being written twice.
 * One cast in one place rather than the three call sites that each had their
 * own; `regions/region-facts.ts` has the same list from the registry, but this
 * layer cannot reach it - `regions/region-position-rows.ts` imports THIS
 * module, so the arrow only points one way.
 */
function layoutRegionIds(): ReadonlyArray<RegionId> {
  return Object.keys(PRESET_VALUES.default) as ReadonlyArray<RegionId>;
}

/** Every order group whose order is no longer the default one. */
export function reorderedGroups(
  arrangement: LayoutArrangement,
): ReadonlyArray<OrderGroupId> {
  return ORDER_GROUP_IDS.filter(
    (group) =>
      !sameFieldList(orderIds(arrangement, group), defaultOrderIds(group)),
  );
}

/**
 * Whether one provider's stored selection differs from the shipped default.
 *
 * By DIFFERENCE rather than by presence: an entry equal to Automatic says
 * nothing the absence of one does not, and reading presence as change left a
 * provider the user had put back marked forever - down to offering "Reset
 * everything", a confirmed destructive action, on a layout nobody had changed
 * (R1-03). The writer no longer stores such an entry; a map rehydrated from an
 * older write still can, which is why the truth is measured here and not
 * assumed at the write.
 */
function limitsChanged(
  selection: StatusBarProviderLimitSelection | undefined,
): boolean {
  return selection !== undefined && !isAutomaticLimitSelection(selection);
}

/** Whether ONE provider has been hidden or had its limits picked (L-26, L-96). */
export function providerChanged(
  arrangement: LayoutArrangement,
  providerId: RateLimitProviderId,
): boolean {
  return (
    arrangement.hiddenProviders.includes(providerId) ||
    limitsChanged(arrangement.providerLimits[providerId])
  );
}

/** That provider back to shown, on Automatic, leaving every other one alone. */
export function revertProvider(
  arrangement: LayoutArrangement,
  providerId: RateLimitProviderId,
): LayoutArrangement {
  const providerLimits = { ...arrangement.providerLimits };
  delete providerLimits[providerId];
  return {
    ...arrangement,
    hiddenProviders: arrangement.hiddenProviders.filter(
      (entry) => entry !== providerId,
    ),
    providerLimits,
  };
}

/** Whether anything about the usage providers differs from what shipped. */
export function usageProvidersChanged(arrangement: LayoutArrangement): boolean {
  return (
    arrangement.hiddenProviders.length > 0 ||
    Object.values(arrangement.providerLimits).some((selection) =>
      limitsChanged(selection),
    ) ||
    reorderedGroups(arrangement).includes("usageProviders")
  );
}

/** Whether the strip is drawn on a narrow viewport against what shipped (L-51). */
export function mobileFooterChanged(arrangement: LayoutArrangement): boolean {
  return arrangement.mobileFooter !== DEFAULT_ARRANGEMENT.mobileFooter;
}

/**
 * Whether the tab strip's placement differs between the two arrangements
 * handed to it - a two-arrangement comparator rather than one fixed against
 * `DEFAULT_ARRANGEMENT`, so a caller comparing against a session's entry
 * snapshot and one comparing against the shipped default can both use it.
 * `surface-diff.ts` passes `DEFAULT_ARRANGEMENT` as `b`, the same "changed
 * from shipped" reading every Position row dot and revert uses
 * (`region-position-rows.ts`).
 */
export function tabStripPlacementChanged(
  a: LayoutArrangement,
  b: LayoutArrangement,
): boolean {
  return a.tabStripPlacement !== b.tabStripPlacement;
}

/** Whether the epic sidebar's side differs between two arrangements (S-06). */
export function sidebarSideChanged(
  a: LayoutArrangement,
  b: LayoutArrangement,
): boolean {
  return a.sidebarSide !== b.sidebarSide;
}

/** Whether the vertical strip's view differs between two arrangements (D8). */
export function sideStripViewChanged(
  a: LayoutArrangement,
  b: LayoutArrangement,
): boolean {
  return a.sideStripView !== b.sideStripView;
}

// ── The change list ─────────────────────────────────────────────────────────

/** Any one leaf some region's value bag holds. */
export type LayoutValueLeaf = boolean | string | ReadonlyArray<string>;

/** One value that differs from the value it is measured against. */
export interface StyleChange {
  readonly kind: "value";
  readonly region: RegionId;
  readonly key: RegionValueKey;
  readonly current: LayoutValueLeaf;
  /**
   * The last-applied preset's value on the change list, which the line's
   * revert restores; the session's entry value on the session list.
   */
  readonly baseline: LayoutValueLeaf;
}

/** The arrangement's single-valued fields a change line can name. */
export type ArrangementField =
  | "tabStripPlacement"
  | "sideStripView"
  | "taskTabLayout"
  | "readingWidth"
  | "wideReadingWidthPx"
  | "sidebarSide"
  | "minimapSide"
  | "usageHost"
  | "usageSide"
  | "resourceHost"
  | "resourceSide"
  | "mobileFooter";

const ARRANGEMENT_FIELDS: ReadonlyArray<ArrangementField> = [
  "tabStripPlacement",
  "sideStripView",
  "taskTabLayout",
  "readingWidth",
  "wideReadingWidthPx",
  "sidebarSide",
  "minimapSide",
  "usageHost",
  "usageSide",
  "resourceHost",
  "resourceSide",
  "mobileFooter",
];

/**
 * One piece of where things live that differs from the arrangement it is
 * measured against.
 *
 * A reordered group and a changed provider carry no value pair: an order and
 * a provider's hidden state plus limits are not one value, and the line reads
 * the same whatever they are.
 */
export type ArrangementChange =
  | {
      readonly kind: "field";
      readonly field: ArrangementField;
      readonly current: LayoutArrangement[ArrangementField];
      /**
       * The shipped value on the change list, which the line's revert
       * restores; the session's entry value on the session list.
       */
      readonly baseline: LayoutArrangement[ArrangementField];
    }
  | { readonly kind: "order"; readonly group: OrderGroupId }
  | { readonly kind: "provider"; readonly providerId: RateLimitProviderId };

export type LayoutChange = StyleChange | ArrangementChange;

export interface LayoutChanges {
  readonly styles: ReadonlyArray<StyleChange>;
  readonly arrangement: ReadonlyArray<ArrangementChange>;
}

/**
 * Everything that differs: values against the last-applied preset, the
 * arrangement against the shipped one.
 *
 * Which profiles the usage popover shows, the pinned breakdown's field order
 * and the status bar's parked set are left out: each is picked where it is
 * drawn rather than in the layout form, so no row could show it. `resetLayout`
 * still puts them back.
 */
export function layoutChanges(snapshot: LayoutSnapshot): LayoutChanges {
  const values = effectiveLayoutValues(snapshot.basePreset, snapshot.overrides);
  const arrangement = snapshot.arrangement;
  return {
    styles: layoutRegionIds().flatMap((region) =>
      regionStyleChanges(snapshot, values, region),
    ),
    arrangement: [
      ...ARRANGEMENT_FIELDS.filter(
        (field) => arrangement[field] !== DEFAULT_ARRANGEMENT[field],
      ).map((field): ArrangementChange => ({
        kind: "field",
        field,
        current: arrangement[field],
        baseline: DEFAULT_ARRANGEMENT[field],
      })),
      ...reorderedGroups(arrangement).map((group): ArrangementChange => ({
        kind: "order",
        group,
      })),
      ...USAGE_PROVIDER_IDS.filter((providerId) =>
        providerChanged(arrangement, providerId),
      ).map((providerId): ArrangementChange => ({
        kind: "provider",
        providerId,
      })),
    ],
  };
}

/** Whether the status reads `<Preset> · Modified` rather than the name alone. */
export function layoutModified(snapshot: LayoutSnapshot): boolean {
  const changes = layoutChanges(snapshot);
  return changes.styles.length > 0 || changes.arrangement.length > 0;
}

/** What an editor session has changed so far. */
export interface SessionLayoutChanges {
  /** The last-applied preset, when the session has applied a different one. */
  readonly preset: {
    readonly current: LayoutPresetId;
    readonly baseline: LayoutPresetId;
  } | null;
  readonly styles: ReadonlyArray<StyleChange>;
  readonly arrangement: ReadonlyArray<ArrangementChange>;
}

/**
 * Everything that differs between the layout a session opened on and the one
 * it has now: values compared EFFECTIVE against effective, so a preset switch
 * reads as the values it visibly moved, and the arrangement field by field.
 *
 * The same scope as {@link layoutChanges}: the choices made where they are
 * drawn (shown accounts, the pinned breakdown's order, the parked set) are
 * left out, and so is `dividerSeq`, which is bookkeeping.
 */
export function sessionLayoutChanges(
  entry: LayoutSnapshot,
  current: LayoutSnapshot,
): SessionLayoutChanges {
  const entryValues = effectiveLayoutValues(entry.basePreset, entry.overrides);
  const values = effectiveLayoutValues(current.basePreset, current.overrides);
  const before = entry.arrangement;
  const after = current.arrangement;
  return {
    preset:
      entry.basePreset === current.basePreset
        ? null
        : { current: current.basePreset, baseline: entry.basePreset },
    styles: layoutRegionIds().flatMap((region) => {
      const keys: ReadonlyArray<string> = Object.keys(
        PRESET_VALUES.default[region],
      );
      return keys
        .filter(isRegionValueKey)
        .filter(
          (key) =>
            !sameRegionValue(
              key,
              regionSettingValue(values[region], key),
              regionSettingValue(entryValues[region], key),
            ),
        )
        .map((key): StyleChange => ({
          kind: "value",
          region,
          key,
          current: regionLeaf(values[region], key),
          baseline: regionLeaf(entryValues[region], key),
        }));
    }),
    arrangement: [
      ...ARRANGEMENT_FIELDS.filter(
        (field) => after[field] !== before[field],
      ).map((field): ArrangementChange => ({
        kind: "field",
        field,
        current: after[field],
        baseline: before[field],
      })),
      ...ORDER_GROUP_IDS.filter(
        (group) =>
          !sameFieldList(orderIds(after, group), orderIds(before, group)),
      ).map((group): ArrangementChange => ({ kind: "order", group })),
      ...USAGE_PROVIDER_IDS.filter(
        (providerId) => !sameProviderState(before, after, providerId),
      ).map((providerId): ArrangementChange => ({
        kind: "provider",
        providerId,
      })),
    ],
  };
}

/** Whether one provider is hidden the same way and draws the same limits in both. */
function sameProviderState(
  left: LayoutArrangement,
  right: LayoutArrangement,
  providerId: RateLimitProviderId,
): boolean {
  return (
    left.hiddenProviders.includes(providerId) ===
      right.hiddenProviders.includes(providerId) &&
    sameFieldList(
      providerLimitKeys(left, providerId),
      providerLimitKeys(right, providerId),
    )
  );
}

/**
 * What one line of the session list puts back. The preset line is its own
 * kind: switching preset replaced every value at once, so putting it back
 * restores the session's opening values with it, and - as applying one never
 * does - leaves the arrangement alone.
 */
export type SessionRevert =
  | { readonly kind: "preset" }
  | { readonly kind: "changes"; readonly changes: ReadonlyArray<LayoutChange> };

/** One session line put back to what it was when the session opened, and nothing else. */
export function revertSessionLine(
  current: LayoutSnapshot,
  entry: LayoutSnapshot,
  revert: SessionRevert,
): LayoutSnapshot {
  if (revert.kind === "preset")
    return {
      ...current,
      basePreset: entry.basePreset,
      overrides: entry.overrides,
    };
  return revert.changes.reduce(
    (snapshot, change) => revertSessionChange(snapshot, entry, change),
    current,
  );
}

/**
 * The whole layout back to where the session opened, as a step Undo can take
 * back - unlike Discard, which also ends the session. `dividerSeq` keeps the
 * higher count for the reason `resetLayout` gives.
 */
export function revertSession(
  current: LayoutSnapshot,
  entry: LayoutSnapshot,
): LayoutSnapshot {
  return {
    ...entry,
    arrangement: {
      ...entry.arrangement,
      dividerSeq: Math.max(
        entry.arrangement.dividerSeq,
        current.arrangement.dividerSeq,
      ),
    },
  };
}

function revertSessionChange(
  current: LayoutSnapshot,
  entry: LayoutSnapshot,
  change: LayoutChange,
): LayoutSnapshot {
  const arrangement = current.arrangement;
  const before = entry.arrangement;
  switch (change.kind) {
    case "value": {
      // Written against the CURRENT preset: the entry's value as an override,
      // or no override at all where the current preset already has it.
      const entryValues = effectiveLayoutValues(
        entry.basePreset,
        entry.overrides,
      );
      const target = regionLeaf(entryValues[change.region], change.key);
      const base = regionSettingValue(
        PRESET_VALUES[current.basePreset][change.region],
        change.key,
      );
      const overrides: Record<string, unknown> = { ...current.overrides };
      const kept: Record<string, unknown> = {
        ...current.overrides[change.region],
      };
      if (sameRegionValue(change.key, base, target)) delete kept[change.key];
      else kept[change.key] = target;
      overrides[change.region] = kept;
      return { ...current, overrides: resolvePersistedOverrides(overrides) };
    }
    case "field":
      return {
        ...current,
        arrangement: { ...arrangement, [change.field]: before[change.field] },
      };
    case "order":
      // Every order group is the arrangement field of the same name.
      // `dividerSeq` stays: it only ever increases.
      return {
        ...current,
        arrangement: { ...arrangement, [change.group]: before[change.group] },
      };
    case "provider": {
      const providerId = change.providerId;
      const providerLimits = { ...arrangement.providerLimits };
      const selection = before.providerLimits[providerId];
      if (selection === undefined) delete providerLimits[providerId];
      else providerLimits[providerId] = selection;
      return {
        ...current,
        arrangement: {
          ...arrangement,
          hiddenProviders: withHidden(
            arrangement.hiddenProviders,
            providerId,
            before.hiddenProviders.includes(providerId),
          ),
          providerLimits,
        },
      };
    }
  }
}

/** The hidden list with one provider in or out of it, untouched when it already is. */
function withHidden(
  hidden: ReadonlyArray<RateLimitProviderId>,
  providerId: RateLimitProviderId,
  hide: boolean,
): ReadonlyArray<RateLimitProviderId> {
  if (hidden.includes(providerId) === hide) return hidden;
  return hide
    ? [...hidden, providerId]
    : hidden.filter((entryId) => entryId !== providerId);
}

/** A provider's picked limits; none is Automatic, stored or not. */
export function providerLimitKeys(
  arrangement: LayoutArrangement,
  providerId: RateLimitProviderId,
): ReadonlyArray<string> {
  return arrangement.providerLimits[providerId]?.limitKeys ?? [];
}

/** That one change put back, and nothing else. */
export function revertLayoutChange(
  snapshot: LayoutSnapshot,
  change: LayoutChange,
): LayoutSnapshot {
  const arrangement = snapshot.arrangement;
  switch (change.kind) {
    case "value": {
      // Taken OUT of the delta, so the value is the last-applied preset's.
      const overrides: Record<string, unknown> = { ...snapshot.overrides };
      const kept: Record<string, unknown> = {
        ...snapshot.overrides[change.region],
      };
      delete kept[change.key];
      overrides[change.region] = kept;
      return {
        ...snapshot,
        overrides: resolvePersistedOverrides(overrides),
      };
    }
    case "field":
      return {
        ...snapshot,
        arrangement: {
          ...arrangement,
          [change.field]: DEFAULT_ARRANGEMENT[change.field],
        },
      };
    case "order":
      // Every order group is the arrangement field of the same name.
      // `dividerSeq` stays: it only ever increases.
      return {
        ...snapshot,
        arrangement: {
          ...arrangement,
          [change.group]: DEFAULT_ARRANGEMENT[change.group],
        },
      };
    case "provider":
      return {
        ...snapshot,
        arrangement: revertProvider(arrangement, change.providerId),
      };
  }
}

/** One region's value lines. */
function regionStyleChanges(
  snapshot: LayoutSnapshot,
  values: LayoutValues,
  region: RegionId,
): ReadonlyArray<StyleChange> {
  const baseline = PRESET_VALUES[snapshot.basePreset][region];
  const keys: ReadonlyArray<string> = changedKeys(snapshot, region);
  return keys.filter(isRegionValueKey).map((key): StyleChange => ({
    kind: "value",
    region,
    key,
    current: regionLeaf(values[region], key),
    baseline: regionLeaf(baseline, key),
  }));
}

function isRegionValueKey(key: string): key is RegionValueKey {
  return layoutRegionIds().some(
    (region) => key in PRESET_VALUES.default[region],
  );
}

/**
 * One leaf off a region's bag, read by a key known to be in it; `Reflect.get`
 * for the reason `regionSettingValue` gives, and narrowed rather than cast.
 */
function regionLeaf(
  regionValues: LayoutValues[RegionId],
  key: RegionValueKey,
): LayoutValueLeaf {
  const leaf: unknown = Reflect.get(regionValues, key);
  if (typeof leaf === "boolean" || typeof leaf === "string") return leaf;
  return isStringList(leaf) ? leaf : [];
}

/**
 * Everything back to what shipped: the Default preset, no value overrides and
 * the shipped arrangement - `Reset layout…`.
 *
 * `dividerSeq` is the one field that does NOT go back. It is the rail's
 * "only ever increases" counter, and handing out an id a removed divider once
 * held is the one way two entries in a list keyed by id can collide.
 */
export function resetLayout(snapshot: LayoutSnapshot): LayoutSnapshot {
  return {
    ...snapshot,
    basePreset: "default",
    overrides: {},
    arrangement: {
      ...DEFAULT_ARRANGEMENT,
      dividerSeq: Math.max(
        snapshot.arrangement.dividerSeq,
        DEFAULT_ARRANGEMENT.dividerSeq,
      ),
    },
  };
}

/**
 * Whether `resetLayout` would change anything at all - including the stored
 * choices the change list leaves out (selected accounts, pinned field order).
 * `dividerSeq` is bookkeeping and never counts.
 */
export function resetWouldChange(snapshot: LayoutSnapshot): boolean {
  const reset = resetLayout(snapshot);
  return !sameData(
    { ...snapshot, arrangement: { ...snapshot.arrangement, dividerSeq: 0 } },
    { ...reset, arrangement: { ...reset.arrangement, dividerSeq: 0 } },
  );
}

/** Plain-data equality that ignores key order. */
function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => sameData(entry, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameData(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
}

/**
 * One order group's ids.
 *
 * A rail divider stands in as a mark rather than as its own id: divider ids are
 * issued from a counter that only ever increases, so a divider removed and
 * added back would leave the rail permanently "reordered" against a rail it
 * draws identically to.
 */
function orderIds(
  arrangement: LayoutArrangement,
  group: OrderGroupId,
): ReadonlyArray<string> {
  switch (group) {
    case "dock":
      return arrangement.dock;
    case "toolbarLeft":
      return arrangement.toolbarLeft;
    case "toolbarRight":
      return arrangement.toolbarRight;
    case "rail":
      return arrangement.rail.map((entry) =>
        entry.kind === "divider" ? DIVIDER_MARK : entry.id,
      );
    case "usageProviders":
      return arrangement.usageProviders;
  }
}

/** Stands for a divider in the rail's comparable order. Not a panel id. */
const DIVIDER_MARK = "|";

function defaultOrderIds(group: OrderGroupId): ReadonlyArray<string> {
  return orderIds(DEFAULT_ARRANGEMENT, group);
}

// ── Analytics (L-46, L-54, L-55, tech-plan section 7) ───────────────────────
//
// `layout_snapshot` and `layout_editor_session`'s change summary are built
// here rather than assembled ad hoc at the firing site, for the same reason
// the rest of this file exists: the shape is the model's, not a door's, and a
// pure function is what a test can drive on real snapshots.

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function layoutSettingPropertyName(region: string, key: string): string {
  return `layout_${snakeCase(region)}_${snakeCase(key)}`;
}

/**
 * Every `region.key` pair `LayoutValues` declares, walked off the shipped
 * Default rather than hand-listed: a leaf added to any region's value bag
 * widens `LayoutValues`, which is what `SHIPPED_DEFAULT_VALUES` (aka
 * `PRESET_VALUES.default`) is typed against, so this list - and the
 * `layout_<region>_<key>` property built from it - cannot drift from the
 * registry it describes without failing that assignment first.
 */
function layoutSettingEntries(): ReadonlyArray<{
  readonly region: RegionId;
  readonly key: string;
}> {
  return layoutRegionIds().flatMap((region) =>
    Object.keys(PRESET_VALUES.default[region]).map((key) => ({ region, key })),
  );
}

/**
 * A region's value bag has no compile-time index signature - `LayoutValues`
 * names each region's shape as its own interface, not `Record<RegionId,
 * ...>` - so reading a runtime-computed key off it generically cannot be a
 * cast: the union of every region's interface (`ContextUsageValues |
 * ModelValues | ...`) does not "sufficiently overlap" with `Record<string,
 * unknown>` for TypeScript's narrowing-cast check. `Reflect.get` reads it
 * without one.
 */
function regionSettingValue(regionValues: object, key: string): unknown {
  return Reflect.get(regionValues, key);
}

/**
 * Every `layout_<region>_<key>` property name `layout_snapshot` declares, in
 * the order {@link layoutSettingEntries} walks them. `lib/analytics.ts`
 * allowlists exactly this list, so the declared property set and the
 * registry it is built from cannot name a different set of settings.
 */
export const LAYOUT_SETTING_PROPERTY_KEYS: ReadonlyArray<string> =
  layoutSettingEntries().map(({ region, key }) =>
    layoutSettingPropertyName(region, key),
  );

/**
 * One setting's reported value (L-54, L-55): `"default"` at the shipped
 * Default, the literal value otherwise, `"true"`/`"false"` for a boolean leaf
 * and `"changed"` for the one list leaf (`pinnedFields`) - a scalar either
 * way, and never the list itself.
 */
function settingPropertyValue(
  key: string,
  value: unknown,
  defaultValue: unknown,
): string {
  if (sameRegionValue(key, value, defaultValue)) return "default";
  if (key === "pinnedFields") return "changed";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * `layout_snapshot`'s whole payload (L-46, L-54, L-55, tech-plan section 7):
 * the ~40 per-setting properties, ALWAYS present so `STRICT_EVENTS` never
 * drops the event for a missing declared key, plus the base preset, how many
 * settings differ from it, three arrangement enums and five reorder
 * booleans. `shownProfiles`, `providerLimits`, `hiddenProviders` and
 * `limitKeys` never reach it because {@link layoutSnapshotProperties} is
 * built only from `LayoutValues` plus the five closed arrangement facts the
 * plan names - the BUILDER is what keeps them out, not this type (L-54,
 * C-41, G3-07).
 */
export interface LayoutSnapshotProperties {
  // The ~40 `layout_<region>_<key>` properties are always strings
  // (`settingPropertyValue`'s return type); this index signature has to
  // cover the explicit properties below it too, so it is their union rather
  // than `string` alone.
  //
  // It also means the property SET is a RUNTIME guarantee, not a type-level
  // one (G3-07): the names are built by walking the registry, TypeScript
  // cannot read literal keys out of that walk, and an index signature wide
  // enough for them is wide enough for any other key. What holds the payload
  // to exactly this set is `STRICT_EVENTS`'s key-count check in
  // `sanitizeAnalyticsProperties` plus the structural test in
  // `layout-analytics.test.ts`, which is also the only thing that would catch
  // a new arrangement field joining the payload. Do not read this type as the
  // guard.
  readonly [key: string]: string | number | boolean;
  readonly base_preset: LayoutPresetId;
  readonly changed_from_default_count: number;
  readonly layout_usage_host: BarHost;
  readonly layout_usage_side: EdgeSide;
  readonly layout_minimap_side: EdgeSide;
  readonly layout_resource_host: BarHost;
  readonly layout_resource_side: EdgeSide;
  readonly layout_tab_strip_placement: TabStripPlacement;
  readonly layout_sidebar_side: EdgeSide;
  readonly layout_side_strip_view: SideStripView;
  readonly layout_dock_reordered: boolean;
  readonly layout_toolbar_left_reordered: boolean;
  readonly layout_toolbar_right_reordered: boolean;
  readonly layout_rail_reordered: boolean;
  readonly layout_usage_providers_reordered: boolean;
}

/** `layout_snapshot`'s payload, built from a whole snapshot. */
export function layoutSnapshotProperties(
  snapshot: LayoutSnapshot,
): LayoutSnapshotProperties {
  const values = effectiveLayoutValues(snapshot.basePreset, snapshot.overrides);
  const defaults = PRESET_VALUES.default;
  let changedFromDefaultCount = 0;
  const settingEntries = layoutSettingEntries().map(({ region, key }) => {
    const propertyValue = settingPropertyValue(
      key,
      regionSettingValue(values[region], key),
      regionSettingValue(defaults[region], key),
    );
    if (propertyValue !== "default") changedFromDefaultCount += 1;
    return [layoutSettingPropertyName(region, key), propertyValue] as const;
  });
  const reordered = new Set(reorderedGroups(snapshot.arrangement));
  return {
    // Built from the same walk `LAYOUT_SETTING_PROPERTY_KEYS` is, so this is
    // exactly that key set with a value per key - the structural test in
    // `layout-analytics.test.ts` is what proves it rather than a second cast.
    ...(Object.fromEntries(settingEntries) as Record<string, string>),
    base_preset: snapshot.basePreset,
    changed_from_default_count: changedFromDefaultCount,
    layout_usage_host: snapshot.arrangement.usageHost,
    layout_usage_side: snapshot.arrangement.usageSide,
    layout_minimap_side: snapshot.arrangement.minimapSide,
    layout_resource_host: snapshot.arrangement.resourceHost,
    layout_resource_side: snapshot.arrangement.resourceSide,
    layout_tab_strip_placement: snapshot.arrangement.tabStripPlacement,
    layout_sidebar_side: snapshot.arrangement.sidebarSide,
    layout_side_strip_view: snapshot.arrangement.sideStripView,
    layout_dock_reordered: reordered.has("dock"),
    layout_toolbar_left_reordered: reordered.has("toolbarLeft"),
    layout_toolbar_right_reordered: reordered.has("toolbarRight"),
    layout_rail_reordered: reordered.has("rail"),
    layout_usage_providers_reordered: reordered.has("usageProviders"),
  };
}

export type LayoutDurationBucket =
  | "under_10s"
  | "10s_to_1m"
  | "1m_to_5m"
  | "over_5m";

/**
 * Buckets a millisecond duration for `layout_editor_session`'s two duration
 * properties. Its own scale rather than the app-wide `duration_bucket`
 * allowlist (`under_10s | 10_to_30s | over_30s`): an editor session routinely
 * outruns that ceiling (C-42).
 */
export function layoutDurationBucket(durationMs: number): LayoutDurationBucket {
  if (durationMs < 10_000) return "under_10s";
  if (durationMs < 60_000) return "10s_to_1m";
  if (durationMs < 300_000) return "1m_to_5m";
  return "over_5m";
}

/**
 * Every region whose EFFECTIVE value bag differs between two snapshots -
 * what a session actually touched, independent of which base preset each
 * snapshot carries (a preset switch mid-session still counts as touching
 * whatever it visibly changed).
 */
function touchedRegionIds(
  from: LayoutSnapshot,
  to: LayoutSnapshot,
): ReadonlyArray<RegionId> {
  const fromValues = effectiveLayoutValues(from.basePreset, from.overrides);
  const toValues = effectiveLayoutValues(to.basePreset, to.overrides);
  return layoutRegionIds().filter(
    (region) =>
      JSON.stringify(fromValues[region]) !== JSON.stringify(toValues[region]),
  );
}

export interface LayoutEditorSessionChangeSummary {
  readonly changedCount: number;
  readonly regionsTouchedCount: number;
}

/**
 * `layout_editor_session`'s value-change facts (L-46, L-54, L-57):
 * `changedCount` is the number of Styles lines on the change list at exit,
 * and `regionsTouchedCount` is the distinct regions that
 * moved between the session's entry snapshot and its exit snapshot.
 */
export function layoutEditorSessionChangeSummary(
  entrySnapshot: LayoutSnapshot,
  exitSnapshot: LayoutSnapshot,
): LayoutEditorSessionChangeSummary {
  return {
    changedCount: layoutChanges(exitSnapshot).styles.length,
    regionsTouchedCount: touchedRegionIds(entrySnapshot, exitSnapshot).length,
  };
}

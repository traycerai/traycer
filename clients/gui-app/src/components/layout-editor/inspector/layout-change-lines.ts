import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import {
  BAR_HOST_OPTIONS,
  EDGE_SIDE_OPTIONS,
  SIDE_STRIP_VIEW_OPTIONS,
  TAB_STRIP_PLACEMENT_OPTIONS,
  READING_WIDTH_OPTIONS,
  TAB_OVERFLOW_OPTIONS,
  type SegmentOption,
} from "@/components/layout-editor/regions/region-grammar";
import {
  regionFacts,
  type AnyGrammarRow,
} from "@/components/layout-editor/regions/region-facts";
import { orderGroupListLabel } from "@/components/layout-editor/regions/surface-groups";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import type { LayoutArrangement } from "@/lib/layout/layout-arrangement";
import {
  providerLimitKeys,
  sessionLayoutChanges,
  type ArrangementChange,
  type ArrangementField,
  type LayoutChange,
  type LayoutValueLeaf,
  type SessionRevert,
  type StyleChange,
} from "@/lib/layout/layout-diff";
import {
  effectiveLayoutValues,
  PRESET_LABELS,
  PRESET_VALUES,
} from "@/lib/layout/layout-presets";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import type { LayoutValues } from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { providerDisplayName } from "@/lib/provider-ordering";

/**
 * One line of View changes: ONE setting, in the words the form uses for it,
 * and the change(s) its revert puts back. A region's display is one setting
 * even though it is stored as `shown` and `size`, so its line carries both.
 */
export interface LayoutChangeLine {
  readonly key: string;
  readonly label: string;
  readonly current: string;
  /** "Compact: Shown", "Default: Top", or "Default order". */
  readonly baseline: string;
  readonly changes: ReadonlyArray<LayoutChange>;
}

/** The keys a region's one display control writes. */
const DISPLAY_KEYS: ReadonlyArray<string> = ["shown", "size"];

/**
 * The value lines, one per setting. Each value is read on its own - the
 * current one off the current values, the baseline off the last-applied
 * preset's - so no line borrows another setting's state.
 */
export function styleChangeLines(
  changes: ReadonlyArray<StyleChange>,
  snapshot: LayoutSnapshot,
  values: LayoutValues,
): ReadonlyArray<LayoutChangeLine> {
  const preset = PRESET_LABELS[snapshot.basePreset];
  return styleLines(changes, values, PRESET_VALUES[snapshot.basePreset]).map(
    (line) => ({ ...line, baseline: `${preset}: ${line.baseline}` }),
  );
}

/**
 * One line per setting, both values as bare words. A region's display is
 * stored as `shown` and `size` but set by one control, so the two collapse
 * into one line that carries both changes.
 */
function styleLines(
  changes: ReadonlyArray<StyleChange>,
  values: LayoutValues,
  baselineValues: LayoutValues,
): ReadonlyArray<LayoutChangeLine> {
  const lines: LayoutChangeLine[] = [];
  const seenDisplay = new Set<RegionId>();
  for (const change of changes) {
    const region = change.region;
    const name = regionFacts(region).name;
    if (DISPLAY_KEYS.includes(change.key)) {
      if (seenDisplay.has(region)) continue;
      seenDisplay.add(region);
      lines.push({
        key: `${region}.display`,
        label: name,
        current: displayWord(region, values[region]),
        baseline: displayWord(region, baselineValues[region]),
        changes: changes.filter(
          (entry) =>
            entry.region === region && DISPLAY_KEYS.includes(entry.key),
        ),
      });
      continue;
    }
    const label =
      offGrammarLabel(region, change.key) ??
      (change.key === "style"
        ? `${name} style`
        : `${name}: ${detailRowLabel(region, change.key)}`);
    lines.push({
      key: `${region}.${change.key}`,
      label,
      current: leafWord(change, change.current),
      baseline: leafWord(change, change.baseline),
      changes: [change],
    });
  }
  return lines;
}

/**
 * One line of the session list: a setting, what it was when the editor opened
 * and what it is now. `before` is `null` where the two do not read as a pair
 * of values - a reordered list is "Reordered", not one order against another.
 */
export interface SessionChangeLine {
  readonly key: string;
  readonly label: string;
  readonly before: string | null;
  readonly after: string;
  /** What the line's revert puts back to where the session opened. */
  readonly revert: SessionRevert;
}

export interface SessionChangeLines {
  /** The preset line, when there is one, and then the value lines. */
  readonly styles: ReadonlyArray<SessionChangeLine>;
  readonly arrangement: ReadonlyArray<SessionChangeLine>;
}

/** What the session has changed, in the words the form uses. */
export function sessionChangeLines(
  entry: LayoutSnapshot,
  current: LayoutSnapshot,
): SessionChangeLines {
  const changes = sessionLayoutChanges(entry, current);
  const preset: ReadonlyArray<SessionChangeLine> =
    changes.preset === null
      ? []
      : [
          {
            key: "preset",
            label: "Preset",
            before: PRESET_LABELS[changes.preset.baseline],
            after: PRESET_LABELS[changes.preset.current],
            revert: { kind: "preset" },
          },
        ];
  const values = styleLines(
    changes.styles,
    effectiveLayoutValues(current.basePreset, current.overrides),
    effectiveLayoutValues(entry.basePreset, entry.overrides),
  ).map((line): SessionChangeLine => ({
    key: line.key,
    label: line.label,
    before: line.baseline,
    after: line.current,
    revert: { kind: "changes", changes: line.changes },
  }));
  return {
    styles: [...preset, ...values],
    arrangement: changes.arrangement.map((change): SessionChangeLine => ({
      ...sessionArrangementWords(
        change,
        entry.arrangement,
        current.arrangement,
      ),
      revert: { kind: "changes", changes: [change] },
    })),
  };
}

function sessionArrangementWords(
  change: ArrangementChange,
  before: LayoutArrangement,
  after: LayoutArrangement,
): Omit<SessionChangeLine, "revert"> {
  switch (change.kind) {
    case "field":
      return {
        key: change.field,
        label: FIELD_LABELS[change.field],
        before: fieldWord(change.field, change.baseline),
        after: fieldWord(change.field, change.current),
      };
    case "order":
      return {
        key: `order.${change.group}`,
        label: `${orderGroupListLabel(change.group)} order`,
        before: null,
        after: "Reordered",
      };
    case "provider":
      return {
        key: `provider.${change.providerId}`,
        label: providerDisplayName(change.providerId),
        before: providerWord(before, change.providerId),
        after: providerWord(after, change.providerId),
      };
  }
}

/** "Shown, Automatic limits", "Hidden, 2 limits": the two things a provider line covers. */
function providerWord(
  arrangement: LayoutArrangement,
  providerId: RateLimitProviderId,
): string {
  const shown = arrangement.hiddenProviders.includes(providerId)
    ? "Hidden"
    : "Shown";
  return `${shown}, ${limitsWord(providerLimitKeys(arrangement, providerId).length)}`;
}

function limitsWord(picked: number): string {
  if (picked === 0) return "Automatic limits";
  return picked === 1 ? "1 limit" : `${picked} limits`;
}

export function arrangementChangeLine(
  change: ArrangementChange,
): LayoutChangeLine {
  switch (change.kind) {
    case "field":
      return {
        key: change.field,
        label: FIELD_LABELS[change.field],
        current: fieldWord(change.field, change.current),
        baseline: `Default: ${fieldWord(change.field, change.baseline)}`,
        changes: [change],
      };
    case "order":
      return {
        key: `order.${change.group}`,
        label: `${orderGroupListLabel(change.group)} order`,
        current: "Reordered",
        baseline: "Default order",
        changes: [change],
      };
    case "provider":
      return {
        key: `provider.${change.providerId}`,
        label: providerDisplayName(change.providerId),
        current: "Changed",
        baseline: "Default: Shown, Automatic limits",
        changes: [change],
      };
  }
}

/** A region's display alone - Shown, Auto, Hidden, or its size - from one bag. */
function displayWord(region: RegionId, bag: LayoutValues[RegionId]): string {
  const shown: unknown = Reflect.get(bag, "shown");
  if (shown === "hidden") return "Hidden";
  if (shown === "auto") return "Auto";
  const size: unknown = Reflect.get(bag, "size");
  if (region === "toolActivity" || region === "thinking")
    return size === "full" ? "Open" : "Closed";
  if (size === "chip") return region === "access" ? "Icon only" : "Chip";
  if (size === "full")
    return region === "access" ? "Icon and label" : "Full row";
  return "Shown";
}

/**
 * A value stored in a region's bag but set by a row outside that region's
 * grammar, named the way that row is. The readings on agent rows sit beside
 * the Resource monitor's values and are a Sidebar switch.
 */
function offGrammarLabel(region: RegionId, key: string): string | null {
  if (region === "resourceMonitor" && key === "agentRows")
    return LAYOUT.definitions.resourceReadings.label;
  return null;
}

/** A detail or style row's label, found by the key its control writes. */
function detailRowLabel(region: RegionId, key: string): string {
  const rows: ReadonlyArray<AnyGrammarRow> = LAYOUT_REGIONS[region].rows;
  for (const row of rows) {
    if (row.kind === "style" && row.key === key) return row.label;
    if (row.kind !== "fine-tune") continue;
    for (const detail of row.rows) {
      const control = detail.control;
      if (control.kind === "checks") {
        const option = control.options.find((entry) => entry.key === key);
        if (option !== undefined) return option.label;
      } else if (control.key === key) {
        return detail.label;
      }
    }
  }
  return key;
}

/** A detail row's value: On or Off, a segment's option, or a checked list. */
function leafWord(change: StyleChange, leaf: LayoutValueLeaf): string {
  if (typeof leaf === "boolean") return leaf ? "On" : "Off";
  const style = styleExampleLabel(change.region, change.key, leaf);
  if (style !== null) return style;
  const options = detailRowOptions(change.region, change.key);
  if (typeof leaf === "string") return optionLabel(options, leaf);
  if (leaf.length === 0) return "None";
  return leaf.map((value) => optionLabel(options, value)).join(", ");
}

/** A style value's name, as its example in the style row that writes `key` calls it. */
function styleExampleLabel(
  region: RegionId,
  key: string,
  value: LayoutValueLeaf,
): string | null {
  const rows: ReadonlyArray<AnyGrammarRow> = LAYOUT_REGIONS[region].rows;
  for (const row of rows) {
    if (row.kind !== "style" || row.key !== key) continue;
    const example = row.examples.find(
      (entry) => Reflect.get(entry.patch, key) === value,
    );
    return example?.label ?? null;
  }
  return null;
}

function detailRowOptions(
  region: StyleChange["region"],
  key: string,
): ReadonlyArray<SegmentOption> {
  const rows: ReadonlyArray<AnyGrammarRow> = LAYOUT_REGIONS[region].rows;
  for (const row of rows) {
    if (row.kind !== "fine-tune") continue;
    for (const detail of row.rows) {
      const control = detail.control;
      if (control.kind !== "checks" && control.kind !== "switch") {
        if (control.key === key) return control.options;
      }
    }
  }
  return [];
}

function optionLabel(
  options: ReadonlyArray<SegmentOption>,
  value: string,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

const FIELD_LABELS: Readonly<Record<ArrangementField, string>> = {
  tabStripPlacement: "Tab placement",
  sideStripView: "Side tab view",
  taskTabLayout: "Tab overflow",
  readingWidth: "Reading width",
  sidebarSide: "Sidebar side",
  minimapSide: "Minimap side",
  usageHost: "Usage limits location",
  usageSide: "Usage limits alignment",
  resourceHost: "Resource monitor location",
  resourceSide: "Resource monitor alignment",
  mobileFooter: "Status bar on small screens",
};

const FIELD_OPTIONS: Readonly<
  Record<ArrangementField, ReadonlyArray<SegmentOption>>
> = {
  tabStripPlacement: TAB_STRIP_PLACEMENT_OPTIONS,
  sideStripView: SIDE_STRIP_VIEW_OPTIONS,
  taskTabLayout: TAB_OVERFLOW_OPTIONS,
  readingWidth: READING_WIDTH_OPTIONS,
  sidebarSide: EDGE_SIDE_OPTIONS,
  minimapSide: EDGE_SIDE_OPTIONS,
  usageHost: BAR_HOST_OPTIONS,
  usageSide: EDGE_SIDE_OPTIONS,
  resourceHost: BAR_HOST_OPTIONS,
  resourceSide: EDGE_SIDE_OPTIONS,
  mobileFooter: [],
};

function fieldWord(
  field: ArrangementField,
  value: string | boolean | number,
): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  return optionLabel(FIELD_OPTIONS[field], String(value));
}

import {
  fineTuneRowLiveWhileHidden,
  readControlValue,
  writeControlValue,
  type RegionControlValue,
} from "@/components/layout-editor/inspector/region-control-io";
import type { FineTuneRowFacts } from "@/components/layout-editor/inspector/rows/fine-tune-row";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import {
  compactIgnoredRows,
  READING_SPOT_LABELS,
  READING_SPOTS,
  readingSpot,
  withReadingSpot,
} from "@/components/layout-editor/regions/reading-placement";
import {
  readingPlacement,
  readingStyleApplies,
  resolvedReadingDensity,
} from "@/lib/layout/reading-density";
import {
  LAYOUT_REGION_LIST,
  regionFacts,
  regionRowAvailable,
  type AnyGrammarRow,
} from "@/components/layout-editor/regions/region-facts";
import {
  ACCESS_DISPLAY_OPTIONS,
  AUTO_SHOWN_HIDDEN_OPTIONS,
  DISCLOSURE_HIDDEN_OPTIONS,
  DISCLOSURE_OPTIONS,
  DOCK_DISPLAY_OPTIONS,
  EDGE_SIDE_OPTIONS,
  READING_WIDTH_OPTIONS,
  SHOWN_HIDDEN_OPTIONS,
  SIDE_STRIP_VIEW_OPTIONS,
  TAB_OVERFLOW_OPTIONS,
  TAB_STRIP_PLACEMENT_OPTIONS,
  type SegmentOption,
} from "@/components/layout-editor/regions/region-grammar";
import {
  orderGroupListLabel,
  SURFACE_ORDER_GROUPS,
} from "@/components/layout-editor/regions/surface-groups";
import {
  regionShownOnValue,
  setRegionShown,
  toggleHiddenProvider,
} from "@/components/layout-editor/layout-gestures";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import { CONTEXT_USAGE_ROW_KEYS } from "@/lib/context-usage-rows";
import {
  writeArrangement,
  writeArrangementField,
} from "@/lib/layout/arrangement-gestures";
import {
  asBarRegionId,
  barPlacement,
  insertRailDivider,
  movedWithin,
  moveRailEntry,
  railPanelToStackBelow,
  removeRailDivider,
  stackRailPanelWithBelow,
  toggleStatusBarSurface,
  unstackRail,
  unstackRailPanel,
  WIDE_READING_WIDTH_MAX_PX,
  type EdgeSide,
  type LayoutArrangement,
  type OrderGroupId,
} from "@/lib/layout/layout-arrangement";
import { resetLayout } from "@/lib/layout/layout-diff";
import {
  effectiveLayoutValues,
  LAYOUT_PRESET_IDS,
  PRESET_LABELS,
  PRESET_VALUES,
  type LayoutPresetId,
} from "@/lib/layout/layout-presets";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import {
  regionValuesHidden,
  type LayoutValues,
  type RegionValueKey,
} from "@/lib/layout/layout-values";
import {
  isAutoRailRegionId,
  railDividerId,
  railDividerInsertIndex,
  railStackMembers,
} from "@/lib/layout/rail";
import type { RegionId } from "@/lib/layout/region-id";
import { providerDisplayName } from "@/lib/provider-ordering";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import {
  isVoiceInputRowAvailable,
  type SettingsAvailabilityContext,
} from "@/lib/settings/settings-availability";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The plan: every layout setting VALUE the product can write, as data, in the
 * order the page lists them, each as a write through the SAME function the
 * product's own control calls.
 *
 * A plan entry is one operation the old Chrome driver performed with a click:
 * an unchecked option of a radio group, a switch, a checkbox, an ordered list's
 * first movable row moved down one and its second moved up one - plus the
 * controls the driver's selectors could not reach (the rail's stack and
 * divider buttons, a provider's Hidden, the two presets, Reset). It is built
 * from the same registries the page draws from (`LAYOUT_REGIONS`, the settings
 * definitions, the arrangement), never a list of names typed out beside them.
 */

export type SweepSource =
  | "region-display"
  | "region-position"
  | "region-style"
  | "region-fine-tune"
  | "order-list"
  | "rail-structure"
  | "provider-display"
  | "surface-row"
  | "arrangement-field"
  | "preset"
  | "reset";

export const SWEEP_SOURCES: ReadonlyArray<SweepSource> = [
  "region-display",
  "region-position",
  "region-style",
  "region-fine-tune",
  "order-list",
  "rail-structure",
  "provider-display",
  "surface-row",
  "arrangement-field",
  "preset",
  "reset",
];

/** One write, named, through the product's own writer. */
export interface SweepStep {
  readonly label: string;
  readonly run: () => void;
}

export interface SweepEntry {
  /** Unique and stable: `<source>:<what>`. */
  readonly id: string;
  readonly source: SweepSource;
  /**
   * Writes a person makes first to reach this control at all: the region shown
   * so its rows are live, the switch a row depends on, the strip at an edge so
   * its view row is live, Choose so a provider's windows are listed. Applied
   * after the reset and before the baseline is taken, so the comparison is
   * between the state the control is in and the state after IT is operated.
   */
  readonly given: ReadonlyArray<SweepStep>;
  readonly write: SweepStep;
  /**
   * The product writer this entry's write RE-STATES because the product keeps
   * it module-private (`writeSizeShown`, a list's `onMove`, `writeSelection`),
   * or `null` where the write IS the product's own function. The parity test
   * holds every non-null one to what the real control writes.
   */
  readonly mirrors: string | null;
  /**
   * The registry rows this entry exercises, for the completeness guard:
   * `display:<region>`, `position-host:<region>`, `position-side:<region>`,
   * `style:<region>:<key>`, `fine-tune:<region>:<row id>`, `order:<group>`,
   * `rail:<what>`, `provider-display`,
   * `arrangement:<field>`, `definition:<key>`.
   */
  readonly covers: ReadonlyArray<string>;
  /**
   * The page controls this entry stands for, named as the census names the
   * controls it finds on the real page (`radio|<row>|<group>|<option>`,
   * `switch|<row>|<name>`, `check|<row>|<label>`, `button|<row>|<name>`,
   * `order|<list>|<row>|<down/up>`). Empty where no page control writes it.
   */
  readonly controls: ReadonlyArray<string>;
}

export interface SweepPlanInput {
  /** The stored layout every entry starts from. */
  readonly shipped: LayoutSnapshot;
  readonly availability: SettingsAvailabilityContext;
  /** The providers the watched host has signed in, in the strip's order. */
  readonly configuredProviders: ReadonlyArray<RateLimitProviderId>;
}

// ── Census key spellings ────────────────────────────────────────────────────

/** A row-less control: a surface-level row sits in no sortable row. */
const NO_ROW = "-";

export function radioControl(
  rowId: string,
  group: string,
  option: string,
): string {
  return `radio|${rowId}|${group}|${option}`;
}

export function switchControl(rowId: string, name: string): string {
  return `switch|${rowId}|${name}`;
}

export function checkControl(rowId: string, label: string): string {
  return `check|${rowId}|${label}`;
}

export function buttonControl(rowId: string, name: string): string {
  return `button|${rowId}|${name}`;
}

export function orderControl(
  list: string,
  rowId: string,
  direction: "down" | "up",
): string {
  return `order|${list}|${rowId}|${direction}`;
}

// ── The writers the product keeps private, said once ────────────────────────
//
// Each is the same two calls the product's own handler makes - the editor's
// `recordGesture` around one store setter - because the handlers themselves
// (`writeSizeShown`, `writeAutoRailVisibility`, `writeSelection`,
// `applyPreset`, the list's `movedById`) are module-private. The parity test
// holds each of them to the real control's write.

function recordedPatch(
  region: RegionId,
  patch: Partial<LayoutValues[RegionId]>,
): void {
  useLayoutEditorStore.getState().recordGesture(() => {
    useLayoutStore.getState().setRegionValues(region, patch);
  });
}

function writeSizeShown(region: RegionId, size: string, hides: boolean): void {
  const patch: Partial<LayoutValues[RegionId]> = {};
  Reflect.set(patch, "size", size);
  if (hides) Reflect.set(patch, "shown", regionShownOnValue(region));
  recordedPatch(region, patch);
}

function writeAutoRailVisibility(region: RegionId, next: string): void {
  const patch: Partial<LayoutValues[RegionId]> = {};
  Reflect.set(patch, "shown", next);
  recordedPatch(region, patch);
}

function applyPresetWrite(presetId: LayoutPresetId): void {
  useLayoutEditorStore.getState().recordGesture(() => {
    useLayoutStore.getState().applyPreset(presetId);
  });
}

function resetLayoutWrite(): void {
  useLayoutEditorStore.getState().recordGesture(() => {
    useLayoutStore.getState().replaceAll(resetLayout(getLayoutSnapshot()));
  });
}

function movedById<Id extends string>(
  list: ReadonlyArray<Id>,
  id: Id,
  toIndex: number,
): ReadonlyArray<Id> {
  const fromIndex = list.indexOf(id);
  return fromIndex < 0 ? list : movedWithin(list, fromIndex, toIndex);
}

function reorderVisibleProviders(
  order: ReadonlyArray<RateLimitProviderId>,
  visible: ReadonlyArray<RateLimitProviderId>,
  id: RateLimitProviderId,
  toIndex: number,
): ReadonlyArray<RateLimitProviderId> {
  const moved = movedById(visible, id, toIndex);
  let index = 0;
  return order.map((providerId) =>
    visible.includes(providerId) ? moved[index++] : providerId,
  );
}

/** The list's own step: one row over, past any row that cannot be a slot. */
function stepPastFixed(
  movable: ReadonlyArray<boolean>,
  from: number,
  delta: number,
): number {
  let to = from + delta;
  while (to >= 0 && to < movable.length && !movable[to]) to += delta;
  return to >= 0 && to < movable.length ? to : from;
}

// ── Region display controls ─────────────────────────────────────────────────

interface DisplayControl {
  readonly ariaLabel: string;
  readonly options: ReadonlyArray<SegmentOption>;
  readonly current: string;
  readonly write: (next: string) => void;
  /** The private writer a pick re-states, or `null` for an exported one. */
  readonly mirrors: (next: string) => string | null;
}

/** The words a sized region's one control uses for its two sizes. */
function sizeOptions(
  region: RegionId,
  hides: boolean,
): ReadonlyArray<SegmentOption> {
  if (region === "thinking" || region === "toolActivity") {
    return hides ? DISCLOSURE_HIDDEN_OPTIONS : DISCLOSURE_OPTIONS;
  }
  return hides ? DOCK_DISPLAY_OPTIONS : ACCESS_DISPLAY_OPTIONS;
}

/**
 * A region's ONE display control, as `RegionDisplayControl` draws it: which
 * options it has, which is checked, and what picking another writes.
 */
function displayControl(
  region: RegionId,
  values: LayoutValues,
  availability: SettingsAvailabilityContext,
): DisplayControl | null {
  const regionValues = values[region];
  const hidden = regionValuesHidden(regionValues);
  if (region === "mic") {
    if (!isVoiceInputRowAvailable(availability)) return null;
    return {
      ariaLabel: "Microphone display",
      options: SHOWN_HIDDEN_OPTIONS,
      current: values.mic.shown !== "hidden" ? "shown" : "hidden",
      write: (next) => {
        setRegionShown("mic", next === "shown");
      },
      mirrors: () => null,
    };
  }
  const ariaLabel = `${regionFacts(region).name} display`;
  if (isAutoRailRegionId(region)) {
    return {
      ariaLabel,
      options: AUTO_SHOWN_HIDDEN_OPTIONS,
      current: String(readControlValue(regionValues, "shown")),
      write: (next) => {
        writeAutoRailVisibility(region, next);
      },
      mirrors: () => "writeAutoRailVisibility",
    };
  }
  const hides = "shown" in PRESET_VALUES.default[region];
  if ("size" in PRESET_VALUES.default[region]) {
    return {
      ariaLabel,
      options: sizeOptions(region, hides),
      current: hidden
        ? "hidden"
        : String(readControlValue(regionValues, "size")),
      write: (next) => {
        if (next === "hidden") {
          setRegionShown(region, false);
          return;
        }
        writeSizeShown(region, next, hides);
      },
      mirrors: (next) => (next === "hidden" ? null : "writeSizeShown"),
    };
  }
  if (!hides) return null;
  return {
    ariaLabel,
    options: SHOWN_HIDDEN_OPTIONS,
    current: hidden ? "hidden" : "shown",
    write: (next) => {
      setRegionShown(region, next === "shown");
    },
    mirrors: () => null,
  };
}

// ── Steps ───────────────────────────────────────────────────────────────────

function controlStep(
  region: RegionId,
  key: RegionValueKey,
  value: RegionControlValue,
  label: string,
): SweepStep {
  return {
    label,
    run: () => {
      writeControlValue(region, key, value);
    },
  };
}

function showRegionStep(region: RegionId): SweepStep {
  return {
    label: `${regionFacts(region).name} display: Shown`,
    run: () => {
      setRegionShown(region, true);
    },
  };
}

function arrangementFieldStep<K extends keyof LayoutArrangement>(
  label: string,
  key: K,
  value: LayoutArrangement[K],
): SweepStep {
  return {
    label,
    run: () => {
      writeArrangementField(key, value);
    },
  };
}

function arrangementStep(
  label: string,
  next: (current: LayoutArrangement) => LayoutArrangement,
): SweepStep {
  return {
    label,
    run: () => {
      writeArrangement(next(useLayoutStore.getState().arrangement));
    },
  };
}

// ── Building ────────────────────────────────────────────────────────────────

const NO_GIVEN: ReadonlyArray<SweepStep> = [];

/** The strip at an edge, which a side view and a foot-hosted reading need. */
const TAB_PLACEMENT_LEFT: SweepStep = arrangementFieldStep(
  "Tab placement: Left",
  "tabStripPlacement",
  "left",
);

type StyleGrammarRow = Extract<AnyGrammarRow, { readonly kind: "style" }>;

/** A reading's Show switch, in its section's header. */
function showSwitchEntries(
  region: RegionId,
  values: LayoutValues,
): ReadonlyArray<SweepEntry> {
  const name = regionFacts(region).name;
  const shown = !regionValuesHidden(values[region]);
  return [
    {
      id: `region-display:${region}:${shown ? "hidden" : "shown"}`,
      source: "region-display",
      mirrors: null,
      given: NO_GIVEN,
      write: {
        label: `Show ${name}: ${shown ? "off" : "on"}`,
        run: () => {
          setRegionShown(region, !shown);
        },
      },
      covers: [`display:${region}`],
      controls: [switchControl(region, `Show ${name}`)],
    },
  ];
}

function displayEntries(
  region: RegionId,
  values: LayoutValues,
  availability: SettingsAvailabilityContext,
): ReadonlyArray<SweepEntry> {
  const display = displayControl(region, values, availability);
  if (display === null) return [];
  return display.options
    .filter((option) => option.value !== display.current)
    .map((option) => ({
      id: `region-display:${region}:${option.value}`,
      source: "region-display",
      mirrors: display.mirrors(option.value),
      given: NO_GIVEN,
      write: {
        label: `${display.ariaLabel}: ${option.label}`,
        run: () => {
          display.write(option.value);
        },
      },
      covers: [`display:${region}`],
      controls: [radioControl(region, display.ariaLabel, option.label)],
    }));
}

function positionHostEntries(
  region: RegionId,
  arrangement: LayoutArrangement,
): ReadonlyArray<SweepEntry> {
  const bar = asBarRegionId(region);
  if (bar === null) return [];
  const name = regionFacts(region).name;
  const current = readingSpot(barPlacement(arrangement, bar));
  const hostField = bar === "usageLimits" ? "usageHost" : "resourceHost";
  const sideField = bar === "usageLimits" ? "usageSide" : "resourceSide";
  return READING_SPOTS.filter((spot) => spot !== current).map((spot) => ({
    id: `region-position:${region}:spot:${spot}`,
    source: "region-position",
    mirrors: null,
    given: NO_GIVEN,
    write: arrangementStep(
      `${name} location: ${READING_SPOT_LABELS[spot]}`,
      (now) => withReadingSpot(now, bar, spot),
    ),
    // The tab strip writes the host alone and a status bar spot the end too,
    // so the pair is covered by the three spots between them.
    covers: [
      `position-host:${region}`,
      `arrangement:${hostField}`,
      `arrangement:${sideField}`,
    ],
    controls: [
      radioControl(region, `${name} location`, READING_SPOT_LABELS[spot]),
    ],
  }));
}

/** The minimap's edge, the one Side row left. */
function positionSideEntries(
  region: RegionId,
  arrangement: LayoutArrangement,
): ReadonlyArray<SweepEntry> {
  if (region !== "minimap") {
    throw new Error(
      `${region} has a position-side row this plan does not know how to write`,
    );
  }
  const name = regionFacts(region).name;
  return EDGE_SIDE_OPTIONS.filter(
    (option) => option.value !== arrangement.minimapSide,
  ).map((option) => {
    const side: EdgeSide = option.value === "left" ? "left" : "right";
    return {
      id: `region-position:${region}:side:${option.value}`,
      source: "region-position",
      mirrors: null,
      given: NO_GIVEN,
      write: arrangementStep(`${name} side: ${option.label}`, (now) => ({
        ...now,
        minimapSide: side,
      })),
      covers: [`position-side:${region}`, "arrangement:minimapSide"],
      controls: [radioControl(region, `${name} side`, option.label)],
    };
  });
}

/**
 * Reading style is drawn by the status bar's Detailed form alone, so the page
 * hides its row anywhere else: a person moves the reading to the status bar
 * first, and picks Detailed if it was Compact.
 */
function styleGiven(
  region: RegionId,
  row: StyleGrammarRow,
  values: LayoutValues,
  arrangement: LayoutArrangement,
): ReadonlyArray<SweepStep> {
  if (
    region !== "usageLimits" ||
    row.key !== "readingStyle" ||
    readingStyleApplies(values.usageLimits.density, arrangement)
  ) {
    return NO_GIVEN;
  }
  const name = regionFacts(region).name;
  return [
    ...(readingPlacement(arrangement, region) === "status-bar"
      ? NO_GIVEN
      : [
          arrangementStep(`${name} location: Status bar left`, (now) =>
            withReadingSpot(now, region, "status-bar-left"),
          ),
        ]),
    ...(values.usageLimits.density === "compact"
      ? [
          controlStep(
            region,
            "density",
            "detailed",
            `${name} density: Detailed`,
          ),
        ]
      : NO_GIVEN),
  ];
}

function styleEntries(
  region: RegionId,
  row: StyleGrammarRow,
  values: LayoutValues,
  arrangement: LayoutArrangement,
): ReadonlyArray<SweepEntry> {
  const regionValues = values[region];
  const given = styleGiven(region, row, values, arrangement);
  return row.examples
    .filter(
      (example) =>
        !Object.entries(example.patch).every(
          ([key, value]) => Reflect.get(regionValues, key) === value,
        ),
    )
    .map((example) => ({
      id: `region-style:${region}:${row.key}:${example.id}`,
      source: "region-style",
      mirrors: "StyleExamples onChange",
      given,
      write: {
        label: `${row.label}: ${example.label}`,
        run: () => {
          recordedPatch(region, example.patch);
        },
      },
      covers: [`style:${region}:${row.key}`],
      controls: [radioControl(region, row.label, example.label)],
    }));
}

function grammarRowEntries(
  region: RegionId,
  row: AnyGrammarRow,
  values: LayoutValues,
  arrangement: LayoutArrangement,
): ReadonlyArray<SweepEntry> {
  switch (row.kind) {
    case "position-host":
      return positionHostEntries(region, arrangement);
    case "position-side":
      return positionSideEntries(region, arrangement);
    case "position-order":
    case "children":
      return [];
    case "style":
      return styleEntries(region, row, values, arrangement);
    case "fine-tune":
      return fineTuneEntries(region, row.rows, values, arrangement);
    default:
      throw new Error(`${region} has a grammar row this plan does not know`);
  }
}

function regionPlan(input: SweepPlanInput): ReadonlyArray<SweepEntry> {
  const { shipped, availability } = input;
  const values = effectiveLayoutValues(shipped.basePreset, shipped.overrides);
  const entries: SweepEntry[] = [];
  for (const facts of LAYOUT_REGION_LIST) {
    const region = facts.id;
    entries.push(
      ...(asBarRegionId(region) === null
        ? displayEntries(region, values, availability)
        : showSwitchEntries(region, values)),
    );
    const declared: ReadonlyArray<AnyGrammarRow> = LAYOUT_REGIONS[region].rows;
    for (const row of declared) {
      if (!regionRowAvailable(region, row, false)) continue;
      entries.push(
        ...grammarRowEntries(region, row, values, shipped.arrangement),
      );
    }
  }
  return entries;
}

/** What a person does first to make one detail row's controls operable. */
function fineTuneGiven(
  region: RegionId,
  row: FineTuneRowFacts,
  values: LayoutValues,
  arrangement: LayoutArrangement,
): ReadonlyArray<SweepStep> {
  const regionValues = values[region];
  const given: SweepStep[] = [];
  // A Compact reading ignores these rows, so the page hides them: a person
  // picks Detailed first.
  const bar = asBarRegionId(region);
  if (
    bar !== null &&
    compactIgnoredRows(bar).includes(row.id) &&
    resolvedReadingDensity(values[bar].density, arrangement, bar) === "compact"
  ) {
    given.push(
      controlStep(
        region,
        "density",
        "detailed",
        `${regionFacts(region).name} density: Detailed`,
      ),
    );
  }
  if (
    regionValuesHidden(regionValues) &&
    !fineTuneRowLiveWhileHidden(row, regionValues)
  ) {
    given.push(showRegionStep(region));
  }
  if (
    row.requires !== null &&
    readControlValue(regionValues, row.requires) !== true
  ) {
    given.push(
      controlStep(region, row.requires, true, `${region} ${row.requires}: on`),
    );
  }
  return given;
}

/** What one fine-tune row's entries are written from. */
interface FineTuneContext {
  readonly arrangement: LayoutArrangement;
  readonly region: RegionId;
  readonly row: FineTuneRowFacts;
  readonly regionValues: LayoutValues[RegionId];
  readonly given: ReadonlyArray<SweepStep>;
}

function fineTuneEntry(
  context: FineTuneContext,
  idPart: string,
  write: SweepStep,
  control: string,
): SweepEntry {
  return {
    id: `region-fine-tune:${context.region}:${context.row.id}${idPart}`,
    source: "region-fine-tune",
    mirrors: null,
    given: context.given,
    write,
    covers: [`fine-tune:${context.region}:${context.row.id}`],
    controls: [control],
  };
}

function switchRowEntries(
  context: FineTuneContext,
  key: RegionValueKey,
): ReadonlyArray<SweepEntry> {
  const { region, row, regionValues } = context;
  const current = readControlValue(regionValues, key) === true;
  return [
    fineTuneEntry(
      context,
      "",
      controlStep(
        region,
        key,
        !current,
        `${row.label}: ${current ? "off" : "on"}`,
      ),
      switchControl(region, row.label),
    ),
  ];
}

/**
 * Compact only differs from Auto where Auto is Detailed, so a Compact pick is
 * made from the status bar; Detailed differs from Auto wherever it starts, in
 * a tab strip.
 */
function densityGiven(
  context: FineTuneContext,
  picked: string,
): ReadonlyArray<SweepStep> {
  const { region, row, arrangement } = context;
  const bar = asBarRegionId(region);
  if (bar === null || row.id !== "density" || picked !== "compact") {
    return context.given;
  }
  if (readingPlacement(arrangement, bar) === "status-bar") return context.given;
  return [
    ...context.given,
    arrangementStep(
      `${regionFacts(region).name} location: Status bar left`,
      (now) => withReadingSpot(now, bar, "status-bar-left"),
    ),
  ];
}

function segmentRowEntries(
  context: FineTuneContext,
  key: RegionValueKey,
  options: ReadonlyArray<SegmentOption>,
): ReadonlyArray<SweepEntry> {
  const { region, row, regionValues } = context;
  const current = String(readControlValue(regionValues, key));
  return options
    .filter((option) => option.value !== current)
    .map((option) =>
      fineTuneEntry(
        { ...context, given: densityGiven(context, option.value) },
        `:${option.value}`,
        controlStep(region, key, option.value, `${row.label}: ${option.label}`),
        radioControl(region, row.label, option.label),
      ),
    );
}

interface ChecksOption {
  readonly key: RegionValueKey;
  readonly label: string;
}

function checksRowEntries(
  context: FineTuneContext,
  options: ReadonlyArray<ChecksOption>,
): ReadonlyArray<SweepEntry> {
  const { region, row, regionValues } = context;
  return options.map((option) => {
    const current = readControlValue(regionValues, option.key) === true;
    return fineTuneEntry(
      context,
      `:${option.key}`,
      controlStep(
        region,
        option.key,
        !current,
        `${row.label} / ${option.label}: ${current ? "off" : "on"}`,
      ),
      checkControl(region, option.label),
    );
  });
}

function fieldChecksRowEntries(
  context: FineTuneContext,
  key: RegionValueKey,
  options: ReadonlyArray<SegmentOption>,
): ReadonlyArray<SweepEntry> {
  const { region, row, regionValues } = context;
  const list = readControlValue(regionValues, key);
  const selected = Array.isArray(list) ? list : [];
  const entries: SweepEntry[] = [];
  for (const option of options) {
    const checked = selected.includes(option.value);
    // The last one on screen cannot be unticked, and the control says so.
    if (checked && selected.length <= 1) continue;
    const nextList = options
      .map((entry) => entry.value)
      .filter((value) =>
        value === option.value ? !checked : selected.includes(value),
      );
    if (nextList.length === 0) continue;
    entries.push(
      fineTuneEntry(
        context,
        `:${option.value}`,
        controlStep(
          region,
          key,
          nextList,
          `${row.label} / ${option.label}: ${checked ? "off" : "on"}`,
        ),
        checkControl(region, option.label),
      ),
    );
  }
  return entries;
}

function fineTuneRowEntries(
  context: FineTuneContext,
): ReadonlyArray<SweepEntry> {
  const { control } = context.row;
  switch (control.kind) {
    case "switch":
      return switchRowEntries(context, control.key);
    case "segment":
      return segmentRowEntries(context, control.key, control.options);
    case "checks":
      return checksRowEntries(context, control.options);
    case "field-checks":
      return fieldChecksRowEntries(context, control.key, control.options);
    default:
      throw new Error(
        `${context.region} has a control this plan does not know`,
      );
  }
}

function fineTuneEntries(
  region: RegionId,
  rows: ReadonlyArray<FineTuneRowFacts>,
  values: LayoutValues,
  arrangement: LayoutArrangement,
): ReadonlyArray<SweepEntry> {
  return rows.flatMap((row) =>
    fineTuneRowEntries({
      arrangement,
      region,
      row,
      regionValues: values[region],
      given: fineTuneGiven(region, row, values, arrangement),
    }),
  );
}

// ── Ordered lists ───────────────────────────────────────────────────────────

interface OrderedList {
  readonly group: OrderGroupId;
  /** The list's accessible name, which the page keys its rows by. */
  readonly label: string;
  readonly ids: ReadonlyArray<string>;
  readonly movable: ReadonlyArray<boolean>;
  readonly move: (id: string, toIndex: number) => void;
}

/** The lists the page lets a keyboard reorder, as it builds their rows. */
function orderedLists(input: SweepPlanInput): ReadonlyArray<OrderedList> {
  const { shipped, availability, configuredProviders } = input;
  const arrangement = shipped.arrangement;
  const voice = isVoiceInputRowAvailable(availability);
  const toolbar = <Id extends string>(
    ids: ReadonlyArray<Id>,
  ): ReadonlyArray<Id> => ids.filter((id) => id !== "mic" || voice);
  const allMovable = (ids: ReadonlyArray<string>): ReadonlyArray<boolean> =>
    ids.map(() => true);
  const now = (): LayoutArrangement => useLayoutStore.getState().arrangement;
  const visibleProviders = arrangement.usageProviders.filter((id) =>
    configuredProviders.includes(id),
  );
  const dock = arrangement.dock;
  const left = toolbar(arrangement.toolbarLeft);
  const right = toolbar(arrangement.toolbarRight);
  const lists: OrderedList[] = [];
  for (const group of SURFACE_ORDER_GROUPS.composer) {
    if (group === "dock") {
      lists.push({
        group,
        label: orderGroupListLabel(group),
        ids: dock,
        movable: allMovable(dock),
        move: (id, toIndex) => {
          const current = now();
          const moved = current.dock.find((entry) => entry === id);
          if (moved === undefined) return;
          writeArrangement({
            ...current,
            dock: movedById(current.dock, moved, toIndex),
          });
        },
      });
    }
    if (group === "toolbarLeft") {
      lists.push({
        group,
        label: orderGroupListLabel(group),
        ids: left,
        movable: allMovable(left),
        move: (id, toIndex) => {
          const current = now();
          const moved = current.toolbarLeft.find((entry) => entry === id);
          if (moved === undefined) return;
          writeArrangement({
            ...current,
            toolbarLeft: movedById(current.toolbarLeft, moved, toIndex),
          });
        },
      });
    }
    if (group === "toolbarRight") {
      lists.push({
        group,
        label: orderGroupListLabel(group),
        ids: right,
        movable: allMovable(right),
        move: (id, toIndex) => {
          const current = now();
          const moved = current.toolbarRight.find((entry) => entry === id);
          if (moved === undefined) return;
          writeArrangement({
            ...current,
            toolbarRight: movedById(current.toolbarRight, moved, toIndex),
          });
        },
      });
    }
  }
  lists.push({
    group: "rail",
    label: orderGroupListLabel("rail"),
    ids: arrangement.rail.map((entry) => entry.id),
    // A stack link moves with its panels and carries no grab.
    movable: arrangement.rail.map((entry) => entry.kind !== "stack"),
    move: (id, toIndex) => {
      writeArrangement(moveRailEntry(now(), id, toIndex));
    },
  });
  lists.push({
    group: "usageProviders",
    label: orderGroupListLabel("usageProviders"),
    ids: visibleProviders,
    movable: allMovable(visibleProviders),
    move: (id, toIndex) => {
      const current = now();
      const moved = visibleProviders.find((entry) => entry === id);
      if (moved === undefined) return;
      writeArrangement({
        ...current,
        usageProviders: reorderVisibleProviders(
          current.usageProviders,
          current.usageProviders.filter((entry) =>
            configuredProviders.includes(entry),
          ),
          moved,
          toIndex,
        ),
      });
    },
  });
  return lists;
}

/**
 * The old driver's rule for every ordered list: the first movable row moved
 * down one and the second moved up one, so the two drawn rows trade places
 * whatever the list's length and one of them can meet a boundary the list
 * refuses without hiding the setting.
 */
function orderEntries(input: SweepPlanInput): ReadonlyArray<SweepEntry> {
  const entries: SweepEntry[] = [];
  for (const list of orderedLists(input)) {
    const movableRows = list.ids
      .map((id, index) => ({ id, index }))
      .filter((row) => list.movable[row.index]);
    movableRows.slice(0, 2).forEach((row, position) => {
      const direction = position === 0 ? "down" : "up";
      const to = stepPastFixed(
        list.movable,
        row.index,
        direction === "down" ? 1 : -1,
      );
      if (to === row.index) return;
      entries.push({
        id: `order-list:${list.group}:${row.id}:${direction}`,
        source: "order-list",
        mirrors: "OrderGroupRows onMove",
        // Provider order is visible where the reading lists its profiles: the
        // status bar, not the tab strip's glyph.
        given:
          list.group === "usageProviders"
            ? [
                arrangementStep(
                  "Usage limits location: Status bar left",
                  (now) =>
                    withReadingSpot(now, "usageLimits", "status-bar-left"),
                ),
              ]
            : NO_GIVEN,
        write: {
          label: `${list.label}: ${row.id} ${direction}`,
          run: () => {
            list.move(row.id, to);
          },
        },
        covers: [`order:${list.group}`, `arrangement:${list.group}`],
        controls: [orderControl(list.label, row.id, direction)],
      });
    });
  }
  return entries;
}

// ── The rail's own verbs ────────────────────────────────────────────────────

function railEntries(input: SweepPlanInput): ReadonlyArray<SweepEntry> {
  const rail = input.shipped.arrangement.rail;
  const entries: SweepEntry[] = [];
  const addDivider = arrangementStep("Sidebar panels: Add divider", (now) =>
    insertRailDivider(now, railDividerInsertIndex(now.rail)),
  );
  entries.push({
    id: "rail-structure:add-divider",
    source: "rail-structure",
    mirrors: null,
    given: NO_GIVEN,
    write: addDivider,
    covers: ["rail:divider", "arrangement:dividerSeq", "arrangement:rail"],
    controls: [buttonControl(NO_ROW, "Add divider")],
  });
  entries.push({
    id: "rail-structure:remove-divider",
    source: "rail-structure",
    mirrors: null,
    given: [addDivider],
    write: arrangementStep("Sidebar panels: Remove divider", (now) => {
      const divider = now.rail.find((entry) => entry.kind === "divider");
      return divider === undefined ? now : removeRailDivider(now, divider.id);
    }),
    covers: ["rail:divider", "arrangement:rail"],
    // The id the divider the given step adds will have.
    controls: [
      buttonControl(
        railDividerId(input.shipped.arrangement.dividerSeq + 1),
        "Remove divider",
      ),
    ],
  });
  for (const entry of rail) {
    if (entry.kind === "stack") {
      entries.push({
        id: `rail-structure:remove-stack:${entry.id}`,
        source: "rail-structure",
        mirrors: null,
        given: NO_GIVEN,
        write: arrangementStep(`Remove stack ${entry.id}`, (now) =>
          unstackRail(now, entry.id),
        ),
        covers: ["rail:stack", "arrangement:rail"],
        controls: [buttonControl(entry.id, "Remove stack")],
      });
      for (const member of railStackMembers(entry.id) ?? []) {
        entries.push({
          id: `rail-structure:unstack:${member}`,
          source: "rail-structure",
          mirrors: null,
          given: NO_GIVEN,
          write: arrangementStep(`Unstack ${regionFacts(member).name}`, (now) =>
            unstackRailPanel(now, member),
          ),
          covers: ["rail:stack", "arrangement:rail"],
          controls: [
            buttonControl(entry.id, `Unstack ${regionFacts(member).name}`),
          ],
        });
      }
    }
    if (
      entry.kind === "panel" &&
      railPanelToStackBelow(rail, entry.id) !== null
    ) {
      const panel = entry.id;
      entries.push({
        id: `rail-structure:stack-below:${panel}`,
        source: "rail-structure",
        mirrors: null,
        given: NO_GIVEN,
        write: arrangementStep(
          `Stack ${regionFacts(panel).name} with the panel below`,
          (now) => stackRailPanelWithBelow(now, panel),
        ),
        covers: ["rail:stack", "arrangement:rail"],
        controls: [
          buttonControl(
            panel,
            `Stack ${regionFacts(panel).name.toLowerCase()} with the panel below`,
          ),
        ],
      });
    }
  }
  return entries;
}

// ── Providers ───────────────────────────────────────────────────────────────

function providerEntries(input: SweepPlanInput): ReadonlyArray<SweepEntry> {
  const { shipped } = input;
  const arrangement = shipped.arrangement;
  const entries: SweepEntry[] = [];
  for (const providerId of arrangement.usageProviders) {
    const name = providerDisplayName(providerId);
    const hidden = arrangement.hiddenProviders.includes(providerId);
    entries.push({
      id: `provider-display:${providerId}:${hidden ? "shown" : "hidden"}`,
      source: "provider-display",
      mirrors: null,
      given: NO_GIVEN,
      write: {
        label: `${name} display: ${hidden ? "Shown" : "Hidden"}`,
        run: () => {
          toggleHiddenProvider(
            providerId,
            useLayoutStore.getState().arrangement,
            hidden,
          );
        },
      },
      covers: ["provider-display", "arrangement:hiddenProviders"],
      controls: [
        buttonControl(providerId, `${hidden ? "Show" : "Hide"} ${name}`),
      ],
    });
  }
  return entries;
}

// ── The rows that belong to an area, not to a region ────────────────────────

type SegmentFieldKey =
  | "tabStripPlacement"
  | "sideStripView"
  | "taskTabLayout"
  | "readingWidth";

interface SegmentFieldSpec<K extends SegmentFieldKey> {
  readonly key: K;
  readonly label: string;
  readonly options: ReadonlyArray<{
    readonly value: LayoutArrangement[K];
    readonly label: string;
  }>;
  readonly current: LayoutArrangement[K];
  readonly given: ReadonlyArray<SweepStep>;
}

/** One segmented surface row that writes one arrangement field. */
function segmentFieldEntries<K extends SegmentFieldKey>(
  spec: SegmentFieldSpec<K>,
): ReadonlyArray<SweepEntry> {
  return spec.options
    .filter((option) => option.value !== spec.current)
    .map((option) => ({
      id: `surface-row:${spec.key}:${String(option.value)}`,
      source: "surface-row",
      mirrors: null,
      given: spec.given,
      write: arrangementFieldStep(
        `${spec.label}: ${option.label}`,
        spec.key,
        option.value,
      ),
      covers: [`definition:${spec.key}`, `arrangement:${spec.key}`],
      controls: [radioControl(NO_ROW, spec.label, option.label)],
    }));
}

function sidebarSideEntries(
  arrangement: LayoutArrangement,
): ReadonlyArray<SweepEntry> {
  return EDGE_SIDE_OPTIONS.filter(
    (option) => option.value !== arrangement.sidebarSide,
  ).map((option) => {
    const side: EdgeSide = option.value === "left" ? "left" : "right";
    return {
      id: `surface-row:sidebarSide:${option.value}`,
      source: "surface-row",
      mirrors: null,
      given: NO_GIVEN,
      write: arrangementFieldStep(
        `Sidebar side: ${option.label}`,
        "sidebarSide",
        side,
      ),
      covers: ["definition:sidebarSide", "arrangement:sidebarSide"],
      controls: [radioControl(NO_ROW, "Sidebar side", option.label)],
    };
  });
}

function switchSurfaceEntries(
  input: SweepPlanInput,
): ReadonlyArray<SweepEntry> {
  const { shipped, availability } = input;
  const definitions = LAYOUT.definitions;
  const values = effectiveLayoutValues(shipped.basePreset, shipped.overrides);
  const entries: SweepEntry[] = [];
  if (definitions.resourceReadings.availableWhen(availability)) {
    const on = values.resourceMonitor.agentRows;
    entries.push({
      id: "surface-row:resourceReadings",
      source: "surface-row",
      mirrors: null,
      given: NO_GIVEN,
      write: controlStep(
        "resourceMonitor",
        "agentRows",
        !on,
        `${definitions.resourceReadings.label}: ${on ? "off" : "on"}`,
      ),
      covers: ["definition:resourceReadings"],
      controls: [switchControl(NO_ROW, definitions.resourceReadings.label)],
    });
  }
  if (definitions.mobileFooter.availableWhen(availability)) {
    entries.push({
      id: "surface-row:mobileFooter",
      source: "surface-row",
      mirrors: null,
      given: NO_GIVEN,
      write: arrangementFieldStep(
        `${definitions.mobileFooter.label}: on`,
        "mobileFooter",
        !shipped.arrangement.mobileFooter,
      ),
      covers: ["definition:mobileFooter", "arrangement:mobileFooter"],
      controls: [switchControl(NO_ROW, definitions.mobileFooter.label)],
    });
  }
  return entries;
}

function surfaceEntries(input: SweepPlanInput): ReadonlyArray<SweepEntry> {
  const { shipped, availability } = input;
  const arrangement = shipped.arrangement;
  const definitions = LAYOUT.definitions;
  const entries: SweepEntry[] = [];
  if (definitions.tabStripPlacement.availableWhen(availability)) {
    entries.push(
      ...segmentFieldEntries({
        key: "tabStripPlacement",
        label: "Tab placement",
        options: TAB_STRIP_PLACEMENT_OPTIONS,
        current: arrangement.tabStripPlacement,
        given: NO_GIVEN,
      }),
    );
  }
  if (definitions.sideStripView.availableWhen(availability)) {
    entries.push(
      ...segmentFieldEntries({
        key: "sideStripView",
        label: "Side tab view",
        options: SIDE_STRIP_VIEW_OPTIONS,
        current: arrangement.sideStripView,
        // The view only means something while the tabs sit at an edge.
        given: [TAB_PLACEMENT_LEFT],
      }),
    );
  }
  entries.push(
    ...segmentFieldEntries({
      key: "taskTabLayout",
      label: "Tab overflow",
      options: TAB_OVERFLOW_OPTIONS,
      current: arrangement.taskTabLayout,
      given: NO_GIVEN,
    }),
  );
  if (definitions.sidebarSide.availableWhen(availability)) {
    entries.push(...sidebarSideEntries(arrangement));
  }
  entries.push(
    ...segmentFieldEntries({
      key: "readingWidth",
      label: "Reading width",
      options: READING_WIDTH_OPTIONS,
      current: arrangement.readingWidth,
      given: NO_GIVEN,
    }),
    ...switchSurfaceEntries(input),
  );
  return entries;
}

// ── Presets, Reset, and the arrangement fields no row writes ────────────────

function presetEntries(): ReadonlyArray<SweepEntry> {
  return LAYOUT_PRESET_IDS.map((presetId) => ({
    id: `preset:${presetId}`,
    source: "preset",
    mirrors: "presets-block applyPreset",
    given: NO_GIVEN,
    write: {
      label: `Apply ${PRESET_LABELS[presetId]}`,
      run: () => {
        applyPresetWrite(presetId);
      },
    },
    covers: ["definition:presets"],
    controls: [],
  }));
}

function resetEntries(): ReadonlyArray<SweepEntry> {
  return [
    {
      id: "reset:layout",
      source: "reset",
      mirrors: null,
      // A reset from the shipped layout is disabled: it needs something to undo.
      given: [
        {
          label: "Apply Compact",
          run: () => {
            applyPresetWrite("compact");
          },
        },
        arrangementFieldStep("Sidebar side: Right", "sidebarSide", "right"),
      ],
      write: { label: "Reset layout", run: resetLayoutWrite },
      covers: ["definition:resetLayout", "definition:resetLayoutAction"],
      controls: [],
    },
  ];
}

function arrangementFieldEntries(): ReadonlyArray<SweepEntry> {
  const pinBreakdown = controlStep(
    "contextUsage",
    "pinBreakdown",
    true,
    "Context usage / Pin breakdown: on",
  );
  return [
    {
      id: "arrangement-field:pinnedContextFieldOrder",
      source: "arrangement-field",
      mirrors: null,
      given: [pinBreakdown],
      write: arrangementFieldStep(
        "Pinned breakdown order: reversed",
        "pinnedContextFieldOrder",
        [...CONTEXT_USAGE_ROW_KEYS].reverse(),
      ),
      covers: ["arrangement:pinnedContextFieldOrder"],
      controls: [],
    },
    {
      id: "arrangement-field:statusBarParked",
      source: "arrangement-field",
      mirrors: null,
      given: NO_GIVEN,
      write: arrangementFieldStep(
        "Toggle status bar's memory: usage limits parked",
        "statusBarParked",
        ["usageLimits"],
      ),
      covers: ["arrangement:statusBarParked"],
      controls: [],
    },
    {
      id: "arrangement-field:toggle-status-bar",
      source: "arrangement-field",
      mirrors: null,
      given: NO_GIVEN,
      write: arrangementStep("Toggle status bar", toggleStatusBarSurface),
      covers: [
        "arrangement:statusBarParked",
        "arrangement:usageHost",
        "arrangement:resourceHost",
      ],
      controls: [],
    },
    {
      id: "arrangement-field:wideReadingWidthPx",
      source: "arrangement-field",
      mirrors: null,
      // The wide-column-width row only draws once Reading width is Wide
      // (`WideReadingWidthRow`).
      given: [
        arrangementFieldStep("Reading width: Wide", "readingWidth", "wide"),
      ],
      write: arrangementFieldStep(
        "Wide column width: max",
        "wideReadingWidthPx",
        WIDE_READING_WIDTH_MAX_PX,
      ),
      covers: ["arrangement:wideReadingWidthPx"],
      controls: [],
    },
  ];
}

export function buildSweepPlan(
  input: SweepPlanInput,
): ReadonlyArray<SweepEntry> {
  const plan = [
    ...regionPlan(input),
    ...orderEntries(input),
    ...railEntries(input),
    ...providerEntries(input),
    ...surfaceEntries(input),
    ...presetEntries(),
    ...resetEntries(),
    ...arrangementFieldEntries(),
  ];
  const seen = new Set<string>();
  for (const entry of plan) {
    if (seen.has(entry.id))
      throw new Error(`duplicate sweep entry: ${entry.id}`);
    seen.add(entry.id);
  }
  return plan;
}

export function sweepEntryName(entry: SweepEntry): string {
  return [...entry.given.map((step) => step.label), entry.write.label].join(
    " > ",
  );
}

/** How many entries each source contributes. */
export function sweepCounts(
  plan: ReadonlyArray<SweepEntry>,
): ReadonlyMap<SweepSource, number> {
  const counts = new Map<SweepSource, number>();
  for (const source of SWEEP_SOURCES) counts.set(source, 0);
  for (const entry of plan) {
    counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1);
  }
  return counts;
}

import {
  fineTuneRowLiveWhileHidden,
  readControlValue,
  writeControlValue,
  type RegionControlValue,
} from "@/components/layout-editor/inspector/region-control-io";
import type { FineTuneRowFacts } from "@/components/layout-editor/inspector/rows/fine-tune-row";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import {
  LAYOUT_REGION_LIST,
  regionFacts,
  regionRowAvailable,
  type AnyGrammarRow,
} from "@/components/layout-editor/regions/region-facts";
import {
  ACCESS_DISPLAY_OPTIONS,
  AUTO_SHOWN_HIDDEN_OPTIONS,
  BAR_HOST_OPTIONS,
  DISCLOSURE_HIDDEN_OPTIONS,
  DISCLOSURE_OPTIONS,
  DOCK_DISPLAY_OPTIONS,
  edgeSideOptions,
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
import { USAGE_PROVIDER_LEVEL } from "@/components/layout-editor/regions/usage-provider-level";
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
  AUTOMATIC_LIMIT_SELECTION,
  barPlacement,
  insertRailDivider,
  isAutomaticLimitSelection,
  movedWithin,
  moveRailEntry,
  railPanelToStackBelow,
  removeRailDivider,
  stackRailPanelWithBelow,
  toggleStatusBarSurface,
  unstackRail,
  unstackRailPanel,
  WIDE_READING_WIDTH_MAX_PX,
  withBarHost,
  withBarSide,
  type BarHost,
  type EdgeSide,
  type BarRegionId,
  type LayoutArrangement,
  type OrderGroupId,
  type StatusBarProviderLimitSelection,
  type TabStripPlacement,
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
import { isWindowedRateLimitProvider } from "@/lib/rate-limits/rate-limit-window-catalog";
import {
  isVoiceInputRowAvailable,
  type SettingsAvailabilityContext,
} from "@/lib/settings/settings-availability";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import type { SweepProviderUsage } from "@/components/layout-editor/__tests__/layout-sweep-fixtures";

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
  | "provider-limits"
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
  "provider-limits",
  "surface-row",
  "arrangement-field",
  "preset",
  "reset",
];

/** What a step may read of the live column: what the providers report and draw. */
export interface SweepContext {
  readonly providerUsage: (
    providerId: RateLimitProviderId,
  ) => SweepProviderUsage | null;
}

/** One write, named, through the product's own writer. */
export interface SweepStep {
  readonly label: string;
  readonly run: (context: SweepContext) => void;
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
   * `rail:<what>`, `provider-display`, `provider-limits`,
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
  /** What each configured provider reports and draws, read from the mounted column. */
  readonly usage: ReadonlyMap<RateLimitProviderId, SweepProviderUsage>;
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

function writeLimitSelection(
  providerId: RateLimitProviderId,
  selection: StatusBarProviderLimitSelection,
): void {
  useLayoutEditorStore.getState().recordGesture(() => {
    const arrangement = useLayoutStore.getState().arrangement;
    const providerLimits = { ...arrangement.providerLimits };
    if (isAutomaticLimitSelection(selection)) delete providerLimits[providerId];
    else providerLimits[providerId] = selection;
    useLayoutStore
      .getState()
      .setArrangement({ ...arrangement, providerLimits });
  });
}

function pickedWindow(
  selection: StatusBarProviderLimitSelection,
  order: ReadonlyArray<string>,
  windowKey: string,
  checked: boolean,
): StatusBarProviderLimitSelection {
  const next = new Set(selection.limitKeys);
  if (checked) next.add(windowKey);
  else next.delete(windowKey);
  if (next.size === 0) return selection;
  const live = order.filter((key) => next.has(key));
  const stale = selection.limitKeys.filter(
    (key) => next.has(key) && !order.includes(key),
  );
  return { limitKeys: [...live, ...stale] };
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
  const current = barPlacement(arrangement, bar).host;
  const field = bar === "usageLimits" ? "usageHost" : "resourceHost";
  return BAR_HOST_OPTIONS.filter((option) => option.value !== current).map(
    (option) => {
      const host: BarHost = option.value === "header" ? "header" : "status-bar";
      return {
        id: `region-position:${region}:host:${option.value}`,
        source: "region-position",
        mirrors: null,
        given: NO_GIVEN,
        write: arrangementStep(`${name} position: ${option.label}`, (now) =>
          withBarHost(now, bar, host),
        ),
        covers: [`position-host:${region}`, `arrangement:${field}`],
        controls: [radioControl(region, `${name} position`, option.label)],
      };
    },
  );
}

/** The stored side field a region's side row writes. */
function sideField(
  bar: BarRegionId | null,
): "minimapSide" | "usageSide" | "resourceSide" {
  if (bar === null) return "minimapSide";
  return bar === "usageLimits" ? "usageSide" : "resourceSide";
}

interface SideCase {
  readonly idPart: string;
  readonly placement: TabStripPlacement;
  readonly given: ReadonlyArray<SweepStep>;
}

/**
 * The placements a side row is swept at. A reading hosted in the tab strip
 * reads its ends as Start and End once the strip stands at an edge (its foot),
 * a different drawing of the same stored side: swept there as well.
 */
function sideCases(
  bar: BarRegionId | null,
  arrangement: LayoutArrangement,
): ReadonlyArray<SideCase> {
  const shipped: SideCase = {
    idPart: "side",
    placement: arrangement.tabStripPlacement,
    given: NO_GIVEN,
  };
  if (bar === null || barPlacement(arrangement, bar).host !== "header") {
    return [shipped];
  }
  return [
    shipped,
    { idPart: "side-foot", placement: "left", given: [TAB_PLACEMENT_LEFT] },
  ];
}

function positionSideEntries(
  region: RegionId,
  arrangement: LayoutArrangement,
): ReadonlyArray<SweepEntry> {
  const bar = asBarRegionId(region);
  if (bar === null && region !== "minimap") {
    throw new Error(
      `${region} has a position-side row this plan does not know how to write`,
    );
  }
  const name = regionFacts(region).name;
  const current =
    bar === null
      ? arrangement.minimapSide
      : barPlacement(arrangement, bar).side;
  const field = sideField(bar);
  const entries: SweepEntry[] = [];
  for (const sideCase of sideCases(bar, arrangement)) {
    const options =
      bar === null
        ? EDGE_SIDE_OPTIONS
        : edgeSideOptions(
            barPlacement(arrangement, bar).host,
            sideCase.placement,
          );
    for (const option of options.filter((entry) => entry.value !== current)) {
      const side: EdgeSide = option.value === "left" ? "left" : "right";
      entries.push({
        id: `region-position:${region}:${sideCase.idPart}:${option.value}`,
        source: "region-position",
        mirrors: null,
        given: sideCase.given,
        write: arrangementStep(`${name} side: ${option.label}`, (now) =>
          bar === null
            ? { ...now, minimapSide: side }
            : withBarSide(now, bar, side),
        ),
        covers: [`position-side:${region}`, `arrangement:${field}`],
        controls: [radioControl(region, `${name} side`, option.label)],
      });
    }
  }
  return entries;
}

function styleEntries(
  region: RegionId,
  row: StyleGrammarRow,
  values: LayoutValues,
): ReadonlyArray<SweepEntry> {
  const regionValues = values[region];
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
      given: NO_GIVEN,
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
      return styleEntries(region, row, values);
    case "fine-tune":
      return fineTuneEntries(region, row.rows, values);
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
    entries.push(...displayEntries(region, values, availability));
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
): ReadonlyArray<SweepStep> {
  const regionValues = values[region];
  const given: SweepStep[] = [];
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
        context,
        `:${option.value}`,
        controlStep(region, key, option.value, `${row.label}: ${option.label}`),
        radioControl(region, row.label, option.label),
      ),
    );
}

interface ChecksOption {
  readonly key: RegionValueKey;
  readonly label: string;
  readonly requires: RegionValueKey | null;
}

/** What a person does first to make a check operable: switch its parent on. */
function checkGiven(
  context: FineTuneContext,
  requires: RegionValueKey | null,
): ReadonlyArray<SweepStep> {
  if (
    requires === null ||
    readControlValue(context.regionValues, requires) === true
  ) {
    return context.given;
  }
  const label = `${context.region} ${requires}: on`;
  if (context.given.some((step) => step.label === label)) return context.given;
  return [...context.given, controlStep(context.region, requires, true, label)];
}

function checksRowEntries(
  context: FineTuneContext,
  options: ReadonlyArray<ChecksOption>,
): ReadonlyArray<SweepEntry> {
  const { region, row, regionValues } = context;
  return options.map((option) => {
    const current = readControlValue(regionValues, option.key) === true;
    return fineTuneEntry(
      { ...context, given: checkGiven(context, option.requires) },
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
): ReadonlyArray<SweepEntry> {
  return rows.flatMap((row) =>
    fineTuneRowEntries({
      region,
      row,
      regionValues: values[region],
      given: fineTuneGiven(region, row, values),
    }),
  );
}

/**
 * The tab strip's foot draws its readings as one row in a fixed order: the
 * header's left end, then its right end, usage before resources inside an end.
 * With usage at the start and resources at the end, either reading moved to the
 * other end leaves that order as it was; the two moves together reverse it.
 * The single moves are swept above and are silent by construction; this is the
 * entry that proves the foot reads the sides at all.
 */
function footOrderEntries(input: SweepPlanInput): ReadonlyArray<SweepEntry> {
  const arrangement = input.shipped.arrangement;
  if (
    arrangement.usageHost !== "header" ||
    arrangement.resourceHost !== "header" ||
    arrangement.usageSide !== "left" ||
    arrangement.resourceSide !== "right"
  ) {
    return [];
  }
  return [
    {
      id: "region-position:resourceMonitor:side-foot:order-flip",
      source: "region-position",
      mirrors: null,
      given: [
        TAB_PLACEMENT_LEFT,
        arrangementStep("Usage limits side: End", (now) =>
          withBarSide(now, "usageLimits", "right"),
        ),
      ],
      write: arrangementStep("Resource monitor side: Start", (now) =>
        withBarSide(now, "resourceMonitor", "left"),
      ),
      covers: ["position-side:resourceMonitor", "arrangement:resourceSide"],
      controls: [
        radioControl("resourceMonitor", "Resource monitor side", "Start"),
      ],
    },
  ];
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
        given: NO_GIVEN,
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
  const { shipped, configuredProviders, usage } = input;
  const arrangement = shipped.arrangement;
  const entries: SweepEntry[] = [];
  for (const providerId of arrangement.usageProviders) {
    const name = providerDisplayName(providerId);
    const configured = configuredProviders.includes(providerId);
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
        radioControl(
          providerId,
          `${name} display`,
          hidden ? "Shown" : "Hidden",
        ),
      ],
    });
    if (!configured || !isWindowedRateLimitProvider(providerId)) continue;
    const facts = usage.get(providerId);
    if (facts === undefined || facts.windows.length === 0) continue;
    const choose: SweepStep = {
      label: `${name} ${USAGE_PROVIDER_LEVEL.limitsLabel}: Choose...`,
      run: (context) => {
        const live = context.providerUsage(providerId);
        if (live === null || live.windows.length === 0) {
          throw new Error(`${providerId} reports no window to choose from`);
        }
        const seed =
          live.drawnKeys.length > 0
            ? live.drawnKeys
            : live.windows.slice(0, 1).map((window) => window.windowKey);
        writeLimitSelection(providerId, { limitKeys: seed });
      },
    };
    entries.push({
      id: `provider-limits:${providerId}:choose`,
      source: "provider-limits",
      mirrors: "ProviderLimitsPick writeSelection",
      given: NO_GIVEN,
      write: choose,
      covers: ["provider-limits", "arrangement:providerLimits"],
      controls: [
        radioControl(providerId, USAGE_PROVIDER_LEVEL.limitsLabel, "Choose..."),
      ],
    });
    entries.push({
      id: `provider-limits:${providerId}:automatic`,
      source: "provider-limits",
      mirrors: "ProviderLimitsPick writeSelection",
      given: [choose],
      write: {
        label: `${name} ${USAGE_PROVIDER_LEVEL.limitsLabel}: Automatic (recommended)`,
        run: () => {
          writeLimitSelection(providerId, AUTOMATIC_LIMIT_SELECTION);
        },
      },
      covers: ["provider-limits", "arrangement:providerLimits"],
      controls: [
        radioControl(
          providerId,
          USAGE_PROVIDER_LEVEL.limitsLabel,
          "Automatic (recommended)",
        ),
      ],
    });
    // What Choose... seeds is checked, and the last checked window cannot be
    // unticked, so the page offers a tick on the others only.
    const seeded =
      facts.drawnKeys.length > 0
        ? facts.drawnKeys
        : facts.windows.slice(0, 1).map((window) => window.windowKey);
    for (const window of facts.windows) {
      if (seeded.includes(window.windowKey)) continue;
      entries.push({
        id: `provider-limits:${providerId}:window:${window.windowKey}`,
        source: "provider-limits",
        mirrors: "ProviderLimitsPick writeSelection",
        given: [choose],
        write: {
          label: `${name} window ${window.label}: on`,
          run: (context) => {
            const live = context.providerUsage(providerId);
            const order = (live ?? facts).windows.map(
              (entry) => entry.windowKey,
            );
            const selection =
              useLayoutStore.getState().arrangement.providerLimits[
                providerId
              ] ?? AUTOMATIC_LIMIT_SELECTION;
            writeLimitSelection(
              providerId,
              pickedWindow(selection, order, window.windowKey, true),
            );
          },
        },
        covers: ["provider-limits", "arrangement:providerLimits"],
        controls: [checkControl(providerId, window.label)],
      });
    }
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
    ...footOrderEntries(input),
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

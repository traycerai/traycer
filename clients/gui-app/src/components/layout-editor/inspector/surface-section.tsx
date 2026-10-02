import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import {
  isMinimapSideRowAvailable,
  type SettingsAvailabilityContext,
} from "@/lib/settings/settings-availability";
import type { ReactNode } from "react";
import { RevertButton } from "@/components/layout-editor/inspector/inspector-row";
import { RegionDisplayControl } from "@/components/layout-editor/inspector/region-controls";
import { UsageProfilesList } from "@/components/layout-editor/inspector/usage-profiles";
import { assertNever } from "@/components/layout-editor/inspector/rows/assert-never";
import {
  FineTuneRows,
  type FineTuneRowFacts,
} from "@/components/layout-editor/inspector/rows/fine-tune-row";
import { fineTuneRowLiveWhileHidden } from "@/components/layout-editor/inspector/region-control-io";
import { setRegionShown } from "@/components/layout-editor/layout-gestures";
import {
  compactIgnoredRows,
  densityDescription,
} from "@/components/layout-editor/regions/reading-placement";
import {
  readingPlacement,
  resolvedReadingDensity,
} from "@/lib/layout/reading-density";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  OrderGroupHeader,
  OrderGroupList,
} from "@/components/layout-editor/inspector/rows/order-group-list";
import {
  BARE_ROW,
  regionRowItems,
  type SortableRowDecoration,
} from "@/components/layout-editor/inspector/rows/order-row-items";
import {
  PositionHostRow,
  PositionSideRow,
} from "@/components/layout-editor/inspector/rows/position-row";
import { StyleRow } from "@/components/layout-editor/inspector/rows/style-row";
import {
  SurfaceLeadingRows,
  SurfaceTrailingRows,
} from "@/components/layout-editor/inspector/rows/surface-placement-rows";
import { SortableList } from "@/components/layout-editor/inspector/sortable-list";
import { useSortableRowPadding } from "@/components/layout-editor/inspector/sortable-row-padding";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import { HOME_TAB_PHONE_HINT } from "@/components/layout-editor/regions/top-bar-regions";
import {
  LAYOUT_REGION_LIST,
  regionFacts,
  regionRowAvailable,
  type AnyGrammarRow,
} from "@/components/layout-editor/regions/region-facts";
import {
  SURFACE_GROUPS,
  type SurfaceGroupId,
} from "@/components/layout-editor/regions/region-grammar";
import {
  regionPositionMoved,
  revertPositionRow,
} from "@/components/layout-editor/regions/region-position-rows";
import {
  looseSurfaceRegions,
  orderGroupListLabel,
  SURFACE_ORDER_GROUPS,
} from "@/components/layout-editor/regions/surface-groups";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import {
  layoutChanges,
  regionChanged,
  reorderedGroups,
  revertLayoutChange,
  usageProvidersChanged,
  type LayoutChange,
} from "@/lib/layout/layout-diff";
import {
  asBarRegionId,
  BAR_REGION_IDS,
  DEFAULT_ARRANGEMENT,
  type BarRegionId,
  type LayoutArrangement,
  type OrderGroupId,
} from "@/lib/layout/layout-arrangement";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import {
  regionValuesHidden,
  type LayoutValues,
} from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * One area's form, the same in Settings > Layout and the editor inspector
 * (L-03): the area's own rows, then its regions as rows of one list per order
 * group (L-92, L-95).
 *
 * Every region is a ROW with its one display control (L-121), a revert while
 * it is changed and, where it has more to say, a disclosure that opens its Location,
 * Side, Style and detail rows in place (L-89). There is no deeper level.
 *
 * `selectedRow` is the region the editor's canvas has selected: its row is
 * highlighted, and the host opens it through `openRows`.
 */
export function SurfaceSection(props: {
  readonly surface: SurfaceGroupId;
  readonly snapshot: LayoutSnapshot;
  readonly openRows: ReadonlyArray<string>;
  readonly onToggleRow: (rowId: string) => void;
  /**
   * Pressing a region row that has no disclosure: the editor selects it, so
   * every region is reachable from its row. `null` in Settings, which has no
   * canvas to select on.
   */
  readonly onSelectRow: ((regionId: RegionId) => void) | null;
  readonly selectedRow: RegionId | null;
}): ReactNode {
  const { surface, snapshot, openRows, onToggleRow, onSelectRow, selectedRow } =
    props;
  const values = effectiveLayoutValues(snapshot.basePreset, snapshot.overrides);
  const narrow = useIsMobileViewport();
  const availability = useSettingsAvailabilityContext();

  function selectHandler(regionId: RegionId): (() => void) | null {
    if (onSelectRow === null) return null;
    return () => {
      onSelectRow(regionId);
    };
  }

  function decorate(id: string): SortableRowDecoration {
    const regionId = asRegionId(id);
    if (regionId === null) return BARE_ROW;
    const changed = regionRowChanged(snapshot, regionId);
    const hint =
      narrow && regionId === "homeTab"
        ? HOME_TAB_PHONE_HINT
        : regionFacts(regionId).hint;
    // A disclosure only where opening it shows something: the region's own
    // detail rows, or its presence rule (G6).
    const discloses =
      hint !== null ||
      regionDetailRows(regionId, narrow, availability).length > 0;
    return {
      ...BARE_ROW,
      hint,
      control: <RegionDisplayControl regionId={regionId} values={values} />,
      revert: changed ? (
        <RevertButton
          label={`Revert ${regionFacts(regionId).name}`}
          onRevert={() => {
            revertRegion(regionId);
          }}
        />
      ) : null,
      detail: discloses ? (
        <RegionRowDetail
          regionId={regionId}
          snapshot={snapshot}
          values={values}
        />
      ) : null,
      open: discloses && openRows.includes(id),
      onToggleOpen: discloses
        ? () => {
            onToggleRow(id);
          }
        : selectHandler(regionId),
    };
  }

  const loose = looseSurfaceRegions(surface);
  const groups = SURFACE_ORDER_GROUPS[surface];

  return (
    <div data-layout-area-form={surface} className="flex flex-col">
      <SurfaceLeadingRows surface={surface} />
      {surface === "statusBar"
        ? BAR_REGION_IDS.map((regionId) => (
            <ReadingSection
              key={regionId}
              regionId={regionId}
              snapshot={snapshot}
              values={values}
              selected={selectedRow === regionId}
            />
          ))
        : null}
      {surface !== "statusBar" && loose.length > 0 ? (
        <SortableList
          label={`${surfaceLabel(surface)} settings`}
          selectedId={selectedRow}
          items={regionRowItems(loose, values, decorate)}
          onMove={null}
        />
      ) : null}
      {groups.map((group) => (
        <SurfaceOrderList
          key={group}
          group={group}
          snapshot={snapshot}
          values={values}
          decorate={decorate}
          selectedRow={selectedRow}
        />
      ))}
      <SurfaceTrailingRows surface={surface} />
    </div>
  );
}

/**
 * One order group as a headed list: the list's name with its own revert, and
 * how it is operated (L-127, LV2-18).
 */
function SurfaceOrderList(props: {
  readonly group: OrderGroupId;
  readonly snapshot: LayoutSnapshot;
  readonly values: LayoutValues;
  readonly decorate: (id: string) => SortableRowDecoration;
  readonly selectedRow: RegionId | null;
}): ReactNode {
  const { group, snapshot, values, decorate, selectedRow } = props;
  const arrangement = snapshot.arrangement;
  const narrow = useIsMobileViewport();
  const movable =
    !narrow || (group !== "toolbarLeft" && group !== "toolbarRight");
  const moved = movable && reorderedGroups(arrangement).includes(group);
  return (
    <div className="flex flex-col">
      <div className="border-b border-border/40">
        <OrderGroupHeader
          group={group}
          revert={
            moved ? (
              <RevertButton
                label={`Revert ${orderGroupListLabel(group)} order`}
                onRevert={() => {
                  writeArrangement(revertedOrderGroup(group, arrangement));
                }}
              />
            ) : null
          }
        />
      </div>
      <OrderGroupList
        group={group}
        selectedId={selectedRow}
        values={values}
        arrangement={arrangement}
        decorate={decorate}
      />
    </div>
  );
}

/**
 * A group put back through the one seam that knows how: any region whose
 * Position row names this group reverts the whole list, because that is what a
 * `position-order` revert has always meant (L-57).
 */
function revertedOrderGroup(
  group: OrderGroupId,
  arrangement: LayoutArrangement,
): LayoutArrangement {
  const member = LAYOUT_REGION_LIST.find((region) =>
    region.rows.some(
      (row) => row.kind === "position-order" && row.group === group,
    ),
  );
  return member === undefined
    ? arrangement
    : revertPositionRow(arrangement, member.id);
}

/**
 * What the row's disclosure opens: Location, Side, Style and the detail rows.
 *
 * While the region is Hidden they stay readable and disabled, and say how to
 * change them: a disabled `fieldset` turns every control off without taking
 * any of them out of the accessibility tree. A detail row something else still
 * reads stays live (`liveWhileHidden`, L-174), so the hint then names only the
 * rest.
 */
function RegionRowDetail(props: {
  readonly regionId: RegionId;
  readonly snapshot: LayoutSnapshot;
  readonly values: LayoutValues;
}): ReactNode {
  const { regionId, snapshot, values } = props;
  const narrow = useIsMobileViewport();
  const availability = useSettingsAvailabilityContext();
  const gutter = useSortableRowPadding();
  const rows = regionDetailRows(regionId, narrow, availability);
  if (rows.length === 0) return null;
  const hidden = regionValuesHidden(values[regionId]);
  const someLive =
    hidden &&
    rows.some(
      (row) =>
        row.kind === "fine-tune" &&
        row.rows.some((detail) =>
          fineTuneRowLiveWhileHidden(detail, values[regionId]),
        ),
    );
  return (
    <div data-region-detail={regionId}>
      {hidden ? (
        <div className={gutter.row}>
          <p className="ml-11 text-ui-xs text-muted-foreground">
            Show {regionFacts(regionId).name} to change{" "}
            {someLive ? "its other settings" : "these settings"}.
          </p>
        </div>
      ) : null}
      {rows.map((row) => (
        <fieldset
          key={row.kind === "style" ? `style:${row.key}` : row.kind}
          // Fine-tune rows decide per row, so one can outlive a Hidden region.
          disabled={hidden ? row.kind !== "fine-tune" : false}
          className="m-0 min-w-0 border-0 p-0"
        >
          <DetailRowView
            row={row}
            regionId={regionId}
            values={values}
            snapshot={snapshot}
          />
        </fieldset>
      ))}
    </div>
  );
}

/**
 * One detail row, drawn by the module that owns its KIND. `position-order` IS
 * the list the row sits in and `children` is the Providers list beside it, so
 * neither is a detail.
 */
function DetailRowView(props: {
  readonly row: AnyGrammarRow;
  readonly regionId: RegionId;
  readonly values: LayoutValues;
  readonly snapshot: LayoutSnapshot;
}): ReactNode {
  const { row, regionId, values, snapshot } = props;
  const arrangement = snapshot.arrangement;
  const narrow = useIsMobileViewport();
  switch (row.kind) {
    case "position-host":
      return (
        <PositionHostRow
          regionId={regionId}
          arrangement={arrangement}
          snapshot={snapshot}
        />
      );
    case "position-side":
      return (
        <PositionSideRow
          regionId={regionId}
          arrangement={arrangement}
          snapshot={snapshot}
          description={row.description}
        />
      );
    case "style":
      return (
        <StyleRow
          label={row.label}
          styleKey={row.key}
          examples={row.examples}
          regionId={regionId}
          values={values}
          arrangement={arrangement}
        />
      );
    case "fine-tune": {
      const bar = asBarRegionId(regionId);
      return (
        <FineTuneRows
          rows={
            bar === null
              ? row.rows
              : readingFineTuneRows({
                  rows: row.rows,
                  region: bar,
                  values,
                  arrangement,
                  narrow,
                })
          }
          regionId={regionId}
          regionValues={values[regionId]}
          regionHidden={regionValuesHidden(values[regionId])}
        />
      );
    }
    case "position-order":
    case "children":
      return null;
    default:
      return assertNever(row);
  }
}

/**
 * A bar reading's detail rows for where it sits now: the Density row says what
 * Auto is at that spot, and the rows a Compact reading ignores are left out.
 * A phone's footer has one density, so it draws no Density row and hides none.
 */
function readingFineTuneRows(input: {
  readonly rows: ReadonlyArray<FineTuneRowFacts>;
  readonly region: BarRegionId;
  readonly values: LayoutValues;
  readonly arrangement: LayoutArrangement;
  readonly narrow: boolean;
}): ReadonlyArray<FineTuneRowFacts> {
  const { rows, region, values, arrangement, narrow } = input;
  if (narrow) return rows.filter((row) => row.id !== "density");
  const density = values[region].density;
  const compact =
    resolvedReadingDensity(density, arrangement, region) === "compact";
  const ignored = compactIgnoredRows(region);
  return rows
    .filter((row) => !compact || !ignored.includes(row.id))
    .map((row) =>
      row.id === "density"
        ? {
            ...row,
            description: densityDescription(
              region,
              readingPlacement(arrangement, region),
              arrangement.tabStripPlacement,
            ),
          }
        : row,
    );
}

/**
 * One of the two readings as its own section: its name, a Show switch, then its
 * Location and detail rows, with the Profiles list under Usage limits. Always
 * open - a section this short has nothing to disclose.
 */
function ReadingSection(props: {
  readonly regionId: BarRegionId;
  readonly snapshot: LayoutSnapshot;
  readonly values: LayoutValues;
  readonly selected: boolean;
}): ReactNode {
  const { regionId, snapshot, values, selected } = props;
  const facts = regionFacts(regionId);
  const gutter = useSortableRowPadding();
  const shown = !regionValuesHidden(values[regionId]);
  const changed = regionRowChanged(snapshot, regionId);
  return (
    <section
      data-region-section={regionId}
      aria-label={facts.name}
      className={cn(
        "flex flex-col border-b border-border/40 last:border-b-0",
        selected && "bg-foreground/6 shadow-[inset_2px_0_0_var(--ring)]",
      )}
    >
      <div className={cn("flex items-center gap-2", gutter.row)}>
        <facts.icon aria-hidden className="size-3.5 text-muted-foreground" />
        <h3 className="font-medium text-foreground">{facts.name}</h3>
        {changed ? (
          <span className="-my-1 flex shrink-0">
            <RevertButton
              label={`Revert ${facts.name}`}
              onRevert={() => {
                revertRegion(regionId);
              }}
            />
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2 text-muted-foreground">
          <label htmlFor={`show-${regionId}`}>Show</label>
          <Switch
            id={`show-${regionId}`}
            data-region-show={regionId}
            aria-label={`Show ${facts.name}`}
            checked={shown}
            onCheckedChange={(next) => {
              setRegionShown(regionId, next);
            }}
          />
        </div>
      </div>
      <RegionRowDetail
        regionId={regionId}
        snapshot={snapshot}
        values={values}
      />
      {regionId === "usageLimits" && shown ? (
        <UsageProfilesList arrangement={snapshot.arrangement} values={values} />
      ) : null}
    </section>
  );
}

/** The grammar row kinds a row's disclosure draws. */
const DETAIL_ROW_KINDS: ReadonlyArray<string> = [
  "position-host",
  "position-side",
  "style",
  "fine-tune",
];

function regionDetailRows(
  regionId: RegionId,
  narrow: boolean,
  availability: SettingsAvailabilityContext,
): ReadonlyArray<AnyGrammarRow> {
  // Annotated rather than inferred: indexing the registry with a UNION of ids
  // gives a union of arrays, and a `filter` on one of those has no single
  // callable signature.
  const declared: ReadonlyArray<AnyGrammarRow> = LAYOUT_REGIONS[regionId].rows;
  return declared.filter(
    (row) =>
      DETAIL_ROW_KINDS.includes(row.kind) &&
      regionRowAvailable(regionId, row, narrow) &&
      (regionId !== "minimap" ||
        row.kind !== "position-side" ||
        isMinimapSideRowAvailable(availability)),
  );
}

/**
 * Whether this region differs from what shipped, in any of the three ways it
 * can - its values, where it sits, or (for Usage limits) its Profiles list's
 * hidden providers and order (P-6, P-7). A provider's limits are not counted:
 * they are edited in Settings ▸ Providers.
 */
function regionRowChanged(
  snapshot: LayoutSnapshot,
  regionId: RegionId,
): boolean {
  return (
    regionChanged(snapshot, regionId) ||
    regionPositionMoved(snapshot, regionId) ||
    (regionId === "usageLimits" && usageProvidersChanged(snapshot.arrangement))
  );
}

/**
 * Everything this row's dot measures, put back as ONE step: its values, where
 * it sits, and - for Usage limits - its hidden providers and their order,
 * leaving each provider's limits alone.
 */
function revertRegion(regionId: RegionId): void {
  const snapshot = getLayoutSnapshot();
  const changes: ReadonlyArray<LayoutChange> = [
    ...layoutChanges(snapshot).styles.filter(
      (change) => change.region === regionId,
    ),
    ...(regionId === "usageLimits"
      ? layoutChanges(snapshot).arrangement.filter(
          (change) =>
            change.kind === "order" && change.group === "usageProviders",
        )
      : []),
  ];
  const reverted = changes.reduce(
    (current, change) => revertLayoutChange(current, change),
    snapshot,
  );
  const placed = regionPositionMoved(snapshot, regionId)
    ? revertPositionRow(reverted.arrangement, regionId)
    : reverted.arrangement;
  const next: LayoutSnapshot = {
    ...reverted,
    arrangement:
      regionId === "usageLimits"
        ? { ...placed, hiddenProviders: DEFAULT_ARRANGEMENT.hiddenProviders }
        : placed,
  };
  useLayoutEditorStore.getState().recordGesture(() => {
    useLayoutStore.getState().replaceAll(next);
  });
}

/**
 * A row id back as a region id, by asking the registry rather than asserting.
 * Divider rows answer `null` and stay undecorated; a provider id answers
 * `null` here and is decorated as a provider instead.
 */
function asRegionId(id: string): RegionId | null {
  return LAYOUT_REGION_LIST.find((region) => region.id === id)?.id ?? null;
}

function surfaceLabel(surface: SurfaceGroupId): string {
  return SURFACE_GROUPS.find((group) => group.id === surface)?.label ?? "";
}

import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import {
  isMinimapSideRowAvailable,
  type SettingsAvailabilityContext,
} from "@/lib/settings/settings-availability";
import { isWindowedRateLimitProvider } from "@/lib/rate-limits/rate-limit-window-catalog";
import type { ReactNode } from "react";
import { RevertButton } from "@/components/layout-editor/inspector/inspector-row";
import { ProviderLimitsControl } from "@/components/layout-editor/inspector/provider-limits";
import {
  ProviderDisplayControl,
  RegionDisplayControl,
} from "@/components/layout-editor/inspector/region-controls";
import { assertNever } from "@/components/layout-editor/inspector/rows/assert-never";
import { FineTuneRows } from "@/components/layout-editor/inspector/rows/fine-tune-row";
import { fineTuneRowLiveWhileHidden } from "@/components/layout-editor/inspector/region-control-io";
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
  providerChanged,
  regionChanged,
  reorderedGroups,
  revertLayoutChange,
  revertProvider,
  usageProvidersChanged,
  type LayoutChange,
} from "@/lib/layout/layout-diff";
import {
  DEFAULT_ARRANGEMENT,
  type LayoutArrangement,
  type OrderGroupId,
} from "@/lib/layout/layout-arrangement";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import {
  regionValuesHidden,
  type LayoutValues,
} from "@/lib/layout/layout-values";
import { providerDisplayName } from "@/lib/provider-ordering";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
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
  const arrangement = snapshot.arrangement;
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
    if (regionId === null) {
      return providerRowDecoration(id, arrangement, openRows, onToggleRow);
    }
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
  const groups = SURFACE_ORDER_GROUPS[surface].filter((group) =>
    groupIsDrawn(group, values),
  );

  return (
    <div data-layout-area-form={surface} className="flex flex-col">
      <SurfaceLeadingRows surface={surface} />
      {loose.length === 0 ? null : (
        <SortableList
          label={`${surfaceLabel(surface)} settings`}
          selectedId={selectedRow}
          items={regionRowItems(loose, values, decorate)}
          onMove={null}
        />
      )}
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
 * Whether the list's own subject is on screen at all: the providers are the
 * segments of ONE region, so a Providers list under a hidden Usage limits row
 * would be a list of parts of something that is not there (redesign 5.4).
 */
function groupIsDrawn(group: OrderGroupId, values: LayoutValues): boolean {
  return group !== "usageProviders" || values.usageLimits.shown === "shown";
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
  // The providers list is the one group no region declares.
  if (group === "usageProviders") {
    return {
      ...arrangement,
      usageProviders: DEFAULT_ARRANGEMENT.usageProviders,
    };
  }
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
 * One provider row: its `Shown | Hidden` state, its revert,
 * and its own Limits pick as the row's disclosure (L-123).
 */
function providerRowDecoration(
  id: string,
  arrangement: LayoutArrangement,
  openRows: ReadonlyArray<string>,
  onToggleRow: (rowId: string) => void,
): SortableRowDecoration {
  const providerId = usageProviderId(arrangement, id);
  if (providerId === null) return BARE_ROW;
  const changed = providerChanged(arrangement, providerId);
  const name = providerDisplayName(providerId);
  const windowed = isWindowedRateLimitProvider(providerId);
  return {
    ...BARE_ROW,
    control: <ProviderDisplayControl providerId={providerId} />,
    revert: changed ? (
      <RevertButton
        label={`Revert ${name}`}
        onRevert={() => {
          writeArrangement(revertProvider(arrangement, providerId));
        }}
      />
    ) : null,
    detail: windowed ? <ProviderLimitsControl providerId={providerId} /> : null,
    open: windowed && openRows.includes(id),
    onToggleOpen: windowed
      ? () => {
          onToggleRow(id);
        }
      : null,
  };
}

/**
 * The row's id back as a provider id, by looking it up in the list it came
 * from rather than asserting (G1-23).
 */
function usageProviderId(
  arrangement: LayoutArrangement,
  id: string,
): RateLimitProviderId | null {
  return arrangement.usageProviders.find((entry) => entry === id) ?? null;
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
  switch (row.kind) {
    case "position-host":
      return (
        <PositionHostRow
          regionId={regionId}
          arrangement={arrangement}
          snapshot={snapshot}
          description={row.description}
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
    case "fine-tune":
      return (
        <FineTuneRows
          rows={row.rows}
          regionId={regionId}
          regionValues={values[regionId]}
          regionHidden={regionValuesHidden(values[regionId])}
        />
      );
    case "position-order":
    case "children":
      return null;
    default:
      return assertNever(row);
  }
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
 * can - its values, where it sits, or (for Usage limits) the providers it
 * draws (P-6, P-7).
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
 * it sits, and - for Usage limits - its providers.
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
            change.kind === "provider" ||
            (change.kind === "order" && change.group === "usageProviders"),
        )
      : []),
  ];
  const reverted = changes.reduce(
    (current, change) => revertLayoutChange(current, change),
    snapshot,
  );
  const next: LayoutSnapshot = regionPositionMoved(snapshot, regionId)
    ? {
        ...reverted,
        arrangement: revertPositionRow(reverted.arrangement, regionId),
      }
    : reverted;
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

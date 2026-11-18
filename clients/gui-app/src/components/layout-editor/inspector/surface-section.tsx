import { useId, type ReactNode } from "react";
import { RevertButton } from "@/components/layout-editor/inspector/inspector-row";
import { useLayoutFormHost } from "@/components/layout-editor/inspector/layout-form-host";
import { RegionDisplayControl } from "@/components/layout-editor/inspector/region-controls";
import { UsageProfilesList } from "@/components/layout-editor/inspector/usage-profiles";
import { useLayoutFormContext } from "@/components/layout-editor/inspector/use-layout-form-context";
import { assertNever } from "@/components/layout-editor/inspector/rows/assert-never";
import {
  FineTuneRowView,
  type FineTuneRowFacts,
} from "@/components/layout-editor/inspector/rows/fine-tune-row";
import { setRegionShown } from "@/components/layout-editor/layout-gestures";
import {
  densityDescription,
  readingFormPlacement,
} from "@/components/layout-editor/regions/reading-placement";
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
import { SurfaceAreaRows } from "@/components/layout-editor/inspector/rows/surface-placement-rows";
import { SortableList } from "@/components/layout-editor/inspector/sortable-list";
import { useSortableRowPadding } from "@/components/layout-editor/inspector/sortable-row-padding";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import { HOME_TAB_PHONE_HINT } from "@/components/layout-editor/regions/top-bar-regions";
import {
  LAYOUT_REGION_LIST,
  regionFacts,
  regionHasDisplayControl,
  type AnyGrammarRow,
} from "@/components/layout-editor/regions/region-facts";
import {
  LOCATION_ROW_ID,
  SIDE_ROW_ID,
  SURFACE_GROUPS,
  type SurfaceGroupId,
} from "@/components/layout-editor/regions/region-grammar";
import { revertOrderGroup } from "@/components/layout-editor/regions/region-position-rows";
import {
  INDEPENDENT,
  orderedRows,
  outlivesGate,
  type LayoutFormContext,
  type OrderedRow,
  type RowDependency,
} from "@/components/layout-editor/regions/row-availability";
import {
  regionRowChanged,
  revertedRegionRow,
} from "@/components/layout-editor/regions/surface-diff";
import {
  looseSurfaceRegions,
  orderGroupHeaded,
  orderGroupListLabel,
  SURFACE_ORDER_GROUPS,
  toolbarMembers,
} from "@/components/layout-editor/regions/surface-groups";
import { writeArrangement } from "@/lib/layout/arrangement-gestures";
import { reorderedGroups } from "@/lib/layout/layout-diff";
import {
  asBarRegionId,
  BAR_REGION_IDS,
  type BarRegionId,
  type OrderGroupId,
} from "@/lib/layout/layout-arrangement";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import { regionValuesHidden } from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";
import { isMobileFooterRowAvailable } from "@/lib/settings/settings-availability";
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
 * Which rows exist, where each sits and how it says it is off is the
 * registry's (`regions/row-availability.ts`, P1): every row here is ordered by
 * `orderedRows` and drawn through the one row shell, against the one
 * {@link LayoutFormContext} this section builds.
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
  const context = useLayoutFormContext();
  const values = context.values;
  const narrow = context.shell.phoneLayout;
  const footerGateId = useId();
  const footerGated = surface === "statusBar" && footerOff(context);

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
      hint !== null || regionDetailRows(regionId, context).length > 0;
    return {
      ...BARE_ROW,
      hint,
      availability: regionFacts(regionId).availability(context),
      control: regionHasDisplayControl(regionId, narrow) ? (
        <RegionDisplayControl regionId={regionId} values={values} />
      ) : null,
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
          context={context}
          gateId={null}
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

  const loose = looseSurfaceRegions(surface).filter((regionId) =>
    regionPresent(regionId, context),
  );
  const groups = SURFACE_ORDER_GROUPS[surface];

  return (
    <div data-layout-area-form={surface} className="flex flex-col">
      <SurfaceAreaRows surface={surface} place="leading" context={context} />
      {footerGated ? (
        // The ONE reason for every reading row below (U1), under the switch
        // it names; each gated row's group points here.
        <GateHint id={footerGateId}>
          Turn on Status bar on small screens to use these. Show still decides
          the header icons.
        </GateHint>
      ) : null}
      {surface === "statusBar"
        ? BAR_REGION_IDS.map((regionId) => (
            <ReadingSection
              key={regionId}
              regionId={regionId}
              snapshot={snapshot}
              context={context}
              selected={selectedRow === regionId}
              gateId={footerGated ? footerGateId : null}
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
          context={context}
          decorate={decorate}
          selectedRow={selectedRow}
        />
      ))}
      <SurfaceAreaRows surface={surface} place="trailing" context={context} />
    </div>
  );
}

/**
 * Whether the phone layout draws its footer off: then the two readings are
 * the header's icons, which read nothing below Show (U1). The same predicate
 * the switch's own row exists by.
 */
function footerOff(context: LayoutFormContext): boolean {
  return (
    isMobileFooterRowAvailable(context.shell) &&
    !context.arrangement.mobileFooter
  );
}

/**
 * One order group as a headed list: the list's name with its own revert, and
 * how it is operated (L-127, LV2-18). A group with no member here draws
 * nothing - no heading over an empty list, no rule under it.
 */
function SurfaceOrderList(props: {
  readonly group: OrderGroupId;
  readonly context: LayoutFormContext;
  readonly decorate: (id: string) => SortableRowDecoration;
  readonly selectedRow: RegionId | null;
}): ReactNode {
  const { group, context, decorate, selectedRow } = props;
  const arrangement = context.arrangement;
  const narrow = context.shell.phoneLayout;
  if (
    (group === "toolbarLeft" || group === "toolbarRight") &&
    toolbarMembers(group, narrow, context).length === 0
  )
    return null;
  const headed = orderGroupHeaded(group, narrow);
  const moved = headed && reorderedGroups(arrangement).includes(group);
  return (
    // A list with no header still starts on a rule, as every other row does.
    <div
      className={cn("flex flex-col", !headed && "border-t border-border/40")}
    >
      {headed ? (
        <div className="border-b border-border/40">
          <OrderGroupHeader
            group={group}
            revert={
              moved ? (
                <RevertButton
                  label={`Revert ${orderGroupListLabel(group)} order`}
                  onRevert={() => {
                    writeArrangement(revertOrderGroup(arrangement, group));
                  }}
                />
              ) : null
            }
          />
        </div>
      ) : null}
      <OrderGroupList
        group={group}
        selectedId={selectedRow}
        values={context.values}
        arrangement={arrangement}
        decorate={decorate}
        context={context}
      />
    </div>
  );
}

/**
 * A region's detail row as the section orders it: every kind its disclosure
 * draws, under the one id its siblings name it by (`depends.under`).
 */
type DetailRow =
  | {
      readonly kind: "position-host";
      readonly id: string;
      readonly depends: RowDependency;
    }
  | {
      readonly kind: "position-side";
      readonly id: string;
      readonly depends: RowDependency;
      readonly description: string;
    }
  | {
      readonly kind: "style";
      readonly id: string;
      readonly depends: RowDependency;
      readonly row: Extract<AnyGrammarRow, { readonly kind: "style" }>;
    }
  | {
      readonly kind: "fine-tune";
      readonly id: string;
      readonly depends: RowDependency;
      readonly row: FineTuneRowFacts;
    }
  | {
      readonly kind: "children";
      readonly id: string;
      readonly depends: RowDependency;
    };

/**
 * A region's detail rows in the order they are drawn, each with what it says
 * about itself; a row its rule leaves out of this shell is not here.
 * `position-order` IS the list the region's row sits in, so it is no detail.
 */
function regionDetailRows(
  regionId: RegionId,
  context: LayoutFormContext,
): ReadonlyArray<OrderedRow<DetailRow>> {
  // Annotated rather than inferred: indexing the registry with a UNION of ids
  // gives a union of arrays, and a `flatMap` on one of those has no single
  // callable signature.
  const declared: ReadonlyArray<AnyGrammarRow> = LAYOUT_REGIONS[regionId].rows;
  const rows = declared.flatMap((row): ReadonlyArray<DetailRow> => {
    switch (row.kind) {
      case "position-host":
        return [{ kind: row.kind, id: LOCATION_ROW_ID, depends: row.depends }];
      case "position-side":
        return [
          {
            kind: row.kind,
            id: SIDE_ROW_ID,
            depends: row.depends,
            description: row.description,
          },
        ];
      case "style":
        return [{ kind: row.kind, id: row.key, depends: row.depends, row }];
      case "fine-tune":
        return row.rows.map((detail): DetailRow => ({
          kind: "fine-tune",
          id: detail.id,
          depends: detail.depends,
          row: detail,
        }));
      case "children":
        return [{ kind: row.kind, id: row.level, depends: INDEPENDENT }];
      case "position-order":
        return [];
      default:
        return assertNever(row);
    }
  });
  return orderedRows(rows, context);
}

/**
 * What the row's disclosure opens: Location, Side, Style and the detail rows,
 * in `orderedRows`' order, each saying through the row shell what it depends
 * on.
 *
 * While the region is Hidden - or, for a reading, while the phone layout's
 * footer is off (`gateId`) - they stay readable and disabled, and a hint
 * above them (or the area's one footer reason) says how to change them: a
 * disabled `fieldset` turns every control off without taking any of them out
 * of the accessibility tree, and each points `aria-describedby` at the hint.
 * A detail row something else still reads stays live (its rule answers
 * `liveOutsideGate`, L-174), so the hint then names only the rest.
 */
function RegionRowDetail(props: {
  readonly regionId: RegionId;
  readonly snapshot: LayoutSnapshot;
  readonly context: LayoutFormContext;
  /** The area's own reason these rows are off, or `null`. */
  readonly gateId: string | null;
}): ReactNode {
  const { regionId, snapshot, context, gateId } = props;
  const hintId = useId();
  const rows = regionDetailRows(regionId, context);
  if (rows.length === 0) return null;
  const hidden = regionValuesHidden(context.values[regionId]);
  const gates = [hidden ? hintId : null, gateId].filter(
    (id): id is string => id !== null,
  );
  const someLive = rows.some((ordered) => outlivesGate(ordered.availability));
  return (
    <div data-region-detail={regionId}>
      {hidden ? (
        <GateHint id={hintId}>
          Show {regionFacts(regionId).name} to change{" "}
          {someLive ? "its other settings" : "these settings"}.
        </GateHint>
      ) : null}
      {rows.map((ordered) => {
        const gated = gates.length > 0 && !outlivesGate(ordered.availability);
        return (
          <fieldset
            key={ordered.row.id}
            disabled={gated}
            aria-describedby={gated ? gates.join(" ") : undefined}
            className="m-0 min-w-0 border-0 p-0"
          >
            <DetailRowView
              ordered={ordered}
              regionId={regionId}
              snapshot={snapshot}
              context={context}
            />
          </fieldset>
        );
      })}
    </div>
  );
}

/**
 * Why a whole group of rows is off, above them: the label column, the host's
 * description size.
 */
function GateHint(props: {
  readonly id: string;
  readonly children: ReactNode;
}): ReactNode {
  const gutter = useSortableRowPadding();
  const page = useLayoutFormHost() === "page";
  return (
    <div className={gutter.row}>
      <p
        id={props.id}
        className={cn(
          "ml-11 max-w-[72ch] text-pretty text-muted-foreground",
          page ? "text-ui-sm" : "text-ui-xs",
        )}
      >
        {props.children}
      </p>
    </div>
  );
}

/** One detail row, drawn by the module that owns its KIND. */
function DetailRowView(props: {
  readonly ordered: OrderedRow<DetailRow>;
  readonly regionId: RegionId;
  readonly snapshot: LayoutSnapshot;
  readonly context: LayoutFormContext;
}): ReactNode {
  const { ordered, regionId, snapshot, context } = props;
  const { row, depth, availability } = ordered;
  const arrangement = context.arrangement;
  switch (row.kind) {
    case "position-host":
      return (
        <PositionHostRow
          regionId={regionId}
          arrangement={arrangement}
          snapshot={snapshot}
          availability={availability}
          depth={depth}
        />
      );
    case "position-side":
      return (
        <PositionSideRow
          regionId={regionId}
          arrangement={arrangement}
          snapshot={snapshot}
          description={row.description}
          availability={availability}
          depth={depth}
        />
      );
    case "style":
      return (
        <StyleRow
          anchor={null}
          icon={null}
          label={row.row.label}
          description={row.row.description}
          styleKey={row.row.key}
          labelPlacement={row.row.labelPlacement}
          examples={row.row.examples}
          regionId={regionId}
          values={context.values}
          arrangement={arrangement}
          availability={availability}
          depth={depth}
        />
      );
    case "fine-tune":
      return (
        <FineTuneRowView
          row={withDensityDescription(row.row, regionId, context)}
          regionId={regionId}
          regionValues={context.values[regionId]}
          arrangement={arrangement}
          availability={availability}
          depth={depth}
        />
      );
    case "children":
      return (
        <UsageProfilesList
          arrangement={arrangement}
          values={context.values}
          context={context}
        />
      );
    default:
      return assertNever(row);
  }
}

/**
 * A bar reading's Density row says what Auto is where the reading is drawn
 * now - the phone layout's footer being the status bar.
 */
function withDensityDescription(
  row: FineTuneRowFacts,
  regionId: RegionId,
  context: LayoutFormContext,
): FineTuneRowFacts {
  const bar = asBarRegionId(regionId);
  if (bar === null || row.id !== "density") return row;
  return {
    ...row,
    description: densityDescription(
      bar,
      readingFormPlacement(context, bar),
      context.arrangement.tabStripPlacement,
    ),
  };
}

/**
 * One of the two readings as its own section: its name, a Show switch, then its
 * Location and detail rows, with the Profiles list under Usage limits. Always
 * open - a section this short has nothing to disclose.
 *
 * Show stays live while the phone layout's footer is off: it is what decides
 * the header's icon then.
 */
function ReadingSection(props: {
  readonly regionId: BarRegionId;
  readonly snapshot: LayoutSnapshot;
  readonly context: LayoutFormContext;
  readonly selected: boolean;
  readonly gateId: string | null;
}): ReactNode {
  const { regionId, snapshot, context, selected, gateId } = props;
  const facts = regionFacts(regionId);
  const gutter = useSortableRowPadding();
  // Both hosts can be mounted at once, so the switch's id is per instance.
  const showId = useId();
  const shown = !regionValuesHidden(context.values[regionId]);
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
          <label htmlFor={showId}>Show</label>
          <Switch
            id={showId}
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
        context={context}
        gateId={gateId}
      />
    </section>
  );
}

/** Whether a region is a row in this shell at all (its shell gate). */
function regionPresent(
  regionId: RegionId,
  context: LayoutFormContext,
): boolean {
  return regionFacts(regionId).shellGate(context.shell);
}

/**
 * Everything this row's dot measures (`regionRowChanged`), put back as ONE
 * step. Order stays: it is the list header's revert (T2).
 */
function revertRegion(regionId: RegionId): void {
  const next = revertedRegionRow(getLayoutSnapshot(), regionId);
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

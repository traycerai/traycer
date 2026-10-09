import type { ReactNode } from "react";
import { LayoutFormRow } from "@/components/layout-editor/inspector/rows/layout-form-row";
import { BARE_ROW } from "@/components/layout-editor/inspector/rows/order-row-items";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "@/components/layout-editor/inspector/segmented-control";
import {
  changedControlKeys,
  isControlValueChanged,
  readControlValue,
  revertControlValue,
  revertControlValues,
  writeControlValue,
} from "@/components/layout-editor/inspector/region-control-io";
import { SortableList } from "@/components/layout-editor/inspector/sortable-list";
import type {
  RowDependency,
  ShownRowAvailability,
} from "@/components/layout-editor/regions/row-availability";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { writeArrangementField } from "@/lib/layout/arrangement-gestures";
import {
  DEFAULT_ARRANGEMENT,
  movedWithin,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import { pinnedFieldOrderChanged } from "@/lib/layout/layout-diff";
import type { LayoutValues, RegionValueKey } from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useLayoutStore } from "@/stores/layout/layout-store";

/** A region's detail rows, and the four control shapes they are operated with. */

/**
 * A fine-tune row as a caller walking EVERY region sees it.
 *
 * The registry's own `FineTuneRow<K>` ties each key to its region, which does
 * not survive the walk (see `RegionRowFacts`); what does survive is
 * `RegionValueKey`, the union of every region's keys, so a row still cannot
 * name something no region has.
 */
export interface FineTuneRowFacts {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
  readonly depends: RowDependency;
  readonly control:
    | { readonly kind: "switch"; readonly key: RegionValueKey }
    | {
        readonly kind: "segment";
        readonly key: RegionValueKey;
        readonly options: ReadonlyArray<SegmentedControlOption>;
      }
    | {
        readonly kind: "checks";
        readonly options: ReadonlyArray<{
          readonly key: RegionValueKey;
          readonly label: string;
        }>;
      }
    | {
        readonly kind: "field-checks";
        readonly key: RegionValueKey;
        readonly options: ReadonlyArray<SegmentedControlOption>;
      };
}

/**
 * One detail row, drawn where the region's disclosure places it
 * (`orderedRows`): its control, its revert, and what it depends on through
 * the row shell. A row whose controller leaves it doing nothing stays in
 * place, disabled, and says why.
 */
export function FineTuneRowView(props: {
  readonly row: FineTuneRowFacts;
  readonly regionId: RegionId;
  readonly regionValues: LayoutValues[RegionId];
  readonly arrangement: LayoutArrangement;
  readonly availability: ShownRowAvailability;
  readonly depth: 0 | 1;
}): ReactNode {
  const { row, regionId, regionValues, availability, depth } = props;
  const { control } = row;

  if (control.kind === "switch") {
    const checked = readControlValue(regionValues, control.key) === true;
    return (
      <LayoutFormRow
        anchor={null}
        icon={null}
        stacked={false}
        selected={false}
        availability={availability}
        depth={depth}
        label={row.label}
        revertLabel={`Revert ${row.label}`}
        description={row.description}
        onRevert={
          isControlValueChanged(regionId, control.key)
            ? () => {
                revertControlValue(regionId, control.key);
              }
            : null
        }
        control={
          <Switch
            aria-label={row.label}
            checked={checked}
            onCheckedChange={(next) => {
              writeControlValue(regionId, control.key, next);
            }}
          />
        }
      />
    );
  }

  if (control.kind === "segment") {
    const value = String(readControlValue(regionValues, control.key));
    return (
      <LayoutFormRow
        anchor={null}
        icon={null}
        stacked={false}
        selected={false}
        availability={availability}
        depth={depth}
        label={row.label}
        revertLabel={`Revert ${row.label}`}
        description={row.description}
        onRevert={
          isControlValueChanged(regionId, control.key)
            ? () => {
                revertControlValue(regionId, control.key);
              }
            : null
        }
        control={
          <SegmentedControl
            ariaLabel={row.label}
            options={control.options}
            value={value}
            onChange={(next) => {
              writeControlValue(regionId, control.key, next);
            }}
          />
        }
      />
    );
  }

  if (control.kind === "checks") {
    const keys = control.options.map((option) => option.key);
    return (
      <LayoutFormRow
        anchor={null}
        icon={null}
        stacked
        selected={false}
        availability={availability}
        depth={depth}
        label={row.label}
        revertLabel={`Revert ${row.label}`}
        description={row.description}
        onRevert={
          keys.some((key) => isControlValueChanged(regionId, key))
            ? () => {
                revertControlValues(regionId, keys);
              }
            : null
        }
        control={
          <div className="flex flex-col gap-1.5">
            {control.options.map((option) => {
              const checked =
                readControlValue(regionValues, option.key) === true;
              return (
                <label
                  key={option.key}
                  className="flex items-center gap-2 text-ui-sm"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) => {
                      writeControlValue(regionId, option.key, next === true);
                    }}
                  />
                  {option.label}
                </label>
              );
            })}
          </div>
        }
      />
    );
  }

  const order = props.arrangement.pinnedContextFieldOrder;
  const changed =
    isControlValueChanged(regionId, control.key) ||
    pinnedFieldOrderChanged(props.arrangement, DEFAULT_ARRANGEMENT);
  return (
    <LayoutFormRow
      anchor={null}
      icon={null}
      stacked
      selected={false}
      availability={availability}
      depth={depth}
      label={row.label}
      revertLabel={`Revert ${row.label}`}
      description={row.description}
      onRevert={
        changed
          ? () => {
              revertFieldChecks(regionId, control.key);
            }
          : null
      }
      control={
        <FieldChecksList
          label={row.label}
          regionId={regionId}
          regionValues={regionValues}
          valueKey={control.key}
          options={control.options}
          order={order}
          // A list nobody can use is not one to drag either: its rows are
          // disabled by the row's fieldset, and its drag by this.
          movable={availability.kind !== "disabled"}
        />
      }
    />
  );
}

/**
 * The pinned breakdown's rows as one sortable check list (C2): a check writes
 * the SET (`pinnedFields`, canonically ordered), a drag writes the ORDER
 * (`pinnedContextFieldOrder`, every field including the unchecked, so a
 * field's place survives being unchecked). The strip prints the checked ones
 * in that order.
 */
function FieldChecksList(props: {
  readonly label: string;
  readonly regionId: RegionId;
  readonly regionValues: LayoutValues[RegionId];
  readonly valueKey: RegionValueKey;
  readonly options: ReadonlyArray<SegmentedControlOption>;
  readonly order: ReadonlyArray<string>;
  readonly movable: boolean;
}): ReactNode {
  const { label, regionId, regionValues, valueKey, options, order } = props;
  const currentList = readControlValue(regionValues, valueKey);
  const selected = Array.isArray(currentList) ? currentList : [];
  // The list cannot be emptied. An empty pinned breakdown is not a state the
  // card has - it would draw an empty box - so the resolver drops it, and
  // before this guard the user emptied the list, watched the card go blank for
  // the session and found every row back on the next launch (G1-07).
  const last = selected.length <= 1;
  const ordered = [
    ...order.filter((value) =>
      options.some((option) => option.value === value),
    ),
    ...options
      .map((option) => option.value)
      .filter((value) => !order.includes(value)),
  ];
  return (
    <SortableList<string>
      label={label}
      selectedId={null}
      onMove={
        props.movable
          ? (id, toIndex) => {
              const from = ordered.indexOf(id);
              if (from < 0) return;
              writeFieldChecksOrder(movedWithin(ordered, from, toIndex));
            }
          : null
      }
      items={ordered.map((value) => {
        const checked = selected.includes(value);
        // Named rather than written inline: `react/jsx-no-leaked-render`
        // autofixes a `&&` in a JSX position into `? … : null`, and
        // `disabled` takes a boolean.
        const locked = checked && last;
        const optionLabel =
          options.find((option) => option.value === value)?.label ?? value;
        return {
          ...BARE_ROW,
          id: value,
          label: optionLabel,
          icon: null,
          glyph: null,
          divider: false,
          movable: true,
          dimmed: !checked,
          onRemove: null,
          removeLabel: null,
          onStack: null,
          stackMembers: null,
          control: (
            <Checkbox
              aria-label={`Show ${optionLabel}`}
              checked={checked}
              disabled={locked}
              onCheckedChange={(next) => {
                const nextList = options
                  .map((entry) => entry.value)
                  .filter((entry) =>
                    entry === value ? next === true : selected.includes(entry),
                  );
                if (nextList.length === 0) return;
                writeControlValue(regionId, valueKey, nextList);
              }}
            />
          ),
        };
      })}
    />
  );
}

/**
 * A new order for the pinned breakdown, kept to the fields the arrangement
 * knows: the list's ids came from that very array, so this only re-finds
 * them in its own type.
 */
function writeFieldChecksOrder(ids: ReadonlyArray<string>): void {
  const known = useLayoutStore.getState().arrangement.pinnedContextFieldOrder;
  writeArrangementField(
    "pinnedContextFieldOrder",
    ids.flatMap((id) => known.filter((field) => field === id)),
  );
}

/** The set and its order put back as ONE gesture: one row, one undo step. */
function revertFieldChecks(regionId: RegionId, key: RegionValueKey): void {
  const keys = changedControlKeys(regionId, [key]);
  useLayoutEditorStore.getState().recordGesture(() => {
    const store = useLayoutStore.getState();
    if (keys.length > 0) store.clearRegionValues(regionId, keys);
    store.setArrangement({
      ...store.arrangement,
      pinnedContextFieldOrder: DEFAULT_ARRANGEMENT.pinnedContextFieldOrder,
    });
  });
}

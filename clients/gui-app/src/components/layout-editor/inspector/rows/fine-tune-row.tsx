import type { ReactNode } from "react";
import { LayoutFormRow } from "@/components/layout-editor/inspector/rows/layout-form-row";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "@/components/layout-editor/inspector/segmented-control";
import {
  fineTuneRowLiveWhileHidden,
  isControlValueChanged,
  readControlValue,
  revertControlValue,
  revertControlValues,
  writeControlValue,
} from "@/components/layout-editor/inspector/region-control-io";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import type { LayoutValues, RegionValueKey } from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";

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
  readonly requires: RegionValueKey | null;
  readonly liveWhileHidden: RegionValueKey | null;
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
 * A region's detail rows, drawn in place inside its row's disclosure. A row
 * whose prerequisite is off stays readable and disabled, rather than leaving
 * the form (the breakdown rows while Pin breakdown is off). While the region
 * is Hidden every row greys with it, except one another reader still follows
 * (`liveWhileHidden`).
 */
export function FineTuneRows(props: {
  readonly rows: ReadonlyArray<FineTuneRowFacts>;
  readonly regionId: RegionId;
  readonly regionValues: LayoutValues[RegionId];
  readonly regionHidden: boolean;
}): ReactNode {
  const { rows, regionId, regionValues, regionHidden } = props;
  return (
    <div className="border-t border-border/40">
      {rows.map((row) => {
        const disabled =
          (regionHidden && !fineTuneRowLiveWhileHidden(row, regionValues)) ||
          (row.requires !== null &&
            readControlValue(regionValues, row.requires) !== true);
        const prerequisite =
          row.requires === null ? null : requiredRowLabel(rows, row.requires);
        return (
          // A disabled `fieldset` turns the controls off and keeps the row,
          // its label and why it is off in the accessibility tree.
          <fieldset
            key={row.id}
            disabled={disabled}
            className="m-0 min-w-0 border-0 p-0"
          >
            <FineTuneRowView
              row={row}
              regionId={regionId}
              regionValues={regionValues}
            />
            {disabled && prerequisite !== null ? (
              <p className="px-2.5 pb-2 text-ui-xs text-muted-foreground">
                Turn on {prerequisite} to change this.
              </p>
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}

/** The label of the switch a row depends on, for its "Turn on …" line. */
function requiredRowLabel(
  rows: ReadonlyArray<FineTuneRowFacts>,
  key: RegionValueKey,
): string | null {
  return (
    rows.find((row) => row.control.kind === "switch" && row.control.key === key)
      ?.label ?? null
  );
}

function FineTuneRowView(props: {
  readonly row: FineTuneRowFacts;
  readonly regionId: RegionId;
  readonly regionValues: LayoutValues[RegionId];
}): ReactNode {
  const { row, regionId, regionValues } = props;
  const { control } = row;

  if (control.kind === "switch") {
    const checked = readControlValue(regionValues, control.key) === true;
    return (
      <LayoutFormRow
        anchor={null}
        icon={null}
        stacked={false}
        selected={false}
        label={row.label}
        revertLabel={`Revert ${row.label}`}
        description={row.description ?? null}
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
        label={row.label}
        revertLabel={`Revert ${row.label}`}
        description={row.description ?? null}
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
        label={row.label}
        revertLabel={`Revert ${row.label}`}
        description={row.description ?? null}
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

  const currentList = readControlValue(regionValues, control.key);
  const selected = Array.isArray(currentList) ? currentList : [];
  // The list cannot be emptied. An empty pinned breakdown is not a state the
  // card has - it would draw an empty box - so the resolver drops it, and
  // before this guard the user emptied the list, watched the card go blank for
  // the session and found every row back on the next launch (G1-07).
  const last = selected.length <= 1;
  return (
    <LayoutFormRow
      anchor={null}
      icon={null}
      stacked
      selected={false}
      label={row.label}
      revertLabel={`Revert ${row.label}`}
      description={row.description ?? "At least one row stays in the card."}
      onRevert={
        isControlValueChanged(regionId, control.key)
          ? () => {
              revertControlValue(regionId, control.key);
            }
          : null
      }
      control={
        <div className="flex flex-col gap-1.5">
          {control.options.map((option) => {
            const checked = selected.includes(option.value);
            // Named rather than written inline: `react/jsx-no-leaked-render`
            // autofixes a `&&` in a JSX position into `? … : null`, and
            // `disabled` takes a boolean.
            const locked = checked && last;
            return (
              <label
                key={option.value}
                className="flex items-center gap-2 text-ui-sm"
              >
                <Checkbox
                  checked={checked}
                  disabled={locked}
                  onCheckedChange={(next) => {
                    const nextList = control.options
                      .map((entry) => entry.value)
                      .filter((value) =>
                        value === option.value
                          ? next === true
                          : selected.includes(value),
                      );
                    if (nextList.length === 0) return;
                    writeControlValue(regionId, control.key, nextList);
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

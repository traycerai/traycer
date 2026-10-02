import type { ReactNode } from "react";
import { LayoutFormRow } from "@/components/layout-editor/inspector/rows/layout-form-row";
import {
  changedControlKeys,
  revertControlValues,
} from "@/components/layout-editor/inspector/region-control-io";
import { regionStyleDepiction } from "@/components/layout-editor/region-depiction";
import { useLiveUsageArrangement } from "@/components/layout-editor/inspector/use-layout-usage";
import { type LayoutArrangement } from "@/lib/layout/layout-arrangement";
import type { LayoutValues } from "@/lib/layout/layout-values";
import type { RegionId } from "@/lib/layout/region-id";
import { PicturedOptions } from "@/components/layout-editor/inspector/pictured-options";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useLayoutStore } from "@/stores/layout/layout-store";

/**
 * A single-value style enum (Context usage and Model's Style, Model's
 * Reasoning control), each value drawn as the real thing: a radio group of
 * pictures rather than a list of words.
 */
export function StyleRow(props: {
  readonly label: string;
  readonly description: string | null;
  /** The one key every example writes. */
  readonly styleKey: string;
  readonly labelPlacement: "end" | "above";
  readonly examples: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly patch: Partial<LayoutValues[RegionId]>;
  }>;
  readonly regionId: RegionId;
  readonly values: LayoutValues;
  readonly arrangement: LayoutArrangement;
}): ReactNode {
  const { label, styleKey, labelPlacement, examples, regionId, values } = props;
  const arrangement = useLiveUsageArrangement(props.arrangement);
  const regionValues = values[regionId];
  const matches = examples.map((example) =>
    Object.entries(example.patch).every(
      ([key, value]) => Reflect.get(regionValues, key) === value,
    ),
  );
  const keys = [styleKey];
  const changed = changedControlKeys(regionId, keys).length > 0;

  return (
    <LayoutFormRow
      anchor={null}
      icon={null}
      label={label}
      description={props.description}
      onRevert={
        changed
          ? () => {
              revertControlValues(regionId, keys);
            }
          : null
      }
      revertLabel={`Revert ${label}`}
      stacked
      selected={false}
      control={
        <StyleExamples
          label={label}
          styleKey={styleKey}
          labelPlacement={labelPlacement}
          examples={examples}
          regionId={regionId}
          values={values}
          arrangement={arrangement}
          matches={matches}
        />
      }
    />
  );
}

function StyleExamples(props: {
  readonly label: string;
  readonly styleKey: string;
  readonly labelPlacement: "end" | "above";
  readonly examples: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly patch: Partial<LayoutValues[RegionId]>;
  }>;
  readonly regionId: RegionId;
  readonly values: LayoutValues;
  readonly arrangement: LayoutArrangement;
  readonly matches: ReadonlyArray<boolean>;
}): ReactNode {
  const {
    label,
    styleKey,
    labelPlacement,
    examples,
    regionId,
    values,
    arrangement,
    matches,
  } = props;
  const checked = examples.findIndex((_, index) => matches[index]);
  return (
    <PicturedOptions
      label={label}
      value={checked === -1 ? null : examples[checked].id}
      disabled={false}
      labelPlacement={labelPlacement}
      onChange={(id) => {
        const example = examples.find((candidate) => candidate.id === id);
        if (example === undefined) return;
        useLayoutEditorStore.getState().recordGesture(() => {
          useLayoutStore.getState().setRegionValues(regionId, example.patch);
        });
      }}
      options={examples.map((example) => ({
        id: example.id,
        label: example.label,
        picture: regionStyleDepiction(
          regionId,
          styleKey,
          valuesWithPatch(regionId, values, example.patch),
          arrangement,
        ),
      }))}
    />
  );
}

/**
 * `regionStyleDepiction` needs a whole `LayoutValues`, not one region's bag, so a
 * style example - which only patches ITS OWN region - is drawn against the
 * live values with just that one region swapped in.
 *
 * Written with `Reflect.set` for the same reason `region-control-io.ts` reads
 * a control's key that way: merging one branch of the region union back into
 * the whole map cannot survive generically-typed. `example.patch` always names
 * keys from the SAME region's own registry entry, so the merge is sound even
 * though its static type cannot say so.
 */
function valuesWithPatch(
  regionId: RegionId,
  values: LayoutValues,
  patch: Partial<LayoutValues[RegionId]>,
): LayoutValues {
  const next: LayoutValues = { ...values };
  const region: object = { ...values[regionId] };
  Object.assign(region, patch);
  Reflect.set(next, regionId, region);
  return next;
}

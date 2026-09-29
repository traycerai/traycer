import {
  sameRegionValue,
  type LayoutValues,
  type RegionValueKey,
} from "@/lib/layout/layout-values";
import { PRESET_VALUES } from "@/lib/layout/layout-presets";
import type { RegionId } from "@/lib/layout/region-id";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import {
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";

/**
 * The dynamic half of the region grammar: reading and writing one control's
 * value by the registry's own `key`.
 *
 * `ControlSpec<K>.key` is `keyof LayoutValues[K] & string` for the region's
 * OWN `K`, which - as `RegionRowFacts`'s comment on `layout-regions.ts`
 * already states - cannot survive a walk over every region: `keyof` of a
 * union of the twenty-six regions' value shapes collapses to the one field
 * they all share (`shown`). Reading a section's rows generically off a plain
 * `RegionId` is exactly what keeps the grammar renderer un-written-per-region
 * (L-08), so this module reads and writes the dynamic key with `Reflect`
 * rather than a type assertion - the same way `layout-editor-store.ts`'s
 * `persistedDockMode` already reads one dynamic field.
 *
 * Two things make that seam sound rather than a cast in disguise (G1-08).
 *
 * The KEY is `RegionValueKey`, the union of every region's own value keys, so
 * a caller cannot hand this module an arbitrary string; which of those keys
 * belongs to which region is what `layout-regions-completeness.test.ts` holds
 * the registry to.
 *
 * The VALUE is parsed on the way in: `setRegionValues` runs the merged patch
 * through `resolvePersistedOverrides`, the same total resolver a rehydrate
 * uses, so a registry typo cannot persist, render from a default branch for a
 * session and then silently vanish on the next launch.
 */

/** Every shape a `ControlSpec` value can hold. */
export type RegionControlValue = boolean | string | ReadonlyArray<string>;

/** One control's current value, read off a region's own value bag. */
export function readControlValue(
  values: LayoutValues[RegionId],
  key: RegionValueKey,
): RegionControlValue {
  const raw: unknown = Reflect.get(values, key);
  if (typeof raw === "boolean" || typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === "string");
  }
  // A key the region does not have is a registry mistake, not a state:
  // answering `false` draws it as an off switch, which is how such a mistake
  // ships looking like a feature that does nothing (G1-22). Loud where it can
  // be fixed, and still a switch rather than a white screen where it cannot.
  if (import.meta.env.DEV) {
    throw new Error(`layout region has no control value for key: ${key}`);
  }
  return false;
}

/** Whether a Hidden region still leaves this fine-tune row editable (L-174). */
export function fineTuneRowLiveWhileHidden(
  row: { readonly liveWhileHidden: RegionValueKey | null },
  values: LayoutValues[RegionId],
): boolean {
  return (
    row.liveWhileHidden !== null &&
    readControlValue(values, row.liveWhileHidden) === true
  );
}

/** One control's new value, written through the editor's gesture recording. */
export function writeControlValue(
  region: RegionId,
  key: RegionValueKey,
  value: RegionControlValue,
): void {
  useLayoutEditorStore.getState().recordGesture(() => {
    const patch: Partial<LayoutValues[RegionId]> = {};
    Reflect.set(patch, key, value);
    useLayoutStore.getState().setRegionValues(region, patch);
  });
}

/** One control's own answer taken back, so the region follows the base again. */
export function revertControlValue(
  region: RegionId,
  key: RegionValueKey,
): void {
  revertControlValues(region, [key]);
}

/** Whether one control's key differs from the base preset (for its revert icon). */
export function isControlValueChanged(
  region: RegionId,
  key: RegionValueKey,
): boolean {
  return changedControlKeys(region, [key]).length > 0;
}

/**
 * Several of one region's controls at once, for a block that owns more than
 * one key: the Style examples, which write five between them (L-20, G1-17).
 *
 * `ReadonlyArray<string>` rather than `RegionValueKey` here because the caller
 * gets its keys from an example PATCH rather than from a declared control, and
 * the membership test below is a real one (`key in base`) rather than a
 * predicate that only says it is.
 */
export function changedControlKeys(
  region: RegionId,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const snapshot = getLayoutSnapshot();
  const override = snapshot.overrides[region];
  if (override === undefined) return [];
  // By DIFFERENCE against the current base, not by the key's presence in the
  // delta (L-133). The delta records what a person picked, so a pick the
  // current preset already makes is stored and is not a change: reading
  // presence would put a revert affordance on a row with nothing to revert,
  // and hand the multi-key revert below keys it must not touch.
  const base = PRESET_VALUES[snapshot.basePreset][region];
  const stored: Record<string, unknown> = override;
  return keys.filter(
    (key) =>
      key in stored &&
      key in base &&
      !sameRegionValue(key, stored[key], Reflect.get(base, key)),
  );
}

/** {@link changedControlKeys} put back, as ONE gesture and one undo step. */
export function revertControlValues(
  region: RegionId,
  keys: ReadonlyArray<string>,
): void {
  // The SAME question the revert affordance asked to appear: difference, not
  // membership. A key the user picked that the current base already makes is
  // stored (L-133) and is not a change, so reverting it deletes an answer
  // while `recordGesture` records nothing - `sameDrawnLayout` sees the same
  // app, by definition - leaving a write with no undo step and losing the
  // pick the moment the base preset moves back. Membership let that through
  // for any caller that did not pre-filter, which `revertRegion` on the page
  // does not: it passes `regionFacts(...)` keys. Reverting nothing is the
  // right answer for a registry typo too, since a key that is not in the
  // base cannot differ from it.
  const owned = changedControlKeys(region, keys);
  if (owned.length === 0) return;
  useLayoutEditorStore.getState().recordGesture(() => {
    useLayoutStore.getState().clearRegionValues(region, owned);
  });
}

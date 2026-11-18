import type { Layer } from "./variable-sound";

/**
 * A run of a layer's 1-based variant ids: one group's, or a pooled layer's
 * whole pool. A grouped layer numbers its groups' variants on from one group to
 * the next, in the order `groups` lists them, so that a variant is one number
 * on either kind of layer.
 */
export interface VariantSpan {
  /** Null on a pooled layer. */
  readonly group: string | null;
  readonly first: number;
  readonly count: number;
}

export function spanHolds(span: VariantSpan, variant: number): boolean {
  return variant >= span.first && variant < span.first + span.count;
}

function spansOf(layer: Layer): readonly VariantSpan[] {
  if (layer.groups === undefined) {
    return [{ group: null, first: 1, count: layer.variants }];
  }
  let first = 1;
  return layer.groups.map((group) => {
    const span = { group: group.name, first, count: group.variants };
    first += group.variants;
    return span;
  });
}

/** The group a variant id is in; the whole pool on a pooled layer. */
export function spanOf(layer: Layer, variant: number): VariantSpan {
  const span = spansOf(layer).find((candidate) =>
    spanHolds(candidate, variant),
  );
  if (span === undefined) {
    throw new Error(`Layer "${layer.name}" has no variant ${String(variant)}`);
  }
  return span;
}

/** The groups in the order they take turns; the one pool on a pooled layer. */
export function turnsOf(layer: Layer): readonly VariantSpan[] {
  const spans = spansOf(layer);
  if (layer.sequence === undefined) return spans;
  if (layer.sequence.length === 0) {
    throw new Error(`Layer "${layer.name}" has an empty sequence`);
  }
  return layer.sequence.map((name) => {
    const span = spans.find((candidate) => candidate.group === name);
    if (span === undefined) {
      throw new Error(`Layer "${layer.name}" has no group "${name}"`);
    }
    return span;
  });
}

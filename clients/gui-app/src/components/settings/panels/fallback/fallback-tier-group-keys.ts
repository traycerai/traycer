import type {
  TierCandidate,
  TierGroup,
} from "@traycer/protocol/host/fallback-policy";

/**
 * A candidate row with a client-side identity.
 *
 * ## Why the wire shape cannot supply the key
 *
 * A React key is an IDENTITY, not a summary of content, and `TierCandidate`
 * has no id - it is `{harnessId, modelFamily, reasoningEffort}` and nothing
 * else. Every content-derived key fails the same way: two rows that happen to
 * hold the same values are the same key, and the editor can produce that pair
 * in two clicks, because a new row starts with an empty family by design.
 *
 * An index key fails differently and worse. These rows REORDER - the ▲▼
 * controls move them and the tier rung walks the resulting order - and an index
 * key makes React reuse the DOM node at a position rather than follow the row,
 * so a move keeps the input the user is typing in while the data underneath it
 * changes.
 *
 * So identity is assigned here, once, when a row enters the draft: either at
 * hydration from a stored policy or at the moment the user adds one. It is
 * never persisted and never sent - {@link toWireGroups} strips it - so the wire
 * shape stays exactly what the host validates.
 */
export interface KeyedCandidate {
  readonly key: string;
  readonly value: TierCandidate;
}

/**
 * A group and its keyed rows.
 *
 * The group itself needs no client key: `fallbackPolicySchema` refines group
 * ids to be unique, so the id IS an identity. Only the candidates lack one.
 */
export interface KeyedGroup {
  readonly id: string;
  readonly candidates: readonly KeyedCandidate[];
}

/**
 * Monotonic within the module, which is all the uniqueness a React key needs -
 * it is scoped to one list in one mounted tree, never stored, never compared
 * across sessions. Deliberately not a random id: a counter makes a key
 * reproducible within a render sequence and keeps a test's expectations
 * readable.
 */
let nextKey = 0;

export function createDraftKey(): string {
  nextKey += 1;
  return `draft-candidate-${nextKey}`;
}

/** Hydration: every stored row gets an identity as it enters the draft. */
export function toKeyedGroups(
  groups: readonly TierGroup[],
): readonly KeyedGroup[] {
  return groups.map((group) => ({
    id: group.id,
    candidates: group.candidates.map((value) => ({
      key: createDraftKey(),
      value,
    })),
  }));
}

/** The projection back to the wire shape. Drops every key. */
export function toWireGroups(
  groups: readonly KeyedGroup[],
): readonly TierGroup[] {
  return groups.map((group) => ({
    id: group.id,
    candidates: group.candidates.map((candidate) => candidate.value),
  }));
}

export function keyedCandidate(value: TierCandidate): KeyedCandidate {
  return { key: createDraftKey(), value };
}

/**
 * The identities to render for a policy that arrived from somewhere other than
 * the editor - a host echo of a save, or a revert to the last persisted value.
 *
 * Both replace `tierGroups` wholesale, and neither carries identities, so the
 * question is whether the rows on screen are still the same rows. Two cases,
 * and the distinction is not the one a key makes:
 *
 *  - the incoming list is structurally the list we already hold identities for
 *    (the ordinary case - a host echo of what we just sent, or any save at all
 *    from a control that does not touch model groups). The rows are the same
 *    rows; keep their keys, so committing an unrelated setting does not remount
 *    every candidate row and take the focus with it.
 *  - anything else. We did not produce this list and cannot say which incoming
 *    row is which existing one, so every row gets a fresh identity. Guessing
 *    positionally here would be index-keying by another name, which is the
 *    thing this module exists to avoid.
 *
 * Deliberately NOT reachable from an ordinary edit: the editor knows what it
 * did to the rows and hands its own keyed list back, which is the only place
 * identity can be tracked through an insert, a removal or a move.
 */
export function reconcileKeyedGroups(
  existing: readonly KeyedGroup[],
  groups: readonly TierGroup[],
): readonly KeyedGroup[] {
  return keyedGroupsMatch(existing, groups) ? existing : toKeyedGroups(groups);
}

/**
 * Whether keyed rows and a wire list describe the same groups.
 *
 * Exported for the panel's preview gate, which asks the same question for a
 * different reason: the preview's verdicts pair to rows by POSITION, so it may
 * only be asked for a list the rows on screen actually are.
 */
export function keyedGroupsMatch(
  existing: readonly KeyedGroup[],
  groups: readonly TierGroup[],
): boolean {
  if (existing.length !== groups.length) return false;
  return existing.every((keyed, at) => {
    const group = groups[at];
    return (
      keyed.id === group.id &&
      keyed.candidates.length === group.candidates.length &&
      keyed.candidates.every((candidate, index) =>
        sameCandidate(candidate.value, group.candidates[index]),
      )
    );
  });
}

/**
 * Field by field over the three `tierCandidateSchema` carries, rather than a
 * generic deep compare.
 *
 * A field added later would make this answer "same" for two rows that differ,
 * which keeps the existing identities - the benign direction. The harmful
 * direction, claiming two lists match when the row COUNT or ORDER differs, is
 * decided above and cannot go stale.
 */
function sameCandidate(a: TierCandidate, b: TierCandidate): boolean {
  return (
    a.harnessId === b.harnessId &&
    a.modelFamily === b.modelFamily &&
    a.reasoningEffort === b.reasoningEffort
  );
}

/** Plain array move over the keyed rows; identity travels with the row. */
export function moveKeyedCandidate(
  candidates: readonly KeyedCandidate[],
  fromIndex: number,
  toIndex: number,
): readonly KeyedCandidate[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= candidates.length ||
    toIndex >= candidates.length
  ) {
    return candidates;
  }
  const next = [...candidates];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

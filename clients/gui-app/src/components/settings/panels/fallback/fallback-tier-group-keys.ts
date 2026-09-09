import type {
  FallbackPolicy,
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
 * A group, its keyed rows, and its own client-side identity.
 *
 * ## Why `id` cannot be the identity
 *
 * `id` is the group's NAME, and the name is an editable text field. The parent
 * used to key the card on it (D174, on the argument that
 * `fallbackPolicySchema` refines group ids to be unique, so the id IS an
 * identity). Uniqueness is not identity while the value is being typed:
 * renaming "fast" to "fastest" changes the key on every keystroke, so React
 * destroys the card containing the focused input and builds another - the
 * rename loses focus after the first character, and blur/Enter never commits
 * the whole name. The intermediate values are also allowed to be duplicates or
 * empty, which a key must survive and a unique-id argument does not cover.
 *
 * So a group carries the same kind of identity its candidate rows already do:
 * assigned once when the group enters the draft, never persisted, never sent -
 * {@link toWireGroups} strips it, exactly as it strips a candidate's.
 */
export interface KeyedGroup {
  readonly draftKey: string;
  readonly id: string;
  readonly candidates: readonly KeyedCandidate[];
}

/**
 * Monotonic within the module, which is all the uniqueness a React key needs -
 * it is scoped to one list in one mounted tree, never stored, never compared
 * across sessions. Deliberately not a random id: a counter makes a key
 * reproducible within a render sequence and keeps a test's expectations
 * readable.
 *
 * One counter for both kinds, with the kind in the prefix: groups and
 * candidates are keyed in different lists, so they could not collide anyway,
 * and a single sequence means a test can read the mint ORDER off the keys.
 */
let nextKey = 0;

export function createDraftKey(): string {
  nextKey += 1;
  return `draft-candidate-${nextKey}`;
}

export function createDraftGroupKey(): string {
  nextKey += 1;
  return `draft-group-${nextKey}`;
}

/** Hydration for one group: it and every row get an identity. */
export function keyedGroup(group: TierGroup): KeyedGroup {
  return {
    draftKey: createDraftGroupKey(),
    id: group.id,
    candidates: group.candidates.map((value) => ({
      key: createDraftKey(),
      value,
    })),
  };
}

/** Hydration: every stored row gets an identity as it enters the draft. */
export function toKeyedGroups(
  groups: readonly TierGroup[],
): readonly KeyedGroup[] {
  return groups.map(keyedGroup);
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
 * The ONE projection from keyed rows back onto a policy.
 *
 * The groups editor builds every ordinary edit through here, and so does the
 * panel's undo - which has to build a policy of its own, because the inverse is
 * applied to the CURRENT draft rather than to whatever the editor last
 * rendered. Two projections would be two places for identity to leak into a
 * saved policy.
 */
export function withTierGroups(
  policy: FallbackPolicy,
  groups: readonly KeyedGroup[],
): FallbackPolicy {
  return { ...policy, tierGroups: [...toWireGroups(groups)] };
}

/**
 * The identities to render for a policy that arrived from somewhere other than
 * the editor: a host ECHO of a save.
 *
 * The echo replaces `tierGroups` wholesale and carries no identities, so the
 * question is whether the rows on screen are still the same rows. Two cases,
 * and the distinction is not the one a key makes:
 *
 *  - the incoming list is structurally the list we already hold identities for,
 *    values included (the ordinary case - a host echo of what we just sent, or
 *    any save at all from a control that does not touch model groups). The rows
 *    are the same rows; keep their keys, so committing an unrelated setting does
 *    not remount every candidate row and take the focus with it.
 *  - anything else. We did not produce this list and cannot say which incoming
 *    row is which existing one, so every row gets a fresh identity. Guessing
 *    positionally here would be index-keying by another name, which is the
 *    thing this module exists to avoid. A restore-defaults response is exactly
 *    this case, and re-seeding it is correct: those are not the rows that were
 *    there.
 *
 * A REVERT is deliberately not routed here - see {@link revertKeyedGroups},
 * which knows it is restoring a list this editor already held identities for
 * and so can answer the weaker question. Neither is reachable from an ordinary
 * edit: the editor knows what it did to the rows and hands its own keyed list
 * back, which is the only place identity can be tracked through an insert, a
 * removal or a move.
 */
export function reconcileKeyedGroups(
  existing: readonly KeyedGroup[],
  groups: readonly TierGroup[],
): readonly KeyedGroup[] {
  return keyedGroupsMatch(existing, groups) ? existing : toKeyedGroups(groups);
}

/**
 * The identities to render when the editor is put BACK to a list it already
 * held identities for - a refused save's revert to `persisted`, or the
 * authoritative read-back after an unknown outcome.
 *
 * Weaker than {@link reconcileKeyedGroups} on purpose, and the difference is
 * the whole of AX4's second half. That function asks "are these the same rows
 * with the same VALUES", which a revert never is: the revert exists precisely
 * because a value changed. So every rejected family-name edit re-seeded the
 * whole list, React remounted every candidate row, and the field the user was
 * still typing in was destroyed under them - by the code path whose job was to
 * put their value back.
 *
 * Here the question is only "are these the same rows", answered by SHAPE: the
 * same number of groups, each with the same number of candidates. That is a
 * safe correspondence for these two callers because both restore a list this
 * editor produced or received earlier, so row N really is row N with its value
 * put back - a rename, an effort change, a family correction. It is NOT the
 * positional guess `reconcileKeyedGroups` refuses to make about a list from an
 * unknown source: a restore-defaults response replaces the rows wholesale, and
 * that arrives through the echo path, which still re-seeds.
 *
 * A shape CHANGE means rows were added or removed - a rejected removal, a
 * rejected "Add a model" - and there is no correspondence left to keep, so it
 * re-seeds like any other foreign list.
 */
export function revertKeyedGroups(
  existing: readonly KeyedGroup[],
  groups: readonly TierGroup[],
): readonly KeyedGroup[] {
  if (!sameGroupShape(existing, groups)) return toKeyedGroups(groups);
  // Nothing to rebuild when the values already agree: returning the same
  // reference keeps a revert that changed nothing from re-rendering the rows.
  if (keyedGroupsMatch(existing, groups)) return existing;
  return groups.map((group, at) => ({
    draftKey: existing[at].draftKey,
    id: group.id,
    candidates: group.candidates.map((value, index) => ({
      key: existing[at].candidates[index].key,
      value,
    })),
  }));
}

function sameGroupShape(
  existing: readonly KeyedGroup[],
  groups: readonly TierGroup[],
): boolean {
  if (existing.length !== groups.length) return false;
  return existing.every(
    (keyed, at) => keyed.candidates.length === groups[at].candidates.length,
  );
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

/**
 * What an "Undo" on a removal toast has to put back.
 *
 * The toasts used to close over the whole policy as it stood when the row was
 * deleted, and re-submit it. That is not an undo, it is a RESTORE POINT: it
 * also reverts every unrelated setting the user changed in between (the maximum
 * wait they adjusted while the toast was still up), and a second deletion
 * followed by the FIRST toast's Undo resurrects the second row, because the
 * snapshot predates it.
 *
 * So the toast carries the inverse of its own operation and nothing else, and
 * the panel applies it to whatever the current draft is. Both variants are
 * identity-addressed rather than positional: `index` is only where to put the
 * row back, and even that is a preference the application clamps, because the
 * one thing a user cannot re-enter by typing is where a row sat.
 */
export type FallbackGroupsInverse =
  | {
      readonly kind: "group";
      readonly group: KeyedGroup;
      readonly index: number;
    }
  | {
      readonly kind: "candidate";
      readonly groupDraftKey: string;
      readonly candidate: KeyedCandidate;
      readonly index: number;
    };

/**
 * One removal undone against the CURRENT groups.
 *
 * Every "cannot apply" answers with the input array unchanged rather than
 * throwing or approximating: an Undo pressed twice, or pressed after the whole
 * group was deleted, is a user gesture with nothing left to do, and inventing a
 * row for it would be worse than ignoring it.
 */
export function applyGroupsInverse(
  groups: readonly KeyedGroup[],
  inverse: FallbackGroupsInverse,
): readonly KeyedGroup[] {
  if (inverse.kind === "group") {
    if (groups.some((group) => group.draftKey === inverse.group.draftKey)) {
      return groups;
    }
    return insertAt(groups, inverse.group, inverse.index);
  }
  const at = groups.findIndex(
    (group) => group.draftKey === inverse.groupDraftKey,
  );
  if (at === -1) return groups;
  const group = groups[at];
  if (
    group.candidates.some(
      (candidate) => candidate.key === inverse.candidate.key,
    )
  ) {
    return groups;
  }
  const candidates = insertAt(
    group.candidates,
    inverse.candidate,
    inverse.index,
  );
  return groups.map((existing, index) =>
    index === at ? { ...existing, candidates } : existing,
  );
}

/** Clamped rather than sparse: the list may have shrunk since the removal. */
function insertAt<T>(
  items: readonly T[],
  item: T,
  index: number,
): readonly T[] {
  const next = [...items];
  next.splice(Math.min(Math.max(index, 0), next.length), 0, item);
  return next;
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

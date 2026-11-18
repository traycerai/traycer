import {
  haystackHasFamilyWord,
  type TierCandidate,
  type TierGroup,
} from "@traycer/protocol/host/fallback-policy";

/**
 * Whether a set of tiers names an equivalent-model destination for a tuple, as
 * a RELEASED host answers it - one whose `providers.fallbackPolicy.get` line is
 * 1.0, where a tier row's `modelFamily` is a family WORD rather than a pattern.
 *
 * The pattern-era answer is the protocol's `tierGroupsNameDestinationFor`, and
 * on a 1.1 host that is the one to ask. It is the wrong one here: its exact
 * matcher reads the old seed's `gpt` row as "the model called exactly gpt", so
 * for `gpt-6-sol` it finds no tier and says nothing is set up, while the host
 * the user is looking at routes that model to the tier and switches it to a
 * Claude model. A hint that contradicts the host it describes is worse than no
 * hint.
 *
 * So this is the 1.0 line's rule, as it shipped (one release, never revised):
 *
 *  - A row matches when its family, trimmed and lower-cased, IS the model's ID
 *    or is a whole word in it (`haystackHasFamilyWord`: `gpt` matches `gpt4`
 *    and `gpt-6-sol`, `pi` does not match `copilot`). The ID only - that host
 *    never read a catalog label, so `claude/default` belongs to no tier there.
 *  - The LONGEST matching family decides the tier, across all tiers; a tie goes
 *    to the earlier one. Families nest (`gpt` is a word in every Codex ID,
 *    `spark` included), and first-match sent a light model to the frontier
 *    tier.
 *  - A model in no tier routes to the default tier, when one is set.
 *  - The routed tier names a destination when any of its rows is not the
 *    failed model's own family on the failed provider.
 *
 * A copy on the client, which the protocol's own doc argues against for the
 * live rule - two copies of a live rule drift. This one cannot: it describes a
 * line that is frozen, and a released host will never answer differently.
 */
export function legacyFamilyTiersNameDestinationFor(input: {
  readonly groups: readonly TierGroup[];
  readonly defaultTierGroupId: string | null;
  readonly harnessId: TierCandidate["harnessId"];
  readonly model: string;
}): boolean {
  const group = legacyFamilyRouteTierGroup(input);
  if (group === null) return false;
  const slug = input.model.toLowerCase();
  return group.candidates.some(
    (candidate) =>
      !(
        candidate.harnessId === input.harnessId &&
        familyMatchesSlug(candidate.modelFamily, slug)
      ),
  );
}

function legacyFamilyRouteTierGroup(input: {
  readonly groups: readonly TierGroup[];
  readonly defaultTierGroupId: string | null;
  readonly harnessId: TierCandidate["harnessId"];
  readonly model: string;
}): TierGroup | null {
  const slug = input.model.toLowerCase();
  let best: { readonly group: TierGroup; readonly length: number } | null =
    null;
  for (const group of input.groups) {
    for (const candidate of group.candidates) {
      if (candidate.harnessId !== input.harnessId) continue;
      if (!familyMatchesSlug(candidate.modelFamily, slug)) continue;
      const length = candidate.modelFamily.trim().length;
      // Strictly greater, so an equal-length match in a LATER tier never
      // displaces the earlier one.
      if (best === null || length > best.length) best = { group, length };
    }
  }
  if (best !== null) return best.group;
  if (input.defaultTierGroupId === null) return null;
  return (
    input.groups.find((group) => group.id === input.defaultTierGroupId) ?? null
  );
}

function familyMatchesSlug(family: string, slug: string): boolean {
  const needle = family.trim().toLowerCase();
  if (needle.length === 0) return false;
  return needle === slug || haystackHasFamilyWord(slug, needle);
}

import Fuse, { type IFuseOptions } from "fuse.js";
import type { MentionMenuEntry, MentionProviderId } from "./providers";

/**
 * One root-search row with the provider that produced it. The provider id is
 * ranking metadata only - it never changes what the row does when picked.
 */
export interface RootSearchCandidate {
  readonly entry: MentionMenuEntry;
  readonly providerId: MentionProviderId;
}

/**
 * Per-provider score multipliers (Fuse scores are 0 = perfect, 1 = worst, so a
 * factor below 1 favors the provider). Curated, human-named items (tasks,
 * agents, artifacts) get a mild edge over path suggestions: their short titles
 * are deliberate names, while a path substring hit is often incidental.
 */
const PROVIDER_SCORE_BOOSTS: Readonly<Record<MentionProviderId, number>> = {
  files: 1,
  folders: 1,
  worktree: 1,
  git: 1,
  epic: 0.9,
  chat: 0.9,
  terminals: 0.9,
  artifacts: 0.9,
};

const FUSE_OPTIONS: IFuseOptions<RootSearchCandidate> = {
  keys: [
    { name: "entry.label", weight: 2 },
    { name: "entry.detail", weight: 1 },
    { name: "entry.description", weight: 0.5 },
  ],
  includeScore: true,
  ignoreLocation: true,
  threshold: 0.4,
};

/**
 * Ranks the flattened root `@` search across every provider into one flat
 * best-match-first list, replacing the fixed provider concatenation (which
 * pinned files/folders above everything regardless of match quality).
 *
 * Every candidate was already query-matched by its source (host path search,
 * cloud `epic.mention*`, or a local filter), so a row the client-side pass
 * cannot re-match is appended after the ranked rows in original provider order
 * rather than dropped - the source's match may live in text the menu row does
 * not carry (e.g. a deep path segment).
 */
export function rankRootSearchEntries(
  candidates: ReadonlyArray<RootSearchCandidate>,
  query: string,
): ReadonlyArray<MentionMenuEntry> {
  const trimmedQuery = query.trim();
  if (candidates.length === 0 || trimmedQuery.length === 0) {
    return candidates.map((candidate) => candidate.entry);
  }
  const fuse = new Fuse([...candidates], FUSE_OPTIONS);
  const matches = fuse
    .search(trimmedQuery)
    .map((result) => ({
      candidate: result.item,
      refIndex: result.refIndex,
      score:
        (result.score ?? 1) * PROVIDER_SCORE_BOOSTS[result.item.providerId],
    }))
    .toSorted((left, right) =>
      left.score === right.score
        ? left.refIndex - right.refIndex
        : left.score - right.score,
    );
  const matchedIndices = new Set(matches.map((match) => match.refIndex));
  const unmatched = candidates.filter(
    (_candidate, index) => !matchedIndices.has(index),
  );
  return [
    ...matches.map((match) => match.candidate.entry),
    ...unmatched.map((candidate) => candidate.entry),
  ];
}

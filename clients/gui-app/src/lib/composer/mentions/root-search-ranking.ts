import type { IFuseOptions } from "fuse.js";
import { resortByNameTier, searchFuzzyMatches } from "../fuzzy-ranking";
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

const FUSE_KEYS: NonNullable<IFuseOptions<RootSearchCandidate>["keys"]> = [
  { name: "entry.label", weight: 2 },
  { name: "entry.detail", weight: 1 },
  { name: "entry.description", weight: 0.5 },
];

export interface RankedRootSearch {
  readonly entries: ReadonlyArray<MentionMenuEntry>;
  /**
   * Rows the client-side fuzzy pass actually matched, or null when no ranking
   * ran (empty query). Appended rows do not count: the dismissal policy needs
   * to know whether anything REALLY matched, and the visible list length
   * cannot say that because unmatched rows are appended, never dropped.
   */
  readonly matchedCount: number | null;
}

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
): RankedRootSearch {
  const trimmedQuery = query.trim();
  if (candidates.length === 0 || trimmedQuery.length === 0) {
    return {
      entries: candidates.map((candidate) => candidate.entry),
      matchedCount: trimmedQuery.length === 0 ? null : 0,
    };
  }
  // Tier on the label (filename/title), not the full path: a deep path-
  // segment hit in `detail` still surfaces via the last tier instead of
  // competing with literal label hits, and the provider boost only orders
  // rows within a tier — it can no longer push a substring hit above a
  // label-prefix hit.
  const matches = resortByNameTier(
    searchFuzzyMatches(
      candidates,
      trimmedQuery,
      FUSE_KEYS,
      (candidate, score) => score * PROVIDER_SCORE_BOOSTS[candidate.providerId],
    ),
    trimmedQuery,
    (candidate) => candidate.entry.label,
  );
  const matchedIndices = new Set(matches.map((match) => match.refIndex));
  const unmatched = candidates.filter(
    (_candidate, index) => !matchedIndices.has(index),
  );
  return {
    entries: [
      ...matches.map((match) => match.item.entry),
      ...unmatched.map((candidate) => candidate.entry),
    ],
    matchedCount: matches.length,
  };
}

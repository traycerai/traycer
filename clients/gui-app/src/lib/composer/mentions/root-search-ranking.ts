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
  // Entity-provider tier: a PR/issue title is a deliberate human name, like a
  // task or artifact title, not an incidental path substring.
  "pull-requests": 0.9,
  issues: 0.9,
  epic: 0.9,
  chat: 0.9,
  "browser-tab": 0.9,
  terminals: 0.9,
  artifacts: 0.9,
};

const FUSE_KEYS: NonNullable<IFuseOptions<RootSearchCandidate>["keys"]> = [
  // The identity segment a PR/issue row leads with (`#4917`). Weighted with
  // the label so typing a bare number at root finds the row it names.
  { name: "entry.labelPrefix", weight: 2 },
  { name: "entry.label", weight: 2 },
  { name: "entry.detail", weight: 1 },
  { name: "entry.description", weight: 0.5 },
  // Non-rendered search-only text (a PR/issue author's login). Weighted at
  // the bottom: it exists so a row the SOURCE matched can be re-matched -
  // and counted by `matchedCount`, which gates the zero-match dismissal -
  // not to outrank rows matched on what the user can actually see.
  { name: "entry.searchText", weight: 0.5 },
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
/**
 * Which of a row's two name fields the tiering should judge it on.
 *
 * `resortByNameTier` tiers one string per row - prefix hit, substring hit,
 * neither - and for most rows `label` is the only name there is. A PR or issue
 * row has two: `label` is the TITLE, and its identity (`#4917`) lives in
 * `labelPrefix` because the two truncate differently. Tiering on `label` alone
 * therefore put the row a query names EXACTLY in the bottom tier, below any
 * unrelated row whose title merely contains those characters - so `#4917` +
 * Enter could insert something else entirely.
 *
 * Returns whichever field earns the better tier for this query, which is the
 * per-row minimum rather than a preference for one field. Concatenating the
 * two instead would fix the reference case and break the title case: `#4917
 * Stop the busy-loop` no longer STARTS with `stop`, so typing a title would
 * fall from the prefix tier to the substring one.
 */
function tierTextFor(candidate: RootSearchCandidate, query: string): string {
  const { labelPrefix, label, description } = candidate.entry;
  if (labelPrefix === null) return label;
  // `description` is the row's canonical reference (`acme/widgets#123`), and it
  // is the ONLY field carrying the repository-qualified form: `labelPrefix` is
  // just `#123`. Tiering without it put a qualified query's exact row in the
  // bottom tier again - the same defect as the bare-number case, one reference
  // shape along.
  //
  // Only the best tier is used, so a field that does not match cannot demote a
  // field that does; which string is returned is immaterial beyond its tier.
  const lowerQuery = query.toLowerCase();
  let best = label;
  let bestTier = tierOf(label, lowerQuery);
  for (const text of [labelPrefix, description]) {
    const tier = tierOf(text, lowerQuery);
    if (tier < bestTier) {
      bestTier = tier;
      best = text;
    }
  }
  return best;
}

/** 0 prefix hit, 1 substring hit, 2 neither - `resortByNameTier`'s own order. */
function tierOf(text: string, lowerQuery: string): number {
  const lowerText = text.toLowerCase();
  if (lowerText.startsWith(lowerQuery)) return 0;
  return lowerText.includes(lowerQuery) ? 1 : 2;
}

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
    (candidate) => tierTextFor(candidate, trimmedQuery),
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

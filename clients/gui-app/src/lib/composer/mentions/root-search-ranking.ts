import type { IFuseOptions } from "fuse.js";
import { resortByNameTier, searchFuzzyMatches } from "../fuzzy-ranking";
import type { MentionMenuEntry, MentionProviderId } from "./providers";

/**
 * One root-search row with the provider that produced it plus the two facts
 * the ranking needs that the rendered row does not carry. The provider id is
 * ranking metadata only - it never changes what the row does when picked.
 */
export interface RootSearchCandidate {
  readonly entry: MentionMenuEntry;
  readonly providerId: MentionProviderId;
  /**
   * The row's full path when it names one (files, folders): the text the
   * ranking judges beside the name, in place of the rendered `detail` /
   * `description`. Those two are BOTH the dirname on a path row, so ranking
   * on them counted a dirname hit twice and never saw the whole path - every
   * file inside a folder outranked the folder itself, and a query spanning a
   * path boundary (`lib/comp`) matched nothing the ranker could see. `null`
   * for rows that are not paths, which rank on their rendered fields.
   */
  readonly path: string | null;
  /**
   * When the user last picked this row from the menu this session, or `null`
   * when never (or evicted from the pick memory's cap). A mild nudge, not a
   * tier: see `RECENT_PICK_SCORE_BOOST`.
   */
  readonly pickedAt: number | null;
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

/**
 * The same mild edge for a row the user picked recently. Multiplicative like
 * the provider boost, so it reorders rows of comparable match quality and
 * never lifts a weak match over a literal one - the name tiers below still
 * decide first. Deliberately not a "recent first" band: `@a` must keep
 * `a.ts` above last week's `authorization.ts`.
 */
const RECENT_PICK_SCORE_BOOST = 0.85;

/**
 * What the Fuse pass reads per candidate. Built here rather than indexing the
 * entry directly so a path row can rank on its full path while every other
 * row keeps ranking on what it renders.
 */
interface RootSearchDocument {
  readonly candidate: RootSearchCandidate;
  readonly namePrefix: string;
  readonly name: string;
  readonly context: string;
  readonly extra: string;
  readonly searchText: string;
}

const FUSE_KEYS: NonNullable<IFuseOptions<RootSearchDocument>["keys"]> = [
  // The identity segment a PR/issue row leads with (`#4917`). Weighted with
  // the name so typing a bare number at root finds the row it names.
  { name: "namePrefix", weight: 2 },
  { name: "name", weight: 2 },
  { name: "context", weight: 1 },
  { name: "extra", weight: 0.5 },
  // Non-rendered search-only text (a PR/issue author's login). Weighted at
  // the bottom: it exists so a row the SOURCE matched can be re-matched -
  // and counted by `matchedCount`, which gates the zero-match dismissal -
  // not to outrank rows matched on what the user can actually see.
  { name: "searchText", weight: 0.5 },
];

function documentFor(candidate: RootSearchCandidate): RootSearchDocument {
  const { entry, path } = candidate;
  return {
    candidate,
    namePrefix: entry.labelPrefix ?? "",
    name: entry.label,
    // A path row's context is its whole path - the same two keys the host
    // ranked it on - and nothing else, so the dirname is never counted twice.
    context: path ?? entry.detail,
    extra: path === null ? entry.description : "",
    searchText: entry.searchText ?? "",
  };
}

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

function scoreBoost(candidate: RootSearchCandidate): number {
  const provider = PROVIDER_SCORE_BOOSTS[candidate.providerId];
  return candidate.pickedAt === null
    ? provider
    : provider * RECENT_PICK_SCORE_BOOST;
}

/**
 * Equal-score order. The input order is provider concatenation, which says
 * nothing about relevance, so a tie is settled on facts about the rows: the
 * more recently picked one, then the shorter path or name (the host's own
 * path tie-break - `src/lib/composer` over a file inside it when both merely
 * contain the query). Only then the input index, for determinism.
 */
function compareTiedCandidates(
  left: RootSearchCandidate,
  right: RootSearchCandidate,
): number {
  const leftPicked = left.pickedAt ?? Number.NEGATIVE_INFINITY;
  const rightPicked = right.pickedAt ?? Number.NEGATIVE_INFINITY;
  if (leftPicked !== rightPicked) return rightPicked - leftPicked;
  return tieLength(left) - tieLength(right);
}

function tieLength(candidate: RootSearchCandidate): number {
  return (candidate.path ?? candidate.entry.label).length;
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
  // segment hit still surfaces via the last tier instead of competing with
  // literal label hits, and the score boosts only order rows within a tier -
  // they can never push a substring hit above a label-prefix hit.
  const matches = resortByNameTier(
    searchFuzzyMatches(candidates.map(documentFor), trimmedQuery, FUSE_KEYS, {
      adjustScore: (document, score) => score * scoreBoost(document.candidate),
      compareTies: (left, right) =>
        compareTiedCandidates(left.candidate, right.candidate),
    }),
    trimmedQuery,
    (document) => tierTextFor(document.candidate, trimmedQuery),
  );
  const matchedIndices = new Set(matches.map((match) => match.refIndex));
  const unmatched = candidates.filter(
    (_candidate, index) => !matchedIndices.has(index),
  );
  return {
    entries: [
      ...matches.map((match) => match.item.candidate.entry),
      ...unmatched.map((candidate) => candidate.entry),
    ],
    matchedCount: matches.length,
  };
}

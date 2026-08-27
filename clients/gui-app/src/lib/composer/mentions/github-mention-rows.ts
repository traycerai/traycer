import { isSubsequence } from "@traycer/protocol/utils/text/fuzzy";
import type {
  GithubIssueMentionFilter,
  GithubMentionBucket,
  GithubMentionRepository,
  GithubMentionRow,
  GithubMentionSection,
  GithubPullRequestMentionFilter,
} from "@traycer/protocol/host/mention-schemas";
import { foldGithubIdentitySegment } from "@traycer/protocol/common/github-mention-identity";

/**
 * Pure row algebra for the PR/Issue mention sections: GitHub identity, the
 * cache/remote merge, bucket-then-recency ranking, the client-side filter, and
 * reference-query recognition. Deliberately free of React and of the host
 * client so the parts that decide what the user sees can be tested directly.
 */

export type GithubMentionFilter =
  | GithubPullRequestMentionFilter
  | GithubIssueMentionFilter;

const EMPTY_ROWS: ReadonlyArray<GithubMentionRow> = [];

export const DEFAULT_PULL_REQUEST_MENTION_FILTER: GithubPullRequestMentionFilter =
  {
    state: "open",
    involvement: "everyone",
    repository: null,
  };

export const DEFAULT_ISSUE_MENTION_FILTER: GithubIssueMentionFilter = {
  state: "open",
  involvement: "everyone",
  repository: null,
};

export function defaultGithubMentionFilter(
  section: GithubMentionSection,
): GithubMentionFilter {
  return section === "pull-requests"
    ? DEFAULT_PULL_REQUEST_MENTION_FILTER
    : DEFAULT_ISSUE_MENTION_FILTER;
}

export function isDefaultGithubMentionFilter(
  section: GithubMentionSection,
  filter: GithubMentionFilter,
): boolean {
  const defaults = defaultGithubMentionFilter(section);
  return (
    filter.state === defaults.state &&
    filter.involvement === defaults.involvement &&
    filter.repository === null
  );
}

const PULL_REQUEST_STATES: ReadonlyArray<
  GithubPullRequestMentionFilter["state"]
> = ["open", "merged", "closed", "all"];
const PULL_REQUEST_INVOLVEMENTS: ReadonlyArray<
  GithubPullRequestMentionFilter["involvement"]
> = ["everyone", "review-requested", "assigned", "authored"];
const ISSUE_STATES: ReadonlyArray<GithubIssueMentionFilter["state"]> = [
  "open",
  "closed",
  "all",
];
const ISSUE_INVOLVEMENTS: ReadonlyArray<
  GithubIssueMentionFilter["involvement"]
> = ["everyone", "assigned", "authored", "mentions"];

/**
 * Narrows a stored filter to the arm its section's wire request needs.
 *
 * The two arms are NOT interchangeable - only PRs have `review-requested`,
 * only issues have `mentions` - and the store is persisted, so a value written
 * by an older build (or by the other section, through a bug) can be shaped
 * wrong. These rebuild the filter field by field and fall back to the default
 * for anything unrecognized, which is why neither needs a type assertion: the
 * result is constructed, not claimed.
 */
export function asPullRequestMentionFilter(
  filter: GithubMentionFilter,
): GithubPullRequestMentionFilter {
  const state = PULL_REQUEST_STATES.find((value) => value === filter.state);
  const involvement = PULL_REQUEST_INVOLVEMENTS.find(
    (value) => value === filter.involvement,
  );
  return {
    state: state ?? DEFAULT_PULL_REQUEST_MENTION_FILTER.state,
    involvement: involvement ?? DEFAULT_PULL_REQUEST_MENTION_FILTER.involvement,
    repository: filter.repository,
  };
}

export function asIssueMentionFilter(
  filter: GithubMentionFilter,
): GithubIssueMentionFilter {
  const state = ISSUE_STATES.find((value) => value === filter.state);
  const involvement = ISSUE_INVOLVEMENTS.find(
    (value) => value === filter.involvement,
  );
  return {
    state: state ?? DEFAULT_ISSUE_MENTION_FILTER.state,
    involvement: involvement ?? DEFAULT_ISSUE_MENTION_FILTER.involvement,
    repository: filter.repository,
  };
}

/**
 * The section's coercion, chosen by section. The dispatch itself is the point:
 * a filter is only ever valid FOR a section, so any code holding one that was
 * not built for the section it is about to qualify goes through here.
 */
export function withGithubMentionSectionShape(
  section: GithubMentionSection,
  filter: GithubMentionFilter,
): GithubMentionFilter {
  const coerced =
    section === "pull-requests"
      ? asPullRequestMentionFilter(filter)
      : asIssueMentionFilter(filter);
  // Identity-preserving when there was nothing to coerce, which is every
  // ordinary read. A store selector's result is compared by identity to decide
  // whether to re-render, so handing back a fresh-but-equal object on each call
  // is not a wasted allocation - it is an unbroken render loop.
  return coerced.state === filter.state &&
    coerced.involvement === filter.involvement
    ? filter
    : coerced;
}

/**
 * Replaces a repository selection. Written as an explicit per-section rebuild
 * for the same reason as the coercions above - spreading a union member does
 * not narrow, and the two arms must stay distinguishable.
 */
export function withGithubMentionRepository(
  section: GithubMentionSection,
  filter: GithubMentionFilter,
  repository: GithubMentionRepository | null,
): GithubMentionFilter {
  if (section === "pull-requests") {
    return { ...asPullRequestMentionFilter(filter), repository };
  }
  return { ...asIssueMentionFilter(filter), repository };
}

/**
 * The one identity a PR/issue row has, everywhere: GitHub host, owner, repo,
 * number. The de-duplication, the preview lookup, and the picker row key all
 * read through this, so a cached row and its remote-search duplicate can never
 * be treated as two different things.
 *
 * Folded like every identity comparison in this file: GitHub treats these
 * segments case-insensitively, and a repository whose casing was renamed
 * between the cached sweep and the live search would otherwise arrive as two
 * spellings of one artifact - the merge would append a duplicate row instead
 * of replacing the stale payload, and either copy could be committed.
 */
export function githubMentionRowKey(
  row: Pick<GithubMentionRow, "githubHost" | "owner" | "repo" | "number">,
): string {
  return [
    foldGithubIdentitySegment(row.githubHost),
    foldGithubIdentitySegment(row.owner),
    foldGithubIdentitySegment(row.repo),
    row.number,
  ].join("\x1f");
}

/** Stable picker-entry id. Section-scoped so a PR and an issue never collide. */
export function githubMentionEntryId(
  section: GithubMentionSection,
  row: GithubMentionRow,
): string {
  return `github:${section}:${githubMentionRowKey(row)}`;
}

/**
 * Keeps only the rows that BELONG to `section`.
 *
 * This is an entity-type boundary, and it is enforced here - where the rows
 * are consumed - rather than trusted from where they arrive. One
 * `useGithubMentionSearch` observer serves both sections, so switching section
 * changes that observer's query key, and `placeholderData: keepPreviousData`
 * answers the new key with the PREVIOUS key's data (query-core never clears
 * its `lastQueryWithDefinedData` on a key change). For the seconds until the
 * new search resolves, the Issues section would otherwise be handed pull
 * requests - which pass the state/involvement filter, rank first for a `#4917`
 * query, sit pre-highlighted, and insert a `github_pull_request` chip from the
 * Issues list.
 *
 * Returns the input array unchanged when nothing is dropped, so the common
 * case costs no identity churn and the merge's same-reference fast path still
 * applies.
 */
export function githubMentionRowsForSection(
  rows: ReadonlyArray<GithubMentionRow>,
  section: GithubMentionSection,
): ReadonlyArray<GithubMentionRow> {
  const wanted = section === "pull-requests" ? "pull-request" : "issue";
  if (rows.every((row) => row.kind === wanted)) return rows;
  return rows.filter((row) => row.kind === wanted);
}

/**
 * Keeps only the rows whose repository is in the RESOLVED scope.
 *
 * Repository membership is a property of the scope's freshest resolved answer,
 * not of whichever response a row happens to ride in on. Two carriers can
 * outlive a repository leaving the scope: the sibling section's catalog entry
 * inside its `staleTime`, and the session store's published rows. Both are
 * still served as rows, so without this boundary a repository detached moments
 * ago keeps offering references the current scope can no longer resolve - and
 * the user can commit one as a mention.
 *
 * Identity-preserving on the common path: when nothing is out of scope the
 * input array is returned as-is, so appliers inside memos do not re-key the
 * picker on every render.
 */
export function githubMentionRowsWithinScope(
  rows: ReadonlyArray<GithubMentionRow>,
  repositories: ReadonlyArray<GithubMentionRepository>,
): ReadonlyArray<GithubMentionRow> {
  const inScope = new Set(repositories.map(githubRepositoryIdentityKey));
  const kept = rows.filter((row) =>
    inScope.has(githubRepositoryIdentityKey(row)),
  );
  return kept.length === rows.length ? rows : kept;
}

/**
 * One casing rule for a repository's identity. GitHub hosts, owners and repo
 * names are case-insensitive, and the two sides of a comparison here can come
 * from DIFFERENT pipelines with different casing: rows carry the API's
 * canonical spelling, while the scope's repositories are parsed from the
 * folder's configured remote - whatever casing the user happened to type
 * there. Compared verbatim, a `TraycerAI/Traycer` remote dropped every row
 * the API returned as `traycerai/traycer`, as if the repository had left the
 * scope. Same rule `referenceMatchesRow` already applies to pasted URLs.
 */
export function githubRepositoryIdentityKey(entry: {
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
}): string {
  return [
    foldGithubIdentitySegment(entry.githubHost),
    foldGithubIdentitySegment(entry.owner),
    foldGithubIdentitySegment(entry.repo),
  ].join("\x1f");
}

/**
 * Merges remote search hits into the cached catalog rows.
 *
 * On a collision the cached row keeps its POSITION and its key, and the remote
 * row supplies the payload. Both halves of that matter, and they used to be
 * conflated:
 *
 * - the key is what the picker lists by, so preserving it is what keeps the
 *   highlight from jumping while the user is typing. It is derived from
 *   `(githubHost, owner, repo, number)`, none of which a refresh can change,
 *   so it survives taking the fresh payload;
 * - the payload is the part that goes stale. Keeping the cached one discarded
 *   the very state the search was issued to discover: searching with the
 *   Merged filter returns a PR the sweep still records as Open, the stale Open
 *   copy wins here, and the state filter downstream then drops it - so a
 *   search that succeeded renders as no results at all.
 *
 * Remote-only rows append in the order the host returned them.
 */
export function mergeGithubMentionRows(
  cached: ReadonlyArray<GithubMentionRow>,
  remote: ReadonlyArray<GithubMentionRow>,
): ReadonlyArray<GithubMentionRow> {
  if (remote.length === 0) return cached;
  const freshByKey = new Map(
    remote.map((row) => [githubMentionRowKey(row), row]),
  );
  const seen = new Set(cached.map((row) => githubMentionRowKey(row)));
  const refreshed = cached.map(
    (row) => freshByKey.get(githubMentionRowKey(row)) ?? row,
  );
  const replaced = refreshed.some((row, index) => row !== cached[index]);
  const additions = remote.filter((row) => {
    const key = githubMentionRowKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Nothing appended and nothing actually swapped: hand back the very array
  // that came in. Allocating a twin here would re-key the picker on every
  // search response that told us only what we already knew.
  if (additions.length === 0) return replaced ? refreshed : cached;
  return [...refreshed, ...additions];
}

const PULL_REQUEST_BUCKET_ORDER: ReadonlyArray<GithubMentionBucket> = [
  "epic",
  "review-requested",
  "assigned",
  "authored",
  "mentions",
  "recent",
  "search",
];

const ISSUE_BUCKET_ORDER: ReadonlyArray<GithubMentionBucket> = [
  "epic",
  "assigned",
  "authored",
  "mentions",
  "review-requested",
  "recent",
  "search",
];

/**
 * A row's rank among the involvement buckets: its BEST bucket wins, because a
 * PR that is both this task's own and merely recent is a task PR.
 */
export function githubMentionBucketRank(
  section: GithubMentionSection,
  row: GithubMentionRow,
): number {
  const order =
    section === "pull-requests"
      ? PULL_REQUEST_BUCKET_ORDER
      : ISSUE_BUCKET_ORDER;
  const ranks = row.buckets.map((bucket) => order.indexOf(bucket));
  const known = ranks.filter((rank) => rank >= 0);
  return known.length === 0 ? order.length : Math.min(...known);
}

/**
 * Client-side match strength for a typed query, or null when the row does not
 * match at all. Lower is better, matching the fuzzy-ranking convention used
 * elsewhere in the picker.
 *
 * Number matches are deliberately first and by a wide margin: `#4917` and
 * `4917` are exact-reference intents, and a title that merely contains "4917"
 * must never outrank the PR that IS 4917.
 */
export function githubMentionMatchScore(
  row: GithubMentionRow,
  rawQuery: string,
): number | null {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) return 0;

  const numberScore = numberMatchScore(row, rawQuery, query);
  if (numberScore !== null) return numberScore;

  const title = row.title.toLowerCase();
  if (title === query) return 100;
  if (title.startsWith(query)) return 200;
  if (title.includes(query)) return 300;

  // One host-qualified haystack, because `repo` and `owner/repo` are both
  // substrings of it. The host segment must be searchable: the UI itself
  // prints `host/owner/repo` when a scope holds the same name on two hosts
  // (see `githubRepositoryQualification`), and a matcher that cannot re-match
  // the identity the row DISPLAYS drops the row the moment the user types
  // what they see.
  const qualified = `${row.githubHost}/${row.owner}/${row.repo}`.toLowerCase();
  if (qualified.includes(query)) return 400;

  const author = row.author?.login.toLowerCase() ?? "";
  if (author.length > 0 && author.includes(query)) return 500;

  if (isSubsequence(query, title)) return 600 + title.length;
  return null;
}

/**
 * Exact-reference intent, or null when the query is not about a number at all.
 * Split out of the score above so each function stays readable, and because
 * these are the only two scores that must outrank every text match.
 */
function numberMatchScore(
  row: GithubMentionRow,
  rawQuery: string,
  query: string,
): number | null {
  const reference = parseGithubReferenceQuery(rawQuery);
  if (reference !== null && referenceMatchesRow(reference, row)) return 0;
  const numberText = String(row.number);
  if (query === numberText || query === `#${numberText}`) return 0;
  if (!/^#?\d+$/.test(query)) return null;
  return numberText.startsWith(query.replace(/^#/, "")) ? 10 : null;
}

export interface RankGithubMentionRowsInput {
  readonly rows: ReadonlyArray<GithubMentionRow>;
  readonly section: GithubMentionSection;
  readonly query: string;
  readonly limit: number;
}

/**
 * The section's row order.
 *
 * With no query this is purely the product's default ordering: involvement
 * bucket, then recency. Once the user types, match strength leads and the
 * bucket becomes the tiebreak - the same philosophy as `resortByNameTier` in
 * root search, where what you typed outranks where a row came from.
 */
export function rankGithubMentionRows(
  input: RankGithubMentionRowsInput,
): ReadonlyArray<GithubMentionRow> {
  const { rows, section, query, limit } = input;
  if (rows.length === 0) return EMPTY_ROWS;
  const trimmed = query.trim();
  const scored = rows.flatMap((row) => {
    const score = githubMentionMatchScore(row, trimmed);
    if (score === null) return [];
    return [{ row, score, bucket: githubMentionBucketRank(section, row) }];
  });
  const ordered = scored.toSorted((left, right) => {
    if (trimmed.length > 0 && left.score !== right.score) {
      return left.score - right.score;
    }
    if (left.bucket !== right.bucket) return left.bucket - right.bucket;
    return right.row.updatedAt - left.row.updatedAt;
  });
  return ordered.slice(0, limit).map((item) => item.row);
}

/**
 * Applies the funnel's selection to already-cached rows, so a filter change
 * re-renders instantly instead of waiting on the network. Anything the cache
 * cannot answer (a `merged`/`closed`/`all` state the sweep never fetched) is
 * served by the search unary; this only narrows what is already here.
 */
export function filterGithubMentionRows(
  rows: ReadonlyArray<GithubMentionRow>,
  section: GithubMentionSection,
  filter: GithubMentionFilter,
): ReadonlyArray<GithubMentionRow> {
  return rows.filter(
    (row) =>
      rowMatchesRepository(row, filter.repository) &&
      rowMatchesState(row, filter.state) &&
      rowMatchesInvolvement(row, section, filter.involvement),
  );
}

function rowMatchesRepository(
  row: GithubMentionRow,
  repository: GithubMentionRepository | null,
): boolean {
  if (repository === null) return true;
  // Folded like the scope boundary: the row is API-cased, the selection came
  // from the remote-parsed repositories list.
  return (
    githubRepositoryIdentityKey(row) === githubRepositoryIdentityKey(repository)
  );
}

function rowMatchesState(row: GithubMentionRow, state: string): boolean {
  if (state === "all") return true;
  return row.state === state;
}

/**
 * Involvement is answered from the row's own buckets. `everyone` never
 * narrows; a bucket the host did not emit for this row means the row is not in
 * it, which is exactly what a filter should conclude.
 */
function rowMatchesInvolvement(
  row: GithubMentionRow,
  section: GithubMentionSection,
  involvement: string,
): boolean {
  if (involvement === "everyone") return true;
  const bucket = involvementBucket(section, involvement);
  if (bucket === null) return true;
  return row.buckets.includes(bucket);
}

function involvementBucket(
  section: GithubMentionSection,
  involvement: string,
): GithubMentionBucket | null {
  if (involvement === "review-requested" && section === "pull-requests") {
    return "review-requested";
  }
  if (involvement === "assigned") return "assigned";
  if (involvement === "authored") return "authored";
  if (involvement === "mentions" && section === "issues") return "mentions";
  return null;
}

/**
 * A query the user clearly meant as a REFERENCE rather than as prose: a bare
 * number (`123` or `#123`), an `org/repo#123`, or a pasted GitHub PR/issue
 * URL. The hash is optional on the bare form because `numberMatchScore`
 * already treats bare digits as exact-number intent - one answer to "is this
 * query a number naming a row?", not a ranker that says yes while the
 * exemption and the `Resolve in ...` rows say no.
 *
 * Two rules read this. Ranking puts an exact number match on top, and the root
 * step's zero-match auto-close is suppressed for these - a reference that the
 * cache happens not to hold is precisely the case where closing the menu is
 * wrong, because the section can still resolve it.
 */
export type GithubReferenceQuery =
  | { readonly kind: "number"; readonly number: number }
  | {
      readonly kind: "repository";
      /**
       * Null for the two-segment `owner/repo#123` form. Three segments parse
       * as `host/owner/repo#123` - the exact identity the UI prints when a
       * scope holds the same `owner/repo` on two hosts, so typing that
       * displayed form back must rank as the reference it is. A repository
       * name cannot contain `/`, which is what makes the segment count
       * unambiguous.
       */
      readonly githubHost: string | null;
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
    }
  | {
      readonly kind: "url";
      readonly githubHost: string;
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
      readonly section: GithubMentionSection;
    };

const BARE_NUMBER_REFERENCE = /^#?(\d{1,7})$/;
const REPOSITORY_REFERENCE = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)#(\d{1,7})$/;
const HOST_REPOSITORY_REFERENCE =
  /^([\w.-]+)\/([A-Za-z0-9][\w.-]*)\/([\w.-]+)#(\d{1,7})$/;
const URL_REFERENCE =
  /^(?:https?:\/\/)([\w.-]+)\/([A-Za-z0-9][\w.-]*)\/([\w.-]+)\/(pull|issues)\/(\d{1,7})(?:[/?#].*)?$/;

export function parseGithubReferenceQuery(
  rawQuery: string,
): GithubReferenceQuery | null {
  const query = rawQuery.trim();
  if (query.length === 0) return null;

  const bare = BARE_NUMBER_REFERENCE.exec(query);
  if (bare !== null) {
    const number = referenceNumber(bare[1]);
    return number === null ? null : { kind: "number", number };
  }

  const repository = REPOSITORY_REFERENCE.exec(query);
  if (repository !== null) {
    const number = referenceNumber(repository[3]);
    return number === null
      ? null
      : {
          kind: "repository",
          githubHost: null,
          owner: repository[1],
          repo: repository[2],
          number,
        };
  }

  const hostRepository = HOST_REPOSITORY_REFERENCE.exec(query);
  if (hostRepository !== null) {
    const number = referenceNumber(hostRepository[4]);
    return number === null
      ? null
      : {
          kind: "repository",
          githubHost: hostRepository[1],
          owner: hostRepository[2],
          repo: hostRepository[3],
          number,
        };
  }

  const url = URL_REFERENCE.exec(query);
  if (url !== null) {
    const number = referenceNumber(url[5]);
    return number === null
      ? null
      : {
          kind: "url",
          githubHost: url[1],
          owner: url[2],
          repo: url[3],
          number,
          section: url[4] === "pull" ? "pull-requests" : "issues",
        };
  }
  return null;
}

/**
 * The number a reference names, or `null` when it cannot name anything.
 *
 * The patterns above match `\d{1,7}`, which accepts `0` and `000`, while the
 * wire row schema requires a positive number. Without this, `@#0` classifies
 * as a resolvable reference: it suppresses root's zero-match auto-close and
 * offers `Resolve in Pull requests…` for an identity that no catalog or search
 * response can ever contain, so the menu stays open on a promise it cannot
 * keep. Treating it as ordinary prose is the honest answer.
 */
function referenceNumber(raw: string): number | null {
  const parsed = Number(raw);
  return parsed > 0 ? parsed : null;
}

/** The row kind a URL reference's section names. */
function referenceSectionMatchesKind(
  section: GithubMentionSection,
  kind: GithubMentionRow["kind"],
): boolean {
  return section === "pull-requests"
    ? kind === "pull-request"
    : kind === "issue";
}

function referenceMatchesRow(
  reference: GithubReferenceQuery,
  row: GithubMentionRow,
): boolean {
  if (reference.number !== row.number) return false;
  if (reference.kind === "number") return true;
  if (reference.owner.toLowerCase() !== row.owner.toLowerCase()) return false;
  if (reference.repo.toLowerCase() !== row.repo.toLowerCase()) return false;
  // A host-qualified repository reference names ONE host's row, exactly like
  // a URL's host does below; the two-segment form stays host-agnostic.
  if (
    reference.kind === "repository" &&
    reference.githubHost !== null &&
    reference.githubHost.toLowerCase() !== row.githubHost.toLowerCase()
  ) {
    return false;
  }
  // Case-folded like `owner` and `repo` above: hostnames are case-insensitive,
  // so a pasted `https://GitHub.com/org/repo/pull/1` must still match the row
  // it names rather than losing its exact-reference rank to text scoring.
  if (reference.kind === "url") {
    if (reference.githubHost.toLowerCase() !== row.githubHost.toLowerCase()) {
      return false;
    }
    // A URL says WHICH KIND it names, and only a URL does. `#123` and
    // `org/repo#123` are deliberately kind-agnostic - GitHub numbers pull
    // requests and issues from one sequence, so a bare number legitimately
    // resolves to either - but `/pull/123` cannot name issue 123. Ignoring the
    // parsed section scored that issue an exact 0, floated it to the top, and
    // let Enter insert a `github_issue` chip for a `/pull/` URL.
    return referenceSectionMatchesKind(reference.section, row.kind);
  }
  return true;
}

/**
 * Cache identity for a mention scope. The host keys its catalog by the repos
 * reachable from these folders; the client cannot see that mapping, so it keys
 * by the folder set itself - order-independent, because the same attached
 * folders in a different order are the same scope.
 *
 * The host and the epic are part of that identity, not decoration. The row
 * store is a single app-wide zustand store, while the rows it holds are
 * answers to a per-host, per-epic question: the `epic` bucket ranks THIS
 * epic's PRs first, and two hosts can serve entirely different repositories
 * from identical absolute paths. Keying on paths alone lets a second tab read
 * the first one's rows and - because root rows are immediately insertable -
 * commit a reference belonging to another host or task before its own catalog
 * answer replaces them.
 */
export function githubMentionScopeKey(
  input: GithubMentionScopeIdentity,
): string {
  return [
    input.hostId ?? "",
    input.epicId ?? "",
    ...[...input.workspacePaths].toSorted(),
  ].join("\x1f");
}

export interface GithubMentionScopeIdentity {
  /** Null before a host is bound; its rows are keyed apart from any host's. */
  readonly hostId: string | null;
  /** Null in the landing composer, which is its own bucket. */
  readonly epicId: string | null;
  readonly workspacePaths: ReadonlyArray<string>;
}

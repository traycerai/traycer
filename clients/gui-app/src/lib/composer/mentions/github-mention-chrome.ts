import type {
  GithubMentionRepository,
  GithubMentionSection,
} from "@traycer/protocol/host/mention-schemas";
import type {
  PrSourceNotice,
  PrSourceStatus,
} from "@traycer/protocol/host/pr-schemas";

import type { GithubMentionFilter } from "./github-mention-rows";
import type { MentionStepChrome, MentionStepChromeStatus } from "./step-chrome";

/**
 * What a PR/Issue section's top bar and body affordances SAY, given what the
 * host answered.
 *
 * Pure, and deliberately so. Everything decided here is state-honesty policy -
 * when the ⓘ is suppressed, when the banner speaks instead, when the empty copy
 * is allowed to claim an empty scope - and that class of rule is exactly what
 * silently rots when it can only be exercised through a mocked query hook. A
 * safety property reachable only via a harness is one nobody re-tests when they
 * change it.
 *
 * The hook keeps the wiring; this keeps the decisions.
 */

// A live sweep can honestly take ~17s: up to 8s behind an in-flight `gh` call,
// ~1s of request spacing, then up to 8s of its own. The artifacts leash (10s)
// would release the spinner while the refresh the user asked for was still
// running, which reads as "done, nothing changed" over a sweep that had not
// finished.
export const GITHUB_MENTION_REFRESH_TIMEOUT_MS = 20_000;

/** The appended row's label - the `Loading…` idiom with a different word. */
export const GITHUB_MENTION_SEARCHING_LABEL = "Searching GitHub…";

// A REJECTED read's row. A rejection carries no response, so none of the
// answered chrome - banner, ⓘ notice, freshness - can move on it; without a
// row of its own the section renders the settled "No matching …" verdict over
// a question GitHub was never successfully asked, or a bare cached list whose
// live ask silently died. The adjacent Refresh button is the retry.
export const GITHUB_MENTION_ERRORED_LABEL = "Couldn't reach GitHub.";

// Distinct from "no matching pull requests" on purpose: one says the search
// came back empty, the other says there was never anything to search.
export const GITHUB_MENTION_EMPTY_SCOPE_LABEL =
  "No GitHub repositories found in this task's folders.";

export interface GithubMentionChromeInput {
  readonly section: GithubMentionSection;
  /**
   * Identity of the scope this chrome describes (host, epic, folders).
   *
   * Only the refresh button's remount key reads it - see
   * `MentionStepChromeRefresh.targetKey`. Taken from the caller rather than
   * rebuilt here, so it is the same string the row store and the query cache
   * are keyed by.
   */
  readonly scopeKey: string;
  /** Null in the landing composer; only decides where stickiness is keyed. */
  readonly epicId: string | null;
  /** The host's resolved scope, never inferred from the rows. */
  readonly repositories: ReadonlyArray<GithubMentionRepository>;
  /** Already reconciled against `repositories` by the caller. */
  readonly selected: GithubMentionFilter;
  /** False until the host has answered at all for this scope. */
  readonly scopeResolved: boolean;
  readonly sourceStatus: PrSourceStatus;
  readonly catalogNotice: PrSourceNotice | null;
  readonly searchNotice: PrSourceNotice | null;
  readonly freshnessAt: number | null;
  /**
   * The live search's own status, or null when no search has answered.
   *
   * Separate from `sourceStatus` because the two reads reach GitHub by
   * different routes: the catalog is cache-only and the search is not, so the
   * search can discover `gh-unavailable` while the catalog is still serving a
   * perfectly good cached list.
   */
  readonly searchSourceStatus: PrSourceStatus | null;
  readonly checking: boolean;
  readonly searching: boolean;
  /**
   * A REQUESTED read for THIS section failed outright - its cache-only
   * catalog read or its live search rejected with no answer. Distinct from
   * the degraded statuses above, which are answers: a rejection is the
   * absence of one, and the only honest chrome for it is its own row.
   */
  readonly errored: boolean;
  readonly onRefresh: () => Promise<void>;
}

export function githubMentionChromeFor(
  input: GithubMentionChromeInput,
): MentionStepChrome {
  // EITHER source proves `gh` unusable, and the search is the one that can
  // observe it FIRST: the catalog read is cache-only, so a host whose `gh`
  // disappeared after the last sweep answers it happily from cache and only
  // the live search actually tries to shell out. Reading the catalog alone
  // meant the typed search silently returned nothing while the banner that
  // explains why stayed hidden.
  const ghUnavailable =
    input.sourceStatus === "gh-unavailable" ||
    input.searchSourceStatus === "gh-unavailable";
  return {
    refresh: {
      onRefresh: input.onRefresh,
      refreshing: input.checking,
      // Scope AND section: both catalogs are refreshed by the same button
      // shape, and stepping between them is as much a target change as
      // detaching a folder.
      targetKey: `${input.scopeKey}\x1f${input.section}`,
      label:
        input.section === "pull-requests"
          ? "Refresh pull requests"
          : "Refresh issues",
      timeoutMs: GITHUB_MENTION_REFRESH_TIMEOUT_MS,
    },
    freshness: { updatedAt: input.freshnessAt, checking: input.checking },
    notice: noticeFor(input, ghUnavailable),
    filter: {
      section: input.section,
      epicId: input.epicId,
      repositories: input.repositories,
      selected: input.selected,
    },
    banner: ghUnavailable
      ? { kind: "gh-unavailable", section: input.section }
      : null,
    appendedStatus: appendedStatusFor(input),
    emptyLabel: emptyLabelFor(input),
  };
}

/**
 * A missing or signed-out `gh` gets the BANNER and nothing else.
 *
 * The ⓘ is the vocabulary of a PAUSE - it says "this resumes on its own" and
 * carries a countdown - and waiting fixes nothing here. The host is contracted
 * to send `notice: null` on this status; suppressing it structurally means a
 * host that ever breaks that contract degrades to one honest message rather
 * than to a countdown that never resolves.
 *
 * Otherwise the catalog's notice wins over the search's: a paused fetch layer
 * is a property of the host's GitHub access, not of the one search that
 * happened to observe it. This is also the channel budget-floor suppression
 * arrives on (the host maps it to a `rate-limited` notice with `retryAt`), so
 * it renders identically to a rate-limit pause.
 */
function noticeFor(
  input: GithubMentionChromeInput,
  ghUnavailable: boolean,
): PrSourceNotice | null {
  if (ghUnavailable) return null;
  return input.catalogNotice ?? input.searchNotice;
}

/**
 * The appended row below the rows, non-null whenever the list on screen is
 * not a settled answer - which is also what suppresses the settled
 * "No matching …" verdict in the menu.
 *
 * Searching wins over errored: retries keep the in-flight flags true, so the
 * error row appears exactly when the ask has given up, and a new ask
 * supersedes the old failure. The error row does double duty: with no rows it
 * replaces the empty verdict for a question GitHub never answered, and over
 * cached rows it is the in-menu report that the live ask died - the same
 * degrade-in-place channel as the banner and the ⓘ, for the one outcome that
 * carries no response. `busy` follows the meaning: a search is in-flight
 * work, a failure that has given up must not spin.
 */
function appendedStatusFor(
  input: GithubMentionChromeInput,
): MentionStepChromeStatus | null {
  if (input.searching) {
    return { label: GITHUB_MENTION_SEARCHING_LABEL, busy: true };
  }
  if (input.errored) {
    return { label: GITHUB_MENTION_ERRORED_LABEL, busy: false };
  }
  return null;
}

/**
 * `repositories: []` from a host that HAS answered is the authoritative "these
 * folders hold no GitHub repo". Gated on `scopeResolved` so the first paint -
 * before any answer - says nothing rather than claiming an empty scope it has
 * not been told about.
 */
function emptyLabelFor(input: GithubMentionChromeInput): string | null {
  if (!input.scopeResolved) return null;
  if (input.repositories.length > 0) return null;
  return GITHUB_MENTION_EMPTY_SCOPE_LABEL;
}

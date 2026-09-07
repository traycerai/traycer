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

/** What a PR/Issue section's top bar and body affordances SAY, given what the host answered. */

// A live sweep can honestly take ~17s: up to 8s behind an in-flight `gh` call, ~1s of request spacing, then up to 8s of its own.
// The artifacts leash (10s) would release the spinner while the refresh the user asked for was still running, which reads as "done, nothing changed" over a sweep that had not finished.
export const GITHUB_MENTION_REFRESH_TIMEOUT_MS = 20_000;

/** The appended row's label - the `Loading…` idiom with a different word. */
export const GITHUB_MENTION_SEARCHING_LABEL = "Searching GitHub…";

// A REJECTED read's row.
// A rejection carries no response, so none of the answered chrome - banner, ⓘ notice, freshness - can move on it; without a row of its own the section renders the settled "No matching …" verdict over a question GitHub was never successfully asked, or a bare.
export const GITHUB_MENTION_ERRORED_LABEL = "Couldn't reach GitHub.";

// Distinct from "no matching pull requests" on purpose: one says the search
// came back empty, the other says there was never anything to search.
export const GITHUB_MENTION_EMPTY_SCOPE_LABEL =
  "No GitHub repositories found in this task's folders.";

export interface GithubMentionChromeInput {
  readonly section: GithubMentionSection;
  /** Identity of the scope this chrome describes (host, epic, folders). */
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
  /** The live search's own status, or null when no search has answered. */
  readonly searchSourceStatus: PrSourceStatus | null;
  readonly checking: boolean;
  readonly searching: boolean;
  /**
   * A REQUESTED read for THIS section failed outright - its cache-only catalog read or its live search rejected with no answer.
   * Distinct from the degraded statuses above, which are answers: a rejection is the absence of one, and the only honest chrome for it is its own row.
   */
  readonly errored: boolean;
  readonly onRefresh: () => Promise<void>;
}

export function githubMentionChromeFor(
  input: GithubMentionChromeInput,
): MentionStepChrome {
  // EITHER source proves `gh` unusable, and the search is the one that can observe it FIRST: the catalog read is cache-only, so a host whose `gh` disappeared after the last sweep answers it happily from cache and only the live search actually tries to shell out.
  const ghUnavailable =
    input.sourceStatus === "gh-unavailable" ||
    input.searchSourceStatus === "gh-unavailable";
  return {
    refresh: {
      onRefresh: input.onRefresh,
      refreshing: input.checking,
      // Scope AND section: both catalogs are refreshed by the same button shape, and stepping between them is as much a target change as detaching a folder.
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

/** A missing or signed-out `gh` gets the BANNER and nothing else. */
function noticeFor(
  input: GithubMentionChromeInput,
  ghUnavailable: boolean,
): PrSourceNotice | null {
  if (ghUnavailable) return null;
  return input.catalogNotice ?? input.searchNotice;
}

/**
 * The appended row below the rows, non-null whenever the list on screen is not a settled answer - which is also what suppresses the settled "No matching …" verdict in the menu.
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
 * `repositories: []` from a host that HAS answered is the authoritative "these folders hold no GitHub repo".
 * Gated on `scopeResolved` so the first paint - before any answer - says nothing rather than claiming an empty scope it has not been told about.
 */
function emptyLabelFor(input: GithubMentionChromeInput): string | null {
  if (!input.scopeResolved) return null;
  if (input.repositories.length > 0) return null;
  return GITHUB_MENTION_EMPTY_SCOPE_LABEL;
}

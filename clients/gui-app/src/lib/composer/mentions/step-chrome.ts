import type {
  GithubMentionRepository,
  GithubMentionSection,
} from "@traycer/protocol/host/mention-schemas";
import type { PrSourceNotice } from "@traycer/protocol/host/pr-schemas";

import type { GithubMentionFilter } from "./github-mention-rows";

/**
 * The mention menu's per-step top bar, and the two body affordances that only
 * some steps have.
 *
 * Split deliberately across two layers, because the two halves of the answer
 * live in different places and cannot be merged without dragging hooks into a
 * module-level singleton:
 *
 * - The provider registry (`providers.tsx`) is hook-free and declares only the
 *   STATIC capability per step - "this step has a refresh button", "this step
 *   has a filter" - via {@link MentionStepChromeCapability}.
 * - The live values (a query's `refetch`, whether it is in flight, the host's
 *   freshness stamp and notice) exist only in the hook layer, so they are
 *   published into the picker store as a {@link MentionStepChrome}, exactly
 *   the way `retryLoad` / `commit` / `clientRect` already are. `composer-menu`
 *   renders from the store.
 *
 * Nothing here holds a `ReactNode`. A node rebuilt every render would change
 * identity on every publish and the store's shallow equality could not damp
 * it; the filter slot is therefore described (which section, which repos) and
 * the menu renders the control itself.
 */

/** What a step's chrome CAN have. Declared statically by the registry. */
export interface MentionStepChromeCapability {
  readonly refresh: boolean;
  readonly freshness: boolean;
  readonly filter: boolean;
}

export const NO_STEP_CHROME_CAPABILITY: MentionStepChromeCapability = {
  refresh: false,
  freshness: false,
  filter: false,
};

export interface MentionStepChromeRefresh {
  readonly onRefresh: () => Promise<void>;
  readonly refreshing: boolean;
  /**
   * Identity of what this button refreshes - the button is REMOUNTED when it
   * changes.
   *
   * `useRefreshSpinner` keeps its own `localRefreshing`, and the button stays
   * mounted while the host, the epic, the attached folders or the section move
   * underneath it. Without a remount, a refresh issued for the scope the user
   * left holds the new scope's button disabled until that promise settles or
   * the leash expires - up to 20s for a GitHub sweep, on a request the new
   * scope never made.
   */
  readonly targetKey: string;
  /** Button label and tooltip; also its accessible name. */
  readonly label: string;
  /**
   * Spinner leash for this step's refresh. Artifacts answer from local state
   * and use the short leash; a GitHub sweep can honestly take ~17s behind two
   * `gh` timeouts plus request spacing, so ending its spinner at 10s would
   * report "done" over a refresh that is still running.
   */
  readonly timeoutMs: number;
}

export interface MentionStepChromeFreshness {
  /** Epoch ms of the last successful fetch, or null when never fetched. */
  readonly updatedAt: number | null;
  readonly checking: boolean;
}

export interface MentionStepChromeFilter {
  readonly section: GithubMentionSection;
  /** Null in composers without an epic - those start from defaults every time. */
  readonly epicId: string | null;
  /** Repos in scope; the Repository group only renders when there is >1. */
  readonly repositories: ReadonlyArray<GithubMentionRepository>;
  /**
   * The filter the list is ACTUALLY applying - already reconciled against
   * `repositories`.
   *
   * Published rather than re-read from the store by the control, because the
   * two answers can differ: a stored repository that has left the scope
   * reconciles to "all repositories" for the list, and a popover reading the
   * raw store would then show a lit dot, an unfiltered list, and a Repository
   * group with nothing selected - one split source of truth wearing three
   * faces.
   */
  readonly selected: GithubMentionFilter;
}

/**
 * A degraded source the user has to be told about in words rather than by a
 * pause countdown. Waiting does not fix these, so they are banners, not ⓘ.
 */
export type MentionStepChromeBanner = {
  readonly kind: "gh-unavailable";
  readonly section: GithubMentionSection;
};

/**
 * The appended row below the rows. `busy` decides the glyph: true is the
 * `Loading…` idiom (spinning dots - work is in flight), false is a plain
 * statement (a failed ask that has GIVEN UP must not spin - a spinner beside
 * "Couldn't reach GitHub." would claim progress the read is not making).
 */
export type MentionStepChromeStatus = {
  readonly label: string;
  readonly busy: boolean;
};

export interface MentionStepChrome {
  readonly refresh: MentionStepChromeRefresh | null;
  readonly freshness: MentionStepChromeFreshness | null;
  readonly notice: PrSourceNotice | null;
  readonly filter: MentionStepChromeFilter | null;
  readonly banner: MentionStepChromeBanner | null;
  /**
   * The appended status row below the rows. Null when nothing needs saying
   * behind the already-rendered list. Non-null also suppresses the settled
   * empty verdict: both of its states (searching, failed) mean the list on
   * screen is not a settled answer.
   */
  readonly appendedStatus: MentionStepChromeStatus | null;
  /**
   * Replaces the provider's generic empty copy when the step can say something
   * truer - "No GitHub repositories found in this task's folders." beats "No
   * matching pull requests" when the scope itself is empty.
   */
  readonly emptyLabel: string | null;
}

export const EMPTY_STEP_CHROME: MentionStepChrome = {
  refresh: null,
  freshness: null,
  notice: null,
  filter: null,
  banner: null,
  appendedStatus: null,
  emptyLabel: null,
};

/**
 * Value equality for a published chrome. The store damps republishes with
 * this so a hook that rebuilds its chrome object every render does not drive
 * a render loop through the store.
 */
export function sameMentionStepChrome(
  left: MentionStepChrome | null,
  right: MentionStepChrome | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    sameRefresh(left.refresh, right.refresh) &&
    sameFreshness(left.freshness, right.freshness) &&
    sameNotice(left.notice, right.notice) &&
    sameFilter(left.filter, right.filter) &&
    sameBanner(left.banner, right.banner) &&
    sameStatus(left.appendedStatus, right.appendedStatus) &&
    left.emptyLabel === right.emptyLabel
  );
}

// Field-wise like every object above: the chrome is rebuilt per render, so a
// reference compare here would republish on every one.
function sameStatus(
  left: MentionStepChromeStatus | null,
  right: MentionStepChromeStatus | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.label === right.label && left.busy === right.busy;
}

function sameRefresh(
  left: MentionStepChromeRefresh | null,
  right: MentionStepChromeRefresh | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.onRefresh === right.onRefresh &&
    left.refreshing === right.refreshing &&
    left.label === right.label &&
    left.timeoutMs === right.timeoutMs &&
    left.targetKey === right.targetKey
  );
}

function sameFreshness(
  left: MentionStepChromeFreshness | null,
  right: MentionStepChromeFreshness | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.updatedAt === right.updatedAt && left.checking === right.checking;
}

function sameNotice(
  left: PrSourceNotice | null,
  right: PrSourceNotice | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind && left.retryAt === right.retryAt;
}

function sameFilter(
  left: MentionStepChromeFilter | null,
  right: MentionStepChromeFilter | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.section === right.section &&
    left.epicId === right.epicId &&
    sameSelection(left.selected, right.selected) &&
    sameRepositories(left.repositories, right.repositories)
  );
}

function sameSelection(
  left: GithubMentionFilter,
  right: GithubMentionFilter,
): boolean {
  return (
    left.state === right.state &&
    left.involvement === right.involvement &&
    sameRepository(left.repository, right.repository)
  );
}

// Verbatim on purpose, unlike the FOLDED identity comparisons in
// `github-mention-rows.ts` (here and in `sameRepositories` below): both sides
// are successive publications of the same pipeline, not two provenances to
// reconcile, and a casing change in what the chrome would PRINT is a real
// change the chrome must republish.
function sameRepository(
  left: GithubMentionRepository | null,
  right: GithubMentionRepository | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.githubHost === right.githubHost &&
    left.owner === right.owner &&
    left.repo === right.repo
  );
}

function sameRepositories(
  left: ReadonlyArray<GithubMentionRepository>,
  right: ReadonlyArray<GithubMentionRepository>,
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((repository, index) => {
    const other = right[index];
    return (
      repository.githubHost === other.githubHost &&
      repository.owner === other.owner &&
      repository.repo === other.repo
    );
  });
}

function sameBanner(
  left: MentionStepChromeBanner | null,
  right: MentionStepChromeBanner | null,
): boolean {
  if (left === null || right === null) return left === right;
  // `kind` has one member today, so comparing it would be a tautology. Compare
  // it here the moment a second banner kind exists.
  return left.section === right.section;
}

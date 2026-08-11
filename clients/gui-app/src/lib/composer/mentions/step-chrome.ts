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

export interface MentionStepChrome {
  readonly refresh: MentionStepChromeRefresh | null;
  readonly freshness: MentionStepChromeFreshness | null;
  readonly notice: PrSourceNotice | null;
  readonly filter: MentionStepChromeFilter | null;
  readonly banner: MentionStepChromeBanner | null;
  /**
   * Label for an appended spinner row below the rows (the existing `Loading…`
   * idiom with a different word). Null when nothing is running behind the
   * already-rendered list.
   */
  readonly appendedStatus: string | null;
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
    left.appendedStatus === right.appendedStatus &&
    left.emptyLabel === right.emptyLabel
  );
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
    left.timeoutMs === right.timeoutMs
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

import type { LandingDraftTab } from "@/stores/home/landing-draft-store";
import { landingDraftDisplayTitle } from "@/lib/composer/landing-draft-title";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";

export interface HistoryLandingDraft {
  readonly id: string;
  readonly title: string;
  readonly lastTouchedAt: number;
  readonly workspacePath: string | null;
  readonly closed: boolean;
}

/**
 * Landing drafts this history facet may list: every retained draft with
 * content, whichever host owns it. Drafts are one account-wide set; a row
 * another host owns opens like any other and FORKS underneath on the first
 * edit (the content moves into a fresh row of this host's own, and the
 * original's cloud row is retracted by the host that takes the fork), and
 * a delete of such a row retracts the owner's cloud row on the user's
 * authority rather than deleting it on a host that does not hold it
 * (`HistoryDraftsList`). Ownership is never a bucket the user sees.
 */
export function isHistoryListedLandingDraft(draft: LandingDraftTab): boolean {
  return !isEmptyLandingDraftContent(draft.content);
}

export function listHistoryLandingDrafts(input: {
  readonly drafts: ReadonlyArray<LandingDraftTab>;
  readonly query: string;
  /**
   * The draft the composer above this list is editing right now. Listing it
   * would show the user the prompt they are typing as a row directly under
   * the box they are typing it into, so it stays out; `null` when the list
   * is not rendered beneath a composer (the history page and modal).
   */
  readonly excludeDraftId: string | null;
}): ReadonlyArray<HistoryLandingDraft> {
  const needle = input.query.trim().toLowerCase();
  return input.drafts
    .filter((draft) => draft.id !== input.excludeDraftId)
    .filter(isHistoryListedLandingDraft)
    .map((draft) => ({
      id: draft.id,
      title: landingDraftDisplayTitle(draft.content),
      lastTouchedAt: draft.lastTouchedAt,
      workspacePath: historyDraftWorkspacePath(draft),
      closed: draft.closed,
    }))
    .filter((draft) =>
      needle.length === 0 ? true : draft.title.toLowerCase().includes(needle),
    )
    .sort(compareHistoryLandingDrafts);
}

function historyDraftWorkspacePath(draft: LandingDraftTab): string | null {
  if (
    draft.workspace.primaryPath !== null &&
    draft.workspace.primaryPath.length > 0
  ) {
    return draft.workspace.primaryPath;
  }
  if (draft.workspace.folders.length === 0) return null;
  const first = draft.workspace.folders[0];
  return first.length > 0 ? first : null;
}

function compareHistoryLandingDrafts(
  left: HistoryLandingDraft,
  right: HistoryLandingDraft,
): number {
  if (left.lastTouchedAt !== right.lastTouchedAt) {
    return right.lastTouchedAt - left.lastTouchedAt;
  }
  return left.id.localeCompare(right.id);
}

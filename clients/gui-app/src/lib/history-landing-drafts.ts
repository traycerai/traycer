import type { LandingDraftTab } from "@/stores/home/landing-draft-store";
import { landingDraftDisplayTitle } from "@/lib/composer/landing-draft-title";

export interface HistoryLandingDraft {
  readonly id: string;
  readonly title: string;
  readonly lastTouchedAt: number;
  readonly workspacePath: string | null;
  readonly closed: boolean;
}

/**
 * Landing drafts this history facet may list: this host's store, not T8's
 * other-host cloud-drafts surface. Replicas and foreign-owned rows stay out.
 *
 * An unresolved host cannot MATCH an owner, so a row stamped with one stays
 * out while `currentHostId` is null. Treating the unresolved case as "mine"
 * hands the facet's open and delete actions a row that may belong to another
 * machine, on the one read where we cannot tell.
 */
export function isHistoryListedLandingDraft(
  draft: LandingDraftTab,
  currentHostId: string | null,
): boolean {
  if (draft.origin === "replica") return false;
  if (draft.ownerHostId !== null && draft.ownerHostId !== currentHostId) {
    return false;
  }
  return true;
}

export function listHistoryLandingDrafts(input: {
  readonly drafts: ReadonlyArray<LandingDraftTab>;
  readonly query: string;
  readonly currentHostId: string | null;
}): ReadonlyArray<HistoryLandingDraft> {
  const needle = input.query.trim().toLowerCase();
  return input.drafts
    .filter((draft) => isHistoryListedLandingDraft(draft, input.currentHostId))
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

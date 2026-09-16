import { v4 as uuidv4 } from "uuid";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { appLogger, describeLogError } from "@/lib/logger";
import type { TabRef } from "@/stores/tabs/types";

/**
 * The fork rule for a landing draft this host does not own: carry its
 * content into a fresh draft of this host's own (with `supersedes` naming
 * the original), re-key the tab onto it, and retire the original locally.
 * The copy adopts and publishes through the normal path, and where that
 * path has no host to publish to it stays a local draft - the same fallback
 * every new draft already has. Nothing is shown; the user keeps typing into
 * what reads as the same draft.
 *
 * The original is retired here, not deleted: the fork's first publish makes
 * its host retract the original's cloud row, and the owner host tombstones
 * (or re-mints) its local row from there. The retirement receipt keeps the
 * original from being ingested back onto this device as a duplicate.
 *
 * Returns the new draft id, or `null` when the source no longer exists (or
 * the fork was refused mid-transaction, which leaves the source and its
 * tab exactly as they were).
 */
export function forkLandingDraftInPlace(sourceId: string): string | null {
  const nextId = uuidv4();
  let replaced: TabRef | null;
  try {
    replaced = tabCommandCoordinator.replaceDraftWithDraft({
      previousDraftId: sourceId,
      nextDraftId: nextId,
    });
  } catch (error: unknown) {
    appLogger.warn("[draft-fork] landing fork refused", {
      draftId: sourceId,
      error: describeLogError(error),
    });
    return null;
  }
  if (replaced !== null) return nextId;
  // No strip item for the source (a surface outside the strip): the store
  // alone carries the fork, and the active draft follows it.
  const store = useLandingDraftStore.getState();
  if (!store.forkDraft(sourceId, nextId)) return null;
  store.applyHostDelete(sourceId);
  return nextId;
}

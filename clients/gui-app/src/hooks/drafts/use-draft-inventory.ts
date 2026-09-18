import { useMemo, useSyncExternalStore } from "react";

import {
  draftInventoryOwnerHostIds,
  listDraftInventory,
  type DraftInventoryFilter,
  type DraftInventoryRow,
  type DraftInventoryScope,
} from "@/lib/drafts/draft-inventory";
import {
  hasDraftMirrorSession,
  subscribeDraftMirrorSessions,
} from "@/lib/drafts/draft-mirror-coordinator";
import { useComposerDraftStore } from "@/stores/composer/composer-draft-store";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useOpenChatIds } from "@/stores/epics/canvas/canvas-selectors";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";

/**
 * Session registry ticks. `hasDraftMirrorSession` reads a live Map, so the
 * memo below needs something that CHANGES when a session is acquired or
 * released; the coordinator's subscription is the notification and this is
 * its snapshot.
 */
let sessionEpoch = 0;

function subscribeSessionEpoch(onStoreChange: () => void): () => void {
  return subscribeDraftMirrorSessions(() => {
    sessionEpoch += 1;
    onStoreChange();
  });
}

function readSessionEpoch(): number {
  return sessionEpoch;
}

/**
 * `epoch` is deliberately unread: the answer comes from the coordinator's
 * live registry, and the epoch is only what ties the caller's memo to it.
 */
function hostIdsWithSession(
  candidates: ReadonlyArray<string>,
  _epoch: number,
): ReadonlySet<string> {
  return new Set(candidates.filter((hostId) => hasDraftMirrorSession(hostId)));
}

/**
 * The drafts a composer may list, newest first (D05-D13). Keep the consumer
 * SMALL - the control, not the composer body: the landing and composer store
 * slices are replaced on every keystroke anywhere in the app, so anything
 * that reads this hook re-renders with them.
 */
export function useDraftInventory(
  scope: DraftInventoryScope,
  filter: DraftInventoryFilter,
): ReadonlyArray<DraftInventoryRow> {
  const landing = useLandingDraftStore((state) => state.drafts);
  const composer = useComposerDraftStore((state) => state.drafts);
  const newChat = useNewConversationModalStore(
    (state) => state.draftPatchesByEpicId,
  );
  const openChatIds = useOpenChatIds();
  const epoch = useSyncExternalStore(
    subscribeSessionEpoch,
    readSessionEpoch,
    readSessionEpoch,
  );
  const liveSessionHostIds = useMemo(
    () =>
      hostIdsWithSession(draftInventoryOwnerHostIds(composer, newChat), epoch),
    [composer, newChat, epoch],
  );
  // Keyed on the scope's FIELDS, not its identity: every call site builds the
  // scope inline, and an object that is new each render makes the memo a no-op.
  const surface = scope.surface;
  const activeDraftId =
    scope.surface === "landing" ? scope.activeDraftId : null;
  const scopeEpicId = scope.surface === "landing" ? null : scope.epicId;
  const scopeChatId = scope.surface === "chat" ? scope.chatId : null;
  return useMemo(
    () =>
      listDraftInventory({
        scope: rebuildScope(surface, activeDraftId, scopeEpicId, scopeChatId),
        filter,
        landing,
        composer,
        newChat,
        openChatIds,
        liveSessionHostIds,
      }),
    [
      surface,
      activeDraftId,
      scopeEpicId,
      scopeChatId,
      filter,
      landing,
      composer,
      newChat,
      openChatIds,
      liveSessionHostIds,
    ],
  );
}

/** Row count for the pill's badge; hidden at zero by the control (D18). */
export function useDraftInventoryCount(
  scope: DraftInventoryScope,
  filter: DraftInventoryFilter,
): number {
  return useDraftInventory(scope, filter).length;
}

function rebuildScope(
  surface: DraftInventoryScope["surface"],
  activeDraftId: string | null,
  epicId: string | null,
  chatId: string | null,
): DraftInventoryScope {
  if (surface === "landing") return { surface, activeDraftId };
  if (surface === "chat") {
    return { surface, epicId: epicId ?? "", chatId: chatId ?? "" };
  }
  return { surface, epicId: epicId ?? "" };
}

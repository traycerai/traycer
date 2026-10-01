import { v4 as uuidv4 } from "uuid";
import type { UseNavigateResult } from "@tanstack/react-router";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { appLogger, describeLogError } from "@/lib/logger";
import {
  currentDraftBlobOwnerId,
  putDraftBlobsForWrite,
} from "@/lib/drafts/draft-blob-transport";
import { isDraftsCapabilityMissing } from "@/lib/drafts/draft-capability";
import { mintDraftId } from "@/lib/drafts/draft-ids";
import {
  composerBoundHostId,
  deleteLandingDraftThroughHost,
  hasDraftMirrorSession,
  newChatBoundHostId,
  retrySubmittedDraftDelete,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  composerDraftWrite,
  newChatTarget,
  requiredChatTarget,
} from "@/lib/drafts/draft-write-codec";
import { activateTabIntent } from "@/lib/tab-navigation";
import {
  openEpicTabIntent,
  resourceEpicTabIntent,
} from "@/lib/tab-navigation/intents";
import {
  applyComposerHostDocument,
  readComposerDraftSnapshot,
  useComposerDraftStore,
  type DraftState,
} from "@/stores/composer/composer-draft-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  applyNewChatHostDocument,
  useNewConversationModalStore,
  type NewConversationModalDraftPatch,
} from "@/stores/epics/new-conversation-modal-store";
import {
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";

/**
 * Row actions for the composer Drafts control: Open, Copy, Delete + Undo
 * (decisions D15-D17).
 *
 * Every host-reaching branch routes EXPLICITLY through the row's owner host
 * client, never through the mirror's implicit routing (`composerHostByChatId`,
 * `newChatHostByEpicId`). Those maps are written only by a MOUNTED composer or
 * modal, and this list exists precisely to act on rows whose surface is not
 * mounted - so the implicit route resolves nothing and the delete stops at the
 * local row while the host goes on listing it (critique C1, C2). It is the same
 * problem, and the same remedy, as `deleteLandingDraftThroughHost`.
 *
 * Deliberately React-free: navigation, clipboard, toasts and client resolution
 * live in `hooks/drafts/use-draft-inventory-actions.ts`, so the routing itself
 * is testable against the coordinator's fake-session harness.
 */

type NavigateFn = UseNavigateResult<string>;

type DraftClient = HostRequester<HostRpcRegistry> | null;

/**
 * `deleted: false` means nothing was removed anywhere - the caller shows no
 * toast rather than claiming a delete that did not happen. `undo` is null for
 * a row this host does not own: a retract has no local snapshot to restore
 * (D17). Undo returns whether it restored the local buffer.
 */
export type DraftRowDeleteOutcome =
  | { readonly deleted: false }
  | { readonly deleted: true; readonly undo: (() => boolean) | null };

/**
 * Open a chat row: activate its epic's header tab and land the chat tile on
 * that canvas in one navigation.
 *
 * NOT `useEpicTileNavigation().openTile`. That path returns right after
 * `prepare()` whenever the router is not already on the target epic tab
 * (`navigateNestedFocusWithDomRestore`), which is every open this list makes
 * from the landing page or from another epic: the tile appears on a canvas
 * the user is not looking at. The tab-navigation intent resolves (or creates)
 * the tab FIRST, runs the tile open against it, and carries the resulting
 * nested focus in the same route write - the same seam the session-import
 * "open task" button uses for exactly this shape of open.
 *
 * `false` only for a row with no owner host, which is unaddressable: the read
 * model does not produce one. Whether the chat still EXISTS is not decided
 * here - the tile renders its own missing / unreachable state.
 */
export function openChatDraftRow(
  navigate: NavigateFn,
  row: {
    readonly chatId: string;
    readonly epicId: string;
    readonly epicTitle: string | null;
    readonly chatTitle: string | null;
    readonly ownerHostId: string | null;
  },
): boolean {
  if (row.ownerHostId === null) return false;
  activateTabIntent(
    navigate,
    resourceEpicTabIntent({
      epicId: row.epicId,
      tabId: null,
      name: row.epicTitle ?? undefined,
      focus: {
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: undefined,
      },
      preparation: {
        kind: "open-tile",
        gesture: "explicit",
        // The plain LIVE ref (critique D4): `makeChatOpenTileRef`'s
        // published-copy branch needs `ownerUserId` / reachability from the
        // open-epic projector, which by construction does not exist for the
        // closed epics this list names. Consequence accepted in the plan: an
        // unreachable owner opens a live tile that reports its own
        // reachability, not the published copy.
        node: {
          id: row.chatId,
          instanceId: uuidv4(),
          type: "chat",
          name: row.chatTitle ?? "Chat",
          hostId: row.ownerHostId,
        },
      },
      includeNestedFocus: true,
    }),
    undefined,
  );
  return true;
}

/**
 * Open the epic and re-open its new-agent modal on the draft.
 *
 * The tab is resolved (or created) FIRST, then navigated to, then the request
 * is set - critique D5. `NewConversationModalHost` reads `request` through a
 * selector, so a request set before that host mounts is consumed on its first
 * render; what it cannot do is invent the `tabId` the request must name, which
 * is why the create happens here rather than being left to the navigation.
 */
export function openNewChatDraftRow(
  navigate: NavigateFn,
  row: {
    readonly epicId: string;
    readonly epicTitle: string | null;
    readonly ownerHostId: string | null;
  },
): boolean {
  if (row.ownerHostId === null) return false;
  const tabId = useEpicCanvasStore
    .getState()
    .resolveTargetTabForEpic(row.epicId, row.epicTitle ?? undefined);
  activateTabIntent(
    navigate,
    openEpicTabIntent({ epicId: row.epicId, focus: undefined }),
    undefined,
  );
  useNewConversationModalOpenStore.getState().open({
    epicId: row.epicId,
    tabId,
    placement: null,
    parentId: null,
    hostId: row.ownerHostId,
  });
  return true;
}

/**
 * Delete a start-page row. An own row goes through the host that HOLDS it
 * (the landing placement can point elsewhere), an unadopted row retires
 * locally, and a foreign row goes through the store's own `deleteDraft`: the
 * local mirror (and its tab) is gone at once, and the coordinator retracts
 * the cloud row through the placement host on the user's authority, retried
 * from the retirement receipt until that host answers. History used to keep
 * the mirror until the retract came back, which on a remote host is a visible
 * lag between the `Deleted` toast and the tab closing.
 */
export function deleteLandingDraftRow(
  draft: LandingDraftTab,
  hostId: string | null,
  client: DraftClient,
): DraftRowDeleteOutcome {
  const draftId = draft.id;
  const restore = (): boolean => {
    restoreLandingDraft(draft);
    return true;
  };
  // With no resolved host there is nowhere to route a delete or a retract, and
  // a local-only delete of a row with a cloud copy would leave that copy to be
  // ingested straight back. Only a row nobody else owns is safe.
  if (hostId === null) {
    if (draft.ownerHostId !== null || draft.origin === "replica") {
      return { deleted: false };
    }
    useLandingDraftStore.getState().deleteDraft(draftId);
    return { deleted: true, undo: restore };
  }
  if (draft.origin !== "replica" && draft.ownerHostId === hostId) {
    deleteLandingDraftThroughHost(draftId, hostId, client);
    return { deleted: true, undo: restore };
  }
  if (draft.origin !== "replica" && draft.ownerHostId === null) {
    useLandingDraftStore.getState().deleteDraft(draftId);
    return { deleted: true, undo: restore };
  }
  useLandingDraftStore.getState().deleteDraft(draftId);
  return { deleted: true, undo: null };
}

/**
 * Re-install a deleted start-page draft under a FRESH id, keeping its prior
 * `closed` state. The old id carries a retirement receipt (`deleteDraft` ->
 * `retireLandingDraft`), so re-creating under it would silently no-op - a
 * constraint of the retirement plane, not a preference.
 */
function restoreLandingDraft(draft: LandingDraftTab): void {
  useLandingDraftStore.getState().installLandingDraft({
    id: mintDraftId(),
    content: draft.content,
    selection: draft.selection,
    lastTouchedAt: draft.lastTouchedAt,
    settings: draft.settings,
    composerMode: draft.composerMode,
    workspace: draft.workspace,
    closed: draft.closed,
  });
}

/**
 * Delete a chat row: empty the local buffer, retire its draft identity, and
 * tombstone the host row through the owner host.
 *
 * `clearDraft` upserts an EMPTY row rather than deleting one (it routes through
 * `replaceDraft`), which the read model hides by filtering empties - so the
 * host tombstone below is what actually removes the row, and it has to be sent
 * here because the chat whose draft this is, is not mounted (C1, G7).
 */
export function deleteComposerDraftRow(
  row: {
    readonly chatId: string;
    readonly draftId: string;
    readonly ownerHostId: string | null;
    readonly foreign: boolean;
  },
  client: DraftClient,
): DraftRowDeleteOutcome {
  const before = readComposerDraftSnapshot(row.chatId);
  const store = useComposerDraftStore.getState();
  store.clearDraft(row.chatId);
  // Retire the id before any host round trip: `clearDraft` keeps it, so an
  // edit typed in that chat meanwhile would re-dirty the very id about to be
  // tombstoned. Fenced first, the next edit mints a fresh id and host row.
  // A foreign row records no pending DELETE - it is retracted, not deleted.
  store.fenceAndDetachSubmittedDraft(
    row.chatId,
    row.draftId,
    row.foreign ? null : row.ownerHostId,
  );
  // Undo may restore only this cleared buffer, never a later edit.
  const cleared = readComposerDraftSnapshot(row.chatId);
  const undo = row.foreign
    ? null
    : (): boolean => {
        if (readComposerDraftSnapshot(row.chatId) !== cleared) return false;
        restoreComposerDraft(row.chatId, before, row.ownerHostId, client);
        return true;
      };
  if (row.ownerHostId === null) return { deleted: true, undo };
  if (row.foreign) {
    store.recordPendingSubmittedDraftRetract(row.draftId, row.ownerHostId);
    if (client !== null) {
      settleComposerDelete(
        client.request("drafts.retract", { draftId: row.draftId }),
        row.draftId,
      );
    }
    return { deleted: true, undo };
  }
  if (hasDraftMirrorSession(row.ownerHostId)) {
    // A mounted session is preferred for the same reason a landing delete
    // prefers one: it serializes the tombstone behind this host's in-flight
    // upserts. The receipt this fence recorded is what it acts on.
    void retrySubmittedDraftDelete(row.draftId);
    return { deleted: true, undo };
  }
  if (client !== null) {
    settleComposerDelete(
      client.request("drafts.delete", { draftId: row.draftId }),
      row.draftId,
    );
  }
  return { deleted: true, undo };
}

/**
 * Put a deleted chat draft back in its composer, and - when that composer is
 * not mounted - on its owner host.
 *
 * `replaceDraft` alone is not enough for an unmounted chat. The fence dropped
 * the row's identity, so the restore mints a fresh `draftId` with no owner,
 * and nothing routes it: `routeLocalEdit` and the dirty-write collector both
 * resolve a chat draft through `composerHostByChatId`, which only a mounted
 * composer writes. The row would then be invisible to the drafts list (it
 * requires an owner host) and would never reach the host at all. So the
 * replacement write goes out here, and the host's answer is what restores
 * `ownerHostId` / `origin` / `hostRevision`.
 */
function restoreComposerDraft(
  chatId: string,
  before: DraftState,
  ownerHostId: string | null,
  client: DraftClient,
): void {
  useComposerDraftStore
    .getState()
    .replaceDraft(chatId, before.content, before.selection);
  if (ownerHostId === null || client === null) return;
  // A mounted composer's own session already took the restore through
  // `notifyDraftLocalEdit`; a second upsert here would race its flush.
  if (composerBoundHostId(chatId) !== null) return;
  const after = readComposerDraftSnapshot(chatId);
  // Without a target epic there is no chat target to write - the same
  // withholding the collector applies.
  if (after.draftId === null || after.targetEpicId === null) return;
  void publishRestoredDraft(
    { hostId: ownerHostId, client },
    composerDraftWrite({
      draftId: after.draftId,
      kind: "chat-composer",
      target: requiredChatTarget({
        epicId: after.targetEpicId,
        chatId,
        blockId: null,
      }),
      // A fresh id the host has never seen: revision 0, like any first write.
      revision: 0,
      lastTouchedAt: after.lastTouchedAt,
      content: after.content,
      selection: after.selection,
      runSettings: null,
      composerMode: "chat",
      workspace: null,
      closed: false,
      supersedes: after.supersedes,
    }),
    applyComposerHostDocument,
    () => composerBoundHostId(chatId) === null,
  );
}

/**
 * Send a restored row's first write on the owner host's client and apply the
 * answer. Best-effort, like every other unmounted-surface write here: a
 * failure leaves a dirty local row for the next session that binds it.
 */
async function publishRestoredDraft(
  owner: {
    readonly hostId: string;
    readonly client: HostRequester<HostRpcRegistry>;
  },
  write: DraftWrite,
  apply: (document: DraftDocument) => void,
  stillUnmounted: () => boolean,
): Promise<void> {
  const { hostId, client } = owner;
  try {
    await putDraftBlobsForWrite(
      hostId,
      client,
      write,
      currentDraftBlobOwnerId(),
    );
    // Blob upload yielded: a mounted session may now own this write.
    if (!stillUnmounted()) return;
    const response = await client.request("drafts.upsert", { draft: write });
    apply(response.draft);
  } catch (error: unknown) {
    if (isDraftsCapabilityMissing(error)) return;
    appLogger.warn("[drafts] restoring a draft on its owner host failed", {
      error: describeLogError(error),
    });
  }
}

/**
 * Clear the receipt once the host has answered. `absent` is as terminal as
 * `deleted` (ownership never moves), and a host too old for the method has
 * nothing to owe; anything else leaves the receipt pending, for whichever
 * session for that host mounts next to retry.
 */
function settleComposerDelete(answer: Promise<unknown>, draftId: string): void {
  void answer.then(
    () => {
      useComposerDraftStore.getState().completeSubmittedDraftDelete(draftId);
    },
    (error: unknown) => {
      if (isDraftsCapabilityMissing(error)) {
        useComposerDraftStore.getState().completeSubmittedDraftDelete(draftId);
        return;
      }
      appLogger.warn("[drafts] direct chat draft delete failed", {
        error: describeLogError(error),
      });
    },
  );
}

/**
 * Delete a new-agent row: remove the epic's patch and tombstone the host row.
 *
 * `clearDraft` notifies the coordinator before it removes the entry, but that
 * routed delete resolves its host through `newChatHostByEpicId`, which only a
 * MOUNTED modal writes - so for the rows this list is made of it reaches
 * nothing and the host goes on listing the draft (critique C2). Hence the
 * explicit request here, skipped only when the routed one has genuinely been
 * sent: the epic is bound AND that host's session is up. Deferring to the
 * session there is not just tidiness - a bare request cannot be ordered
 * against the upserts a mounted modal may still have in flight, and a delete
 * that overtakes one would be undone by it.
 *
 * Best-effort by design: a failed delete re-lists on the next `drafts.list`
 * and the user deletes again.
 */
export function deleteNewChatDraftRow(
  row: {
    readonly epicId: string;
    readonly draftId: string;
    readonly ownerHostId: string | null;
  },
  client: DraftClient,
): DraftRowDeleteOutcome {
  const boundHostId = newChatBoundHostId(row.epicId);
  const routed = boundHostId !== null && hasDraftMirrorSession(boundHostId);
  const before =
    useNewConversationModalStore.getState().draftPatchesByEpicId[row.epicId] ??
    null;
  useNewConversationModalStore.getState().clearDraft(row.epicId);
  const cleared =
    useNewConversationModalStore.getState().draftPatchesByEpicId[row.epicId];
  if (!routed && client !== null && row.ownerHostId !== null) {
    void client
      .request("drafts.delete", { draftId: row.draftId })
      .catch((error: unknown) => {
        if (isDraftsCapabilityMissing(error)) return;
        appLogger.warn("[drafts] direct new-chat draft delete failed", {
          error: describeLogError(error),
        });
      });
  }
  const content = before?.content ?? null;
  if (before === null || content === null) return { deleted: true, undo: null };
  return {
    deleted: true,
    undo: () => {
      if (
        useNewConversationModalStore.getState().draftPatchesByEpicId[
          row.epicId
        ] !== cleared
      ) {
        return false;
      }
      restoreNewChatDraft(row, before, content, client);
      return true;
    },
  };
}

/**
 * Put a deleted new-agent draft back. `setContent` mints a fresh identity (the
 * old entry is gone, receipts and all), and the remaining setters compare
 * before writing, so each one either restores its field or is a no-op. The
 * workspace goes back through `addResolvedFolders` with NO folders: merging
 * nothing onto the snapshot yields the snapshot, and the entry's own workspace
 * is null at that point, so the seed is written through verbatim - primary
 * folder included.
 *
 * As for a chat row, a restore with no modal mounted is routed nowhere - the
 * collector skips an epic absent from `newChatBoundHostId` - so the write goes
 * out on the owner host's client and its answer re-establishes the owner.
 */
function restoreNewChatDraft(
  row: { readonly epicId: string; readonly ownerHostId: string | null },
  patch: NewConversationModalDraftPatch,
  content: JsonContent,
  client: DraftClient,
): void {
  const { epicId, ownerHostId } = row;
  const store = useNewConversationModalStore.getState();
  store.setContent(epicId, content);
  if (patch.settings !== null) store.setSettings(epicId, patch.settings);
  if (patch.composerMode !== null) {
    store.setComposerMode(epicId, patch.composerMode);
  }
  if (patch.workspace !== null) {
    store.addResolvedFolders(epicId, patch.workspace, []);
  }
  if (patch.selection !== null) store.setSelection(epicId, patch.selection);
  if (ownerHostId === null || client === null) return;
  if (newChatBoundHostId(epicId) !== null) return;
  const after =
    useNewConversationModalStore.getState().draftPatchesByEpicId[epicId];
  if (after === undefined || after.draftId === null || after.content === null) {
    return;
  }
  void publishRestoredDraft(
    { hostId: ownerHostId, client },
    composerDraftWrite({
      draftId: after.draftId,
      kind: "new-chat",
      target: newChatTarget(epicId),
      revision: 0,
      lastTouchedAt: after.lastTouchedAt,
      content: after.content,
      selection: after.selection,
      runSettings: after.settings,
      composerMode: after.composerMode,
      workspace: after.workspace,
      closed: false,
      // New-chat drafts live on the epic's host and are never forked.
      supersedes: null,
    }),
    applyNewChatHostDocument,
    () => newChatBoundHostId(epicId) === null,
  );
}

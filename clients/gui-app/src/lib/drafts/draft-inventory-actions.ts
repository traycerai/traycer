import { v4 as uuidv4 } from "uuid";
import type { UseNavigateResult } from "@tanstack/react-router";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { DraftDocument, DraftWrite } from "@traycer/protocol/host";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { writeDraftAuthority, type WriteDraftAuthorityInput } from "./draft-authority";
import {
  captureDraftAuthorityActor,
  draftAuthorityActorIsCurrent,
} from "./draft-authority-session";
import type {
  DraftAuthorityActor,
  DraftAuthorityEditReceipt,
  DraftAuthorityHostRetirement,
  DraftAuthorityLandingFlush,
  DraftAuthorityVersion,
} from "./draft-authority-types";
import { appLogger, describeLogError } from "@/lib/logger";
import {
  currentDraftBlobOwnerId,
  putDraftBlobsForWrite,
} from "@/lib/drafts/draft-blob-transport";
import { isDraftsCapabilityMissing } from "@/lib/drafts/draft-capability";
import { mintDraftId } from "@/lib/drafts/draft-ids";
import {
  composerBoundHostId,
  deliverInventoryRetirement,
  newChatBoundHostId,
} from "@/lib/drafts/draft-mirror-coordinator";
import {
  composerDraftWrite,
  newChatTarget,
  requiredChatTarget,
} from "@/lib/drafts/draft-write-codec";
import { returnedSandboxFor } from "@/lib/sandboxes/returned-sandbox";
import { activateTabIntent } from "@/lib/tab-navigation";
import {
  openEpicTabIntent,
  resourceEpicTabIntent,
} from "@/lib/tab-navigation/intents";
import {
  applyComposerHostDocument,
  captureDirectSendChatDraft,
  flushCanonicalChatDraft,
  projectCanonicalChatDeletion,
  readComposerDraftSnapshot,
  useComposerDraftStore,
  type DraftState,
} from "@/stores/composer/composer-draft-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";
import {
  applyNewChatHostDocument,
  captureCanonicalTaskDraft,
  flushCanonicalTaskDraft,
  projectCanonicalTaskDeletion,
  useNewConversationModalStore,
  type NewConversationModalDraftPatch,
} from "@/stores/epics/new-conversation-modal-store";
import {
  captureCanonicalLandingDraft,
  projectCanonicalLandingDeletion,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";

/**
 * Row actions for the composer Drafts control: Open, Copy, Delete and
 * Undo.
 *
 * Every host-reaching branch routes EXPLICITLY through the row's owner host
 * client, never through the mirror's implicit routing (`composerHostByChatId`,
 * `newChatHostByEpicId`). Those maps are written only by a MOUNTED composer or
 * modal, and this list exists precisely to act on rows whose surface is not
 * mounted - so the implicit route resolves nothing and the delete stops at the
 * local row while the host goes on listing it (C1, C2). It is the same
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
 * a row this host does not own: a retract has no local snapshot to restore.
 * Undo returns whether it restored the local buffer.
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
        // The plain LIVE ref: `makeChatOpenTileRef`'s
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
 * is set. `NewConversationModalHost` reads `request` through a
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
  // A message given back on a sandbox opens unnamed, as its give-back does:
  // the composer then stages that sandbox again, so Send goes there. Only
  // for the account it was returned under: another's is never restored.
  const returned = returnedSandboxFor(
    useNewConversationModalStore.getState().draftPatchesByEpicId[row.epicId]
      ?.returnedSandbox ?? null,
    useAuthStore.getState().contextMetadata?.userId ?? null,
  );
  useNewConversationModalOpenStore.getState().open({
    epicId: row.epicId,
    tabId,
    placement: null,
    parentId: null,
    hostId: returned === null ? row.ownerHostId : null,
  });
  return true;
}

async function commitInventoryDelete(
  actor: DraftAuthorityActor,
  draft: DraftAuthorityVersion,
  route: DraftAuthorityHostRetirement | null,
  client: DraftClient,
  canvas: WriteDraftAuthorityInput["canvas"],
): Promise<DraftAuthorityEditReceipt | null> {
  const outcome = await writeDraftAuthority({
    operation: { id: mintDraftId(), actor },
    expected: { kind: "current", draft },
    mutation: { kind: "delete", retirements: route === null ? [] : [route] },
    ...(canvas === undefined ? {} : { canvas }),
  });
  if ((outcome.kind !== "committed" && outcome.kind !== "replayed") ||
    !draftAuthorityActorIsCurrent(actor)) {
    return null;
  }
  if (route !== null) {
    void deliverInventoryRetirement({ actor, receipt: outcome.receipt, hostId: route.hostId, client });
  }
  return outcome.receipt;
}

export async function deleteLandingDraftRow(
  draft: LandingDraftTab,
  hostId: string | null,
  client: DraftClient,
): Promise<DraftRowDeleteOutcome> {
  const actor = captureDraftAuthorityActor();
  const current = useLandingDraftStore.getState().drafts.find((entry) => entry.id === draft.id);
  const version = captureCanonicalLandingDraft(draft.id);
  if (actor === null || current !== draft || version === null) return { deleted: false };
  const unowned = draft.origin !== "replica" && draft.ownerHostId === null;
  if (hostId === null && !unowned) return { deleted: false };
  const foreign = !unowned &&
    (draft.origin === "replica" || draft.ownerHostId !== hostId);
  const route: DraftAuthorityHostRetirement | null = hostId === null || unowned
    ? null
    : {
        accountId: actor.accountId,
        hostId,
        draftId: draft.id,
        kind: foreign ? "retract" : "delete",
      };
  const receipt = await commitInventoryDelete(actor, version, route, client, undefined);
  if (receipt === null) return { deleted: false };
  await projectCanonicalLandingDeletion(receipt);
  if (!draftAuthorityActorIsCurrent(actor)) return { deleted: false };
  return {
    deleted: true,
    undo: foreign ? null : () => {
      if (!draftAuthorityActorIsCurrent(actor)) return false;
      restoreLandingDraft(draft);
      return true;
    },
  };
}

/**
 * Re-install a deleted start-page draft under a FRESH id, keeping its prior
 * `closed` state. The old id carries a retirement receipt (`deleteDraft` ->
 * `retireLandingDraft`), so re-creating under it would silently no-op - a
 * constraint of the retirement plane, not a preference.
 */
function restoreLandingDraft(draft: LandingDraftTab): void {
  const id = mintDraftId();
  useLandingDraftStore.getState().installLandingDraft({
    id,
    content: draft.content,
    selection: draft.selection,
    lastTouchedAt: draft.lastTouchedAt,
    settings: draft.settings,
    composerMode: draft.composerMode,
    workspace: draft.workspace,
    closed: draft.closed,
    // Stored: it keeps the account it was returned under.
    returnedSandbox: draft.returnedSandbox,
    // Undo restores the draft as it was, the machine it was opened for too.
    namedHostId: draft.namedHostId,
    // The deleted row is gone: memory is the last copy of it.
    durability: "in-memory",
  });
}

export async function deleteComposerDraftRow(
  row: {
    readonly chatId: string;
    readonly draftId: string;
    readonly ownerHostId: string | null;
    readonly foreign: boolean;
    readonly content: JsonContent;
    readonly lastTouchedAt: number;
  },
  client: DraftClient,
): Promise<DraftRowDeleteOutcome> {
  const actor = captureDraftAuthorityActor();
  const before = readComposerDraftSnapshot(row.chatId);
  if (actor === null || before.draftId !== row.draftId ||
    before.content !== row.content || before.lastTouchedAt !== row.lastTouchedAt ||
    before.ownerHostId !== row.ownerHostId) {
    return { deleted: false };
  }
  const capture = captureDirectSendChatDraft(row.chatId, row.ownerHostId, actor);
  if (capture === null) return { deleted: false };
  const route: DraftAuthorityHostRetirement | null = row.ownerHostId === null ? null : {
    accountId: actor.accountId,
    hostId: row.ownerHostId,
    draftId: row.draftId,
    kind: row.foreign ? "retract" : "delete",
  };
  const receipt = await commitInventoryDelete(actor, capture.draft, route, client, capture.canvas);
  if (receipt === null) return { deleted: false };
  await projectCanonicalChatDeletion(receipt);
  if (!draftAuthorityActorIsCurrent(actor)) return { deleted: false };
  return {
    deleted: true,
    undo: row.foreign ? null : () => {
      if (!draftAuthorityActorIsCurrent(actor) ||
        useComposerDraftStore.getState().drafts[row.chatId] !== undefined) {
        return false;
      }
      restoreComposerDraft(row.chatId, before, row.ownerHostId, client);
      return true;
    },
  };
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
  const store = useComposerDraftStore.getState();
  store.replaceDraft(chatId, before.content, before.selection);
  if (before.targetEpicId !== null) store.bindTarget(chatId, before.targetEpicId);
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
  captureDirectSendChatDraft,
  flushCanonicalChatDraft,
  projectCanonicalChatDeletion,
    () => composerBoundHostId(chatId) === null &&
      readComposerDraftSnapshot(chatId) === after,
    () => flushCanonicalChatDraft(chatId),
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
  flush: () => Promise<DraftAuthorityLandingFlush>,
): Promise<void> {
  const { hostId, client } = owner;
  const actor = captureDraftAuthorityActor();
  if (actor === null) return;
  try {
    const initial = await flush();
    if (initial.kind !== "committed" || !stillUnmounted() ||
      !draftAuthorityActorIsCurrent(actor)) return;
    await putDraftBlobsForWrite(
      hostId,
      client,
      write,
      currentDraftBlobOwnerId(),
    );
    const exact = await flush();
    if (exact.kind !== "committed" || exact.draft.version !== initial.draft.version ||
      !stillUnmounted() || !draftAuthorityActorIsCurrent(actor)) return;
    const response = await client.request("drafts.upsert", { draft: write });
    if (draftAuthorityActorIsCurrent(actor)) apply(response.draft);
  } catch (error: unknown) {
    if (isDraftsCapabilityMissing(error)) return;
    appLogger.warn("[drafts] restoring a draft on its owner host failed", {
      error: describeLogError(error),
    });
  }
}

export async function deleteNewChatDraftRow(
  row: {
    readonly epicId: string;
    readonly draftId: string;
    readonly ownerHostId: string | null;
    readonly content: JsonContent;
    readonly lastTouchedAt: number;
  },
  client: DraftClient,
): Promise<DraftRowDeleteOutcome> {
  const actor = captureDraftAuthorityActor();
  const before = useNewConversationModalStore.getState().draftPatchesByEpicId[row.epicId];
  const version = captureCanonicalTaskDraft(row.epicId);
  if (actor === null || before === undefined || version === null ||
    before.draftId !== row.draftId || before.content !== row.content ||
    before.lastTouchedAt !== row.lastTouchedAt ||
    (before.ownerHostId ?? newChatBoundHostId(row.epicId)) !== row.ownerHostId) {
    return { deleted: false };
  }
  const route: DraftAuthorityHostRetirement | null = row.ownerHostId === null ? null : {
    accountId: actor.accountId,
    hostId: row.ownerHostId,
    draftId: row.draftId,
    kind: "delete",
  };
  const receipt = await commitInventoryDelete(actor, version, route, client, undefined);
  if (receipt === null) return { deleted: false };
  await projectCanonicalTaskDeletion(receipt);
  if (!draftAuthorityActorIsCurrent(actor)) return { deleted: false };
  return {
    deleted: true,
    undo: () => {
      if (!draftAuthorityActorIsCurrent(actor) ||
        useNewConversationModalStore.getState().draftPatchesByEpicId[row.epicId] !== undefined) {
        return false;
      }
      restoreNewChatDraft(row, before, row.content, client);
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
  store.setReturnedSandbox(epicId, patch.returnedSandbox ?? null);
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
  captureCanonicalTaskDraft,
  flushCanonicalTaskDraft,
  projectCanonicalTaskDeletion,
    () => newChatBoundHostId(epicId) === null &&
      useNewConversationModalStore.getState().draftPatchesByEpicId[epicId] === after,
    () => flushCanonicalTaskDraft(epicId),
  );
}

import type { JsonContent } from "@traycer/protocol/common/registry";

import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
import { LANDING_DRAFT_TITLE_FALLBACK } from "@/lib/composer/landing-draft-title";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { newChatBoundHostId } from "@/lib/drafts/draft-mirror-coordinator";
import type { DraftState } from "@/stores/composer/composer-draft-store";
import type { NewConversationModalDraftPatch } from "@/stores/epics/new-conversation-modal-store";
import {
  isOpenLandingDraft,
  landingRowIsForeign,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";

/** Line 2 of a row is one line; anything past this is never drawn. */
const PREVIEW_LIMIT = 160;

/** A row published by a host before any local composer named its chat/epic. */
const CHAT_TITLE_FALLBACK = "Chat";
const EPIC_TITLE_FALLBACK = "Epic";
/** Title fallback for a textless (image-only) new-agent draft. */
const NEW_CHAT_TITLE_FALLBACK = "New agent";

interface DraftInventoryRowFields {
  /** Landing draft id, or the host row's `draftId` for the other kinds. */
  readonly id: string;
  readonly title: string;
  readonly preview: string;
  /** The document itself - Copy flattens it, Undo restores it. */
  readonly content: JsonContent;
  readonly lastTouchedAt: number;
  /** The draft's surface is open in this window (`Open` badge). */
  readonly open: boolean;
  /** Owned by another host: deleting retracts instead of deleting. */
  readonly foreign: boolean;
}

export type DraftInventoryRow =
  | (DraftInventoryRowFields & {
      readonly kind: "landing";
      /** `null` while the draft is unadopted - nothing to route through. */
      readonly ownerHostId: string | null;
    })
  | (DraftInventoryRowFields & {
      readonly kind: "chat";
      readonly chatId: string;
      readonly epicId: string;
      readonly ownerHostId: string;
      readonly chatTitle: string;
      readonly epicTitle: string;
    })
  | (DraftInventoryRowFields & {
      readonly kind: "new-chat";
      readonly epicId: string;
      readonly ownerHostId: string;
      readonly epicTitle: string;
    });

/**
 * Which composer is asking. The scope's OWN draft is the live buffer being
 * edited, so it is never a row under either filter.
 */
export type DraftInventoryScope =
  | { readonly surface: "landing"; readonly activeDraftId: string | null }
  | {
      readonly surface: "chat";
      readonly epicId: string;
      readonly chatId: string;
    }
  | { readonly surface: "new-chat"; readonly epicId: string };

export type DraftInventoryFilter = "current" | "all";

export interface DraftInventoryInput {
  readonly scope: DraftInventoryScope;
  readonly filter: DraftInventoryFilter;
  readonly landing: ReadonlyArray<LandingDraftTab>;
  readonly composer: Partial<Record<string, DraftState>>;
  readonly newChat: Readonly<
    Record<string, NewConversationModalDraftPatch | undefined>
  >;
  /** Chat ids open as a tile anywhere in this window. */
  readonly openChatIds: ReadonlySet<string>;
  /**
   * Hosts this window holds a draft mirror session with (D09). Chat and
   * new-chat rows for any other host are hidden rather than listed with a
   * dead Open: their stores are persisted and never sweep a host that is
   * simply gone.
   */
  readonly liveSessionHostIds: ReadonlySet<string>;
}

/**
 * The drafts list, newest first. Pure apart from two module-level reads the
 * stores themselves already depend on - the landing placement host
 * (`landingRowIsForeign`) and the epic's bound mirror host
 * (`newChatBoundHostId`).
 */
export function listDraftInventory(
  input: DraftInventoryInput,
): ReadonlyArray<DraftInventoryRow> {
  const all = input.filter === "all";
  const onLanding = input.scope.surface === "landing";
  const rows: DraftInventoryRow[] = [];
  // D05: the start page's "current" is the start page, and the two in-epic
  // surfaces' "current" is the epic. Each lists the other kinds only under All.
  if (onLanding || all) rows.push(...landingRows(input));
  if (!onLanding || all) {
    rows.push(...chatRows(input), ...newChatRows(input));
  }
  // D12: flat, newest first, ties broken by id so the order is total.
  return rows.sort(
    (left, right) =>
      right.lastTouchedAt - left.lastTouchedAt ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Owner hosts every chat / new-chat row would route through, for the hook to
 * intersect with the live session registry. Same resolution as the rows
 * below, so a row can never be listed for a host the intersection dropped.
 */
export function draftInventoryOwnerHostIds(
  composer: Partial<Record<string, DraftState>>,
  newChat: Readonly<Record<string, NewConversationModalDraftPatch | undefined>>,
): ReadonlyArray<string> {
  const hostIds = new Set<string>();
  for (const draft of Object.values(composer)) {
    if (draft === undefined || draft.ownerHostId === null) continue;
    hostIds.add(draft.ownerHostId);
  }
  for (const [epicId, patch] of Object.entries(newChat)) {
    if (patch === undefined) continue;
    const hostId = newChatOwnerHostId(epicId, patch);
    if (hostId !== null) hostIds.add(hostId);
  }
  return [...hostIds];
}

function newChatOwnerHostId(
  epicId: string,
  patch: NewConversationModalDraftPatch,
): string | null {
  return patch.ownerHostId ?? newChatBoundHostId(epicId);
}

function landingRows(
  input: DraftInventoryInput,
): ReadonlyArray<DraftInventoryRow> {
  const activeId =
    input.scope.surface === "landing" ? input.scope.activeDraftId : null;
  const rows: DraftInventoryRow[] = [];
  for (const draft of input.landing) {
    if (draft.id === activeId) continue;
    if (isEmptyLandingDraftContent(draft.content)) continue;
    rows.push({
      kind: "landing",
      ...commonFields(
        draft.id,
        draft.content,
        draft.lastTouchedAt,
        LANDING_DRAFT_TITLE_FALLBACK,
      ),
      open: isOpenLandingDraft(draft),
      foreign: landingRowIsForeign(draft),
      ownerHostId: draft.ownerHostId,
    });
  }
  return rows;
}

function chatRows(
  input: DraftInventoryInput,
): ReadonlyArray<DraftInventoryRow> {
  const { scope } = input;
  const epicScoped = input.filter === "current" && scope.surface !== "landing";
  const rows: DraftInventoryRow[] = [];
  for (const [chatId, draft] of Object.entries(input.composer)) {
    if (draft === undefined) continue;
    const { draftId, targetEpicId, ownerHostId } = draft;
    if (draftId === null || targetEpicId === null || ownerHostId === null) {
      continue;
    }
    if (scope.surface === "chat" && chatId === scope.chatId) continue;
    if (epicScoped && targetEpicId !== scope.epicId) continue;
    if (!input.liveSessionHostIds.has(ownerHostId)) continue;
    if (isEmptyLandingDraftContent(draft.content)) continue;
    // A textless chat draft falls back to the chat it belongs to - which is
    // itself `Chat` when no local composer has named it yet.
    const chatTitle = draft.chatTitle ?? CHAT_TITLE_FALLBACK;
    rows.push({
      kind: "chat",
      ...commonFields(draftId, draft.content, draft.lastTouchedAt, chatTitle),
      open: input.openChatIds.has(chatId),
      foreign: draft.origin === "replica",
      chatId,
      epicId: targetEpicId,
      ownerHostId,
      chatTitle,
      epicTitle: draft.epicTitle ?? EPIC_TITLE_FALLBACK,
    });
  }
  return rows;
}

function newChatRows(
  input: DraftInventoryInput,
): ReadonlyArray<DraftInventoryRow> {
  const { scope } = input;
  const epicScoped = input.filter === "current" && scope.surface !== "landing";
  const rows: DraftInventoryRow[] = [];
  for (const [epicId, patch] of Object.entries(input.newChat)) {
    if (patch === undefined) continue;
    const { draftId, content } = patch;
    if (draftId === null || content === null) continue;
    if (scope.surface === "new-chat" && epicId === scope.epicId) continue;
    if (epicScoped && epicId !== scope.epicId) continue;
    const ownerHostId = newChatOwnerHostId(epicId, patch);
    if (ownerHostId === null) continue;
    if (!input.liveSessionHostIds.has(ownerHostId)) continue;
    if (isEmptyLandingDraftContent(content)) continue;
    rows.push({
      kind: "new-chat",
      ...commonFields(
        draftId,
        content,
        patch.lastTouchedAt,
        NEW_CHAT_TITLE_FALLBACK,
      ),
      // A modal is never a tile, and its draft never replicates (D09).
      open: false,
      foreign: false,
      epicId,
      ownerHostId,
      epicTitle: patch.epicTitle ?? EPIC_TITLE_FALLBACK,
    });
  }
  return rows;
}

function commonFields(
  id: string,
  content: JsonContent,
  lastTouchedAt: number,
  titleFallback: string,
): Omit<DraftInventoryRowFields, "open" | "foreign"> {
  return {
    id,
    title: draftTitle(content, titleFallback),
    preview: draftPreviewText(content),
    content,
    lastTouchedAt,
  };
}

/**
 * Line 1: the first non-empty line of typed text. An image-only draft has no
 * derived text, and the fallback is PER KIND - the same shape
 * `landingDraftDisplayTitle` gives the tab strip, but a chat row names its
 * chat and a new-agent row says so, rather than reading `Start Page` in an
 * epic it has nothing to do with.
 */
function draftTitle(content: JsonContent, fallback: string): string {
  const text = extractPlainTextFromComposerJSONContent(content).trim();
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 0 ? firstLine : fallback;
}

/** Line 2: the whole document flattened onto one line (D13). */
function draftPreviewText(content: JsonContent): string {
  return extractPlainTextFromComposerJSONContent(content)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_LIMIT);
}

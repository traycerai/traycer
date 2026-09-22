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

/**
 * A row's text is clamped to a few wrapped lines; past this many characters
 * nothing is ever drawn, so a pasted essay does not put its whole body in the
 * DOM.
 */
const PREVIEW_LIMIT = 400;

/** A row published by a host before any local composer named its chat/epic. */
const CHAT_TITLE_FALLBACK = "Chat";
const EPIC_TITLE_FALLBACK = "Task";
/** Title fallback for a textless (image-only) new-agent draft. */
const NEW_CHAT_TITLE_FALLBACK = "New agent";

interface DraftInventoryRowFields {
  /** Landing draft id, or the host row's `draftId` for the other kinds. */
  readonly id: string;
  /**
   * The draft's typed text flattened onto one run, or the per-kind fallback
   * for a textless (image-only) draft.
   */
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
export interface DraftInventoryScope {
  readonly surface: "landing";
  readonly activeDraftId: string | null;
}

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
  const rows = [...landingRows(input)];
  if (input.filter === "all") {
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
  const activeId = input.scope.activeDraftId;
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
  const rows: DraftInventoryRow[] = [];
  for (const [chatId, draft] of Object.entries(input.composer)) {
    if (draft === undefined) continue;
    const { draftId, targetEpicId, ownerHostId } = draft;
    if (draftId === null || targetEpicId === null || ownerHostId === null) {
      continue;
    }
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
  const rows: DraftInventoryRow[] = [];
  for (const [epicId, patch] of Object.entries(input.newChat)) {
    if (patch === undefined) continue;
    const { draftId, content } = patch;
    if (draftId === null || content === null) continue;
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
  fallback: string,
): Omit<DraftInventoryRowFields, "open" | "foreign"> {
  return {
    id,
    preview: draftPreviewText(content, fallback),
    content,
    lastTouchedAt,
  };
}

/**
 * The whole document flattened onto one run of text. An image-only draft has
 * no derived text, and the fallback is PER KIND - the same shape
 * `landingDraftDisplayTitle` gives the tab strip, but a chat row names its
 * chat and a new-agent row says so, rather than reading `Start Page` in an
 * epic it has nothing to do with.
 */
function draftPreviewText(content: JsonContent, fallback: string): string {
  const text = extractPlainTextFromComposerJSONContent(content)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_LIMIT);
  return text.length > 0 ? text : fallback;
}

/**
 * Which surface a row belongs to, in the words D12 gives it.
 *
 * A chat or new-agent row ALWAYS names itself, under either filter: the row's
 * own first line is the draft's text, and text does not say which chat it was
 * being typed into. The epic prefix is the part that is conditional, because
 * inside one epic naming it on every row is noise.
 *
 * A start-page row is the exception and carries nothing under `current` - the
 * start page has no sub-surfaces to tell apart, so the chip would repeat what
 * the filter already said.
 */
export function draftRowSourceChip(
  row: DraftInventoryRow,
  scopeEpicId: string | null,
  filter: DraftInventoryFilter,
): string | null {
  if (row.kind === "landing") {
    return filter === "all" ? "Start page" : null;
  }
  const name = row.kind === "chat" ? row.chatTitle : "New agent";
  return row.epicId === scopeEpicId ? name : `${row.epicTitle} · ${name}`;
}

/**
 * The highlight, falling back to the first row. A highlight that no longer
 * names a listed row (its draft was deleted) is dropped
 * rather than left pointing at nothing.
 */
export function resolveSelectedId(
  rows: ReadonlyArray<DraftInventoryRow>,
  highlightedId: string | null,
): string | null {
  if (highlightedId !== null && rows.some((row) => row.id === highlightedId)) {
    return highlightedId;
  }
  return rows.at(0)?.id ?? null;
}

/** The row a deletion should leave highlighted: the next one, else the previous. */
export function neighbourRowId(
  rows: ReadonlyArray<DraftInventoryRow>,
  deletedId: string,
): string | null {
  const index = rows.findIndex((row) => row.id === deletedId);
  if (index === -1) return null;
  return rows.at(index + 1)?.id ?? rows.at(index - 1)?.id ?? null;
}

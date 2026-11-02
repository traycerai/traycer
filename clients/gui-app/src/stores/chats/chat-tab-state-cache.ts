import type { ChatTabPersistenceIdentity } from "@/stores/chats/chat-tab-persistence-key";
import {
  deleteReadingPositionView,
  deleteReadingPositionsForContent,
  deleteReadingPositionsForEpic,
  readExactReadingPosition,
  readReadingPosition,
  saveReadingPosition,
  saveReadingPositionContentFallback,
} from "@/lib/reading-position/service";
import { readingPositionIdentityForChat } from "@/lib/reading-position/chat-identity";
import { isUnplacedRowKey } from "@/stores/chats/transcript-list-rows";

export type ChatTabScrollMode = "following-end" | "free-scrolling";

export interface SavedChatTabScrollState {
  readonly mode: ChatTabScrollMode;
  readonly anchorMessageId: string | null;
  /** Owning unsplit row key. Absent in saved states from older clients. */
  readonly anchorRowKey?: string | null;
  readonly anchorIndex: number | null;
  readonly offset: number;
}

const DEFAULT_CHAT_TAB_SCROLL_STATE: SavedChatTabScrollState = {
  mode: "following-end",
  anchorMessageId: null,
  anchorIndex: null,
  offset: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSavedChatTabScrollState(
  value: unknown,
): value is SavedChatTabScrollState {
  if (!isRecord(value)) return false;
  return (
    (value.mode === "following-end" || value.mode === "free-scrolling") &&
    (typeof value.anchorMessageId === "string" ||
      value.anchorMessageId === null) &&
    (value.anchorRowKey === undefined ||
      value.anchorRowKey === null ||
      typeof value.anchorRowKey === "string") &&
    (typeof value.anchorIndex === "number" || value.anchorIndex === null) &&
    (value.anchorIndex === null || Number.isFinite(value.anchorIndex)) &&
    typeof value.offset === "number" &&
    Number.isFinite(value.offset)
  );
}

/** Raw, unclamped state: exact view first, then durable content fallback. */
export function peekSavedChatTabState(
  identity: ChatTabPersistenceIdentity,
): SavedChatTabScrollState | null {
  return readReadingPosition(
    readingPositionIdentityForChat(identity),
    "chat",
    isSavedChatTabScrollState,
  );
}

/**
 * Resolve an owning row without parsing segment ids, which may contain `#`.
 * Older saved states omit the explicit owner; a matching row-key prefix also
 * recovers part anchors written before the owner field was introduced.
 */
export function savedChatTabAnchorRowKey(
  saved: SavedChatTabScrollState,
  rowKeys: readonly string[],
): string | null {
  if (saved.anchorRowKey !== undefined && saved.anchorRowKey !== null) {
    return saved.anchorRowKey;
  }
  const anchor = saved.anchorMessageId;
  if (anchor === null || rowKeys.includes(anchor)) return anchor;
  let owner = anchor;
  for (const key of rowKeys) {
    if (
      anchor.startsWith(`${key}#`) &&
      (owner === anchor || key.length > owner.length)
    ) {
      owner = key;
    }
  }
  return owner;
}

/**
 * @param rowKeys The LIST's row keys in render order - `TranscriptListRow.key`
 * values (which on the windowed line include unhydrated placeholder rows, so a
 * saved anchor deep in cold history resolves without waiting for its body),
 * or message ids on the legacy line where the two are the same sequence.
 */
export function restoreChatTabState(
  identity: ChatTabPersistenceIdentity,
  rowKeys: ReadonlyArray<string>,
): SavedChatTabScrollState {
  const saved = peekSavedChatTabState(identity);
  if (saved === null) return DEFAULT_CHAT_TAB_SCROLL_STATE;
  if (saved.anchorMessageId === null) return saved;
  if (rowKeys.includes(saved.anchorMessageId)) {
    return saved;
  }
  const owner = savedChatTabAnchorRowKey(saved, rowKeys);
  if (
    owner !== null &&
    owner !== saved.anchorMessageId &&
    rowKeys.includes(owner)
  ) {
    return {
      ...saved,
      anchorMessageId: owner,
      anchorRowKey: owner,
      anchorIndex: rowKeys.indexOf(owner),
      offset: 0,
    };
  }
  if (owner !== null && turnWasSplit(owner, rowKeys)) {
    return restoreAcrossSteerSplit(
      saved.anchorMessageId,
      saved,
      owner,
      rowKeys,
    );
  }
  // A new saved index describes an expanded list. It cannot locate a missing
  // row in a cold or differently expanded list; retain only semantic identity.
  if (
    saved.anchorRowKey !== undefined ||
    owner !== saved.anchorMessageId ||
    rowKeys.length === 0 ||
    saved.anchorIndex === null
  ) {
    return {
      mode: saved.mode,
      anchorMessageId: null,
      anchorIndex: null,
      offset: 0,
    };
  }
  const clampedIndex = Math.min(
    Math.max(Math.trunc(saved.anchorIndex), 0),
    rowKeys.length - 1,
  );
  return {
    mode: saved.mode,
    anchorMessageId: rowKeys[clampedIndex],
    anchorIndex: clampedIndex,
    offset: 0,
  };
}

/**
 * The slice rows of a turn whose unsplit row id was `owner`: a same-turn steer
 * splits an assistant turn and renames every row it draws, `assistant:<key>`
 * becoming `assistant:<key>:part:<n>` (`assistantSliceRowId` in the protocol's
 * row projection, sticky for the whole turn).
 */
function sliceRowKeyPrefix(owner: string): string {
  return `${owner}:part:`;
}

function turnWasSplit(owner: string, rowKeys: ReadonlyArray<string>): boolean {
  const prefix = sliceRowKeyPrefix(owner);
  return rowKeys.some((key) => key.startsWith(prefix));
}

/**
 * Whether a steer split the turn `saved` is anchored in since the position was
 * saved. The row id the anchor names is then gone for good: no hydration brings
 * it back, and only the renamed slices can answer for the position.
 */
export function savedAnchorTurnWasSplit(
  saved: SavedChatTabScrollState,
  rowKeys: ReadonlyArray<string>,
): boolean {
  const anchor = saved.anchorMessageId;
  if (anchor === null || rowKeys.includes(anchor)) return false;
  const owner = savedChatTabAnchorRowKey(saved, rowKeys);
  if (owner === null || rowKeys.includes(owner)) return false;
  return turnWasSplit(owner, rowKeys);
}

/**
 * A reading position saved inside a turn before a steer split it names a row
 * no list will draw again. The coordinate survives where its pieces do: the
 * turn's own key is now its first slice, which starts where the turn started;
 * a part key hangs off the id of the text segment it cuts at
 * (`assistantTurnPartKey`), which the split keeps, so the slice part cutting
 * at that segment is the same pixel position.
 *
 * Part keys exist only on drawn rows, so a part no key names is either behind
 * a slice still cold or gone - the text streaming at the save moved behind
 * the steer and now starts a slice instead of cutting one. Keys alone cannot
 * tell the two apart: the answer is the pending shape, and
 * `restoreSplitTurnAnchorForMount` decides from the rows.
 */
function restoreAcrossSteerSplit(
  anchor: string,
  saved: SavedChatTabScrollState,
  owner: string,
  rowKeys: ReadonlyArray<string>,
): SavedChatTabScrollState {
  const prefix = sliceRowKeyPrefix(owner);
  let resolved: string | null = null;
  if (anchor === owner) {
    resolved = `${prefix}0`;
  } else if (anchor.startsWith(`${owner}#`)) {
    resolved = slicePartCuttingAt(
      prefix,
      anchor.slice(owner.length + 1),
      rowKeys,
    );
  }
  const index = resolved === null ? -1 : rowKeys.indexOf(resolved);
  if (resolved === null || index === -1) {
    return {
      mode: saved.mode,
      anchorMessageId: null,
      anchorIndex: null,
      offset: 0,
    };
  }
  const cut = resolved.indexOf("#", prefix.length);
  return {
    mode: saved.mode,
    anchorMessageId: resolved,
    ...(cut === -1 ? {} : { anchorRowKey: resolved.slice(0, cut) }),
    anchorIndex: index,
    offset: saved.offset,
  };
}

/** What `restoreSplitTurnAnchorForMount` reads off a list row; a
 *  `TranscriptListRow` satisfies it. */
export interface ChatTabRestoreRow {
  readonly key: string;
  readonly kind: "hydrated" | "placeholder";
  readonly ordinal: number | null;
}

export interface SplitTurnMountRestore {
  readonly state: SavedChatTabScrollState;
  /**
   * The split is answered for good - the saved part was found, or every slice
   * is drawn and the segment is gone - so nothing is left for the hydration
   * catch-up. `false` while a slice is still cold and may bring the part.
   */
  readonly settled: boolean;
  /** The turn's slice rows not drawn yet, in list order: what the catch-up
   *  asks the host for while it waits. */
  readonly coldSlices: readonly ChatTabRestoreRow[];
}

/**
 * Refines `restored`, `restoreChatTabState`'s answer for `saved`, where a steer
 * split the anchored turn (`savedAnchorTurnWasSplit`) and no row names the
 * saved part. A slice still cold - a placeholder, or an unplaced row the
 * skeleton has not described yet - can still bring it: the reader is placed
 * on the first slice meanwhile, where the turn started, and the saved
 * coordinate stays pending. Once every slice is drawn and no part names the
 * segment, it is gone, and the reader follows the latest rather than being
 * placed by a guess.
 */
export function restoreSplitTurnAnchorForMount(
  saved: SavedChatTabScrollState,
  restored: SavedChatTabScrollState,
  rows: ReadonlyArray<ChatTabRestoreRow>,
): SplitTurnMountRestore {
  if (restored.anchorMessageId !== null) {
    return { state: restored, settled: true, coldSlices: [] };
  }
  const owner = savedChatTabAnchorRowKey(
    saved,
    rows.map((row) => row.key),
  );
  const prefix = owner === null ? null : sliceRowKeyPrefix(owner);
  const isSlice = (row: ChatTabRestoreRow): boolean =>
    prefix !== null && row.key.startsWith(prefix);
  const coldSlices = rows.filter(
    (row) => isSlice(row) && row.kind === "placeholder",
  );
  const firstSliceIndex = rows.findIndex(isSlice);
  if (
    firstSliceIndex === -1 ||
    (coldSlices.length === 0 && !rows.some((row) => isUnplacedRowKey(row.key)))
  ) {
    return {
      state: DEFAULT_CHAT_TAB_SCROLL_STATE,
      settled: true,
      coldSlices: [],
    };
  }
  return {
    state: {
      mode: saved.mode,
      anchorMessageId: rows[firstSliceIndex].key,
      anchorIndex: firstSliceIndex,
      offset: 0,
    },
    settled: false,
    coldSlices,
  };
}

/** `<prefix><n>#<segmentId>` among `rowKeys`, for any slice number `n`. */
function slicePartCuttingAt(
  prefix: string,
  segmentId: string,
  rowKeys: ReadonlyArray<string>,
): string | null {
  const suffix = `#${segmentId}`;
  for (const key of rowKeys) {
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const slice = key.slice(prefix.length, key.length - suffix.length);
    if (/^\d+$/.test(slice)) return key;
  }
  return null;
}

/**
 * `restoreChatTabState` for a tile that is mounting, where the result seeds
 * the list's `initialScrollAtEnd` / `initialScrollIndex`.
 *
 * A free scroll that was SAVED without an anchor names no row to restore to:
 * the list would mount at scroll 0, the top of the transcript, with no follow
 * permission to correct it. Following the latest is the fallback.
 *
 * A saved anchor that does not resolve yet is not that shape. It may be a row
 * the transcript has not hydrated (an empty or partial one), which the
 * pending-hydration restore replays once it arrives, so it is left to it.
 *
 * Only mounting wants this. A kept-alive tile that is shown again replays
 * through `restoreChatTabState` itself, where an anchorless free scroll means
 * "leave the viewport where the reader put it", not "jump to the end".
 */
export function restoreChatTabStateForMount(
  identity: ChatTabPersistenceIdentity,
  rowKeys: ReadonlyArray<string>,
): SavedChatTabScrollState {
  const restored = restoreChatTabState(identity, rowKeys);
  if (restored.mode !== "free-scrolling" || restored.anchorMessageId !== null) {
    return restored;
  }
  const saved = peekSavedChatTabState(identity);
  if (saved !== null && saved.anchorMessageId !== null) return restored;
  return DEFAULT_CHAT_TAB_SCROLL_STATE;
}

export interface SaveChatTabStateInput extends SavedChatTabScrollState {
  readonly identity: ChatTabPersistenceIdentity;
}

export function saveChatTabState(input: SaveChatTabStateInput): void {
  const { identity, ...anchor } = input;
  saveReadingPosition(readingPositionIdentityForChat(identity), "chat", anchor);
}

export function commitChatTabStateToDurable(
  input: SaveChatTabStateInput,
): void {
  const { identity, ...anchor } = input;
  saveReadingPositionContentFallback(
    readingPositionIdentityForChat(identity),
    "chat",
    anchor,
  );
}

export function promoteChatTabStateToDurable(
  identity: ChatTabPersistenceIdentity,
): void {
  const globalIdentity = readingPositionIdentityForChat(identity);
  const exact = readExactReadingPosition(
    globalIdentity,
    "chat",
    isSavedChatTabScrollState,
  );
  if (exact === null) return;
  saveReadingPositionContentFallback(globalIdentity, "chat", exact);
}

export function evictChatTabState(keys: ReadonlyArray<string>): void {
  keys.forEach(deleteReadingPositionView);
}

export function evictChatTabStateForChat(
  identity: Pick<ChatTabPersistenceIdentity, "epicId" | "chatId">,
): void {
  deleteReadingPositionsForContent(
    readingPositionIdentityForChat({
      ...identity,
      tileInstanceId: `deleted-chat:${identity.chatId}`,
    }),
  );
}

export function evictChatTabStateForEpic(epicId: string): void {
  deleteReadingPositionsForEpic(epicId);
}

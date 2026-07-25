import { create } from "zustand";
import {
  appLogger,
  describeLogError,
  describeLogErrorSummary,
} from "@/lib/logger";
import { interviewDraftKey, interviewDraftKeyPrefix } from "@/lib/persist";

export interface StoredInterviewDraftAnswer {
  readonly selected: ReadonlyArray<string>;
  readonly otherText: string;
  readonly otherSelected: boolean;
}

export interface StoredInterviewDraft {
  readonly pageIndex: number;
  readonly answers: ReadonlyArray<StoredInterviewDraftAnswer>;
}

type StoredInterviewDrafts = Readonly<
  Partial<Record<string, StoredInterviewDraft>>
>;
type StoredInterviewDraftsByChat = Readonly<
  Partial<Record<string, StoredInterviewDrafts>>
>;

interface InterviewDraftStore {
  readonly draftsByChat: StoredInterviewDraftsByChat;
  readonly saveDraft: (
    chatId: string,
    blockId: string,
    draft: StoredInterviewDraft,
  ) => void;
  readonly clearDraft: (chatId: string, blockId: string) => void;
  // Drop this chat's stored drafts whose block IDs are absent from
  // `keepBlockIds` (an authoritative snapshot's still-pending interviews).
  readonly pruneChatDrafts: (
    chatId: string,
    keepBlockIds: ReadonlySet<string>,
  ) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredAnswer(value: unknown): StoredInterviewDraftAnswer | null {
  if (!isRecord(value) || !Array.isArray(value.selected)) return null;
  if (
    typeof value.otherText !== "string" ||
    typeof value.otherSelected !== "boolean"
  ) {
    return null;
  }
  return {
    selected: value.selected.filter(
      (label): label is string => typeof label === "string",
    ),
    otherText: value.otherText,
    otherSelected: value.otherSelected,
  };
}

function parseStoredDraft(value: unknown): StoredInterviewDraft | null {
  if (
    !isRecord(value) ||
    typeof value.pageIndex !== "number" ||
    !Number.isFinite(value.pageIndex) ||
    !Array.isArray(value.answers)
  ) {
    return null;
  }
  const parsedAnswers = value.answers.map(parseStoredAnswer);
  if (parsedAnswers.some((answer) => answer === null)) return null;
  return {
    pageIndex: Math.max(0, Math.trunc(value.pageIndex)),
    answers: parsedAnswers.filter(
      (answer): answer is StoredInterviewDraftAnswer => answer !== null,
    ),
  };
}

// ── Prototype-safe map access ──────────────────────────────────────────────
// chatId/blockId are arbitrary strings (a malicious or accidental
// `"__proto__"`, `"constructor"`, …). All READS go through own-property checks
// so a special key can never resolve to an inherited value, and all WRITES
// rebuild via object-literal computed keys / `Object.fromEntries`, which create
// OWN properties (never invoke the `__proto__` setter), so no update can
// pollute `Object.prototype`.

function ownValue<T>(
  record: Readonly<Partial<Record<string, T>>>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function selectInterviewDraft(
  draftsByChat: StoredInterviewDraftsByChat,
  chatId: string,
  blockId: string,
): StoredInterviewDraft | null {
  const chatDrafts = ownValue(draftsByChat, chatId);
  if (chatDrafts === undefined) return null;
  return ownValue(chatDrafts, blockId) ?? null;
}

// ── Per-(chat, block) localStorage persistence ─────────────────────────────
// Each draft is its own key so a write from one window never rewrites the whole
// map and erases another window's unrelated draft. The reactive `draftsByChat`
// map below mirrors these keys for in-memory reads and cross-pane subscription.

function parseStoredDraftJson(raw: string): StoredInterviewDraft | null {
  // Boundary: raw storage bytes are untrusted and can be malformed JSON. A
  // JSON.parse SyntaxError can echo a fragment of the offending input, and
  // that input is the user's own persisted interview answer text - use the
  // content-free summary (name + message length only), never the raw error.
  try {
    return parseStoredDraft(JSON.parse(raw));
  } catch (error) {
    appLogger.warn("[interview-draft] persisted draft JSON parse failed", {
      error: describeLogErrorSummary(error),
    });
    return null;
  }
}

function safeDecode(value: string): string | null {
  // Boundary: a hand-tampered key segment can be a malformed percent-encoding.
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function storageKeys(): ReadonlyArray<string> {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function readAllStoredDrafts(): StoredInterviewDraftsByChat {
  if (typeof window === "undefined") return {};
  // Boundary: a disabled or inaccessible store (hardened embed, revoked
  // storage permission, private-mode quirks, ...) can throw on enumeration.
  // This runs at store construction (module init) and on every cross-window
  // storage event, so an uncaught throw here would crash the app before the
  // empty-state fallback below is ever reached.
  try {
    return readAllStoredDraftsUnguarded();
  } catch (error) {
    appLogger.warn(
      "[interview-draft] localStorage access failed during hydration",
      { error: describeLogError(error) },
    );
    return {};
  }
}

// The block IDs actually persisted for `chatId`, read directly from
// localStorage rather than the in-memory mirror: a cross-window write can
// land in storage before its `storage` event reaches this window's map, so a
// prune driven only by the mirror can miss it (see `pruneChatDrafts`).
function persistedBlockIdsForChat(chatId: string): ReadonlyArray<string> {
  if (typeof window === "undefined") return [];
  try {
    const chatPrefix = `${interviewDraftKeyPrefix()}${encodeURIComponent(chatId)}:`;
    const blockIds: string[] = [];
    for (const key of storageKeys()) {
      if (!key.startsWith(chatPrefix)) continue;
      const blockId = safeDecode(key.slice(chatPrefix.length));
      if (blockId !== null) blockIds.push(blockId);
    }
    return blockIds;
  } catch (error) {
    appLogger.warn(
      "[interview-draft] localStorage access failed while pruning",
      { error: describeLogError(error) },
    );
    return [];
  }
}

function readAllStoredDraftsUnguarded(): StoredInterviewDraftsByChat {
  const prefix = interviewDraftKeyPrefix();
  // Build in Maps (arbitrary string keys, no prototype chain), then materialize
  // via Object.fromEntries so even a `"__proto__"` id lands as an OWN property.
  const byChat = new Map<string, Map<string, StoredInterviewDraft>>();
  for (const key of storageKeys()) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    const separatorIndex = suffix.indexOf(":");
    if (separatorIndex <= 0) continue;
    const chatId = safeDecode(suffix.slice(0, separatorIndex));
    const blockId = safeDecode(suffix.slice(separatorIndex + 1));
    if (chatId === null || blockId === null) continue;
    const raw = window.localStorage.getItem(key);
    if (raw === null) continue;
    const draft = parseStoredDraftJson(raw);
    if (draft === null) continue;
    const chatMap =
      byChat.get(chatId) ?? new Map<string, StoredInterviewDraft>();
    chatMap.set(blockId, draft);
    byChat.set(chatId, chatMap);
  }
  return Object.fromEntries(
    [...byChat].map(([chatId, chatMap]) => [
      chatId,
      Object.fromEntries(chatMap),
    ]),
  );
}

function writeStoredDraft(
  chatId: string,
  blockId: string,
  draft: StoredInterviewDraft,
): void {
  if (typeof window === "undefined") return;
  // Boundary: localStorage can throw when full or disabled in a hardened shell.
  try {
    window.localStorage.setItem(
      interviewDraftKey(chatId, blockId),
      JSON.stringify(draft),
    );
  } catch (error) {
    appLogger.warn("[interview-draft] persist write failed", {
      error: describeLogError(error),
    });
  }
}

function removeStoredDraft(chatId: string, blockId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(interviewDraftKey(chatId, blockId));
  } catch (error) {
    appLogger.warn("[interview-draft] persist clear failed", {
      error: describeLogError(error),
    });
  }
}

export const useInterviewDraftStore = create<InterviewDraftStore>()((set) => ({
  draftsByChat: readAllStoredDrafts(),
  saveDraft: (chatId, blockId, draft) => {
    writeStoredDraft(chatId, blockId, draft);
    set((state) => {
      const existingChat = ownValue(state.draftsByChat, chatId);
      return {
        // Computed keys create OWN properties even for `"__proto__"`.
        draftsByChat: {
          ...state.draftsByChat,
          [chatId]: { ...existingChat, [blockId]: draft },
        },
      };
    });
  },
  clearDraft: (chatId, blockId) => {
    removeStoredDraft(chatId, blockId);
    set((state) => {
      const chatDrafts = ownValue(state.draftsByChat, chatId);
      if (chatDrafts === undefined || !Object.hasOwn(chatDrafts, blockId)) {
        return state;
      }
      const nextChatEntries = Object.entries(chatDrafts).filter(
        ([candidateBlockId]) => candidateBlockId !== blockId,
      );
      const otherChatEntries = Object.entries(state.draftsByChat).filter(
        ([candidateChatId]) => candidateChatId !== chatId,
      );
      if (nextChatEntries.length === 0) {
        return { draftsByChat: Object.fromEntries(otherChatEntries) };
      }
      return {
        draftsByChat: Object.fromEntries([
          ...otherChatEntries,
          [chatId, Object.fromEntries(nextChatEntries)],
        ]),
      };
    });
  },
  pruneChatDrafts: (chatId, keepBlockIds) => {
    // Prune every PERSISTED key for this chat, not just the in-memory
    // mirror: a cross-window write can exist in localStorage before its
    // storage event updates `draftsByChat`, and this authoritative snapshot
    // must still be able to remove it - otherwise the delayed event later
    // rehydrates a draft for an interview that already resolved. This runs
    // even when the chat has no in-memory entry yet.
    persistedBlockIdsForChat(chatId)
      .filter((blockId) => !keepBlockIds.has(blockId))
      .forEach((blockId) => removeStoredDraft(chatId, blockId));
    set((state) => {
      const chatDrafts = ownValue(state.draftsByChat, chatId);
      if (chatDrafts === undefined) return state;
      const keptEntries = Object.entries(chatDrafts).filter(([blockId]) =>
        keepBlockIds.has(blockId),
      );
      if (keptEntries.length === Object.keys(chatDrafts).length) return state;
      const otherChatEntries = Object.entries(state.draftsByChat).filter(
        ([candidateChatId]) => candidateChatId !== chatId,
      );
      if (keptEntries.length === 0) {
        return { draftsByChat: Object.fromEntries(otherChatEntries) };
      }
      return {
        draftsByChat: Object.fromEntries([
          ...otherChatEntries,
          [chatId, Object.fromEntries(keptEntries)],
        ]),
      };
    });
  },
}));

// Rebuild the in-memory map from the per-draft keys. Runs at construction (cold
// start) and again whenever another window mutates the shared storage.
export function rehydrateInterviewDraftsFromStorage(): void {
  useInterviewDraftStore.setState({ draftsByChat: readAllStoredDrafts() });
}

// Cross-window synchronized authority: another window's write/clear (or a
// `localStorage.clear()`, which fires with `key === null`) reconciles this
// window's map so a duplicate live card stays in lockstep and can never
// re-persist a draft the other window just resolved. Same-window writes do not
// fire this event, so there is no self-trigger loop.
function handleInterviewDraftStorageEvent(event: StorageEvent): void {
  if (event.key !== null && !event.key.startsWith(interviewDraftKeyPrefix())) {
    return;
  }
  rehydrateInterviewDraftsFromStorage();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", handleInterviewDraftStorageEvent);
}

export function readInterviewDraftSnapshot(
  chatId: string,
  blockId: string,
): StoredInterviewDraft | null {
  return selectInterviewDraft(
    useInterviewDraftStore.getState().draftsByChat,
    chatId,
    blockId,
  );
}

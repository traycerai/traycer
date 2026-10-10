import { create } from "zustand";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { appendBlocks } from "@/components/chat/quote/append-quote-to-draft";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
  type DraftSelection,
} from "@/stores/composer/composer-draft-store";

/**
 * Which chat composers hold a message an MCP App asked to send (D29). The app
 * never sends: its text lands in the composer, the composer shows a "From the
 * <app> app" chip with Discard, and the reader sends it or not.
 *
 * Session-only. The record is live only while the draft is exactly what the
 * insert left: its `revision` still equals the one the insert produced. Any
 * change after that - the reader typing, a send, a clear - retires it, and
 * with it every right to rewrite the draft. So:
 *
 * - Discard is offered only while the draft is untouched, and puts back the
 *   draft as it was before the app's text.
 * - A later message from the same app, while untouched, replaces that app's
 *   text. Any other message is appended to the draft as it now stands, so
 *   nothing the reader wrote, and no other app's text, is ever lost.
 */
interface AppMessageDraft {
  readonly appName: string;
  readonly revision: number;
  /** The draft before the app's text, which Discard puts back. */
  readonly before: {
    readonly content: JsonContent;
    readonly selection: DraftSelection | null;
  };
}

interface AppMessageDraftStore {
  readonly byChat: Partial<Record<string, AppMessageDraft>>;
}

const useAppMessageDraftStore = create<AppMessageDraftStore>()(() => ({
  byChat: {},
}));

function liveRecord(chatId: string): AppMessageDraft | null {
  const record = useAppMessageDraftStore.getState().byChat[chatId] ?? null;
  if (record === null) return null;
  return readComposerDraftSnapshot(chatId).revision === record.revision
    ? record
    : null;
}

function setRecord(chatId: string, record: AppMessageDraft | null): void {
  useAppMessageDraftStore.setState((state) => {
    const byChat = { ...state.byChat };
    if (record === null) delete byChat[chatId];
    else byChat[chatId] = record;
    return { byChat };
  });
}

function paragraphs(text: string): JsonContent[] {
  return text
    .split(/\r\n?|\n/)
    .map((line) =>
      line.length === 0
        ? { type: "paragraph" }
        : { type: "paragraph", content: [{ type: "text", text: line }] },
    );
}

/** Puts an app's message into the chat's composer (see the module note). */
export function insertAppMessageDraft(
  chatId: string,
  appName: string,
  text: string,
): void {
  const live = liveRecord(chatId);
  const current = readComposerDraftSnapshot(chatId);
  const before =
    live !== null && live.appName === appName
      ? live.before
      : { content: current.content, selection: current.selection };
  // `null` selection: the composer takes the new content and focuses its end.
  useComposerDraftStore
    .getState()
    .replaceDraft(chatId, appendBlocks(before.content, paragraphs(text)), null);
  setRecord(chatId, {
    appName,
    revision: readComposerDraftSnapshot(chatId).revision,
    before,
  });
}

/** Puts the draft back as it was before the app's message, if untouched. */
export function discardAppMessageDraft(chatId: string): void {
  const live = liveRecord(chatId);
  setRecord(chatId, null);
  if (live === null) return;
  useComposerDraftStore
    .getState()
    .replaceDraft(chatId, live.before.content, live.before.selection);
}

/** The app whose untouched message the chat's composer holds, if any. */
export function useAppMessageDraftName(chatId: string): string | null {
  const record = useAppMessageDraftStore(
    (state) => state.byChat[chatId] ?? null,
  );
  const revision = useComposerDraftStore(
    (state) => state.drafts[chatId]?.revision ?? 0,
  );
  return record !== null && record.revision === revision
    ? record.appName
    : null;
}

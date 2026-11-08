import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  BOT_BOX_DRAFTS_PERSIST_KEY,
  createBotBoxDraftStorage,
  storedBoxDraftsOf,
  type PersistedBotBoxDrafts,
} from "@/lib/bots/bot-box-draft-storage";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { basePersistOptions } from "@/lib/persist";

/**
 * A member's answer to one question of a bot's question card (Tracy Bots,
 * decisions 121 and 122) as they are making it, and the answer they sent
 * while the question waits for the bot's host to settle it.
 */
export interface BotAnswerDraft {
  readonly chosen: ReadonlyArray<string>;
  readonly typed: string;
  /**
   * The answer sent: held from the send until the question shows settled,
   * whether the host took it at once or queued it for a bot's host that is
   * away; `null` before a send, and again after a send that failed.
   */
  readonly sent: BotSentAnswer | null;
}

export interface BotSentAnswer {
  readonly text: string;
  readonly skipped: boolean;
}

/** What a thread's box holds unsent. */
export interface BotThreadBoxDraft {
  readonly text: string;
  /** The box's document, images and chips included; `null` for text put there from outside it. */
  readonly content: JsonContent | null;
  /**
   * Bumped each time a draft is put in the box from outside it (Discuss on a
   * question card), never by typing, so the box loads each one once.
   */
  readonly seedId: number;
}

/** A message a box sent that never reached the conversation. */
export interface BotUnsentMessage {
  /** The replacement's original session: null is trunk; absent is unknown. */
  readonly sessionThreadId?: string | null;
  /** As the box showed it. */
  readonly text: string;
  /** As it was sent: each mention as its member's token. */
  readonly wire: string;
  /** The failed message it was to replace; `null` for a new message. */
  readonly supersedes: string | null;
  /** The box's document as it was sent: its chips, and its images' bytes. */
  readonly content: JsonContent;
}

/** A lookup misses for a bot or key with nothing kept. */
type ByBot<T> = Readonly<
  Partial<Record<string, Readonly<Partial<Record<string, T>>>>>
>;

interface BotDraftsState {
  /** By bot, then by {@link answerDraftKey}. */
  readonly answers: ByBot<BotAnswerDraft>;
  /**
   * By bot, then by the message the thread hangs off, or by the channel's
   * conversation for the channel's own box.
   */
  readonly threadBoxes: ByBot<BotThreadBoxDraft>;
  /**
   * A box's send that failed while the box held a newer draft, or after the
   * box was gone, offered back beside that draft; keyed as `threadBoxes`.
   */
  readonly unsentBoxes: ByBot<BotUnsentMessage>;
  /** Keeps a card's draft; `null` drops it. */
  readonly setAnswer: (
    botId: string,
    key: string,
    draft: BotAnswerDraft | null,
  ) => void;
  /** Puts `text` in the box of the thread hanging off `anchorMessageId`, replacing what it held. */
  readonly seedThreadBox: (
    botId: string,
    anchorMessageId: string,
    text: string,
  ) => void;
  /** Keeps what the person put in that box; an empty box keeps nothing. */
  readonly typeThreadBox: (
    botId: string,
    anchorMessageId: string,
    text: string,
    content: JsonContent | null,
  ) => void;
  /** Offers `unsent` back in that box; `null` takes the offer away. */
  readonly offerUnsent: (
    botId: string,
    anchorMessageId: string,
    unsent: BotUnsentMessage | null,
  ) => void;
  /** Drops every draft of the bot: it is gone. */
  readonly forgetBot: (botId: string) => void;
  /** Drops the bot's card answers: the Tracy surface closed. Its boxes' drafts stay. */
  readonly closeBot: (botId: string) => void;
}

/** Which question of which bot row a card draft answers. */
export function answerDraftKey(
  questionMessageId: string,
  questionIndex: number,
): string {
  return `${questionMessageId}#${String(questionIndex)}`;
}

function withEntry<T>(
  byBot: ByBot<T>,
  botId: string,
  key: string,
  entry: T | null,
): ByBot<T> {
  const entries = { ...byBot[botId] };
  if (entry === null) delete entries[key];
  else entries[key] = entry;
  const next = { ...byBot };
  if (Object.keys(entries).length === 0) delete next[botId];
  else next[botId] = entries;
  return next;
}

/**
 * What a member has not sent yet: a card's answer, and what a thread's box
 * or the channel's holds, typed or put there by Discuss. Kept above the
 * channel panes, so switching channels or reopening a thread preserves it;
 * a send consumes what it carried. Forgetting a bot drops its drafts; closing
 * the Tracy surface drops its card answers only.
 *
 * The boxes' drafts are kept on this device too (Tracy Bots T158), so a box
 * shows what it held after the app restarts: stored as the person types,
 * read back once at start (`createBotBoxDraftStorage`). A box typed in
 * before that read answers keeps what was typed.
 */
export const useBotDraftsStore = create<BotDraftsState>()(
  persist(
    (set) => ({
      answers: {},
      threadBoxes: {},
      unsentBoxes: {},
      setAnswer: (botId, key, draft) =>
        set((state) => ({
          answers: withEntry(state.answers, botId, key, draft),
        })),
      seedThreadBox: (botId, anchorMessageId, text) =>
        set((state) => ({
          threadBoxes: withEntry(state.threadBoxes, botId, anchorMessageId, {
            text,
            content: null,
            seedId:
              (state.threadBoxes[botId]?.[anchorMessageId]?.seedId ?? 0) + 1,
          }),
        })),
      typeThreadBox: (botId, anchorMessageId, text, content) =>
        set((state) => {
          const current = state.threadBoxes[botId]?.[anchorMessageId];
          if (
            (current?.text ?? "") === text &&
            (current?.content ?? null) === content
          ) {
            return state;
          }
          return {
            threadBoxes: withEntry(
              state.threadBoxes,
              botId,
              anchorMessageId,
              text.length === 0 && content === null
                ? null
                : {
                    text,
                    content,
                    seedId: current?.seedId ?? 0,
                  },
            ),
          };
        }),
      offerUnsent: (botId, anchorMessageId, unsent) =>
        set((state) =>
          unsent === null &&
          state.unsentBoxes[botId]?.[anchorMessageId] === undefined
            ? state
            : {
                unsentBoxes: withEntry(
                  state.unsentBoxes,
                  botId,
                  anchorMessageId,
                  unsent,
                ),
              },
        ),
      forgetBot: (botId) =>
        set((state) => {
          const answers = { ...state.answers };
          const threadBoxes = { ...state.threadBoxes };
          const unsentBoxes = { ...state.unsentBoxes };
          delete answers[botId];
          delete threadBoxes[botId];
          delete unsentBoxes[botId];
          return { answers, threadBoxes, unsentBoxes };
        }),
      closeBot: (botId) =>
        set((state) => {
          if (state.answers[botId] === undefined) return state;
          const answers = { ...state.answers };
          delete answers[botId];
          return { answers };
        }),
    }),
    {
      ...basePersistOptions(BOT_BOX_DRAFTS_PERSIST_KEY),
      storage: createBotBoxDraftStorage(),
      partialize: (state): PersistedBotBoxDrafts => ({
        threadBoxes: state.threadBoxes,
      }),
      // What a box held before the stored drafts were read is newer than
      // what was stored for it.
      merge: (persisted, current) => {
        const stored = storedBoxDraftsOf(
          isRecord(persisted) ? persisted.threadBoxes : null,
        );
        const threadBoxes: Record<
          string,
          Readonly<Partial<Record<string, BotThreadBoxDraft>>>
        > = {};
        for (const botId of new Set([
          ...Object.keys(stored),
          ...Object.keys(current.threadBoxes),
        ])) {
          threadBoxes[botId] = {
            ...stored[botId],
            ...current.threadBoxes[botId],
          };
        }
        return { ...current, threadBoxes };
      },
    },
  ),
);

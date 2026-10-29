import { create } from "zustand";

/**
 * A member's answer to one question of a bot's question card (Tracy Bots,
 * decisions 121 and 122) as they are making it, and the answer they sent
 * while the question waits for the bot's host to settle it.
 */
export interface BotAnswerDraft {
  readonly chosen: string | null;
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
  /**
   * Bumped each time a draft is put in the box from outside it (Discuss on a
   * question card), never by typing, so the box loads each one once.
   */
  readonly seedId: number;
  /**
   * Which draft this is, new on every change to it, typed or put there, and
   * never reused: a send spends the revision it carried and nothing newer,
   * even one with the same text.
   */
  readonly revision: number;
}

/** A lookup misses for a bot or key with nothing kept. */
type ByBot<T> = Readonly<
  Partial<Record<string, Readonly<Partial<Record<string, T>>>>>
>;

interface BotDraftsState {
  /** By bot, then by {@link answerDraftKey}. */
  readonly answers: ByBot<BotAnswerDraft>;
  /** By bot, then by the message the thread hangs off. */
  readonly threadBoxes: ByBot<BotThreadBoxDraft>;
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
  /** Keeps what the person typed in that box; an empty box keeps nothing. */
  readonly typeThreadBox: (
    botId: string,
    anchorMessageId: string,
    text: string,
  ) => void;
  /**
   * The draft at `revision` was sent from that box: dropped while the box
   * still holds it, and kept when a newer draft took its place before the
   * send landed.
   */
  readonly spendThreadBox: (
    botId: string,
    anchorMessageId: string,
    revision: number,
  ) => void;
  /** Drops every draft of the bot: its tab closed. */
  readonly forgetBot: (botId: string) => void;
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

let lastRevision = 0;

function nextRevision(): number {
  lastRevision += 1;
  return lastRevision;
}

/**
 * What a member has not sent yet on a bot's tab and must not lose to the
 * views that draw it: a card's answer, and the draft Discuss put in a
 * thread's box. Held above the tab's views, as the open thread is, so a
 * switch to Under the hood and back, or closing and reopening the thread,
 * keeps them; a send consumes what it carried. Closing the tab drops them
 * (`closeBotTab`). Not persisted.
 */
export const useBotDraftsStore = create<BotDraftsState>()((set) => ({
  answers: {},
  threadBoxes: {},
  setAnswer: (botId, key, draft) =>
    set((state) => ({ answers: withEntry(state.answers, botId, key, draft) })),
  seedThreadBox: (botId, anchorMessageId, text) =>
    set((state) => ({
      threadBoxes: withEntry(state.threadBoxes, botId, anchorMessageId, {
        text,
        seedId: (state.threadBoxes[botId]?.[anchorMessageId]?.seedId ?? 0) + 1,
        revision: nextRevision(),
      }),
    })),
  typeThreadBox: (botId, anchorMessageId, text) =>
    set((state) => {
      const current = state.threadBoxes[botId]?.[anchorMessageId];
      if ((current?.text ?? "") === text) return state;
      return {
        threadBoxes: withEntry(
          state.threadBoxes,
          botId,
          anchorMessageId,
          text.length === 0
            ? null
            : {
                text,
                seedId: current?.seedId ?? 0,
                revision: nextRevision(),
              },
        ),
      };
    }),
  spendThreadBox: (botId, anchorMessageId, revision) =>
    set((state) =>
      state.threadBoxes[botId]?.[anchorMessageId]?.revision === revision
        ? {
            threadBoxes: withEntry(
              state.threadBoxes,
              botId,
              anchorMessageId,
              null,
            ),
          }
        : state,
    ),
  forgetBot: (botId) =>
    set((state) => {
      const answers = { ...state.answers };
      const threadBoxes = { ...state.threadBoxes };
      delete answers[botId];
      delete threadBoxes[botId];
      return { answers, threadBoxes };
    }),
}));

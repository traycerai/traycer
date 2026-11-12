import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  botBoxDraftCleared,
  botBoxDraftsForgotten,
  botBoxDraftsRead,
  botBoxDraftsReading,
  createBotBoxDraftStorage,
  isCurrentBotBoxDraftsRead,
  retireBotBoxDraftWrites,
  storedBoxDraftsOf,
  type PersistedBotBoxDrafts,
} from "@/lib/bots/bot-box-draft-storage";
import { isRecord } from "@/lib/editor/prosemirror-json";
import { basePersistOptions, botBoxDraftsKey } from "@/lib/persist";

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
  /**
   * For a sent answer whose send failed after it may have reached the host:
   * the transcript's baseline when it was sent. A later baseline - the
   * subscription resynced, or a new session subscribed - shows whether it
   * landed: settled, or still open and given back to edit. `null` otherwise.
   */
  readonly unsureSince: BotTranscriptBaseline | null;
  /**
   * For a sent answer the bot's host refused because a question of that send
   * was settled already (`E_BOT_QUESTION_ALREADY_SETTLED`): the send's
   * questions, by their keys joined with newlines. The answer stays held as
   * sent until one of those questions shows settled here, which moves it or
   * spends it; any of them still open then go back to edit. `null` otherwise.
   */
  readonly heldForSettlement: string | null;
}

/**
 * A transcript's baseline (`transcriptBaselineEpoch`) and the session store
 * that seated it. A store the registry replaces, evicted while idle, starts
 * its epochs again, so the epoch alone cannot tell its baseline from the one
 * before.
 */
export interface BotTranscriptBaseline {
  /** The session's `sessionGeneration`. */
  readonly store: number;
  /** `NO_TRANSCRIPT_BASELINE` until the store seats one. */
  readonly epoch: number;
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
  /** Kept as stored, never bumped by typing, so the box loads its draft once. */
  readonly seedId: number;
}

/**
 * One move of a member's answers that someone else's settlement overtook
 * (T186), taken off their question cards: its block of lines, waiting for the
 * box. The store keeps it until a send that carried it went, so it is never
 * in neither: waiting for a box, then beside the kept draft that holds it
 * (`draftMoves`), which a send of that draft carries again. A box cleared by
 * the person drops it.
 */
export interface BotCarriedBlock {
  /** Which move it is: the box adds each id once, and says by it what it holds. */
  readonly id: number;
  readonly block: string;
  /** Carried by a send still out: no box adds it until that send failed. */
  readonly sending: boolean;
}

/**
 * Where a send that carries moves is: `out` until the host answers, then
 * `went`, which lets them go, or `failed`, which gives them back.
 */
export type BotCarrySend = "out" | "went" | "failed";

/** What an account's retirement adds below a box's kept draft. */
export type BotRetiredPart =
  | { readonly kind: "move"; readonly block: string }
  | { readonly kind: "unsent"; readonly content: JsonContent };

/** A box's kept draft, `null` for none, with `parts` added below it. */
export type BotRetireFold = (
  kept: BotThreadBoxDraft | null,
  parts: ReadonlyArray<BotRetiredPart>,
) => BotThreadBoxDraft;

/** What a box holds as the person types, and the moves whose lines it holds (`held`). */
export interface BotBoxTyped {
  readonly text: string;
  /** The box's document, images and chips included; `null` for an empty box. */
  readonly content: JsonContent | null;
  readonly held: ReadonlyArray<number>;
}

/**
 * What a box says under it about a question card's answers, until the box
 * sends or another takes its place: who settled them first, the person's
 * answers now in the box; or that an answer did not reach the bot's host.
 */
export type BotBoxNotice =
  | { readonly kind: "moved"; readonly text: string }
  | { readonly kind: "answer-failed" };

/** What one move takes off its cards: its block of lines and the line under the box. */
export interface BotAnswersMove {
  readonly block: string;
  readonly notice: string;
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
  /** The moves whose lines `content` holds: whatever holds the message holds them. */
  readonly held: ReadonlyArray<number>;
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
  /** Answers moved off question cards, in order, until a box holds them; keyed as `threadBoxes`. */
  readonly boxCarries: ByBot<ReadonlyArray<BotCarriedBlock>>;
  /**
   * The moves each box's kept draft holds, let go when the draft took them:
   * a send of that draft carries them back into `boxCarries` (`sendCarry`),
   * since the box empties as it sends. Keyed as `threadBoxes`.
   */
  readonly draftMoves: ByBot<ReadonlyArray<BotCarriedBlock>>;
  /** What each box says under it about question cards' answers; keyed as `threadBoxes`. */
  readonly boxNotices: ByBot<BotBoxNotice>;
  /**
   * Bumped each time the account signed in retires (`retire`): a change made
   * for an earlier one does nothing ({@link useBotDraftActions}).
   */
  readonly generation: number;
  /** Keeps a card's draft; `null` drops it. */
  readonly setAnswer: (
    botId: string,
    key: string,
    draft: BotAnswerDraft | null,
  ) => void;
  /**
   * Takes the card drafts `keys` that are still kept off their cards, at
   * once, into the box `boxKey`: `compose` makes the move from them, or
   * `null` where none holds anything of the person's, and the drafts are
   * dropped either way. A card drawn twice moves its drafts once: the second
   * finds them gone and changes nothing.
   */
  readonly moveAnswers: (
    botId: string,
    boxKey: string,
    keys: ReadonlyArray<string>,
    compose: (
      drafts: ReadonlyArray<readonly [string, BotAnswerDraft]>,
    ) => BotAnswersMove | null,
  ) => void;
  /** The box's send carries the moves `held`; `stage` says where it is. */
  readonly sendCarry: (
    botId: string,
    boxKey: string,
    held: ReadonlyArray<number>,
    stage: BotCarrySend,
  ) => void;
  /** Says `notice` under the box; `null` says nothing. */
  readonly noticeBox: (
    botId: string,
    boxKey: string,
    notice: BotBoxNotice | null,
  ) => void;
  /**
   * Keeps what the person put in that box, an empty box nothing, and the
   * moves `box.held` it now holds stop waiting, in the one change: from then
   * on the kept draft is their copy, until a send of it carries them again
   * (`draftMoves`). An empty box drops them.
   */
  readonly typeThreadBox: (
    botId: string,
    anchorMessageId: string,
    box: BotBoxTyped,
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
  /**
   * The account signed in is retiring - it signed out, or another signed in
   * (`BotDraftsPersistLifecycleBridge`). Each box's failed send offered back,
   * then the moves still in the store that it does not hold, a send's still
   * out included, go below that box's kept draft (`fold` makes it); what it
   * keeps is written under the account's own key at once, and then the store
   * holds nothing: no card answer, draft, move or line of that account's
   * reaches the next.
   */
  readonly retire: (fold: BotRetireFold) => void;
}

/** The store's changes a component makes, for {@link useBotDraftActions}. */
export type BotDraftActions = Pick<
  BotDraftsState,
  | "setAnswer"
  | "moveAnswers"
  | "sendCarry"
  | "noticeBox"
  | "typeThreadBox"
  | "offerUnsent"
>;

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
 * The boxes' drafts the store changed while the stored ones were being read,
 * by bot and box (`boxKey`), and the bots it forgot then: the merge keeps
 * none of the stored drafts they name, a cleared or forgotten one included,
 * and the merged drafts are written once read, since nothing was written
 * while they were read.
 */
const changedDuringRead = { keys: new Set<string>(), bots: new Set<string>() };
let readingStoredDrafts = false;
/** The newest read's number: a read an account's retirement overtook merges nothing. */
let storedRead = 0;

function boxKey(botId: string, key: string): string {
  return JSON.stringify([botId, key]);
}

function noteBoxChange(botId: string, key: string | null): void {
  if (!readingStoredDrafts) return;
  if (key === null) changedDuringRead.bots.add(botId);
  else changedDuringRead.keys.add(boxKey(botId, key));
}

// No account's drafts until one signs in: the bridge points the store at that
// account's key and reads it.
const PERSIST_OPTIONS = basePersistOptions(botBoxDraftsKey(null));

/** Numbers each move of card answers into a box, so the box adds each once. */
let carryCount = 0;

/** The carries without the moves `held` for that box; `null` where it holds none of them. */
function carriesWithout(
  carries: ByBot<ReadonlyArray<BotCarriedBlock>>,
  botId: string,
  key: string,
  held: ReadonlyArray<number>,
): ByBot<ReadonlyArray<BotCarriedBlock>> | null {
  const blocks = carries[botId]?.[key];
  const left = withoutHeld(blocks, held);
  return left === (blocks ?? null)
    ? null
    : withEntry(carries, botId, key, left);
}

/** `blocks` without the moves `held`, the same array where it holds none of them. */
function withoutHeld(
  blocks: ReadonlyArray<BotCarriedBlock> | undefined,
  held: ReadonlyArray<number>,
): ReadonlyArray<BotCarriedBlock> | null {
  if (blocks === undefined) return null;
  const left = blocks.filter((item) => !held.includes(item.id));
  if (left.length === blocks.length) return blocks;
  return left.length === 0 ? null : left;
}

/** A box, by its bot and its key. */
interface BoxAt {
  readonly botId: string;
  readonly key: string;
}

/**
 * What a box's keep changes of the moves: those `held` leave the carries
 * for its draft's moves, which a cleared draft drops. Empty where neither
 * changes.
 */
function keptMoves(
  state: BotDraftsState,
  at: BoxAt,
  held: ReadonlyArray<number>,
  cleared: boolean,
): Partial<Pick<BotDraftsState, "boxCarries" | "draftMoves">> {
  const blocks = state.boxCarries[at.botId]?.[at.key] ?? [];
  const taken = blocks.filter((item) => held.includes(item.id));
  const kept = state.draftMoves[at.botId]?.[at.key];
  const carried: Partial<Pick<BotDraftsState, "boxCarries">> =
    taken.length === 0
      ? {}
      : {
          boxCarries: withEntry(
            state.boxCarries,
            at.botId,
            at.key,
            withoutHeld(blocks, held),
          ),
        };
  if (cleared) {
    return kept === undefined
      ? carried
      : {
          ...carried,
          draftMoves: withEntry(state.draftMoves, at.botId, at.key, null),
        };
  }
  if (taken.length === 0) return carried;
  return {
    ...carried,
    draftMoves: withEntry(state.draftMoves, at.botId, at.key, [
      ...(kept ?? []),
      ...taken.map((item) => ({ ...item, sending: false })),
    ]),
  };
}

/**
 * The moves `held` for that box carried by a send now out: back from its
 * draft's moves where the draft took them, and marked `sending`. `null`
 * where none changes.
 */
function sentMoves(
  state: BotDraftsState,
  at: BoxAt,
  held: ReadonlyArray<number>,
): Partial<Pick<BotDraftsState, "boxCarries" | "draftMoves">> | null {
  const fromDraft =
    state.draftMoves[at.botId]?.[at.key]?.filter((item) =>
      held.includes(item.id),
    ) ?? [];
  const carries =
    fromDraft.length === 0
      ? state.boxCarries
      : withEntry(state.boxCarries, at.botId, at.key, [
          ...(state.boxCarries[at.botId]?.[at.key] ?? []),
          ...fromDraft,
        ]);
  const boxCarries = carriesMarked(carries, at, held, true) ?? carries;
  if (fromDraft.length === 0) {
    return boxCarries === state.boxCarries ? null : { boxCarries };
  }
  return {
    boxCarries,
    draftMoves: withEntry(
      state.draftMoves,
      at.botId,
      at.key,
      withoutHeld(state.draftMoves[at.botId]?.[at.key], held),
    ),
  };
}

/** The carries with the moves `held` for that box marked `sending`; `null` where none changes. */
function carriesMarked(
  carries: ByBot<ReadonlyArray<BotCarriedBlock>>,
  at: BoxAt,
  held: ReadonlyArray<number>,
  sending: boolean,
): ByBot<ReadonlyArray<BotCarriedBlock>> | null {
  const blocks = carries[at.botId]?.[at.key];
  if (
    blocks?.some(
      (item) => held.includes(item.id) && item.sending !== sending,
    ) !== true
  ) {
    return null;
  }
  return withEntry(
    carries,
    at.botId,
    at.key,
    blocks.map((item) =>
      held.includes(item.id) ? { ...item, sending } : item,
    ),
  );
}

/** The boxes' drafts with what retirement adds below each (`retiredParts`). */
function retiredThreadBoxes(
  state: BotDraftsState,
  fold: BotRetireFold,
): ByBot<BotThreadBoxDraft> {
  let threadBoxes = state.threadBoxes;
  for (const botId of new Set([
    ...Object.keys(state.boxCarries),
    ...Object.keys(state.unsentBoxes),
  ])) {
    const carries = state.boxCarries[botId] ?? {};
    const offers = state.unsentBoxes[botId] ?? {};
    for (const key of new Set([
      ...Object.keys(carries),
      ...Object.keys(offers),
    ])) {
      const parts = retiredParts(offers[key], carries[key]);
      if (parts.length === 0) continue;
      threadBoxes = withEntry(
        threadBoxes,
        botId,
        key,
        fold(threadBoxes[botId]?.[key] ?? null, parts),
      );
    }
  }
  return threadBoxes;
}

/**
 * What retirement adds below a box's kept draft: the failed send it offers
 * back, then the moves still waiting that the send does not hold.
 */
function retiredParts(
  offer: BotUnsentMessage | undefined,
  blocks: ReadonlyArray<BotCarriedBlock> | undefined,
): ReadonlyArray<BotRetiredPart> {
  const parts: Array<BotRetiredPart> =
    offer === undefined ? [] : [{ kind: "unsent", content: offer.content }];
  for (const item of blocks ?? []) {
    if (offer?.held.includes(item.id) !== true) {
      parts.push({ kind: "move", block: item.block });
    }
  }
  return parts;
}

/**
 * What a member has not sent yet: a card's answer, and what a thread's box
 * or the channel's holds, typed or moved there off a card someone else
 * settled first. Kept above the channel panes, so switching channels or
 * reopening a thread preserves it; a send consumes what it carried.
 * Forgetting a bot drops its drafts; closing the Tracy surface drops its
 * card answers only. Moves waiting for their box, failed sends offered back,
 * and what each box says under it, are kept in memory only, until the
 * account retires: its offers and moves go into its boxes' drafts then.
 *
 * The boxes' drafts are kept on this device too (Tracy Bots T158), so a box
 * shows what it held after the app restarts: stored under the signed-in
 * account's key as the person types, read back once that account signs in
 * (`createBotBoxDraftStorage`, `BotDraftsPersistLifecycleBridge`). What a box
 * did while they were read, typing or clearing, wins over what was stored
 * for it.
 */
export const useBotDraftsStore = create<BotDraftsState>()(
  persist(
    (set, get) => ({
      answers: {},
      threadBoxes: {},
      unsentBoxes: {},
      boxCarries: {},
      draftMoves: {},
      boxNotices: {},
      generation: 0,
      setAnswer: (botId, key, draft) =>
        set((state) => ({
          answers: withEntry(state.answers, botId, key, draft),
        })),
      moveAnswers: (botId, boxKey, keys, compose) =>
        set((state) => {
          const kept = state.answers[botId] ?? {};
          const taken: Array<readonly [string, BotAnswerDraft]> = [];
          for (const key of keys) {
            const draft = kept[key];
            if (draft !== undefined) taken.push([key, draft]);
          }
          if (taken.length === 0) return state;
          let answers = state.answers;
          for (const [key] of taken) {
            answers = withEntry(answers, botId, key, null);
          }
          const move = compose(taken);
          if (move === null) return { answers };
          carryCount += 1;
          const earlier = state.boxCarries[botId]?.[boxKey] ?? [];
          return {
            answers,
            boxCarries: withEntry(state.boxCarries, botId, boxKey, [
              ...earlier,
              { id: carryCount, block: move.block, sending: false },
            ]),
            boxNotices: withEntry(state.boxNotices, botId, boxKey, {
              kind: "moved",
              text: move.notice,
            }),
          };
        }),
      sendCarry: (botId, boxKey, held, stage) =>
        set((state) => {
          const at = { botId, key: boxKey };
          if (stage === "out") return sentMoves(state, at, held) ?? state;
          const boxCarries =
            stage === "went"
              ? carriesWithout(state.boxCarries, botId, boxKey, held)
              : carriesMarked(state.boxCarries, at, held, false);
          return boxCarries === null ? state : { boxCarries };
        }),
      noticeBox: (botId, boxKey, notice) =>
        set((state) =>
          notice === null && state.boxNotices[botId]?.[boxKey] === undefined
            ? state
            : {
                boxNotices: withEntry(state.boxNotices, botId, boxKey, notice),
              },
        ),
      typeThreadBox: (botId, anchorMessageId, box) => {
        const { text, content, held } = box;
        const state = get();
        const cleared = text.length === 0 && content === null;
        const carried = keptMoves(
          state,
          { botId, key: anchorMessageId },
          held,
          cleared,
        );
        const current = state.threadBoxes[botId]?.[anchorMessageId];
        if (
          (current?.text ?? "") === text &&
          (current?.content ?? null) === content
        ) {
          if (Object.keys(carried).length > 0) set(carried);
          return;
        }
        noteBoxChange(botId, anchorMessageId);
        // Cleared or sent: what it kept that this window could not show goes too.
        if (cleared) botBoxDraftCleared(botId, anchorMessageId);
        set({
          ...carried,
          threadBoxes: withEntry(
            state.threadBoxes,
            botId,
            anchorMessageId,
            cleared ? null : { text, content, seedId: current?.seedId ?? 0 },
          ),
        });
      },
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
      forgetBot: (botId) => {
        noteBoxChange(botId, null);
        botBoxDraftsForgotten(botId);
        set((state) => ({
          answers: withoutBot(state.answers, botId),
          threadBoxes: withoutBot(state.threadBoxes, botId),
          unsentBoxes: withoutBot(state.unsentBoxes, botId),
          boxCarries: withoutBot(state.boxCarries, botId),
          draftMoves: withoutBot(state.draftMoves, botId),
          boxNotices: withoutBot(state.boxNotices, botId),
        }));
      },
      closeBot: (botId) =>
        set((state) => ({ answers: withoutBot(state.answers, botId) })),
      retire: (fold) => {
        const state = get();
        const threadBoxes = retiredThreadBoxes(state, fold);
        // Written under the retiring account's key, then nothing more is.
        if (threadBoxes !== state.threadBoxes) set({ threadBoxes });
        retireBotBoxDraftWrites(
          readingStoredDrafts
            ? {
                name:
                  useBotDraftsStore.persist.getOptions().name ??
                  PERSIST_OPTIONS.name,
                value: {
                  state: { threadBoxes },
                  version: PERSIST_OPTIONS.version,
                },
              }
            : null,
        );
        readingStoredDrafts = false;
        changedDuringRead.keys.clear();
        changedDuringRead.bots.clear();
        set({
          answers: {},
          threadBoxes: {},
          unsentBoxes: {},
          boxCarries: {},
          draftMoves: {},
          boxNotices: {},
          generation: state.generation + 1,
        });
      },
    }),
    {
      ...PERSIST_OPTIONS,
      skipHydration: true,
      storage: createBotBoxDraftStorage(),
      partialize: (state): PersistedBotBoxDrafts => ({
        threadBoxes: state.threadBoxes,
      }),
      merge: (persisted, current) => {
        if (!isCurrentBotBoxDraftsRead(storedRead)) return current;
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
          const kept: Partial<Record<string, BotThreadBoxDraft>> = {};
          if (!changedDuringRead.bots.has(botId)) {
            for (const [key, draft] of Object.entries(stored[botId] ?? {})) {
              if (!changedDuringRead.keys.has(boxKey(botId, key))) {
                kept[key] = draft;
              }
            }
          }
          const merged = { ...kept, ...current.threadBoxes[botId] };
          if (Object.keys(merged).length > 0) threadBoxes[botId] = merged;
        }
        return { ...current, threadBoxes };
      },
      onRehydrateStorage: () => {
        readingStoredDrafts = true;
        const read = botBoxDraftsReading();
        storedRead = read;
        return (state, error) => {
          // An account that retired meanwhile, or a newer read, took it over.
          if (!isCurrentBotBoxDraftsRead(read)) return;
          readingStoredDrafts = false;
          const changed =
            changedDuringRead.keys.size > 0 || changedDuringRead.bots.size > 0;
          changedDuringRead.keys.clear();
          changedDuringRead.bots.clear();
          if (state === undefined || error !== undefined) return;
          botBoxDraftsRead({
            // The account's own key, which the bridge set before this read.
            name:
              useBotDraftsStore.persist.getOptions().name ??
              PERSIST_OPTIONS.name,
            version: PERSIST_OPTIONS.version,
            threadBoxes: state.threadBoxes,
            changedDuringRead: changed,
          });
        };
      },
    },
  ),
);

/**
 * The store's changes, made for the account signed in now: once it retires
 * (`retire`), each does nothing, so a card, a send or a box's keep that
 * answers late never puts the retired account's answer, draft or move in
 * front of the account signed in after it.
 */
export function useBotDraftActions(): BotDraftActions {
  const generation = useBotDraftsStore((state) => state.generation);
  return useMemo(() => draftActionsOf(generation), [generation]);
}

function draftActionsOf(generation: number): BotDraftActions {
  const live = (): BotDraftsState | null => {
    const state = useBotDraftsStore.getState();
    return state.generation === generation ? state : null;
  };
  return {
    setAnswer: (botId, key, draft) => {
      live()?.setAnswer(botId, key, draft);
    },
    moveAnswers: (botId, boxKey, keys, compose) => {
      live()?.moveAnswers(botId, boxKey, keys, compose);
    },
    sendCarry: (botId, boxKey, held, stage) => {
      live()?.sendCarry(botId, boxKey, held, stage);
    },
    noticeBox: (botId, boxKey, notice) => {
      live()?.noticeBox(botId, boxKey, notice);
    },
    typeThreadBox: (botId, anchorMessageId, box) => {
      live()?.typeThreadBox(botId, anchorMessageId, box);
    },
    offerUnsent: (botId, anchorMessageId, unsent) => {
      live()?.offerUnsent(botId, anchorMessageId, unsent);
    },
  };
}

/** `byBot` without the bot, the same object where it holds nothing of it. */
function withoutBot<T>(byBot: ByBot<T>, botId: string): ByBot<T> {
  if (byBot[botId] === undefined) return byBot;
  const next = { ...byBot };
  delete next[botId];
  return next;
}

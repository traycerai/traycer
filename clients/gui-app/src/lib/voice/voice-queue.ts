import {
  composeBriefing,
  itemLineOf,
  itemTitleOf,
  offerTextOf,
  readTextOf,
  VOICE_SESSION_INPUT_MAX_CHARS,
} from "@/lib/voice/briefing";
import {
  hydratedEntryOf,
  type Announcement,
  type AttentionPrompts,
  type HydrationRow,
  type ReplyRef,
  type StoppedAnswer,
} from "@/lib/voice/queue-sources";
import type { QueueVerb, QueueVerbOutcome } from "@/lib/voice/queue-verbs";
import { confirmationWords, type SpeechScheduler } from "@/lib/voice/scheduler";
import {
  waitingItems,
  type QueueItem,
} from "@/stores/voice/voice-session-store";

/**
 * The voice's queue (Tracy Bots voice, VT4): what is waiting to be said
 * that the person is not looking at. Its items come from the sources in
 * `queue-sources.ts`, each hydrated from the records before anything about
 * it is said, deduplicated by the reply's message id across the
 * notification view and the focused chat store, and kept apart from the
 * unread count: glancing at a channel never empties it, `later` marks
 * nothing, and the one mark it makes is the entity-level read looking
 * makes, after a confirmed hearing of a reply.
 *
 * A reply or a question that arrives while the session runs is offered in
 * one line under no delegation, through the speech scheduler, so it is said
 * at the first clear moment and never appended mid-speech (probe P1). What
 * was already waiting when the session started was in the briefing and is
 * not offered again. Announcements and stopped answers are never offered.
 */

/** A reply reference waiting for its row. */
export interface PendingHydration {
  readonly ref: ReplyRef;
  /** The host whose records are read. */
  readonly hostId: string;
}

export interface VoiceQueueDeps {
  readonly scheduler: Pick<SpeechScheduler, "enqueue" | "withdraw">;
  /** Mirrors the items into the store, for the strip and the re-mint summary. */
  readonly publish: (items: ReadonlyArray<QueueItem>) => void;
  readonly botTitle: (botId: string) => string;
  /** The entity-level read looking makes: one chat of one bot, on its host. */
  readonly markRead: (target: {
    readonly hostId: string;
    readonly botId: string;
    readonly chatId: string;
  }) => void;
  /**
   * Opens a bot's tab on a thread (or its channel, `threadId` `null`) and
   * makes that the focus. `hostId` `null`: the bot's tab host, else the
   * app's.
   */
  readonly switchTo: (target: {
    readonly botId: string;
    readonly hostId: string | null;
    readonly threadId: string | null;
    readonly messageId: string | null;
  }) => void;
  /** Whether a chat is the focus, whose new rows the focused feed speaks itself. */
  readonly isFocused: (botId: string, chatId: string) => boolean;
  /** The attention tier now: unread answers and prompts, for a briefing. */
  readonly attention: () => {
    readonly answers: ReadonlyArray<ReplyRef>;
    readonly prompts: AttentionPrompts;
  };
}

export interface VoiceQueue {
  /**
   * The session starts: everything waiting now is briefed and queued, never
   * offered. Later references are arrivals.
   */
  begin(refs: ReadonlyArray<ReplyRef>, hostOf: (ref: ReplyRef) => string): void;
  /** References from the notification view; known ones change nothing. */
  ingestReplies(
    refs: ReadonlyArray<ReplyRef>,
    hostOf: (ref: ReplyRef) => string,
  ): void;
  /**
   * The references whose rows are being read now, newest first, a bounded
   * number at a time. The same array until the set changes, so a store
   * subscription can read it as a snapshot.
   */
  readonly pendingHydrations: () => ReadonlyArray<PendingHydration>;
  readonly subscribePending: (listener: () => void) => () => void;
  /** The records answered for a reference: its row, or `null` when they have none. */
  hydrated(messageId: string, row: HydrationRow | null): void;
  /** The focused feed scheduled this row: it is said there, not here. */
  noteFocused(messageId: string): void;
  addAnnouncement(input: {
    readonly botId: string;
    readonly hostId: string;
    readonly chatId: string;
    readonly announcement: Announcement;
  }): void;
  /** A bot's stopped answers as its activity says now; ones that recovered leave. */
  syncStopped(input: {
    readonly botId: string;
    readonly hostId: string;
    readonly channelChatId: string;
    readonly stopped: ReadonlyArray<StoppedAnswer>;
  }): void;
  /** Runs `read`, `switch`, `later` or `brief`; `status` is the controller's. */
  run(verb: Exclude<QueueVerb, { readonly kind: "status" }>): QueueVerbOutcome;
  items(): ReadonlyArray<QueueItem>;
  /** The session ended: forgets everything. */
  reset(): void;
}

/** How many references are hydrated at once. */
export const MAX_CONCURRENT_HYDRATIONS = 4;

interface Entry {
  item: QueueItem;
  /** The bot's words; `null` for an item that has none (a stopped answer). */
  readonly content: string | null;
  readonly options: ReadonlyArray<string>;
  /** The scheduler item offering it, while it may still be appended. */
  offerId: string | null;
  /** The scheduler item reading it, while it is in flight. */
  readId: string | null;
}

interface Pending {
  readonly hydration: PendingHydration;
  /** An arrival is offered once hydrated; what the briefing covered is not. */
  readonly offer: boolean;
}

export function createVoiceQueue(deps: VoiceQueueDeps): VoiceQueue {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Pending>();
  /** Message ids settled without an item: said by the focused feed, or not hydratable. */
  const settled = new Set<string>();
  const pendingListeners = new Set<() => void>();
  let pendingSnapshot: ReadonlyArray<PendingHydration> | null = null;
  let speechSeq = 0;

  const publish = (): void => {
    deps.publish(Array.from(entries.values(), (entry) => entry.item));
  };
  const notifyPending = (): void => {
    pendingSnapshot = null;
    for (const listener of pendingListeners) listener();
  };
  const setState = (entry: Entry, state: QueueItem["state"]): void => {
    if (entry.item.state === state) return;
    entry.item = { ...entry.item, state };
    publish();
  };
  const known = (messageId: string): boolean =>
    entries.has(messageId) || pending.has(messageId) || settled.has(messageId);

  const add = (
    refs: ReadonlyArray<ReplyRef>,
    hostOf: (ref: ReplyRef) => string,
    offer: boolean,
  ): void => {
    let changed = false;
    for (const ref of refs) {
      if (known(ref.messageId)) continue;
      pending.set(ref.messageId, {
        hydration: { ref, hostId: hostOf(ref) },
        offer,
      });
      changed = true;
    }
    if (changed) notifyPending();
  };

  const withdrawOffer = (entry: Entry): void => {
    if (entry.offerId === null) return;
    // Queued or already appended: either way it is not said (again).
    deps.scheduler.withdraw(entry.offerId);
    entry.offerId = null;
  };

  /** A read asked and not yet confirmed said is taken back: it is never said, and marks nothing. */
  const withdrawRead = (entry: Entry): void => {
    if (entry.readId === null) return;
    deps.scheduler.withdraw(entry.readId);
    entry.readId = null;
  };

  const offer = (entry: Entry): void => {
    const item = entry.item;
    const botTitle = deps.botTitle(item.botId);
    speechSeq += 1;
    const id = `offer:${item.id}:${speechSeq}`;
    entry.offerId = id;
    deps.scheduler.enqueue({
      id,
      priority: "elsewhere",
      text: offerTextOf(item, botTitle),
      delegationId: null,
      confirmWords: confirmationWords({
        botTitle,
        threadTitle: item.title,
        text: "",
      }),
      onDelivered: () => {
        if (entry.offerId !== id) return;
        entry.offerId = null;
        if (entry.item.state === "queued") setState(entry, "offered");
      },
      // Not confirmed heard within its attempts: it stays queued for the
      // Waiting control and the bell, and is not offered again.
      onGivenUp: () => {
        if (entry.offerId === id) entry.offerId = null;
      },
    });
  };

  /** The item a verb names, or the newest waiting one. */
  const target = (itemId: string | null): Entry | null => {
    if (itemId !== null) return entries.get(itemId) ?? null;
    const first = waitingItems(
      Array.from(entries.values(), (entry) => entry.item),
    ).at(0);
    return first === undefined ? null : (entries.get(first.id) ?? null);
  };

  const read = (
    itemId: string | null,
    delegationId: string | null,
  ): QueueVerbOutcome => {
    const entry = target(itemId);
    if (entry === null) return "nothing";
    if (entry.readId !== null) return "appended";
    withdrawOffer(entry);
    const item = entry.item;
    const botTitle = deps.botTitle(item.botId);
    const text =
      entry.content === null
        ? `${itemLineOf(item, botTitle)}.`
        : readTextOf({
            botTitle,
            content: entry.content,
            options: entry.options,
          });
    speechSeq += 1;
    const id = `read:${item.id}:${speechSeq}`;
    entry.readId = id;
    deps.scheduler.enqueue({
      id,
      // The person asked for it: it goes ahead of offers and briefings.
      priority: "focused",
      text,
      delegationId,
      confirmWords: confirmationWords({
        botTitle,
        threadTitle: null,
        text: entry.content ?? text,
      }),
      onDelivered: () => {
        // A read taken back (`later`) is no longer this item's to settle.
        if (entry.readId !== id) return;
        entry.readId = null;
        setState(entry, "heard");
        // A confirmed hearing of a reply marks its one chat read, as looking
        // does; a stopped answer has nothing of its own to mark.
        if (entry.content !== null) {
          deps.markRead({
            hostId: entry.item.hostId,
            botId: entry.item.botId,
            chatId: entry.item.chatId,
          });
        }
      },
      onGivenUp: () => {
        if (entry.readId === id) entry.readId = null;
      },
    });
    return "appended";
  };

  const brief = (delegationId: string | null): QueueVerbOutcome => {
    const attention = deps.attention();
    const text = composeBriefing({
      answers: attention.answers,
      prompts: attention.prompts,
      items: Array.from(entries.values(), (entry) => entry.item),
      botTitle: deps.botTitle,
      maxChars: VOICE_SESSION_INPUT_MAX_CHARS,
    });
    speechSeq += 1;
    deps.scheduler.enqueue({
      id: `brief:${speechSeq}`,
      priority: "focused",
      text,
      delegationId,
      confirmWords: confirmationWords({
        botTitle: null,
        threadTitle: null,
        text,
      }),
      onDelivered: null,
      onGivenUp: null,
    });
    return "appended";
  };

  return {
    begin(refs, hostOf) {
      add(refs, hostOf, false);
    },
    ingestReplies(refs, hostOf) {
      add(refs, hostOf, true);
    },
    pendingHydrations() {
      pendingSnapshot ??= Array.from(pending.values())
        .map((entry) => entry.hydration)
        .sort((a, b) => b.ref.at - a.ref.at)
        .slice(0, MAX_CONCURRENT_HYDRATIONS);
      return pendingSnapshot;
    },
    subscribePending(listener) {
      pendingListeners.add(listener);
      return () => {
        pendingListeners.delete(listener);
      };
    },
    hydrated(messageId, row) {
      const waiting = pending.get(messageId);
      if (waiting === undefined) return;
      pending.delete(messageId);
      notifyPending();
      const ref = waiting.hydration.ref;
      const entry = row === null ? null : hydratedEntryOf(row);
      // No row, no prose, or a chat the focused feed speaks itself: nothing
      // is queued, and the bell keeps it.
      if (entry === null || deps.isFocused(ref.botId, ref.chatId)) {
        settled.add(messageId);
        return;
      }
      // A surface is keyed by what it points at: a second post about the
      // same approval or question is the same thing waiting.
      const surfaceId = entry.surfaceId;
      if (
        surfaceId !== null &&
        Array.from(entries.values()).some(
          (existing) => existing.item.surfaceId === surfaceId,
        )
      ) {
        settled.add(messageId);
        return;
      }
      const created: Entry = {
        item: {
          id: messageId,
          kind: entry.kind,
          botId: ref.botId,
          hostId: waiting.hydration.hostId,
          threadId: ref.threadId,
          chatId: ref.chatId,
          messageId,
          surfaceId: entry.surfaceId,
          title: itemTitleOf(entry.content),
          line: "",
          at: ref.at,
          state: "queued",
        },
        content: entry.content,
        options: entry.options,
        offerId: null,
        readId: null,
      };
      created.item = {
        ...created.item,
        line: itemLineOf(created.item, deps.botTitle(ref.botId)),
      };
      entries.set(messageId, created);
      publish();
      if (waiting.offer) offer(created);
    },
    noteFocused(messageId) {
      settled.add(messageId);
      if (pending.delete(messageId)) notifyPending();
      const entry = entries.get(messageId);
      if (entry === undefined) return;
      withdrawOffer(entry);
      entries.delete(messageId);
      publish();
    },
    addAnnouncement({ botId, hostId, chatId, announcement }) {
      if (known(announcement.messageId)) return;
      const item: QueueItem = {
        id: announcement.messageId,
        kind: "announcement",
        botId,
        hostId,
        threadId: null,
        chatId,
        messageId: announcement.messageId,
        surfaceId: null,
        title: itemTitleOf(announcement.content),
        line: "",
        at: announcement.at,
        state: "queued",
      };
      entries.set(announcement.messageId, {
        item: { ...item, line: itemLineOf(item, deps.botTitle(botId)) },
        content: announcement.content,
        options: [],
        offerId: null,
        readId: null,
      });
      publish();
    },
    syncStopped({ botId, hostId, channelChatId, stopped }) {
      let changed = false;
      const live = new Set(
        stopped.map((answer) => stoppedId(botId, answer.requestId)),
      );
      for (const [id, entry] of entries) {
        if (entry.item.kind !== "failed" || entry.item.botId !== botId)
          continue;
        if (live.has(id) || entry.item.state !== "queued") continue;
        entries.delete(id);
        changed = true;
      }
      for (const answer of stopped) {
        const id = stoppedId(botId, answer.requestId);
        if (entries.has(id)) continue;
        const item: QueueItem = {
          id,
          kind: "failed",
          botId,
          hostId,
          threadId: answer.threadId,
          chatId: answer.threadId ?? channelChatId,
          messageId: null,
          surfaceId: null,
          title: "",
          line: "",
          at: answer.at,
          state: "queued",
        };
        entries.set(id, {
          item: { ...item, line: itemLineOf(item, deps.botTitle(botId)) },
          content: null,
          options: [],
          offerId: null,
          readId: null,
        });
        changed = true;
      }
      if (changed) publish();
    },
    run(verb) {
      switch (verb.kind) {
        case "read":
          return read(verb.itemId, verb.delegationId);
        case "brief":
          return brief(verb.delegationId);
        case "later": {
          const entry = target(verb.itemId);
          if (entry === null) return "nothing";
          // Set aside means not said at all: its offer and a read asked
          // earlier and still waiting are both taken back.
          withdrawOffer(entry);
          withdrawRead(entry);
          setState(entry, "dismissed");
          return "dismissed";
        }
        case "switch": {
          if (verb.target.kind === "bot") {
            deps.switchTo({
              botId: verb.target.botId,
              hostId: null,
              threadId: null,
              messageId: null,
            });
            return "navigated";
          }
          const entry = target(verb.target.itemId);
          if (entry === null) return "nothing";
          // The person is going to look at it: the one line about it is not
          // needed. Looking leaves the item where it is.
          withdrawOffer(entry);
          deps.switchTo({
            botId: entry.item.botId,
            hostId: entry.item.hostId,
            threadId: entry.item.threadId,
            messageId: entry.item.messageId,
          });
          return "navigated";
        }
      }
    },
    items() {
      return Array.from(entries.values(), (entry) => entry.item);
    },
    reset() {
      for (const entry of entries.values()) {
        withdrawOffer(entry);
        withdrawRead(entry);
      }
      entries.clear();
      pending.clear();
      settled.clear();
      notifyPending();
      publish();
    },
  };
}

function stoppedId(botId: string, requestId: string): string {
  return `stopped:${botId}:${requestId}`;
}

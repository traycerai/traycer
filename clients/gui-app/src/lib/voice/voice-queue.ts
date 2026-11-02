import type { BotSurfaceReference } from "@traycer/protocol/persistence/epic/messages";
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
  type HydratedEntry,
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
 * at the first clear moment and never appended mid-speech (probe). What
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
   * A row of a chat was confirmed said through the queue: the focused feed
   * of that chat, now or later, takes it as said too and never reads it
   * again.
   */
  readonly noteHeard: (chatId: string, messageId: string) => void;
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
  /**
   * An item's one-line offer ("want it?") was heard: a yes said now answers
   * the offer, so a card's candidate waiting for one is offered again.
   */
  readonly onOfferHeard: () => void;
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
  /**
   * The records answered for a reference: its row, or `null` when they have
   * none. `author` is the name of the member who wrote a member's row, as
   * the member directory gives it (`null` when it does not, or for the
   * bot's own rows).
   */
  hydrated(
    messageId: string,
    row: HydrationRow | null,
    author: string | null,
  ): void;
  /**
   * The focused feed scheduled this row: it is said there, not here. Until
   * it says so, an item in the focused chat stays queued; being focused is
   * not being heard. A question or approval it says stays queued all the
   * same, unsaid by the queue, so it can still be opened as a card until it
   * is settled.
   */
  noteFocused(messageId: string): void;
  addAnnouncement(input: {
    readonly botId: string;
    readonly hostId: string;
    readonly chatId: string;
    readonly announcement: Announcement;
  }): void;
  /**
   * A bot's stopped answers as its activity says now; ones that recovered
   * leave. One whose start the stream does not say is dated `seenAt`, the
   * moment the queue first sees it, and keeps that date for its life.
   */
  syncStopped(input: {
    readonly botId: string;
    readonly hostId: string;
    readonly channelChatId: string;
    readonly stopped: ReadonlyArray<StoppedAnswer>;
    readonly seenAt: number;
  }): void;
  /**
   * Whether the item's saying is the queue's, not the focused feed's: a
   * Read of it is queued or being said, or the person already heard it or
   * set it aside. The focused feed then never says it.
   */
  keepsFromFocus(itemId: string): boolean;
  /**
   * What a switch to the item does to the queue, whoever navigates (the
   * Waiting control through `run`, or the router's own move): the person
   * is going to look at it, so its one-line offer is not said. Looking
   * leaves the item where it is.
   */
  noteSwitched(itemId: string): void;
  /**
   * The item is read as a card (VT5): its saying is the card's from now on.
   * Its one-line offer and a Read of it queued here are taken back, so
   * neither is said over or after the card, and the focused feed leaves it.
   */
  claimForCard(itemId: string): void;
  /**
   * A queued question or surfaced prompt was settled by someone else (its
   * row no longer asks anything open): it no longer waits on the person, so
   * it leaves the queue unsaid, its offer and any Read withdrawn, and is not
   * queued again.
   */
  promptSettled(itemId: string): void;
  /** The ids of prompts settled by someone else, for a briefing to leave out. */
  settledPromptIds(): ReadonlySet<string>;
  /**
   * The task surface the item's row points at, of any kind and settled or
   * not, as hydrated; `null` for an item whose row points at none.
   */
  surfaceOf(itemId: string): BotSurfaceReference | null;
  /** Runs `read`, `switch`, `later` or `brief`; `status` and `open` are the controller's. */
  run(
    verb: Exclude<QueueVerb, { readonly kind: "status" | "open" }>,
  ): QueueVerbOutcome;
  items(): ReadonlyArray<QueueItem>;
  /** The session ended: forgets everything. */
  reset(): void;
}

/** How many references are hydrated at once. */
const MAX_CONCURRENT_HYDRATIONS = 4;

interface Entry {
  item: QueueItem;
  /** The bot's words; `null` for an item that has none (a stopped answer). */
  readonly content: string | null;
  readonly options: ReadonlyArray<string>;
  /** The task surface the row points at, as hydrated; `null` for none. */
  readonly surface: BotSurfaceReference | null;
  /** The scheduler item offering it, while it may still be appended. */
  offerId: string | null;
  /** The scheduler item reading it, while it is in flight. */
  readId: string | null;
  /**
   * Said elsewhere: read as a card, or a prompt the focused feed said. The
   * queue never offers or reads it; it stays to be opened as a card.
   */
  claimed: boolean;
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
  /**
   * Rows the focused feed said while their records were still being read:
   * decided once they are, a prompt kept as a card, anything else let go.
   */
  const focusedPending = new Set<string>();
  /** Prompts someone else settled: message and surface ids, for the briefing. */
  const settledPrompts = new Set<string>();
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
      // A notification naming a row is stronger evidence than the
      // announcement fallback, which can classify an answer that landed
      // before its request was resolved: the row is hydrated as what it is,
      // and replaces the announcement once it is.
      // A row already being read, or already settled (said by the focused
      // feed, or found not to be a reply), stays as it is.
      if (pending.has(ref.messageId) || settled.has(ref.messageId)) continue;
      const existing = entries.get(ref.messageId);
      const announced = existing?.item.kind === "announcement";
      if (!announced && existing !== undefined) continue;
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
        deps.onOfferHeard();
      },
      // Not confirmed heard within its attempts: it stays queued for the
      // Waiting control and the bell, and is not offered again.
      onGivenUp: () => {
        if (entry.offerId === id) entry.offerId = null;
      },
    });
  };

  /** The queue's side of a switch to an item, whoever navigates: its offer is not said. */
  const switchedTo = (entry: Entry): void => {
    withdrawOffer(entry);
  };

  /** A row the focused feed said, and that waits on nobody: the queue lets it go. */
  const letFocusedGo = (messageId: string): void => {
    settled.add(messageId);
    const entry = entries.get(messageId);
    if (entry === undefined) return;
    withdrawOffer(entry);
    withdrawRead(entry);
    entries.delete(messageId);
    publish();
  };

  /**
   * What a row read for a reference is queued as; `null` when it is not
   * queued (it is settled here). No row, or no prose: the bell keeps it (an
   * announcement already held for it stays as it was). A surface is keyed
   * by what it points at: a second post about the same approval or question
   * is the same thing waiting. A row the focused feed said while it was
   * read is kept only when it is a prompt.
   */
  const queuedEntryOf = (
    messageId: string,
    row: HydrationRow | null,
    saidByFeed: boolean,
  ): HydratedEntry | null => {
    const entry = row === null ? null : hydratedEntryOf(row);
    if (saidByFeed && (entry === null || !isPromptKind(entry.kind))) {
      letFocusedGo(messageId);
      return null;
    }
    if (entry === null || surfaceTaken(entry.surfaceId)) {
      settled.add(messageId);
      return null;
    }
    return entry;
  };

  /** Whether a queued item already points at this surface. */
  const surfaceTaken = (surfaceId: string | null): boolean =>
    surfaceId !== null &&
    Array.from(entries.values()).some(
      (existing) => existing.item.surfaceId === surfaceId,
    );

  /**
   * An announcement held for a row gives way to what the row is: it is
   * removed, and what carries over is returned, how far the person got with
   * it (heard, set aside) and a Read they asked of it, queued or being said,
   * which stays theirs under its own delegation (the row is then not offered
   * on top of it). `null` when no announcement holds the row.
   */
  const takeOverAnnouncement = (
    messageId: string,
  ): {
    readonly state: QueueItem["state"];
    readonly readId: string | null;
  } | null => {
    const held = entries.get(messageId);
    if (held?.item.kind !== "announcement") return null;
    withdrawOffer(held);
    entries.delete(messageId);
    return { state: held.item.state, readId: held.readId };
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
    const speaker =
      item.kind === "message" ? (item.author ?? "A teammate") : botTitle;
    const text =
      entry.content === null
        ? `${itemLineOf(item, botTitle)}.`
        : readTextOf({
            speaker,
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
        botTitle: speaker,
        threadTitle: null,
        text: entry.content ?? text,
      }),
      // Settled on whichever entry holds the item when it is said: an
      // announcement promoted to the reply it is carries its read along. A
      // read taken back (`later`, a recovery) is no longer any entry's.
      onDelivered: () => {
        const holder = entries.get(item.id);
        if (holder === undefined || holder.readId !== id) return;
        holder.readId = null;
        setState(holder, "heard");
        // A confirmed hearing of a reply marks its one chat read, as looking
        // does; a stopped answer has nothing of its own to mark.
        if (holder.content !== null) {
          deps.markRead({
            hostId: holder.item.hostId,
            botId: holder.item.botId,
            chatId: holder.item.chatId,
          });
        }
        if (holder.item.messageId !== null) {
          deps.noteHeard(holder.item.chatId, holder.item.messageId);
        }
      },
      onGivenUp: () => {
        const holder = entries.get(item.id);
        if (holder !== undefined && holder.readId === id) holder.readId = null;
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
      settledIds: settledPrompts,
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
    hydrated(messageId, row, author) {
      const waiting = pending.get(messageId);
      if (waiting === undefined) return;
      pending.delete(messageId);
      notifyPending();
      const ref = waiting.hydration.ref;
      const saidByFeed = focusedPending.delete(messageId);
      const entry = queuedEntryOf(messageId, row, saidByFeed);
      if (entry === null) return;
      const carried = takeOverAnnouncement(messageId);
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
          author: entry.kind === "message" ? author : null,
          line: "",
          at: ref.at,
          state: carried?.state ?? "queued",
        },
        content: entry.content,
        options: entry.options,
        surface: surfaceOfRow(row),
        offerId: null,
        readId: carried?.readId ?? null,
        claimed: saidByFeed,
      };
      created.item = {
        ...created.item,
        line: itemLineOf(created.item, deps.botTitle(ref.botId)),
      };
      entries.set(messageId, created);
      publish();
      // An arrival in the focused chat is the focused feed's to say: it is
      // queued, unoffered, until the feed claims it (`noteFocused`), and
      // stays in Waiting if the feed never does (a row it took for history).
      if (
        waiting.offer &&
        !created.claimed &&
        created.item.state === "queued" &&
        created.readId === null &&
        !deps.isFocused(ref.botId, ref.chatId)
      ) {
        offer(created);
      }
    },
    noteFocused(messageId) {
      const entry = entries.get(messageId);
      // A question or approval the focused feed says still waits on the
      // person: it stays, openable as a card, and the queue never says it.
      if (entry !== undefined && isPromptKind(entry.item.kind)) {
        withdrawOffer(entry);
        withdrawRead(entry);
        entry.claimed = true;
        return;
      }
      // Its row is still being read: whether it is a prompt is not known yet.
      if (pending.has(messageId)) {
        focusedPending.add(messageId);
        return;
      }
      letFocusedGo(messageId);
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
        author: null,
        line: "",
        at: announcement.at,
        state: "queued",
      };
      entries.set(announcement.messageId, {
        item: { ...item, line: itemLineOf(item, deps.botTitle(botId)) },
        content: announcement.content,
        options: [],
        surface: null,
        offerId: null,
        readId: null,
        claimed: false,
      });
      publish();
    },
    syncStopped({ botId, hostId, channelChatId, stopped, seenAt }) {
      let changed = false;
      const live = new Set(
        stopped.map((answer) => stoppedId(botId, answer.requestId)),
      );
      for (const [id, entry] of entries) {
        if (entry.item.kind !== "failed" || entry.item.botId !== botId)
          continue;
        if (live.has(id) || entry.item.state !== "queued") continue;
        // The bot recovered: a read asked of it and not yet said would now
        // tell of a stop that is over, about an item no longer listed.
        withdrawOffer(entry);
        withdrawRead(entry);
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
          author: null,
          line: "",
          at: answer.at ?? seenAt,
          state: "queued",
        };
        entries.set(id, {
          item: { ...item, line: itemLineOf(item, deps.botTitle(botId)) },
          content: null,
          options: [],
          surface: null,
          offerId: null,
          readId: null,
          claimed: false,
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
          switchedTo(entry);
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
    promptSettled(itemId) {
      const entry = entries.get(itemId);
      if (entry === undefined) return;
      if (entry.item.kind !== "question" && entry.item.kind !== "surface") {
        return;
      }
      withdrawOffer(entry);
      withdrawRead(entry);
      entries.delete(itemId);
      settled.add(itemId);
      settledPrompts.add(itemId);
      if (entry.item.surfaceId !== null)
        settledPrompts.add(entry.item.surfaceId);
      publish();
    },
    settledPromptIds() {
      return settledPrompts;
    },
    surfaceOf(itemId) {
      return entries.get(itemId)?.surface ?? null;
    },
    noteSwitched(itemId) {
      const entry = entries.get(itemId);
      if (entry !== undefined) switchedTo(entry);
    },
    claimForCard(itemId) {
      const entry = entries.get(itemId);
      if (entry === undefined) return;
      withdrawOffer(entry);
      withdrawRead(entry);
      entry.claimed = true;
    },
    keepsFromFocus(itemId) {
      const entry = entries.get(itemId);
      if (entry === undefined) return false;
      return (
        entry.claimed ||
        entry.readId !== null ||
        entry.item.state === "heard" ||
        entry.item.state === "dismissed"
      );
    },
    reset() {
      for (const entry of entries.values()) {
        withdrawOffer(entry);
        withdrawRead(entry);
      }
      entries.clear();
      pending.clear();
      focusedPending.clear();
      settled.clear();
      settledPrompts.clear();
      notifyPending();
      publish();
    },
  };
}

/** The task surface a hydrated bot row points at; `null` for none, or a member's row. */
function surfaceOfRow(row: HydrationRow | null): BotSurfaceReference | null {
  if (row === null || row.role !== "assistant") return null;
  return row.surface ?? null;
}

/** What waits on the person: a bot's question, or a task's surfaced question or approval. */
function isPromptKind(kind: QueueItem["kind"]): boolean {
  return kind === "question" || kind === "surface";
}

function stoppedId(botId: string, requestId: string): string {
  return `stopped:${botId}:${requestId}`;
}

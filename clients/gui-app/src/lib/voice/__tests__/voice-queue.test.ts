import type { OpenTextBlock } from "@traycer/protocol/persistence/epic/open-harness-records";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { composeBriefing, VOICE_SESSION_INPUT_MAX_CHARS } from "../briefing";
import type {
  AttentionPrompts,
  HydrationRow,
  ReplyRef,
  StoppedAnswer,
} from "../queue-sources";
import {
  CONFIRM_WINDOW_MS,
  INPUT_ACTIVE_WINDOW_MS,
  OUTPUT_HANGOVER_MS,
  createSpeechScheduler,
  type SpeechScheduler,
} from "../scheduler";
import {
  waitingItems,
  type QueueItem,
} from "@/stores/voice/voice-session-store";
import {
  createVoiceQueue,
  type VoiceQueue,
  type VoiceQueueDeps,
} from "../voice-queue";

interface Timer {
  readonly handle: number;
  readonly at: number;
  readonly fn: () => void;
}

/** A manual clock: timers fire only when the test advances time. */
interface Clock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (handle: unknown) => void;
  advance: (ms: number) => void;
}

function createClock(): Clock {
  let nowMs = 1_000;
  let nextHandle = 1;
  let timers: Timer[] = [];
  return {
    now: () => nowMs,
    setTimer: (fn: () => void, ms: number): number => {
      const handle = nextHandle++;
      timers.push({ handle, at: nowMs + ms, fn });
      return handle;
    },
    clearTimer: (handle: unknown): void => {
      timers = timers.filter((timer) => timer.handle !== handle);
    },
    advance(ms: number): void {
      const target = nowMs + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at)
          .at(0);
        if (due === undefined) break;
        timers = timers.filter((timer) => timer !== due);
        nowMs = due.at;
        due.fn();
      }
      nowMs = target;
    },
  };
}

interface Appended {
  readonly text: string;
  readonly delegationId: string | null;
}

const BOT_TITLES: Readonly<Record<string, string>> = {
  "bot-2": "Release bot",
  "bot-3": "CI bot",
};

const REPLY_TEXT = "The Safari fix landed in build forty.";

let clock: Clock;
let appended: Appended[];
let scheduler: SpeechScheduler;
let published: ReadonlyArray<QueueItem>;
let focusedChats: Set<string>;
let attentionNow: {
  readonly answers: ReadonlyArray<ReplyRef>;
  readonly prompts: AttentionPrompts;
};
let markRead: Mock<VoiceQueueDeps["markRead"]>;
let switchTo: Mock<VoiceQueueDeps["switchTo"]>;
let noteHeard: Mock<VoiceQueueDeps["noteHeard"]>;
let queue: VoiceQueue;

beforeEach(() => {
  clock = createClock();
  appended = [];
  published = [];
  focusedChats = new Set<string>();
  attentionNow = { answers: [], prompts: { approvals: [], questions: [] } };
  markRead = vi.fn<VoiceQueueDeps["markRead"]>();
  switchTo = vi.fn<VoiceQueueDeps["switchTo"]>();
  noteHeard = vi.fn<VoiceQueueDeps["noteHeard"]>();
  scheduler = createSpeechScheduler({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    append: (text, delegationId) => appended.push({ text, delegationId }),
  });
  scheduler.setLevelDetection(true);
  scheduler.setReady(true);
  queue = createVoiceQueue({
    scheduler,
    publish: (items) => {
      published = items;
    },
    botTitle: (botId) => BOT_TITLES[botId] ?? "the bot",
    markRead,
    switchTo,
    noteHeard,
    isFocused: (botId, chatId) => focusedChats.has(`${botId}:${chatId}`),
    attention: () => attentionNow,
  });
});

const hostOf = (): string => "host-a";

function replyRef(overrides: Partial<ReplyRef>): ReplyRef {
  return {
    messageId: "r-1",
    botId: "bot-2",
    threadId: "thread-x",
    chatId: "thread-x",
    originHostId: "host-a",
    at: 5_000,
    blocking: false,
    ...overrides,
  };
}

function textBlock(text: string): OpenTextBlock {
  return {
    blockId: `block-${text}`,
    status: "completed",
    timestamp: 1,
    parentBlockId: null,
    type: "text",
    text,
    providerNotice: null,
  };
}

function botRow(
  messageId: string,
  text: string,
): Extract<HydrationRow, { readonly role: "assistant" }> {
  return { role: "assistant", messageId, blocks: [textBlock(text)] };
}

/** A reply that arrives while the session runs, hydrated and so offered. */
function arrive(ref: ReplyRef, row: HydrationRow): void {
  queue.ingestReplies([ref], hostOf);
  queue.hydrated(ref.messageId, row, null);
}

function stateOf(itemId: string): QueueItem["state"] | undefined {
  return queue.items().find((item) => item.id === itemId)?.state;
}

describe("a reply elsewhere that arrives while the session runs", () => {
  it("is one item and one offer under no delegation, said at the first clear moment and never twice", () => {
    const ref = replyRef({});
    queue.begin([], hostOf);
    queue.ingestReplies([ref], hostOf);
    expect(queue.pendingHydrations()).toEqual([{ ref, hostId: "host-a" }]);
    expect(queue.items()).toEqual([]);

    // The person is speaking when the row is read: the offer waits.
    scheduler.noteInputTranscript();
    queue.hydrated("r-1", botRow("r-1", REPLY_TEXT), null);

    expect(queue.pendingHydrations()).toEqual([]);
    expect(queue.items()).toHaveLength(1);
    expect(published).toEqual(queue.items());
    expect(appended).toEqual([]);

    clock.advance(INPUT_ACTIVE_WINDOW_MS);
    expect(appended).toEqual([
      {
        text: 'Release bot answered in a thread: "The Safari fix landed in build forty". Want it?',
        delegationId: null,
      },
    ]);
    expect(stateOf("r-1")).toBe("queued");

    // The voice said it: the item is offered, and nothing offers it again.
    scheduler.noteOutputTranscript("Release bot has an answer for you.");
    expect(stateOf("r-1")).toBe("offered");
    clock.advance(120_000);
    expect(appended).toHaveLength(1);
  });

  it("is never offered while the voice is playing, and is once playback and its hangover end", () => {
    scheduler.noteOutputLevel(true);
    scheduler.noteOutputTranscript("Working on it.");
    arrive(replyRef({}), botRow("r-1", REPLY_TEXT));
    expect(queue.items()).toHaveLength(1);
    expect(appended).toEqual([]);

    scheduler.noteOutputLevel(false);
    expect(appended).toEqual([]);

    clock.advance(OUTPUT_HANGOVER_MS);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.text).toContain("Want it?");
  });
});

describe("a reply seen from two views", () => {
  it("is one item, and what the focused feed says leaves the queue with its offer", () => {
    // The briefing named the message, and the notification view names it again.
    queue.begin([replyRef({ messageId: "r-1" })], hostOf);
    queue.ingestReplies([replyRef({ messageId: "r-1" })], hostOf);
    expect(queue.pendingHydrations()).toHaveLength(1);
    queue.hydrated("r-1", botRow("r-1", REPLY_TEXT), null);
    queue.ingestReplies([replyRef({ messageId: "r-1" })], hostOf);
    expect(queue.pendingHydrations()).toEqual([]);
    expect(queue.items().map((item) => item.id)).toEqual(["r-1"]);

    // The focused feed schedules a row before the records answer for it.
    queue.ingestReplies([replyRef({ messageId: "r-2" })], hostOf);
    queue.noteFocused("r-2");
    expect(queue.pendingHydrations()).toEqual([]);
    queue.hydrated("r-2", botRow("r-2", "Merged the release branch."), null);
    queue.ingestReplies([replyRef({ messageId: "r-2" })], hostOf);
    expect(queue.pendingHydrations()).toEqual([]);
    expect(queue.items().map((item) => item.id)).toEqual(["r-1"]);
    expect(appended).toEqual([]);

    // The focused feed schedules a row whose offer is still queued.
    scheduler.noteInputTranscript();
    arrive(
      replyRef({ messageId: "r-3" }),
      botRow("r-3", "Rolled back the canary."),
    );
    expect(queue.items().map((item) => item.id)).toEqual(["r-1", "r-3"]);
    queue.noteFocused("r-3");
    expect(queue.items().map((item) => item.id)).toEqual(["r-1"]);
    expect(published.map((item) => item.id)).toEqual(["r-1"]);
    clock.advance(INPUT_ACTIVE_WINDOW_MS * 5);
    expect(appended).toEqual([]);
  });

  it("is queued without an offer when its chat is the focus, until the focused feed claims it", () => {
    focusedChats.add("bot-2:thread-x");
    arrive(replyRef({}), botRow("r-1", REPLY_TEXT));

    expect(queue.items().map((item) => [item.id, item.state])).toEqual([
      ["r-1", "queued"],
    ]);
    clock.advance(120_000);
    expect(appended).toEqual([]);

    queue.noteFocused("r-1");
    expect(queue.items()).toEqual([]);
    queue.ingestReplies([replyRef({})], hostOf);
    expect(queue.pendingHydrations()).toEqual([]);
  });
});

describe("read", () => {
  it("appends the reply under the delegation and marks its thread read only once it is confirmed said", () => {
    queue.begin([replyRef({})], hostOf);
    queue.hydrated("r-1", botRow("r-1", REPLY_TEXT), null);

    expect(queue.run({ kind: "read", itemId: "r-1", delegationId: "d1" })).toBe(
      "appended",
    );
    expect(appended).toEqual([
      {
        text: `Release bot said: ${REPLY_TEXT}`,
        delegationId: "d1",
      },
    ]);

    scheduler.noteOutputTranscript("Mm-hmm.");
    expect(markRead).not.toHaveBeenCalled();
    expect(noteHeard).not.toHaveBeenCalled();
    expect(stateOf("r-1")).toBe("queued");

    scheduler.noteOutputTranscript(" The Safari fix landed");
    expect(noteHeard.mock.calls).toEqual([["thread-x", "r-1"]]);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith({
      hostId: "host-a",
      botId: "bot-2",
      chatId: "thread-x",
    });
    expect(stateOf("r-1")).toBe("heard");
  });

  it("reads an open question's choices as an explicit list", () => {
    queue.begin([replyRef({})], hostOf);
    queue.hydrated(
      "r-1",
      {
        ...botRow("r-1", "The release is ready. Ship or hold?"),
        question: {
          requestId: "q-1",
          questions: [
            {
              text: "Ship or hold?",
              options: ["Ship", "Hold"],
              allowFreeText: false,
              settlement: null,
            },
          ],
        },
      },
      null,
    );

    expect(queue.items()[0]?.kind).toBe("question");
    queue.run({ kind: "read", itemId: "r-1", delegationId: null });
    expect(appended[0]?.text).toContain("1. Ship; 2. Hold");
  });
});

describe("two posts about the same approval", () => {
  it("are one surface item and one offer", () => {
    const approvalRow = (
      messageId: string,
      text: string,
    ): Extract<HydrationRow, { readonly role: "assistant" }> => ({
      ...botRow(messageId, text),
      surface: {
        kind: "approval",
        epicId: "epic-1",
        hostId: "host-a",
        chatId: "task-chat",
        approvalId: "ap-1",
        resolution: null,
      },
    });
    queue.ingestReplies(
      [
        replyRef({ messageId: "r-1", at: 5_000 }),
        replyRef({ messageId: "r-2", at: 6_000 }),
      ],
      hostOf,
    );
    queue.hydrated(
      "r-1",
      approvalRow("r-1", "The task needs your approval to deploy."),
      null,
    );
    queue.hydrated(
      "r-2",
      approvalRow("r-2", "Still waiting on the deploy approval."),
      null,
    );

    expect(
      queue.items().map((item) => [item.id, item.kind, item.surfaceId]),
    ).toEqual([["r-1", "surface", "ap-1"]]);
    expect(queue.pendingHydrations()).toEqual([]);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.text).toContain("says a task is waiting on you");
  });
});

describe("later", () => {
  it("sets the item aside: nothing is marked read, its queued offer is never said, and Waiting leaves it out", () => {
    scheduler.noteInputTranscript();
    arrive(replyRef({}), botRow("r-1", REPLY_TEXT));
    expect(waitingItems(queue.items())).toHaveLength(1);

    expect(queue.run({ kind: "later", itemId: "r-1" })).toBe("dismissed");

    expect(stateOf("r-1")).toBe("dismissed");
    expect(waitingItems(queue.items())).toEqual([]);
    clock.advance(INPUT_ACTIVE_WINDOW_MS * 5);
    expect(appended).toEqual([]);
    expect(markRead).not.toHaveBeenCalled();
  });
});

describe("later, once the offer is on its way", () => {
  it("does not say the offer again when it was never confirmed", () => {
    arrive(replyRef({}), botRow("r-1", REPLY_TEXT));
    expect(appended).toHaveLength(1);

    queue.run({ kind: "later", itemId: "r-1" });
    clock.advance(CONFIRM_WINDOW_MS * 4);

    expect(stateOf("r-1")).toBe("dismissed");
    expect(appended).toHaveLength(1);
  });
});

describe("read, asked while the offer is on its way unconfirmed", () => {
  it("is appended at the next clear moment, ahead of the confirm window, and the offer is never said again", () => {
    queue.begin([], hostOf);
    arrive(replyRef({}), botRow("r-1", REPLY_TEXT));
    scheduler.noteOutputLevel(true);
    scheduler.noteOutputTranscript("Working on it.");
    expect(appended).toHaveLength(1);

    queue.run({ kind: "read", itemId: "r-1", delegationId: null });
    expect(appended).toHaveLength(1);
    scheduler.noteOutputLevel(false);
    clock.advance(OUTPUT_HANGOVER_MS);

    expect(OUTPUT_HANGOVER_MS).toBeLessThan(CONFIRM_WINDOW_MS);
    expect(appended).toHaveLength(2);
    expect(appended[1]?.text).toBe(`Release bot said: ${REPLY_TEXT}`);

    scheduler.noteOutputTranscript(" The Safari fix landed");
    clock.advance(CONFIRM_WINDOW_MS * 4);
    expect(
      appended.filter((entry) => entry.text.includes("Want it?")),
    ).toHaveLength(1);
    expect(appended).toHaveLength(2);
  });
});

describe("read, asked before the offer's own words have come", () => {
  it("waits for the offer's words to come and go, and only its own transcript confirms it", () => {
    queue.begin([], hostOf);
    arrive(replyRef({}), botRow("r-1", REPLY_TEXT));
    expect(appended).toHaveLength(1);

    queue.run({ kind: "read", itemId: "r-1", delegationId: null });
    // The offer is already with the engine, whose words are still to come.
    expect(appended).toHaveLength(1);
    scheduler.noteOutputTranscript(
      "Release bot has an answer for you, the Safari fix landed in build forty.",
    );
    expect(markRead).not.toHaveBeenCalled();
    expect(appended).toHaveLength(1);

    clock.advance(OUTPUT_HANGOVER_MS);
    expect(appended).toHaveLength(2);
    expect(appended[1]?.text).toBe(`Release bot said: ${REPLY_TEXT}`);
    expect(markRead).not.toHaveBeenCalled();
    expect(stateOf("r-1")).toBe("queued");

    scheduler.noteOutputTranscript(" The Safari fix landed");
    expect(markRead.mock.calls).toEqual([
      [{ hostId: "host-a", botId: "bot-2", chatId: "thread-x" }],
    ]);
    expect(stateOf("r-1")).toBe("heard");
  });
});

describe("read, asked before the offer's words came, across a dictation pause", () => {
  it("is not confirmed by the offer's late words, and is appended once they are over", () => {
    queue.begin([], hostOf);
    arrive(replyRef({}), botRow("r-1", REPLY_TEXT));
    queue.run({ kind: "read", itemId: "r-1", delegationId: null });

    scheduler.setReady(false);
    scheduler.suspendInFlight();
    scheduler.setReady(true);
    scheduler.noteOutputTranscript(
      "Release bot has an answer for you, the Safari fix landed in build forty.",
    );
    expect(appended).toHaveLength(1);
    expect(markRead).not.toHaveBeenCalled();

    clock.advance(OUTPUT_HANGOVER_MS);
    expect(appended).toHaveLength(2);
    expect(appended[1]?.text).toBe(`Release bot said: ${REPLY_TEXT}`);
    expect(markRead).not.toHaveBeenCalled();

    scheduler.noteOutputTranscript(" The Safari fix landed");
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(stateOf("r-1")).toBe("heard");
  });
});

describe("a bot's stopped answer", () => {
  const stopped = (requestId: string): ReadonlyArray<StoppedAnswer> => [
    { requestId, threadId: "thread-x", state: "failed", at: 5_000 },
  ];
  const sync = (answers: ReadonlyArray<StoppedAnswer>): void =>
    queue.syncStopped({
      botId: "bot-2",
      hostId: "host-a",
      channelChatId: "chan-2",
      stopped: answers,
      seenAt: clock.now(),
    });

  it("is one item that waits without an offer, and leaves once the bot no longer reports it", () => {
    sync(stopped("req-1"));
    sync(stopped("req-1"));

    expect(
      queue
        .items()
        .map((item) => [item.id, item.kind, item.chatId, item.state]),
    ).toEqual([["stopped:bot-2:req-1", "failed", "thread-x", "queued"]]);
    expect(waitingItems(queue.items())).toHaveLength(1);
    clock.advance(120_000);
    expect(appended).toEqual([]);

    sync([]);

    expect(queue.items()).toEqual([]);
    expect(published).toEqual([]);
  });

  it("that the stream does not date is dated when first seen, and keeps that date", () => {
    const undated: ReadonlyArray<StoppedAnswer> = [
      { requestId: "req-1", threadId: "thread-x", state: "failed", at: null },
    ];
    const firstSeen = clock.now();
    sync(undated);
    clock.advance(30_000);
    sync(undated);

    expect(queue.items().map((item) => item.at)).toEqual([firstSeen]);
  });

  it("that recovers takes back a read still waiting to be said", () => {
    sync(stopped("req-1"));
    scheduler.noteInputTranscript();

    queue.run({
      kind: "read",
      itemId: "stopped:bot-2:req-1",
      delegationId: null,
    });
    expect(appended).toEqual([]);

    // The bot recovered: its stream no longer reports the answer.
    sync([]);
    expect(queue.items()).toEqual([]);
    clock.advance(INPUT_ACTIVE_WINDOW_MS * 10);

    expect(appended).toEqual([]);
  });

  it("is read as its line, and has nothing of its own to mark read", () => {
    sync(stopped("req-1"));

    queue.run({
      kind: "read",
      itemId: "stopped:bot-2:req-1",
      delegationId: null,
    });
    expect(appended).toEqual([
      {
        text: "Release bot stopped before answering in a thread.",
        delegationId: null,
      },
    ]);
    scheduler.noteOutputTranscript("Release bot stopped before answering");

    expect(stateOf("stopped:bot-2:req-1")).toBe("heard");
    expect(markRead).not.toHaveBeenCalled();
  });
});

describe("later, asked after a read that is still waiting to be said", () => {
  it("takes the read back: it is never said, marks nothing, and the item stays set aside", () => {
    queue.begin([replyRef({})], hostOf);
    queue.hydrated("r-1", botRow("r-1", REPLY_TEXT), null);
    scheduler.noteOutputLevel(true);

    queue.run({ kind: "read", itemId: "r-1", delegationId: "d1" });
    expect(appended).toEqual([]);
    queue.run({ kind: "later", itemId: "r-1" });
    scheduler.noteOutputLevel(false);
    clock.advance(CONFIRM_WINDOW_MS * 10);
    scheduler.noteOutputTranscript(" The Safari fix landed");

    expect(appended).toEqual([]);
    expect(markRead).not.toHaveBeenCalled();
    expect(stateOf("r-1")).toBe("dismissed");
  });
});

describe("switch", () => {
  it("opens the thread the item lives in, says nothing about it, and leaves the item waiting", () => {
    scheduler.noteInputTranscript();
    arrive(replyRef({ messageId: "r-1" }), botRow("r-1", REPLY_TEXT));

    expect(
      queue.run({ kind: "switch", target: { kind: "item", itemId: "r-1" } }),
    ).toBe("navigated");
    expect(switchTo).toHaveBeenCalledWith({
      botId: "bot-2",
      hostId: "host-a",
      threadId: "thread-x",
      messageId: "r-1",
    });
    clock.advance(INPUT_ACTIVE_WINDOW_MS * 5);
    expect(appended).toEqual([]);
    expect(stateOf("r-1")).toBe("queued");

    queue.run({ kind: "switch", target: { kind: "bot", botId: "bot-3" } });
    expect(switchTo).toHaveBeenLastCalledWith({
      botId: "bot-3",
      hostId: null,
      threadId: null,
      messageId: null,
    });
  });
});

describe("looking at the channel", () => {
  it("does not remove an item: a later notification view without its row leaves it queued", () => {
    queue.begin([replyRef({})], hostOf);
    queue.hydrated("r-1", botRow("r-1", REPLY_TEXT), null);

    // The row was read, so the attention tier no longer lists it.
    queue.ingestReplies([], hostOf);

    expect(queue.items().map((item) => [item.id, item.state])).toEqual([
      ["r-1", "queued"],
    ]);
  });
});

describe("what the session started with", () => {
  it("is queued and briefed, never offered", () => {
    queue.begin(
      [
        replyRef({ messageId: "r-1" }),
        replyRef({ messageId: "r-2", at: 6_000 }),
      ],
      hostOf,
    );
    queue.hydrated("r-1", botRow("r-1", REPLY_TEXT), null);
    queue.hydrated("r-2", botRow("r-2", "Merged the release branch."), null);

    expect(queue.items()).toHaveLength(2);
    clock.advance(120_000);
    expect(appended).toEqual([]);
  });
});

describe("a reference whose row cannot be read", () => {
  it("creates nothing and is not asked for again", () => {
    queue.ingestReplies([replyRef({})], hostOf);
    queue.hydrated("r-1", null, null);

    expect(queue.items()).toEqual([]);
    queue.ingestReplies([replyRef({})], hostOf);
    expect(queue.pendingHydrations()).toEqual([]);
    clock.advance(120_000);
    expect(appended).toEqual([]);
  });
});

describe("an announcement", () => {
  it("never interjects, and is said only in a briefing under the request that asked", () => {
    queue.addAnnouncement({
      botId: "bot-2",
      hostId: "host-a",
      chatId: "chan-2",
      announcement: {
        messageId: "ann-1",
        content: "The nightly build finished.",
        at: 7_000,
      },
    });
    clock.advance(120_000);
    expect(appended).toEqual([]);
    expect(waitingItems(queue.items())).toEqual([]);

    expect(queue.run({ kind: "brief", delegationId: "d2" })).toBe("appended");

    expect(appended).toHaveLength(1);
    expect(appended[0]?.delegationId).toBe("d2");
    expect(appended[0]?.text).toContain(
      'Release bot posted in its channel: "The nightly build finished"',
    );
  });
});

describe("a reply's notification for a row held as an announcement", () => {
  const announce = (): void =>
    queue.addAnnouncement({
      botId: "bot-2",
      hostId: "host-a",
      chatId: "chan-2",
      announcement: { messageId: "a-1", content: REPLY_TEXT, at: 7_000 },
    });
  const channelRef = replyRef({
    messageId: "a-1",
    threadId: null,
    chatId: "chan-2",
    at: 7_000,
  });

  it("replaces the announcement: one reply item, offered once, and the briefing says it as a reply", () => {
    queue.begin([], hostOf);
    announce();

    queue.ingestReplies([channelRef], hostOf);
    expect(queue.pendingHydrations()).toEqual([
      { ref: channelRef, hostId: "host-a" },
    ]);
    queue.hydrated("a-1", botRow("a-1", REPLY_TEXT), null);

    expect(
      queue.items().map((item) => [item.id, item.kind, item.state]),
    ).toEqual([["a-1", "reply", "queued"]]);
    expect(appended).toEqual([
      {
        text: 'Release bot answered in its channel: "The Safari fix landed in build forty". Want it?',
        delegationId: null,
      },
    ]);
    const briefing = composeBriefing({
      answers: [channelRef],
      prompts: { approvals: [], questions: [] },
      items: queue.items(),
      botTitle: (botId) => BOT_TITLES[botId] ?? "the bot",
      maxChars: VOICE_SESSION_INPUT_MAX_CHARS,
    });
    expect(briefing).toContain(
      'Release bot answered in its channel: "The Safari fix landed in build forty".',
    );
    expect(briefing).not.toContain("posted in its channel");
  });

  it("carries a Read still waiting to be said over to the reply, which is then not offered", () => {
    queue.begin([], hostOf);
    announce();
    scheduler.noteInputTranscript();
    queue.run({ kind: "read", itemId: "a-1", delegationId: "d-read" });

    queue.ingestReplies([channelRef], hostOf);
    queue.hydrated("a-1", botRow("a-1", REPLY_TEXT), null);
    clock.advance(INPUT_ACTIVE_WINDOW_MS);

    expect(appended).toEqual([
      { text: `Release bot said: ${REPLY_TEXT}`, delegationId: "d-read" },
    ]);
    scheduler.noteOutputTranscript(" The Safari fix landed");
    expect(markRead.mock.calls).toEqual([
      [{ hostId: "host-a", botId: "bot-2", chatId: "chan-2" }],
    ]);
    expect(queue.items().map((item) => [item.kind, item.state])).toEqual([
      ["reply", "heard"],
    ]);
  });

  it("lets a Read already with the engine be confirmed on the reply, and offers nothing afterwards", () => {
    queue.begin([], hostOf);
    announce();
    queue.run({ kind: "read", itemId: "a-1", delegationId: "d-read" });
    expect(appended).toEqual([
      { text: `Release bot said: ${REPLY_TEXT}`, delegationId: "d-read" },
    ]);

    queue.ingestReplies([channelRef], hostOf);
    queue.hydrated("a-1", botRow("a-1", REPLY_TEXT), null);
    scheduler.noteOutputTranscript(" The Safari fix landed");

    expect(queue.items().map((item) => [item.kind, item.state])).toEqual([
      ["reply", "heard"],
    ]);
    expect(markRead).toHaveBeenCalledTimes(1);
    clock.advance(120_000);
    expect(appended).toHaveLength(1);
  });

  it("keeps a set-aside announcement set aside, and offers nothing", () => {
    queue.begin([], hostOf);
    announce();
    expect(queue.run({ kind: "later", itemId: "a-1" })).toBe("dismissed");

    queue.ingestReplies([channelRef], hostOf);
    queue.hydrated("a-1", botRow("a-1", REPLY_TEXT), null);
    clock.advance(120_000);

    expect(
      queue.items().map((item) => [item.id, item.kind, item.state]),
    ).toEqual([["a-1", "reply", "dismissed"]]);
    expect(appended).toEqual([]);
  });
});

describe("brief", () => {
  it("is composed from the attention tier's unread answers and the prompts waiting on the person", () => {
    attentionNow = {
      answers: [
        replyRef({
          messageId: "r-1",
          botId: "bot-2",
          threadId: "thread-a",
          at: 9_000,
        }),
        replyRef({
          messageId: "r-2",
          botId: "bot-2",
          threadId: "thread-b",
          at: 8_000,
        }),
        replyRef({
          messageId: "r-3",
          botId: "bot-3",
          threadId: "thread-c",
          at: 7_000,
        }),
      ],
      prompts: { approvals: ["ap-1"], questions: ["q-1", "q-2"] },
    };

    queue.run({ kind: "brief", delegationId: "d3" });

    const text = appended[0]?.text ?? "";
    expect(text).toContain("Release bot answered in 2 threads.");
    expect(text).toContain("CI bot answered in a thread.");
    expect(text).toContain("1 approval and 2 questions are waiting on you.");
    expect(appended[0]?.delegationId).toBe("d3");
  });
});

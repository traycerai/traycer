import { act, cleanup, renderHook } from "@testing-library/react";
import type { OpenTextBlock } from "@traycer/protocol/persistence/epic/open-harness-records";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CardApi,
  type CardContent,
  type CardFacts,
} from "@/lib/voice/card-desk";
import { runVoiceQueueVerb } from "@/lib/voice/queue-verbs";
import type { HydrationRow, ReplyRef } from "@/lib/voice/queue-sources";
import {
  OUTPUT_HANGOVER_MS,
  createSpeechScheduler,
  type SpeechItem,
} from "@/lib/voice/scheduler";
import { useVoiceSessionStore } from "@/stores/voice/voice-session-store";
import { useVoiceQueueOwner } from "../use-voice-queue-owner";

const fake = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fake.navigate,
}));
vi.mock("@/hooks/voice/use-voice-attention", () => {
  const attention = {
    answers: [],
    prompts: { approvals: [], questions: [] },
  };
  return { useVoiceAttention: () => attention };
});

const initial = useVoiceSessionStore.getState();

/** A fake clock: the scheduler's timers fire only when time is advanced. */
function createClock() {
  interface Timer {
    readonly fn: () => void;
    readonly due: number;
    live: boolean;
  }
  const timers: Timer[] = [];
  let now = 0;
  return {
    now: (): number => now,
    setTimer: (fn: () => void, ms: number): Timer => {
      const timer: Timer = { fn, due: now + ms, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown): void => {
      for (const timer of timers) if (timer === handle) timer.live = false;
    },
    advance: (ms: number): void => {
      const target = now + ms;
      for (;;) {
        const next = timers
          .filter((timer) => timer.live && timer.due <= target)
          .sort((a, b) => a.due - b.due)
          .at(0);
        if (next === undefined) break;
        next.live = false;
        now = next.due;
        next.fn();
      }
      now = target;
    },
  };
}

const QUESTION_ITEM = "q-1";
const REPLY_ITEM = "r-2";

const QUESTION: CardContent = {
  family: "bot-question",
  botTitle: "Release bot",
  place: "in its channel",
  questions: [
    {
      text: "Which environment?",
      options: ["Staging", "Production"],
      takesText: false,
      questionId: null,
    },
  ],
  questionIndex: 0,
  approval: null,
  postText: "Which environment?",
  actable: true,
};

function ref(messageId: string, at: number): ReplyRef {
  return {
    messageId,
    botId: "bot-2",
    threadId: "thread-x",
    chatId: "thread-x",
    originHostId: "host-a",
    at,
    blocking: false,
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

const QUESTION_ROW: HydrationRow = {
  role: "assistant",
  messageId: QUESTION_ITEM,
  blocks: [textBlock("Which environment?")],
  question: {
    requestId: "req-1",
    questions: [
      {
        text: "Which environment?",
        options: ["Staging", "Production"],
        allowFreeText: false,
        settlement: null,
      },
    ],
  },
};

const REPLY_ROW: HydrationRow = {
  role: "assistant",
  messageId: REPLY_ITEM,
  blocks: [textBlock("The build is green.")],
};

/**
 * The real queue owner, queue and card desk over the real speech scheduler,
 * with a waiting question and a waiting reply in the queue. Only the card's
 * records (the watcher's part) and the host APIs are fed by hand.
 */
function mountOwnerWithWaitingItems(
  arrival: "briefed" | "during-session" | "in-focused-chat",
) {
  const clock = createClock();
  const appended: string[] = [];
  const scheduler = createSpeechScheduler({
    append: (text) => appended.push(text),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  scheduler.setReady(true);
  scheduler.setLevelDetection(true);
  const enqueued = vi.spyOn(scheduler, "enqueue");
  const withdrawn = vi.spyOn(scheduler, "withdraw");
  const { result } = renderHook(() =>
    useVoiceQueueOwner({
      ensureSpeech: () => scheduler,
      botList: undefined,
      appHostId: "host-a",
      botTitle: () => "Release bot",
      noteHeard: () => undefined,
    }),
  );
  act(() => {
    result.current.beginQueue();
  });
  const queue = result.current.queue;
  if (queue === null) throw new Error("the owner built no queue");
  if (arrival === "briefed") {
    act(() => {
      queue.begin(
        [ref(QUESTION_ITEM, 5_000), ref(REPLY_ITEM, 4_000)],
        () => "host-a",
      );
      queue.hydrated(QUESTION_ITEM, QUESTION_ROW, null);
      queue.hydrated(REPLY_ITEM, REPLY_ROW, null);
    });
  } else {
    act(() => {
      queue.begin([], () => "host-a");
    });
    if (arrival === "during-session") {
      // The voice is speaking when the question arrives: its offer waits queued.
      scheduler.noteOutputLevel(true);
    } else {
      // The person is in the chat the question arrives in: it is not offered.
      useVoiceSessionStore.getState().setFocus({
        botId: "bot-2",
        hostId: "host-a",
        threadId: "thread-x",
        anchorMessageId: null,
        anchorThread: null,
      });
    }
    act(() => {
      queue.ingestReplies([ref(QUESTION_ITEM, 5_000)], () => "host-a");
      queue.hydrated(QUESTION_ITEM, QUESTION_ROW, null);
    });
  }
  useVoiceSessionStore.setState({ phase: "live" });

  const api = {
    answerBotQuestion: vi.fn<CardApi["answerBotQuestion"]>(() =>
      Promise.resolve({ kind: "sent", delivery: "written" }),
    ),
    actSurface: vi.fn<CardApi["actSurface"]>(() =>
      Promise.resolve({ kind: "failed" }),
    ),
    postInThread: vi.fn<CardApi["postInThread"]>(() => Promise.resolve(true)),
    canPost: true,
  };
  const latest = (): SpeechItem => {
    const item = enqueued.mock.calls.at(-1)?.[0];
    if (item === undefined) throw new Error("nothing was spoken");
    return item;
  };
  /** The voice says the item whole, its sound ends, and the desk's check of the playback runs. */
  const heard = async (item: SpeechItem): Promise<void> => {
    scheduler.noteOutputLevel(true);
    scheduler.noteOutputTranscript(item.text);
    scheduler.noteOutputLevel(false);
    clock.advance(OUTPUT_HANGOVER_MS * 3);
    await Promise.resolve();
  };
  /** The person's words reach the card as the say loop hands them over. */
  const say = (text: string): "handled" | "route" => {
    useVoiceSessionStore.getState().appendInputSegment(text, 0);
    const words = useVoiceSessionStore.getState().reserveOpenSpan("words");
    const driver = useVoiceSessionStore.getState().cardDriver;
    if (words === null || driver === null) throw new Error("nothing to say to");
    const verdict = driver.answer(words, null);
    useVoiceSessionStore.getState().consumeReservation(words.seqs);
    return verdict;
  };
  /** The question is read, its records arrive, and its list is heard. */
  const readQuestion = async (): Promise<void> => {
    expect(
      runVoiceQueueVerb({
        kind: "read",
        itemId: QUESTION_ITEM,
        delegationId: null,
      }),
    ).toBe("appended");
    const facts: CardFacts = {
      content: QUESTION,
      settledBy: () => null,
      gone: false,
      forwarded: () => null,
    };
    act(() => result.current.cardDesk?.observe(QUESTION_ITEM, facts, api));
    // Whatever waited on the voice's speech is said now, and the list heard.
    scheduler.noteOutputLevel(false);
    clock.advance(OUTPUT_HANGOVER_MS * 3);
    await heard(latest());
  };
  return {
    api,
    appended,
    clock,
    enqueued,
    withdrawn,
    owner: () => result.current,
    latest,
    heard,
    say,
    readQuestion,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useVoiceSessionStore.setState(initial, true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Later on a card that waits for the person's answer", () => {
  it("closes the card, so a yes to a heard candidate sends nothing", async () => {
    const h = mountOwnerWithWaitingItems("briefed");
    await h.readQuestion();
    h.say("Staging");
    await h.heard(h.latest());
    expect(useVoiceSessionStore.getState().activeCard?.candidate).toMatchObject(
      { kind: "option", label: "Staging" },
    );

    let outcome = "";
    act(() => {
      outcome = runVoiceQueueVerb({ kind: "later", itemId: QUESTION_ITEM });
    });

    expect(outcome).toBe("dismissed");
    expect(useVoiceSessionStore.getState().activeCard).toBeNull();
    expect(h.say("yes")).toBe("route");
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
    expect(h.api.actSurface).not.toHaveBeenCalled();
  });

  it("takes back a candidate read-back not yet heard", async () => {
    const h = mountOwnerWithWaitingItems("briefed");
    await h.readQuestion();
    h.say("Staging");
    await h.heard(h.latest());
    h.say("Production");
    const unheard = h.latest();

    act(() => {
      runVoiceQueueVerb({ kind: "later", itemId: QUESTION_ITEM });
    });

    expect(unheard.text).toContain('"Production" as your answer');
    expect(h.withdrawn).toHaveBeenCalledWith(unheard.id);
    expect(useVoiceSessionStore.getState().activeCard).toBeNull();
  });

  it("leaves the active card and its candidate alone when another item is set aside", async () => {
    const h = mountOwnerWithWaitingItems("briefed");
    await h.readQuestion();
    h.say("Staging");
    const candidateSay = h.latest();
    await h.heard(candidateSay);

    let outcome = "";
    act(() => {
      outcome = runVoiceQueueVerb({ kind: "later", itemId: REPLY_ITEM });
    });

    expect(outcome).toBe("dismissed");
    expect(useVoiceSessionStore.getState().activeCard).toMatchObject({
      state: "proposed",
      candidate: { kind: "option", label: "Staging" },
    });
    expect(h.withdrawn).not.toHaveBeenCalledWith(candidateSay.id);
    h.say("yes");
    expect(h.api.answerBotQuestion).toHaveBeenCalledTimes(1);
  });
});

describe("Read on a question whose offer is still queued", () => {
  it("takes the offer back, so it is never said after the card and its candidate stays", async () => {
    const h = mountOwnerWithWaitingItems("during-session");
    const offer = h.enqueued.mock.calls
      .map(([item]) => item)
      .find((item) => item.text.includes("Want it?"));
    if (offer === undefined) throw new Error("the question was never offered");
    expect(h.appended).toEqual([]);
    const desk = h.owner().cardDesk;
    if (desk === null) throw new Error("the owner built no card desk");
    const invalidate = vi.spyOn(desk, "invalidate");

    await h.readQuestion();
    h.say("Staging");
    await h.heard(h.latest());
    act(() => h.clock.advance(60_000));

    expect(h.withdrawn).toHaveBeenCalledWith(offer.id);
    expect(h.appended.filter((text) => text.includes("Want it?"))).toEqual([]);
    expect(h.owner().keepsFromFocus(QUESTION_ITEM)).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
    expect(useVoiceSessionStore.getState().activeCard).toMatchObject({
      state: "proposed",
      candidate: { kind: "option", label: "Staging" },
    });
    h.say("yes");
    expect(h.api.answerBotQuestion).toHaveBeenCalledTimes(1);
  });
});

describe("a question the focused feed said", () => {
  it("is still found by a spoken open and read as the card, until its row settles", () => {
    const h = mountOwnerWithWaitingItems("in-focused-chat");
    expect(
      h
        .owner()
        .queue?.items()
        .map((item) => item.id),
    ).toEqual([QUESTION_ITEM]);
    expect(h.enqueued.mock.calls.map(([item]) => item.text)).toEqual([]);

    act(() => {
      h.owner().noteFocused(QUESTION_ITEM);
    });
    let opened = "";
    act(() => {
      opened = runVoiceQueueVerb({
        kind: "open",
        itemId: QUESTION_ITEM,
        delegationId: null,
      });
    });

    expect(opened).toBe("appended");
    expect(useVoiceSessionStore.getState().activeCard).toMatchObject({
      family: "bot-question",
      ids: { itemId: QUESTION_ITEM },
    });

    act(() => {
      h.owner().queue?.promptSettled(QUESTION_ITEM);
    });
    let again = "";
    act(() => {
      again = runVoiceQueueVerb({
        kind: "open",
        itemId: QUESTION_ITEM,
        delegationId: null,
      });
    });

    expect(again).toBe("nothing");
    expect(h.owner().queue?.items()).toEqual([]);
  });
});

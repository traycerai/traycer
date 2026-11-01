import type { BotSurfaceActionState } from "@traycer/protocol/host/bot/schemas";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  useVoiceSessionStore,
  type ActiveCard,
  type ActiveCardIds,
  type CardChoice,
  type CardFamily,
  type CardKey,
} from "@/stores/voice/voice-session-store";
import {
  CARD_ANSWER_WINDOW_MS,
  CARD_DECLINED_TEXT,
  CARD_FAILED_TEXT,
  CARD_GONE_TEXT,
  CARD_LOAD_TIMEOUT_MS,
  CARD_SETTLER_WAIT_MS,
  CARD_UNREADABLE_TEXT,
  CARD_WHICH_TEXT,
  cardListText,
  createCardDesk,
  matchCardChoice,
  type BotAnswerOutcome,
  type CardApi,
  type CardContent,
  type CardDesk,
  type CardFacts,
  type SurfaceActOutcome,
} from "../card-desk";
import {
  OUTPUT_HANGOVER_MS,
  createSpeechScheduler,
  type SpeechItem,
  type SpeechScheduler,
} from "../scheduler";

const ITEM = "item-1";
const OTHER_ITEM = "item-2";
const IDS: ActiveCardIds = {
  itemId: ITEM,
  botId: "bot-1",
  hostId: "host-a",
  threadId: "thread-1",
  chatId: "chat-1",
  messageId: "msg-1",
};
const OTHER_IDS: ActiveCardIds = {
  ...IDS,
  itemId: OTHER_ITEM,
  messageId: "msg-2",
};

const BOT_QUESTION: CardContent = {
  family: "bot-question",
  botTitle: "Release bot",
  place: 'in the thread about "Deploy"',
  questions: [
    {
      text: "Which environment?",
      options: ["Staging", "Production"],
      takesText: false,
      questionId: null,
    },
  ],
  questionIndex: 1,
  approval: null,
  postText: "Which environment?",
  actable: true,
};

const AGENT_QUESTION: CardContent = {
  family: "agent-question",
  botTitle: "Release bot",
  place: "in its channel",
  questions: [
    {
      text: "Which branch?",
      options: ["main", "release/2.1"],
      takesText: true,
      questionId: "q-branch",
    },
  ],
  questionIndex: 0,
  approval: null,
  postText: "A task is asking which branch.",
  actable: true,
};

const TWO_QUESTIONS: CardContent = {
  ...AGENT_QUESTION,
  questions: [
    ...AGENT_QUESTION.questions,
    {
      text: "Run the migration?",
      options: ["Run it", "Hold off"],
      takesText: false,
      questionId: "q-migrate",
    },
  ],
};

const APPROVAL: CardContent = {
  family: "approval",
  botTitle: "Release bot",
  place: "in its channel",
  questions: [],
  questionIndex: 0,
  approval: { tool: "Bash", summary: "rm -rf build" },
  postText: "A task needs your approval.",
  actable: true,
};

/** What the voice says when someone else settled the card first and the answer is offered as a post. */
function settledElsewhere(who: string, verb: string): string {
  return `${who} already ${verb} it, so yours was not sent. Want me to post your answer in the thread instead? Say yes or no.`;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

let wordsCount = 0;

/** The person's words reach the card as the say loop hands them over. */
function speakTo(
  cardDesk: CardDesk,
  text: string,
  delegationId: string,
): "handled" | "route" {
  useVoiceSessionStore.getState().appendInputSegment(text, 0);
  wordsCount += 1;
  const words = useVoiceSessionStore
    .getState()
    .reserveOpenSpan(`words:${wordsCount}`);
  if (words === null) throw new Error("no open words");
  const verdict = cardDesk.answer(words, delegationId);
  // Words the card takes are spent; words routed elsewhere are spent by the request they start.
  useVoiceSessionStore.getState().consumeReservation(words.seqs);
  return verdict;
}

/** The person's words are heard and left open (a route for them is still out); their segment's seq. */
function utterWords(text: string): number {
  useVoiceSessionStore.getState().appendInputSegment(text, 0);
  const seq = useVoiceSessionStore.getState().segments.at(-1)?.seq;
  if (seq === undefined) throw new Error("no segment was heard");
  return seq;
}

function option(index: number, label: string): CardChoice {
  return { kind: "option", index, label };
}

/** A fake timer list: `schedule` is the desk's, `advance` runs what came due. */
function createTimers() {
  interface Timer {
    readonly fn: () => void;
    readonly due: number;
    live: boolean;
  }
  const timers: Timer[] = [];
  let now = 0;
  return {
    schedule: (fn: () => void, ms: number): (() => void) => {
      const timer: Timer = { fn, due: now + ms, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    now: (): number => now,
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

/** What the card's records say; the watcher's reading of them is `deliver`. */
interface Records {
  content: CardContent | null;
  settledBy: string | null;
  gone: boolean;
  forwarded: BotSurfaceActionState | null;
}

interface Harness {
  readonly desk: CardDesk;
  readonly api: {
    readonly answerBotQuestion: Mock<CardApi["answerBotQuestion"]>;
    readonly actSurface: Mock<CardApi["actSurface"]>;
    readonly postInThread: Mock<CardApi["postInThread"]>;
    /** Whether a post can be sent; a test may turn it off. */
    canPost: boolean;
  };
  readonly records: Records;
  /** Everything the voice was given to say, in order. */
  readonly spoken: SpeechItem[];
  /** The ids of what was taken back before it was said. */
  readonly withdrawn: string[];
  readonly advance: (ms: number) => void;
  /** The watcher reads the records and hands them to the desk. */
  readonly deliver: () => void;
  /** The same, for the card of another item. */
  readonly deliverItem: (itemId: string) => void;
  /** The voice confirmed having said it. */
  readonly heard: (item: SpeechItem) => Promise<void>;
  /** The newest thing the voice was given to say. */
  readonly latest: () => SpeechItem;
  /** The person's words reach the card as the say loop hands them over. */
  readonly say: (text: string) => "handled" | "route";
  /** The same, under the delegation of the utterance. */
  readonly sayUnder: (
    text: string,
    delegationId: string,
  ) => "handled" | "route";
  /** The card is opened, its list read back and heard: the person's turn. */
  readonly listen: () => Promise<SpeechItem>;
  /** A choice named and its read-back heard: a yes is next. */
  readonly candidate: (choiceWords: string) => Promise<SpeechItem>;
  /** The router's answer, routed against the card as it stands now. */
  readonly route: (choice: number | null, text: string) => boolean;
  /** Words (by their segments) routed elsewhere, against the card as it stands now. */
  readonly drop: (seqs: ReadonlyArray<number>) => void;
  readonly card: () => ActiveCard | null;
  readonly texts: () => ReadonlyArray<string>;
}

const initial = useVoiceSessionStore.getState();

function setup(content: CardContent): Harness {
  const spoken: SpeechItem[] = [];
  const withdrawn: string[] = [];
  const timers = createTimers();
  let actionCount = 0;
  const cardDesk = createCardDesk({
    store: useVoiceSessionStore,
    speech: {
      enqueue: (item) => spoken.push(item),
      withdraw: (itemId) => withdrawn.push(itemId),
      activity: () => ({
        inputActiveUntil: null,
        outputPlaying: false,
        ackPending: false,
      }),
      subscribe: () => () => undefined,
    },
    schedule: timers.schedule,
    target: (itemId) => {
      if (itemId === ITEM) return { family: content.family, ids: IDS };
      if (itemId === OTHER_ITEM) {
        return { family: content.family, ids: OTHER_IDS };
      }
      return null;
    },
    newActionId: () => {
      actionCount += 1;
      return `act-${actionCount}`;
    },
  });
  const records: Records = {
    content,
    settledBy: null,
    gone: false,
    forwarded: null,
  };
  const api = {
    answerBotQuestion: vi.fn<CardApi["answerBotQuestion"]>(() =>
      Promise.resolve({ kind: "sent", delivery: "written" }),
    ),
    actSurface: vi.fn<CardApi["actSurface"]>(() =>
      Promise.resolve({
        kind: "answered",
        response: { outcome: "settled", code: null },
      }),
    ),
    postInThread: vi.fn<CardApi["postInThread"]>(() => Promise.resolve(true)),
    canPost: true,
  };
  const deliverItem = (itemId: string): void => {
    const facts: CardFacts = {
      content: records.content,
      settledBy: () => records.settledBy,
      gone: records.gone,
      forwarded: (actionId) =>
        records.forwarded?.actionId === actionId ? records.forwarded : null,
    };
    cardDesk.observe(itemId, facts, api);
  };
  const deliver = (): void => {
    deliverItem(ITEM);
  };
  /** Delivered, and the desk's check of the playback after it has run. */
  const heard = async (item: SpeechItem): Promise<void> => {
    item.onDelivered?.();
    await Promise.resolve();
  };
  const latest = (): SpeechItem => {
    const item = spoken.at(-1);
    if (item === undefined) throw new Error("nothing was spoken");
    return item;
  };
  const say = (text: string): "handled" | "route" =>
    speakTo(cardDesk, text, "d-words");
  const sayUnder = (text: string, delegationId: string): "handled" | "route" =>
    speakTo(cardDesk, text, delegationId);
  const listen = async (): Promise<SpeechItem> => {
    cardDesk.open(ITEM, "d-open");
    deliver();
    const list = latest();
    await heard(list);
    return list;
  };
  const candidate = async (choiceWords: string): Promise<SpeechItem> => {
    say(choiceWords);
    const item = latest();
    await heard(item);
    return item;
  };
  const currentKey = (): CardKey => {
    const active = useVoiceSessionStore.getState().activeCard;
    if (active === null) throw new Error("no card is open");
    return { opening: active.opening, questionIndex: active.questionIndex };
  };
  return {
    desk: cardDesk,
    api,
    records,
    spoken,
    withdrawn,
    advance: timers.advance,
    deliver,
    deliverItem,
    heard,
    latest,
    say,
    sayUnder,
    listen,
    candidate,
    route: (choice, text) =>
      cardDesk.answerRouted(
        { choice, text, key: currentKey(), seqs: [] },
        "d-routed",
      ),
    drop: (seqs) => cardDesk.dropCandidate(currentKey(), seqs),
    card: () => useVoiceSessionStore.getState().activeCard,
    texts: () => spoken.map((item) => item.text),
  };
}

/** Words said, then handed over only once `before` ran: what a late boundary delivers. */
async function sayLate(
  h: Harness,
  text: string,
  before: () => Promise<void>,
): Promise<"handled" | "route"> {
  useVoiceSessionStore.getState().appendInputSegment(text, 0);
  await before();
  const words = useVoiceSessionStore.getState().reserveOpenSpan("late");
  if (words === null) throw new Error("no open words");
  const verdict = h.desk.answer(words, "d-late");
  useVoiceSessionStore.getState().consumeReservation(words.seqs);
  return verdict;
}

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
});

describe("the read-back of a card", () => {
  it.each([
    [
      "a bot's question",
      BOT_QUESTION,
      ["Which environment?", "1. Staging; 2. Production"],
    ],
    [
      "a task agent's question",
      AGENT_QUESTION,
      ["Which branch?", "1. main; 2. release/2.1"],
    ],
    [
      "an approval",
      APPROVAL,
      ["Bash: rm -rf build", "1. Allow; 2. Deny", "Say allow or deny"],
    ],
  ])(
    "of %s names every choice verbatim, as an ask",
    (_name, content, parts) => {
      const h = setup(content);

      h.desk.open(ITEM, "d-open");
      expect(h.spoken).toEqual([]);
      h.deliver();

      expect(h.spoken).toHaveLength(1);
      expect(h.latest().priority).toBe("ask");
      expect(h.latest().delegationId).toBe("d-open");
      for (const part of parts) expect(h.latest().text).toContain(part);
    },
  );

  it("spends an exact choice, a yes or a no said before it was heard, chooses nothing, and leaves other words to the router", () => {
    const h = setup(BOT_QUESTION);
    h.desk.open(ITEM, "d-open");
    h.deliver();

    expect(h.desk.awaitsAnswer()).toBe(true);
    expect(h.say("Staging")).toBe("handled");
    expect(h.say("yes")).toBe("handled");
    expect(h.say("no")).toBe("handled");
    expect(h.say("tell the CI bot hello")).toBe("route");

    expect(h.spoken).toHaveLength(1);
    expect(h.card()).toMatchObject({ candidate: null, state: "proposed" });
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
  });

  it("chooses nothing from words said while it played but handed over after it was heard", async () => {
    const h = setup(BOT_QUESTION);
    h.desk.open(ITEM, "d-open");
    h.deliver();
    const list = h.latest();

    expect(await sayLate(h, "Production", () => h.heard(list))).toBe("handled");

    expect(h.spoken).toEqual([list]);
    expect(h.card()?.candidate).toBeNull();
  });

  it("is said once however often the records change, and the card waits as proposed", () => {
    const h = setup(BOT_QUESTION);
    h.desk.open(ITEM, "d-open");

    h.deliver();
    h.deliver();

    expect(h.spoken).toHaveLength(1);
    expect(h.card()).toMatchObject({
      family: "bot-question",
      state: "proposed",
      candidate: null,
      ids: IDS,
      questionIndex: 1,
    });
  });

  it("opens nothing for an item that asks nothing", () => {
    const h = setup(BOT_QUESTION);

    expect(h.desk.open("item-unknown", "d-open")).toBe("nothing");
    expect(h.card()).toBeNull();
  });

  it("is apologised for when the records never load, and nothing is sent", () => {
    const h = setup(BOT_QUESTION);
    h.desk.open(ITEM, "d-open");

    h.advance(CARD_LOAD_TIMEOUT_MS);

    expect(h.texts()).toEqual([CARD_UNREADABLE_TEXT]);
    expect(h.card()).toBeNull();
  });

  it("lapses when the person says nothing for the answer window", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();

    h.advance(CARD_ANSWER_WINDOW_MS);

    expect(h.card()).toBeNull();
    expect(h.desk.awaitsAnswer()).toBe(false);
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
  });
});

describe("a yes", () => {
  it("sends the candidate only once the read-back that offered it was heard", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();
    h.say("Production");
    const readBack = h.latest();
    expect(readBack.text).toContain('"Production" as your answer');
    expect(readBack.text).toContain("Say yes to send it, or no.");

    // Said while the read-back plays.
    expect(h.say("yes")).toBe("handled");
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();

    // Said before it was heard but handed over after.
    expect(await sayLate(h, "yes", () => h.heard(readBack))).toBe("handled");
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();

    h.say("yes");
    expect(h.api.answerBotQuestion).toHaveBeenCalledTimes(1);
  });

  it("sends nothing with no candidate: the voice asks which one", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();

    expect(h.say("yes")).toBe("handled");

    expect(h.texts().at(-1)).toBe(CARD_WHICH_TEXT);
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
    expect(h.card()?.state).toBe("proposed");
  });

  it("is declined by a no: the card closes and nothing is sent", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();
    await h.candidate("Staging");

    h.say("no");

    expect(h.texts().at(-1)).toBe(CARD_DECLINED_TEXT);
    expect(h.card()).toBeNull();
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
  });

  it("is the candidate itself when the only choice takes no words of its own", async () => {
    const h = setup({
      ...BOT_QUESTION,
      questions: [
        {
          text: "Ship build forty?",
          options: ["Ship it"],
          takesText: false,
          questionId: null,
        },
      ],
    });
    const list = await h.listen();
    expect(list.text).toContain("Say yes to send it, or skip.");
    expect(h.card()?.candidate).toEqual(option(0, "Ship it"));

    h.say("yes");

    expect(h.api.answerBotQuestion).toHaveBeenCalledWith({
      text: "Ship it",
      questionIndex: 1,
      skipped: false,
    });
  });

  it("is taken as that choice when an option is literally labelled Yes", async () => {
    const h = setup({
      ...BOT_QUESTION,
      questions: [
        {
          text: "Ship build forty?",
          options: ["Yes", "No"],
          takesText: false,
          questionId: null,
        },
      ],
    });
    await h.listen();

    h.say("yes");
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
    expect(h.card()?.candidate).toEqual(option(0, "Yes"));
    expect(h.latest().text).toContain('"Yes" as your answer');

    // Said again after that read-back, the same choice is its confirmation.
    await h.heard(h.latest());
    h.say("yes");
    expect(h.api.answerBotQuestion).toHaveBeenCalledWith({
      text: "Yes",
      questionIndex: 1,
      skipped: false,
    });
  });
});

describe("a move or an interjection while a candidate waits", () => {
  it.each([
    ["focus", "You moved, so I did not send it."],
    ["interjection", "Still open:"],
  ] as const)(
    "after %s offers it again, and a yes counts only after the new read-back was heard",
    async (reason, prefix) => {
      const h = setup(BOT_QUESTION);
      await h.listen();
      await h.candidate("Staging");

      h.desk.invalidate(reason);

      expect(h.latest().text.startsWith(prefix)).toBe(true);
      expect(h.latest().text).toContain('"Staging" as your answer');
      expect(h.latest().priority).toBe("ask");
      h.say("yes");
      expect(h.api.answerBotQuestion).not.toHaveBeenCalled();

      await h.heard(h.latest());
      h.say("yes");
      expect(h.api.answerBotQuestion).toHaveBeenCalledWith({
        text: "Staging",
        questionIndex: 1,
        skipped: false,
      });
    },
  );

  it("takes back a candidate read-back not yet heard when the words went elsewhere", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();
    h.say("Staging");
    const readBack = h.latest();

    // A request said after the choice, routed elsewhere.
    h.drop([utterWords("tell the CI bot hello")]);

    expect(h.withdrawn).toEqual([readBack.id]);
    expect(h.card()?.candidate).toBeNull();
    h.say("yes");
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
  });
});

describe("the three families", () => {
  it("answers a bot's question through the send, with the row's open question index", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();
    await h.candidate("the second one");

    h.say("yes");

    expect(h.api.answerBotQuestion).toHaveBeenCalledWith({
      text: "Production",
      questionIndex: 1,
      skipped: false,
    });
    expect(h.api.actSurface).not.toHaveBeenCalled();
  });

  it("answers a task agent's question through the surface act, never the bot's send", async () => {
    const h = setup(AGENT_QUESTION);
    await h.listen();
    await h.candidate("release 2.1");

    h.say("yes");

    expect(h.api.actSurface).toHaveBeenCalledTimes(1);
    expect(h.api.actSurface).toHaveBeenCalledWith(
      {
        kind: "answer",
        answers: [
          {
            questionId: "q-branch",
            question: "Which branch?",
            values: ["release/2.1"],
            notes: null,
            selection: {
              questionIndex: 0,
              optionIndices: [1],
              optionLabels: ["release/2.1"],
              customText: null,
            },
          },
        ],
      },
      "act-1",
    );
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
  });

  it("walks an agent's questions one by one and sends them once, together", async () => {
    const h = setup(TWO_QUESTIONS);
    await h.listen();
    await h.candidate("main");

    h.say("yes");

    expect(h.api.actSurface).not.toHaveBeenCalled();
    expect(h.latest().text).toContain("Question 2 of 2: Run the migration?");
    expect(h.card()).toMatchObject({
      questionIndex: 1,
      candidate: null,
      draft: [option(0, "main")],
    });

    await h.heard(h.latest());
    await h.candidate("hold off");
    h.say("yes");

    expect(h.api.actSurface).toHaveBeenCalledTimes(1);
    const sent = h.api.actSurface.mock.calls.at(0)?.[0];
    expect(sent?.kind === "answer" ? sent.answers : []).toMatchObject([
      { questionId: "q-branch", values: ["main"] },
      { questionId: "q-migrate", values: ["Hold off"] },
    ]);
  });

  it.each([
    ["allow", true],
    ["deny", false],
  ])(
    "decides an approval with %s through the surface act",
    async (verb, approved) => {
      const h = setup(APPROVAL);
      await h.listen();
      await h.candidate(verb);
      expect(h.latest().text).toContain("Bash: rm -rf build");

      h.say("yes");

      expect(h.api.actSurface).toHaveBeenCalledWith(
        { kind: "decide", decision: { approved } },
        "act-1",
      );
      expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
    },
  );

  it("sends a skipped bot question as skipped, with the Skipped text", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();
    await h.candidate("skip");
    expect(h.latest().text).toContain("Skip Release bot's question.");

    h.say("yes");

    expect(h.api.answerBotQuestion).toHaveBeenCalledWith({
      text: "Skipped",
      questionIndex: 1,
      skipped: true,
    });
  });

  it("sends a skipped agent question as a skip with no draft answers", async () => {
    const h = setup(TWO_QUESTIONS);
    await h.listen();
    await h.candidate("main");
    h.say("yes");
    await h.heard(h.latest());
    await h.candidate("skip");

    h.say("yes");

    expect(h.api.actSurface).toHaveBeenCalledWith(
      { kind: "skip", draftAnswers: [] },
      "act-1",
    );
  });
});

describe("the router's answer to the card", () => {
  it("is shown the question and the choices by number, with Skip last, from the moment its content is known", () => {
    const h = setup(BOT_QUESTION);
    h.desk.open(ITEM, "d-open");
    expect(h.desk.routerCard()).toBeNull();

    h.deliver();
    expect(h.desk.routerCard()).toEqual({
      key: { opening: 1, questionIndex: 1 },
      question: "Which environment?",
      choices: ["Staging", "Production", "Skip"],
      takesText: false,
    });
  });

  it("is shown an approval as Allow and Deny with no Skip", async () => {
    const h = setup(APPROVAL);
    await h.listen();

    expect(h.desk.routerCard()).toEqual({
      key: { opening: 1, questionIndex: 0 },
      question: "Allow or deny Bash?",
      choices: ["Allow", "Deny"],
      takesText: false,
    });
  });

  it("is not shown a card that cannot be answered from here", () => {
    const h = setup({ ...BOT_QUESTION, actable: false });
    h.desk.open(ITEM, "d-open");
    h.deliver();

    expect(h.desk.routerCard()).toBeNull();
  });

  it("chooses nothing when it arrives before the card could be answered", () => {
    const h = setup(BOT_QUESTION);
    h.desk.open(ITEM, "d-open");
    h.deliver();

    expect(h.route(1, "")).toBe(true);

    expect(h.spoken).toHaveLength(1);
    expect(h.card()?.candidate).toBeNull();
  });

  it.each([
    [1, "", '"release/2.1" as your answer to the agent\'s question'],
    [2, "", "Skip the agent's question."],
    [
      null,
      "use the hotfix branch",
      '"use the hotfix branch" as your answer to the agent\'s question',
    ],
  ])(
    "choice %s becomes the candidate and is read back alone",
    async (choice, text, readBack) => {
      const h = setup(AGENT_QUESTION);
      await h.listen();

      expect(h.route(choice, text)).toBe(true);

      expect(h.latest().text).toContain(readBack);
      expect(h.latest().delegationId).toBe("d-routed");
      expect(h.api.actSurface).not.toHaveBeenCalled();
    },
  );

  it("sends the person's own words as custom text once confirmed", async () => {
    const h = setup(AGENT_QUESTION);
    await h.listen();
    h.route(null, "use the hotfix branch");
    await h.heard(h.latest());

    h.say("yes");

    const sent = h.api.actSurface.mock.calls.at(0)?.[0];
    expect(sent?.kind === "answer" ? sent.answers : []).toMatchObject([
      {
        values: ["use the hotfix branch"],
        selection: { optionIndices: [], customText: "use the hotfix branch" },
      },
    ]);
  });

  it.each([
    ["a choice past the list", AGENT_QUESTION, 7, "anything"],
    ["a skip of an approval", APPROVAL, 2, ""],
    ["no words for a question that takes them", AGENT_QUESTION, null, "  "],
    ["words for a question that takes none", BOT_QUESTION, null, "maybe"],
  ])("asks which one for %s", async (_name, content, choice, text) => {
    const h = setup(content);
    await h.listen();

    expect(h.route(choice, text)).toBe(true);

    expect(h.latest().text).toBe(CARD_WHICH_TEXT);
    expect(h.card()?.candidate).toBeNull();
  });

  describe("while the person names a choice exactly with a route still out", () => {
    /** "use staging" is routed; before it comes back, "Production" is said exactly: its read-back is out. */
    async function routeOutThenExactChoice() {
      const h = setup(BOT_QUESTION);
      await h.listen();
      const earlySeq = utterWords("use staging");
      expect(
        h.desk.answer({ text: "use staging", seqs: [earlySeq] }, "d-early"),
      ).toBe("route");
      // The say loop holds those words for the route; later words are their own.
      useVoiceSessionStore.getState().reserveOpenSpan("route");
      h.say("Production");
      const readBack = h.latest();
      const active = h.card();
      if (active === null) throw new Error("no card is open");
      const key = {
        opening: active.opening,
        questionIndex: active.questionIndex,
      };
      return { h, earlySeq, readBack, key };
    }

    it("ignores the answer to the earlier words: the exact choice and its read-back stand", async () => {
      const { h, earlySeq, readBack, key } = await routeOutThenExactChoice();
      const spokenBefore = h.spoken.length;

      const taken = h.desk.answerRouted(
        { choice: 0, text: "use staging", key, seqs: [earlySeq] },
        "d-early",
      );

      expect(taken).toBe(true);
      expect(h.card()?.candidate).toEqual(option(1, "Production"));
      expect(h.withdrawn).toEqual([]);
      expect(h.latest()).toBe(readBack);
      expect(h.spoken).toHaveLength(spokenBefore);
    });

    it("lets an answer to words said after the exact choice replace it", async () => {
      const { h, readBack, key } = await routeOutThenExactChoice();
      const laterSeq = utterWords("no, staging");

      h.desk.answerRouted(
        { choice: 0, text: "no, staging", key, seqs: [laterSeq] },
        "d-later",
      );

      expect(h.card()?.candidate).toEqual(option(0, "Staging"));
      expect(h.withdrawn).toEqual([readBack.id]);
    });
  });

  it("is not taken when no card waits", () => {
    const h = setup(BOT_QUESTION);

    expect(
      h.desk.answerRouted(
        {
          choice: 0,
          text: "",
          key: { opening: 1, questionIndex: 0 },
          seqs: [],
        },
        "d-routed",
      ),
    ).toBe(false);
    expect(h.spoken).toEqual([]);
  });
});

describe("a card settled first by someone else", () => {
  /**
   * The act lands refused, as each family's API reports it: a bot's send
   * only fails, and its records say whether someone answered first.
   */
  function refuseAsSettled(h: Harness, family: CardFamily): void {
    if (family === "bot-question") {
      h.api.answerBotQuestion.mockResolvedValueOnce({ kind: "failed" });
      return;
    }
    h.api.actSurface.mockResolvedValueOnce({
      kind: "answered",
      response: { outcome: "refused", code: "ALREADY_SETTLED" },
    });
  }

  it.each([
    {
      name: "a bot's question",
      content: BOT_QUESTION,
      words: "the second one",
      label: "Production",
      verb: "answered",
    },
    {
      name: "an agent's question",
      content: AGENT_QUESTION,
      words: "main",
      label: "main",
      verb: "answered",
    },
    {
      name: "an approval",
      content: APPROVAL,
      words: "deny",
      label: "Deny",
      verb: "decided",
    },
  ])(
    "on $name is said with who settled it, and a heard yes posts the answer in the thread",
    async ({ content, words, label, verb }) => {
      const h = setup(content);
      await h.listen();
      await h.candidate(words);
      // The records name the settler by the time the refusal lands.
      h.records.settledBy = "Dana";
      refuseAsSettled(h, content.family);

      h.say("yes");

      await vi.waitFor(() =>
        expect(h.latest().text).toBe(settledElsewhere("Dana", verb)),
      );
      expect(h.latest().priority).toBe("ask");
      expect(h.card()?.state).toBe("settled");

      // A yes said before the offer was heard is not its answer.
      h.say("yes");
      expect(h.api.postInThread).not.toHaveBeenCalled();

      await h.heard(h.latest());
      h.say("yes");

      expect(h.api.postInThread).toHaveBeenCalledWith(label);
      await vi.waitFor(() => expect(h.card()).toBeNull());
      expect(h.texts().at(-1)).toBe("Posted your answer in the thread.");
    },
  );

  it.each([
    {
      name: "a bot's question",
      content: BOT_QUESTION,
      words: "the second one",
      verb: "answered",
    },
    { name: "an approval", content: APPROVAL, words: "deny", verb: "decided" },
  ])(
    "on $name offers no post when none can be sent: it says so and closes",
    async ({ content, words, verb }) => {
      const h = setup(content);
      await h.listen();
      await h.candidate(words);
      h.api.canPost = false;
      h.records.settledBy = "Dana";
      refuseAsSettled(h, content.family);

      h.say("yes");

      await vi.waitFor(() =>
        expect(h.latest().text).toBe(
          `Dana already ${verb} it, so there is nothing to send.`,
        ),
      );
      expect(h.card()).toBeNull();
      expect(h.say("yes")).toBe("route");
      expect(h.api.postInThread).not.toHaveBeenCalled();
    },
  );

  it("is said as Someone when the records name nobody within the wait", async () => {
    const h = setup(AGENT_QUESTION);
    await h.listen();
    await h.candidate("main");
    refuseAsSettled(h, "agent-question");

    h.say("yes");
    await vi.waitFor(() => expect(h.card()?.state).toBe("refused"));
    const spokenBefore = h.spoken.length;

    h.advance(CARD_SETTLER_WAIT_MS - 1);
    expect(h.spoken).toHaveLength(spokenBefore);
    h.advance(1);

    expect(h.latest().text).toBe(settledElsewhere("Someone", "answered"));
    await h.heard(h.latest());
    h.say("yes");
    expect(h.api.postInThread).toHaveBeenCalledWith("main");
  });

  it("is not claimed for a bot's send that failed while the records show the question still open", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();
    await h.candidate("Staging");
    refuseAsSettled(h, "bot-question");

    h.say("yes");
    await vi.waitFor(() => expect(h.card()?.state).toBe("refused"));
    h.advance(CARD_SETTLER_WAIT_MS);

    expect(h.texts().at(-1)).toBe(CARD_FAILED_TEXT);
    expect(h.texts().some((text) => text.includes("already"))).toBe(false);
    expect(h.api.postInThread).not.toHaveBeenCalled();
    expect(h.card()).toBeNull();
  });

  it("is said with the name once the records give it within the wait, and only once", async () => {
    const h = setup(AGENT_QUESTION);
    await h.listen();
    await h.candidate("main");
    refuseAsSettled(h, "agent-question");

    h.say("yes");
    await vi.waitFor(() => expect(h.card()?.state).toBe("refused"));
    h.records.settledBy = "Priya";
    h.deliver();
    h.advance(CARD_SETTLER_WAIT_MS * 2);

    expect(h.texts().filter((text) => text.includes("already"))).toEqual([
      settledElsewhere("Priya", "answered"),
    ]);
  });

  it("is said when the records show it while the person is still deciding, without sending", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();
    await h.candidate("Staging");

    h.records.settledBy = "Dana";
    h.records.content = null;
    h.deliver();

    expect(h.latest().text).toBe(settledElsewhere("Dana", "answered"));
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
  });

  it("is offered again when the person moves, and a yes before the new offer is heard posts nothing", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();
    await h.candidate("Production");
    h.records.settledBy = "Dana";
    refuseAsSettled(h, "bot-question");
    h.say("yes");
    await vi.waitFor(() =>
      expect(h.latest().text).toBe(settledElsewhere("Dana", "answered")),
    );
    const offer = h.latest();
    await h.heard(offer);

    h.desk.invalidate("focus");

    expect(h.withdrawn).toEqual([offer.id]);
    expect(h.latest().text).toBe(
      "You moved, so nothing was posted. Want me to post your answer in the thread instead? Say yes or no.",
    );
    // Said over the new offer: spent by it, never routed as a request.
    expect(h.say("yes")).toBe("handled");
    expect(h.api.postInThread).not.toHaveBeenCalled();

    await h.heard(h.latest());
    h.say("yes");
    expect(h.api.postInThread).toHaveBeenCalledWith("Production");
  });

  it("lets the offer go when the person says no", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();
    await h.candidate("Staging");
    h.records.settledBy = "Dana";
    refuseAsSettled(h, "bot-question");
    h.say("yes");
    await vi.waitFor(() => expect(h.latest().text).toContain("Dana"));
    await h.heard(h.latest());

    h.say("no");

    expect(h.texts().at(-1)).toBe("Okay, nothing was posted.");
    expect(h.api.postInThread).not.toHaveBeenCalled();
    expect(h.card()).toBeNull();
  });
});

describe("an act forwarded to the task's machine", () => {
  async function forwarded(): Promise<Harness> {
    const h = setup(AGENT_QUESTION);
    await h.listen();
    await h.candidate("main");
    h.api.actSurface.mockResolvedValueOnce({
      kind: "answered",
      response: { outcome: "forwarded", code: null },
    });
    h.say("yes");
    await vi.waitFor(() => expect(h.card()?.state).toBe("forwarded"));
    return h;
  }

  it("keeps the card and its draft while the records still show it waiting", async () => {
    const h = await forwarded();

    h.records.forwarded = {
      actionId: "act-1",
      messageId: "msg-1",
      state: "sending",
      code: null,
    };
    h.deliver();

    expect(h.card()).toMatchObject({
      state: "forwarded",
      draft: [option(0, "main")],
    });
    expect(h.texts().at(-1)).toBe(
      "Sent. It is on its way to the task's machine.",
    );
  });

  it("closes once the records show who settled it", async () => {
    const h = await forwarded();

    h.records.settledBy = "you";
    h.records.content = null;
    h.deliver();

    expect(h.card()).toBeNull();
    expect(h.api.actSurface).toHaveBeenCalledTimes(1);
  });

  it("says why when the task's machine refuses it, and closes", async () => {
    const h = await forwarded();

    h.records.forwarded = {
      actionId: "act-1",
      messageId: "msg-1",
      state: "refused",
      code: "NOT_REACHABLE",
    };
    h.deliver();

    expect(h.texts().at(-1)).toContain("could not be reached");
    expect(h.card()).toBeNull();
  });

  it("offers the post, with the name, when the task's machine reports it was settled first", async () => {
    const h = await forwarded();

    h.records.forwarded = {
      actionId: "act-1",
      messageId: "msg-1",
      state: "refused",
      code: "ALREADY_SETTLED",
    };
    h.deliver();
    h.records.settledBy = "Dana";
    h.deliver();

    expect(h.latest().text).toBe(settledElsewhere("Dana", "answered"));
    await h.heard(h.latest());
    h.say("yes");
    expect(h.api.postInThread).toHaveBeenCalledWith("main");
  });

  it("ignores a refusal of some other act", async () => {
    const h = await forwarded();

    h.records.forwarded = {
      actionId: "act-other",
      messageId: "msg-1",
      state: "refused",
      code: "NOT_REACHABLE",
    };
    h.deliver();

    expect(h.card()?.state).toBe("forwarded");
  });
});

describe("a card that is gone", () => {
  it.each([
    ["before it was read", false],
    ["after the candidate was read back", true],
  ])("is said %s and never acted on", async (_name, afterCandidate) => {
    const h = setup(BOT_QUESTION);
    if (afterCandidate) {
      await h.listen();
      await h.candidate("Staging");
    } else {
      h.desk.open(ITEM, "d-open");
    }

    h.records.content = null;
    h.records.gone = true;
    h.deliver();

    expect(h.texts().at(-1)).toBe(CARD_GONE_TEXT);
    expect(h.card()).toBeNull();
    expect(h.say("yes")).toBe("route");
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
    expect(h.api.actSurface).not.toHaveBeenCalled();
  });
});

interface RealScheduled {
  readonly scheduler: SpeechScheduler;
  readonly cardDesk: CardDesk;
  readonly actSurface: Mock<CardApi["actSurface"]>;
  readonly answerBotQuestion: Mock<CardApi["answerBotQuestion"]>;
  /** The voice's sound starts and this much of the read-back is transcribed. */
  readonly speak: (words: string) => void;
  /** The sound ends and the hangover passes. */
  readonly endPlayback: () => Promise<void>;
}

/** The real scheduler on a fake clock, with healthy level detection, behind a desk with this card open and its records read. */
function openOnRealScheduler(content: CardContent): RealScheduled {
  const timers = createTimers();
  const cancels = new Map<number, () => void>();
  let handle = 0;
  const scheduler = createSpeechScheduler({
    append: () => undefined,
    now: timers.now,
    setTimer: (fn, ms) => {
      handle += 1;
      cancels.set(handle, timers.schedule(fn, ms));
      return handle;
    },
    clearTimer: (timer) => {
      if (typeof timer === "number") cancels.get(timer)?.();
    },
  });
  scheduler.setReady(true);
  scheduler.setLevelDetection(true);
  const actSurface = vi.fn<CardApi["actSurface"]>(() =>
    Promise.resolve({
      kind: "answered",
      response: { outcome: "settled", code: null },
    }),
  );
  const answerBotQuestion = vi.fn<CardApi["answerBotQuestion"]>(() =>
    Promise.resolve({ kind: "sent", delivery: "written" }),
  );
  const api: CardApi = {
    answerBotQuestion,
    actSurface,
    postInThread: () => Promise.resolve(true),
    canPost: true,
  };
  const cardDesk = createCardDesk({
    store: useVoiceSessionStore,
    speech: scheduler,
    schedule: timers.schedule,
    target: () => ({ family: content.family, ids: IDS }),
    newActionId: () => "act-1",
  });
  cardDesk.open(ITEM, null);
  cardDesk.observe(
    ITEM,
    {
      content,
      settledBy: () => null,
      gone: false,
      forwarded: () => null,
    },
    api,
  );
  return {
    scheduler,
    cardDesk,
    actSurface,
    answerBotQuestion,
    speak: (words) => {
      scheduler.noteOutputLevel(true);
      scheduler.noteOutputTranscript(words);
    },
    endPlayback: async () => {
      scheduler.noteOutputLevel(false);
      timers.advance(OUTPUT_HANGOVER_MS * 3);
      await Promise.resolve();
      expect(scheduler.activity().outputPlaying).toBe(false);
    },
  };
}

describe("a read-back confirmed by its first words", () => {
  /** An approval open on the real scheduler, its list heard, "approve" said: the candidate read-back is out. */
  async function approvalOnRealScheduler(): Promise<RealScheduled> {
    const h = openOnRealScheduler(APPROVAL);
    // The list plays whole and is heard.
    h.speak("Bash. Allow or deny.");
    await h.endPlayback();
    speakTo(h.cardDesk, "approve", "d-words");
    expect(useVoiceSessionStore.getState().activeCard?.candidate).toEqual(
      option(0, "Allow"),
    );
    return h;
  }

  /** The yes said over the rest of the read-back sends nothing; one after it ends sends once. */
  async function expectYesWaitsForPlayback(h: RealScheduled): Promise<void> {
    await Promise.resolve();
    expect(h.scheduler.activity().outputPlaying).toBe(true);
    speakTo(h.cardDesk, "yes", "d-words");
    expect(h.actSurface).not.toHaveBeenCalled();

    await h.endPlayback();
    speakTo(h.cardDesk, "yes", "d-words");
    expect(h.actSurface).toHaveBeenCalledTimes(1);
    expect(h.actSurface).toHaveBeenCalledWith(
      { kind: "decide", decision: { approved: true } },
      "act-1",
    );
  }

  it("counts as heard only once its playback is over: a yes said over the rest of it sends nothing", async () => {
    const h = await approvalOnRealScheduler();

    h.scheduler.noteOutputLevel(true);
    h.scheduler.noteOutputTranscript("Allow");

    await expectYesWaitsForPlayback(h);
  });

  it("is held to the same when its transcript arrives before the sound", async () => {
    const h = await approvalOnRealScheduler();

    h.scheduler.noteOutputTranscript("Allow");
    h.scheduler.noteOutputLevel(true);

    await expectYesWaitsForPlayback(h);
  });
});

describe("a read-back proven by its end", () => {
  const QUESTION_ONLY =
    "Release bot asks in the thread about Deploy: Which environment?";
  const SINGLE: CardContent = {
    ...BOT_QUESTION,
    questions: [
      {
        text: "Ship build forty?",
        options: ["Ship it"],
        takesText: false,
        questionId: null,
      },
    ],
  };

  it.each([
    ["only its question was spoken", QUESTION_ONLY, null],
    [
      "its last choice was spoken",
      `${QUESTION_ONLY} 1. Staging; 2. Production`,
      option(0, "Staging"),
    ],
    [
      "only its closing 'or skip' was spoken",
      "Say one of them, or skip.",
      option(0, "Staging"),
    ],
  ])(
    "counts a question's list as heard only when the end was said: %s",
    async (_name, transcript, candidate) => {
      const h = openOnRealScheduler(BOT_QUESTION);

      h.speak(transcript);
      await h.endPlayback();
      speakTo(h.cardDesk, "Staging", "d-words");
      speakTo(h.cardDesk, "yes", "d-words");

      expect(useVoiceSessionStore.getState().activeCard?.candidate).toEqual(
        candidate,
      );
      expect(h.answerBotQuestion).not.toHaveBeenCalled();
    },
  );

  it("arms a single choice as the candidate only once its end was said", async () => {
    const h = openOnRealScheduler(SINGLE);

    h.speak("Release bot asks in the thread about Deploy: Ship build forty?");
    await h.endPlayback();
    speakTo(h.cardDesk, "yes", "d-words");
    expect(h.answerBotQuestion).not.toHaveBeenCalled();

    h.speak(" The choices are: 1. Ship it. Say yes to send it, or skip.");
    await h.endPlayback();
    speakTo(h.cardDesk, "yes", "d-words");
    expect(h.answerBotQuestion).toHaveBeenCalledExactlyOnceWith({
      text: "Ship it",
      questionIndex: 1,
      skipped: false,
    });
  });

  /** A task agent's question with one choice that takes no words of its own, so a yes sends it. */
  function soleChoice(question: string): CardContent {
    return {
      ...AGENT_QUESTION,
      questions: [
        {
          text: question,
          options: ["Production"],
          takesText: false,
          questionId: "q-deploy",
        },
      ],
    };
  }
  const SPOKEN_LEAD = "Release bot says a task's agent asks in its channel:";

  it.each([["Deploy production or skip?"], ["Deploy production?"]])(
    "is not armed by the question alone, whatever of the choice and the skip it repeats: %s",
    async (question) => {
      const h = openOnRealScheduler(soleChoice(question));

      h.speak(`${SPOKEN_LEAD} ${question}`);
      await h.endPlayback();
      speakTo(h.cardDesk, "yes", "d-words");

      expect(h.actSurface).not.toHaveBeenCalled();
      expect(useVoiceSessionStore.getState().activeCard?.state).toBe(
        "proposed",
      );
    },
  );

  it.each([[" Production"], [" or skip"]])(
    "is armed once the question's words are said again after it (%s)",
    async (tail) => {
      const question = "Deploy production or skip?";
      const h = openOnRealScheduler(soleChoice(question));
      h.speak(`${SPOKEN_LEAD} ${question}`);
      await h.endPlayback();
      speakTo(h.cardDesk, "yes", "d-words");
      expect(h.actSurface).not.toHaveBeenCalled();

      h.speak(tail);
      await h.endPlayback();
      speakTo(h.cardDesk, "yes", "d-words");

      expect(h.actSurface).toHaveBeenCalledTimes(1);
    },
  );

  /** A bot's question whose choices share a word. */
  function regions(
    options: ReadonlyArray<string>,
    question: string,
  ): CardContent {
    return {
      ...BOT_QUESTION,
      questions: [
        { text: question, options, takesText: false, questionId: null },
      ],
    };
  }
  const BOT_LEAD = "Release bot asks in the thread about Deploy:";
  const REGIONS = regions(
    ["Production east", "Production west"],
    "Choose a region.",
  );

  it("is not armed by a list cut off after an earlier choice that shares a word with the last", async () => {
    const h = openOnRealScheduler(REGIONS);

    h.speak(
      `${BOT_LEAD} Choose a region. The first choice is Production east.`,
    );
    await h.endPlayback();
    speakTo(h.cardDesk, "Production east", "d-words");
    speakTo(h.cardDesk, "yes", "d-words");

    expect(useVoiceSessionStore.getState().activeCard?.candidate).toBeNull();
    expect(h.answerBotQuestion).not.toHaveBeenCalled();
  });

  it.each([
    ["both choices were said", "1. Production east; 2. Production west"],
    [
      "the closing skip was said",
      "1. Production east. Say one of them, or skip.",
    ],
  ])(
    "is armed once %s, and a candidate chosen then is sent by one yes",
    async (_name, tail) => {
      const h = openOnRealScheduler(REGIONS);
      h.speak(`${BOT_LEAD} Choose a region. ${tail}`);
      await h.endPlayback();

      speakTo(h.cardDesk, "Production east", "d-words");
      expect(useVoiceSessionStore.getState().activeCard?.candidate).toEqual(
        option(0, "Production east"),
      );
      h.speak(' "Production east" as your answer. Say yes to send it, or no.');
      await h.endPlayback();
      speakTo(h.cardDesk, "yes", "d-words");

      expect(h.answerBotQuestion).toHaveBeenCalledExactlyOnceWith({
        text: "Production east",
        questionIndex: 1,
        skipped: false,
      });
    },
  );

  it("does not take a re-offered candidate as heard from the line it opens with, only once its label is said", async () => {
    const h = openOnRealScheduler(
      regions(["Open later", "Close now"], "When should it open?"),
    );
    h.speak(
      `${BOT_LEAD} When should it open? 1. Open later; 2. Close now. Say one of them, or skip.`,
    );
    await h.endPlayback();
    speakTo(h.cardDesk, "Open later", "d-words");
    h.speak(' "Open later" as your answer. Say yes to send it, or no.');
    await h.endPlayback();

    h.cardDesk.invalidate("interjection");
    h.speak("Still open:");
    await h.endPlayback();
    speakTo(h.cardDesk, "yes", "d-words");
    expect(h.answerBotQuestion).not.toHaveBeenCalled();

    h.speak(' "Open later" as your answer.');
    await h.endPlayback();
    speakTo(h.cardDesk, "yes", "d-words");

    expect(h.answerBotQuestion).toHaveBeenCalledTimes(1);
  });

  const WHO: CardContent = {
    ...AGENT_QUESTION,
    questions: [
      {
        text: "Who should handle it?",
        options: ["Agent"],
        takesText: false,
        questionId: "q-who",
      },
    ],
  };
  const DENY_FIRST: CardContent = {
    ...APPROVAL,
    approval: { tool: "Bash", summary: "deny the old branch" },
  };

  it.each([
    [
      "the template's introduction and the question",
      "Release bot says a task's agent asks in its channel: Who should handle it?",
      0,
    ],
    ["the whole read-back", cardListText(WHO, 0), 1],
  ])(
    "arms a sole choice named like the template's own words only by its tail: %s",
    async (_name, transcript, sends) => {
      const h = openOnRealScheduler(WHO);

      h.speak(transcript);
      await h.endPlayback();
      speakTo(h.cardDesk, "yes", "d-words");

      expect(h.actSurface).toHaveBeenCalledTimes(sends);
    },
  );

  it.each([
    [
      "before the choice list",
      "Release bot says a task's agent wants to use Bash: deny the old branch, in its channel.",
      null,
    ],
    ["the whole read-back", cardListText(DENY_FIRST, 0), option(0, "Allow")],
  ])(
    "arms an approval whose summary says Deny only by its choice list: %s",
    async (_name, transcript, candidate) => {
      const h = openOnRealScheduler(DENY_FIRST);

      h.speak(transcript);
      await h.endPlayback();
      speakTo(h.cardDesk, "approve", "d-words");

      expect(useVoiceSessionStore.getState().activeCard?.candidate).toEqual(
        candidate,
      );
      expect(h.actSurface).not.toHaveBeenCalled();
    },
  );

  it("counts a candidate read-back as heard by its label, not by the tool it names", async () => {
    const h = openOnRealScheduler(APPROVAL);
    h.speak("Bash. Allow or deny.");
    await h.endPlayback();
    speakTo(h.cardDesk, "approve", "d-words");

    h.speak("Bash: rm -rf build");
    await h.endPlayback();
    speakTo(h.cardDesk, "yes", "d-words");
    expect(h.actSurface).not.toHaveBeenCalled();

    // A further delta of the same utterance, as the transcript carries it.
    h.speak(" Allow");
    await h.endPlayback();
    speakTo(h.cardDesk, "yes", "d-words");
    expect(h.actSurface).toHaveBeenCalledTimes(1);
  });
});

describe("a card opened again while its act is out", () => {
  /** An approval of the first item allowed, its act pending; another card opened, then the first again. */
  async function reopenedWhileOut(): Promise<{
    readonly h: Harness;
    readonly resolveAct: (response: "settled" | "forwarded") => void;
  }> {
    const h = setup(APPROVAL);
    let resolveAct: (response: "settled" | "forwarded") => void = () =>
      undefined;
    h.api.actSurface.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAct = (outcome) =>
            resolve({
              kind: "answered",
              response: { outcome, code: null },
            });
        }),
    );
    await h.listen();
    await h.candidate("approve");
    h.say("yes");
    expect(h.api.actSurface).toHaveBeenCalledTimes(1);

    h.desk.open(OTHER_ITEM, "d-other");
    h.deliverItem(OTHER_ITEM);
    h.desk.open(ITEM, "d-again");
    h.deliver();
    return { h, resolveAct };
  }

  it("shows that act as sending, says it is on its way, and never sends a second one", async () => {
    const { h } = await reopenedWhileOut();

    expect(h.card()).toMatchObject({
      state: "sending",
      draft: [option(0, "Allow")],
      ids: IDS,
    });
    expect(h.texts().at(-1)).toBe("Your answer to that is already on its way.");

    h.say("approve");
    h.say("yes");
    expect(h.api.actSurface).toHaveBeenCalledTimes(1);
    expect(h.card()?.state).toBe("sending");
  });

  it.each([
    ["settles", "settled", null, "Sent: allowed."],
    [
      "is forwarded",
      "forwarded",
      "forwarded",
      "Sent. It is on its way to the task's machine.",
    ],
  ] as const)(
    "has its answer said on the current opening when it %s",
    async (_name, outcome, cardState, text) => {
      const { h, resolveAct } = await reopenedWhileOut();
      const opening = h.card()?.opening;

      resolveAct(outcome);

      await vi.waitFor(() => expect(h.latest().text).toBe(text));
      expect(h.latest().id.startsWith(`card:${opening}:`)).toBe(true);
      expect(h.card()?.state ?? null).toBe(cardState);
    },
  );
});

describe("a forwarded act that lost the race", () => {
  it("is said with who decided first when one reading shows both their resolution and its refusal, and offers the post", async () => {
    const h = setup(APPROVAL);
    await h.listen();
    await h.candidate("deny");
    h.api.actSurface.mockResolvedValueOnce({
      kind: "answered",
      response: { outcome: "forwarded", code: null },
    });
    h.say("yes");
    await vi.waitFor(() => expect(h.card()?.state).toBe("forwarded"));

    h.records.content = null;
    h.records.settledBy = "Alice";
    h.records.forwarded = {
      actionId: "act-1",
      messageId: "msg-1",
      state: "refused",
      code: "ALREADY_SETTLED",
    };
    h.deliver();

    expect(h.latest().text).toBe(settledElsewhere("Alice", "decided"));
    expect(h.card()).not.toBeNull();
    await h.heard(h.latest());
    h.say("yes");
    expect(h.api.postInThread).toHaveBeenCalledWith("Deny");
  });
});

describe("records that already carry the end of an act still out", () => {
  /** Approval denied with its act pending, and the records read meanwhile. */
  async function actOutWhileRecordsRead(
    h: Harness,
    records: Pick<Records, "settledBy" | "forwarded">,
  ): Promise<() => void> {
    let forward: () => void = () => undefined;
    h.api.actSurface.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          forward = () =>
            resolve({
              kind: "answered",
              response: { outcome: "forwarded", code: null },
            });
        }),
    );
    await h.listen();
    await h.candidate("deny");
    h.say("yes");
    expect(h.card()?.state).toBe("sending");

    h.records.content = null;
    h.records.settledBy = records.settledBy;
    h.records.forwarded = records.forwarded;
    h.deliver();
    expect(h.card()?.state).toBe("sending");
    return forward;
  }

  it("closes the card when the call turns forwarded after the post already showed its resolution", async () => {
    const h = setup(APPROVAL);
    const forward = await actOutWhileRecordsRead(h, {
      settledBy: "Alice",
      forwarded: null,
    });

    forward();

    await vi.waitFor(() => expect(h.card()).toBeNull());
  });

  it("says who decided first and offers the post when the call turns forwarded after its refusal was already recorded", async () => {
    const h = setup(APPROVAL);
    const forward = await actOutWhileRecordsRead(h, {
      settledBy: "Alice",
      forwarded: {
        actionId: "act-1",
        messageId: "msg-1",
        state: "refused",
        code: "ALREADY_SETTLED",
      },
    });

    forward();

    await vi.waitFor(() =>
      expect(h.latest().text).toBe(settledElsewhere("Alice", "decided")),
    );
    await h.heard(h.latest());
    h.say("yes");
    expect(h.api.postInThread).toHaveBeenCalledWith("Deny");
  });
});

describe("an act answered after its session ended", () => {
  it("leaves the new opening of a surfaced card proposed when the old call comes back forwarded", async () => {
    const old = deferred<SurfaceActOutcome>();
    const h = setup(APPROVAL);
    h.api.actSurface.mockImplementationOnce(() => old.promise);
    await h.listen();
    await h.candidate("approve");
    h.say("yes");
    h.desk.reset();
    useVoiceSessionStore.getState().sessionEnded(null);
    useVoiceSessionStore.getState().sessionConnecting();
    h.desk.open(ITEM, "d-new");
    h.deliver();
    const spokenBefore = h.spoken.length;

    old.resolve({
      kind: "answered",
      response: { outcome: "forwarded", code: null },
    });
    await old.promise;

    expect(h.card()?.state).toBe("proposed");
    expect(h.spoken).toHaveLength(spokenBefore);
    expect(h.latest().text).toContain("Bash");
  });

  it("leaves the new opening of a bot's question untouched when the old send comes back sent", async () => {
    const old = deferred<BotAnswerOutcome>();
    const h = setup(BOT_QUESTION);
    h.api.answerBotQuestion.mockImplementationOnce(() => old.promise);
    await h.listen();
    await h.candidate("Staging");
    h.say("yes");
    h.desk.reset();
    useVoiceSessionStore.getState().sessionEnded(null);
    useVoiceSessionStore.getState().sessionConnecting();
    h.desk.open(ITEM, "d-new");
    h.deliver();
    const spokenBefore = h.spoken.length;

    old.resolve({ kind: "sent", delivery: "written" });
    await old.promise;

    expect(h.card()).toMatchObject({ state: "proposed", candidate: null });
    expect(h.spoken).toHaveLength(spokenBefore);
  });
});

describe("an old call answered after a new act went out on the same card", () => {
  interface PendingPath {
    /** The next call of the card's API stays out until `resolveOld` for the first, never for the second. */
    readonly callCount: () => number;
    readonly resolveOld: () => Promise<void>;
    readonly armNew: () => void;
  }

  it.each([
    {
      name: "a surfaced act settled",
      content: APPROVAL,
      words: "approve",
      arm: (h: Harness): PendingPath => {
        const old = deferred<SurfaceActOutcome>();
        h.api.actSurface.mockImplementationOnce(() => old.promise);
        return {
          callCount: () => h.api.actSurface.mock.calls.length,
          resolveOld: async () => {
            old.resolve({
              kind: "answered",
              response: { outcome: "settled", code: null },
            });
            await old.promise;
          },
          armNew: () => {
            h.api.actSurface.mockImplementationOnce(
              () => new Promise<SurfaceActOutcome>(() => undefined),
            );
          },
        };
      },
    },
    {
      name: "a bot's answer sent",
      content: BOT_QUESTION,
      words: "Staging",
      arm: (h: Harness): PendingPath => {
        const old = deferred<BotAnswerOutcome>();
        h.api.answerBotQuestion.mockImplementationOnce(() => old.promise);
        return {
          callCount: () => h.api.answerBotQuestion.mock.calls.length,
          resolveOld: async () => {
            old.resolve({ kind: "sent", delivery: "written" });
            await old.promise;
          },
          armNew: () => {
            h.api.answerBotQuestion.mockImplementationOnce(
              () => new Promise<BotAnswerOutcome>(() => undefined),
            );
          },
        };
      },
    },
  ])(
    "leaves the new act out when the old call comes back ($name): the card reopens still sending",
    async ({ content, words, arm }) => {
      const h = setup(content);
      const path = arm(h);
      await h.listen();
      await h.candidate(words);
      h.say("yes");
      h.desk.reset();
      useVoiceSessionStore.getState().sessionEnded(null);
      useVoiceSessionStore.getState().sessionConnecting();

      // The same card, answered again in the new session: a new act is out.
      await h.listen();
      await h.candidate(words);
      path.armNew();
      h.say("yes");
      expect(path.callCount()).toBe(2);

      await path.resolveOld();

      h.desk.open(OTHER_ITEM, "d-other");
      h.deliverItem(OTHER_ITEM);
      h.desk.open(ITEM, "d-again");
      h.deliver();
      expect(h.card()?.state).toBe("sending");
      expect(h.texts().at(-1)).toBe(
        "Your answer to that is already on its way.",
      );
      h.say(words);
      h.say("yes");
      expect(path.callCount()).toBe(2);
    },
  );
});

describe("an item set aside", () => {
  it("leaves its card alone while an act is out on it", async () => {
    const old = deferred<SurfaceActOutcome>();
    const h = setup(APPROVAL);
    h.api.actSurface.mockImplementationOnce(() => old.promise);
    await h.listen();
    await h.candidate("approve");
    h.say("yes");
    const spokenBefore = h.spoken.length;

    h.desk.dismiss(ITEM);

    expect(h.card()).toMatchObject({
      state: "sending",
      draft: [option(0, "Allow")],
    });
    expect(h.spoken).toHaveLength(spokenBefore);
    expect(h.withdrawn).toEqual([]);
  });

  it("closes its card while an offer to post is out, taking the offer back", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();
    await h.candidate("Staging");
    h.records.content = null;
    h.records.settledBy = "Dana";
    h.deliver();
    const offer = h.latest();
    expect(offer.text).toBe(settledElsewhere("Dana", "answered"));

    h.desk.dismiss(ITEM);

    expect(h.card()).toBeNull();
    expect(h.withdrawn).toEqual([offer.id]);
  });
});

describe("the delegation of a card's words", () => {
  it("is not left behind by words the card routes: a later notice goes out under none", async () => {
    const h = setup(BOT_QUESTION);
    await h.listen();

    expect(h.sayUnder("tell the CI bot hello", "d-routed")).toBe("route");
    h.records.content = null;
    h.records.settledBy = "Dana";
    h.deliver();

    expect(h.latest().text).toBe(
      "Dana already answered it, so there is nothing to send.",
    );
    expect(h.latest().delegationId).toBeNull();
  });

  it.each([
    ["the engine lives on", () => undefined, "d-yes"],
    [
      "the engine was replaced meanwhile",
      () => useVoiceSessionStore.getState().engineReplacing(),
      null,
    ],
  ])(
    "of the yes that sent an act is on the act's answer while %s",
    async (_name, meanwhile, expected) => {
      const old = deferred<SurfaceActOutcome>();
      const h = setup(APPROVAL);
      h.api.actSurface.mockImplementationOnce(() => old.promise);
      await h.listen();
      await h.candidate("approve");
      h.sayUnder("yes", "d-yes");
      meanwhile();

      old.resolve({
        kind: "answered",
        response: { outcome: "settled", code: null },
      });
      await old.promise;

      expect(h.latest().text).toBe("Sent: allowed.");
      expect(h.latest().delegationId).toBe(expected);
    },
  );
});

describe("matchCardChoice", () => {
  const BRANCHES = ["main", "release/2.1", "hotfix"];
  const APPROVE = ["Allow", "Deny"];

  it.each([
    ["the second one", "agent-question", BRANCHES, option(1, "release/2.1")],
    ["option 3", "agent-question", BRANCHES, option(2, "hotfix")],
    ["Second.", "agent-question", BRANCHES, option(1, "release/2.1")],
    ["option one", "agent-question", BRANCHES, option(0, "main")],
    ["Release 2.1!", "agent-question", BRANCHES, option(1, "release/2.1")],
    ["HOTFIX", "agent-question", BRANCHES, option(2, "hotfix")],
    ["skip it", "bot-question", BRANCHES, { kind: "skip" }],
    ["approve", "approval", APPROVE, option(0, "Allow")],
    ["deny it please", "approval", APPROVE, option(1, "Deny")],
    ["reject the request", "approval", APPROVE, option(1, "Deny")],
    ["skip", "approval", APPROVE, null],
    ["the fourth one", "agent-question", BRANCHES, null],
    ["option 9", "agent-question", BRANCHES, null],
    ["yes", "agent-question", BRANCHES, null],
    ["use my own branch", "agent-question", BRANCHES, null],
    ["", "agent-question", BRANCHES, null],
  ] as const)("%j on a %s card", (text, family, choices, expected) => {
    expect(matchCardChoice(text, family, choices)).toEqual(expected);
  });
});

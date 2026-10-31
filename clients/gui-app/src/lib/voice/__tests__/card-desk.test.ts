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
  createCardDesk,
  matchCardChoice,
  type CardApi,
  type CardContent,
  type CardDesk,
  type CardFacts,
} from "../card-desk";
import {
  OUTPUT_HANGOVER_MS,
  createSpeechScheduler,
  type SpeechItem,
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

let wordsCount = 0;

/** The person's words reach the card as the say loop hands them over. */
function speakTo(cardDesk: CardDesk, text: string): "handled" | "route" {
  useVoiceSessionStore.getState().appendInputSegment(text, 0);
  wordsCount += 1;
  const words = useVoiceSessionStore
    .getState()
    .reserveOpenSpan(`words:${wordsCount}`);
  if (words === null) throw new Error("no open words");
  const verdict = cardDesk.answer(words, "d-words");
  // Words the card takes are spent; words routed elsewhere are spent by the request they start.
  useVoiceSessionStore.getState().consumeReservation(words.seqs);
  return verdict;
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
  readonly heard: (item: SpeechItem) => void;
  /** The newest thing the voice was given to say. */
  readonly latest: () => SpeechItem;
  /** The person's words reach the card as the say loop hands them over. */
  readonly say: (text: string) => "handled" | "route";
  /** The card is opened, its list read back and heard: the person's turn. */
  readonly listen: () => SpeechItem;
  /** A choice named and its read-back heard: a yes is next. */
  readonly candidate: (choiceWords: string) => SpeechItem;
  /** The router's answer, routed against the card as it stands now. */
  readonly route: (choice: number | null, text: string) => boolean;
  /** Words routed elsewhere, against the card as it stands now. */
  readonly drop: () => void;
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
  const heard = (item: SpeechItem): void => {
    item.onDelivered?.();
  };
  const latest = (): SpeechItem => {
    const item = spoken.at(-1);
    if (item === undefined) throw new Error("nothing was spoken");
    return item;
  };
  const say = (text: string): "handled" | "route" => speakTo(cardDesk, text);
  const listen = (): SpeechItem => {
    cardDesk.open(ITEM, "d-open");
    deliver();
    const list = latest();
    heard(list);
    return list;
  };
  const candidate = (choiceWords: string): SpeechItem => {
    say(choiceWords);
    const item = latest();
    heard(item);
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
    listen,
    candidate,
    route: (choice, text) =>
      cardDesk.answerRouted(choice, text, "d-routed", currentKey()),
    drop: () => cardDesk.dropCandidate(currentKey()),
    card: () => useVoiceSessionStore.getState().activeCard,
    texts: () => spoken.map((item) => item.text),
  };
}

/** Words said, then handed over only once `before` ran: what a late boundary delivers. */
function sayLate(
  h: Harness,
  text: string,
  before: () => void,
): "handled" | "route" {
  useVoiceSessionStore.getState().appendInputSegment(text, 0);
  before();
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

  it("chooses nothing from words said while it played but handed over after it was heard", () => {
    const h = setup(BOT_QUESTION);
    h.desk.open(ITEM, "d-open");
    h.deliver();
    const list = h.latest();

    expect(sayLate(h, "Production", () => h.heard(list))).toBe("handled");

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

  it("lapses when the person says nothing for the answer window", () => {
    const h = setup(BOT_QUESTION);
    h.listen();

    h.advance(CARD_ANSWER_WINDOW_MS);

    expect(h.card()).toBeNull();
    expect(h.desk.awaitsAnswer()).toBe(false);
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
  });
});

describe("a yes", () => {
  it("sends the candidate only once the read-back that offered it was heard", () => {
    const h = setup(BOT_QUESTION);
    h.listen();
    h.say("Production");
    const readBack = h.latest();
    expect(readBack.text).toContain('"Production" as your answer');
    expect(readBack.text).toContain("Say yes to send it, or no.");

    // Said while the read-back plays.
    expect(h.say("yes")).toBe("handled");
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();

    // Said before it was heard but handed over after.
    expect(sayLate(h, "yes", () => h.heard(readBack))).toBe("handled");
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();

    h.say("yes");
    expect(h.api.answerBotQuestion).toHaveBeenCalledTimes(1);
  });

  it("sends nothing with no candidate: the voice asks which one", () => {
    const h = setup(BOT_QUESTION);
    h.listen();

    expect(h.say("yes")).toBe("handled");

    expect(h.texts().at(-1)).toBe(CARD_WHICH_TEXT);
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
    expect(h.card()?.state).toBe("proposed");
  });

  it("is declined by a no: the card closes and nothing is sent", () => {
    const h = setup(BOT_QUESTION);
    h.listen();
    h.candidate("Staging");

    h.say("no");

    expect(h.texts().at(-1)).toBe(CARD_DECLINED_TEXT);
    expect(h.card()).toBeNull();
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
  });

  it("is the candidate itself when the only choice takes no words of its own", () => {
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
    const list = h.listen();
    expect(list.text).toContain("Say yes to send it, or skip.");
    expect(h.card()?.candidate).toEqual(option(0, "Ship it"));

    h.say("yes");

    expect(h.api.answerBotQuestion).toHaveBeenCalledWith({
      text: "Ship it",
      questionIndex: 1,
      skipped: false,
    });
  });

  it("is taken as that choice when an option is literally labelled Yes", () => {
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
    h.listen();

    h.say("yes");
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
    expect(h.card()?.candidate).toEqual(option(0, "Yes"));
    expect(h.latest().text).toContain('"Yes" as your answer');

    // Said again after that read-back, the same choice is its confirmation.
    h.heard(h.latest());
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
    (reason, prefix) => {
      const h = setup(BOT_QUESTION);
      h.listen();
      h.candidate("Staging");

      h.desk.invalidate(reason);

      expect(h.latest().text.startsWith(prefix)).toBe(true);
      expect(h.latest().text).toContain('"Staging" as your answer');
      expect(h.latest().priority).toBe("ask");
      h.say("yes");
      expect(h.api.answerBotQuestion).not.toHaveBeenCalled();

      h.heard(h.latest());
      h.say("yes");
      expect(h.api.answerBotQuestion).toHaveBeenCalledWith({
        text: "Staging",
        questionIndex: 1,
        skipped: false,
      });
    },
  );

  it("takes back a candidate read-back not yet heard when the words went elsewhere", () => {
    const h = setup(BOT_QUESTION);
    h.listen();
    h.say("Staging");
    const readBack = h.latest();

    h.drop();

    expect(h.withdrawn).toEqual([readBack.id]);
    expect(h.card()?.candidate).toBeNull();
    h.say("yes");
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
  });
});

describe("the three families", () => {
  it("answers a bot's question through the send, with the row's open question index", () => {
    const h = setup(BOT_QUESTION);
    h.listen();
    h.candidate("the second one");

    h.say("yes");

    expect(h.api.answerBotQuestion).toHaveBeenCalledWith({
      text: "Production",
      questionIndex: 1,
      skipped: false,
    });
    expect(h.api.actSurface).not.toHaveBeenCalled();
  });

  it("answers a task agent's question through the surface act, never the bot's send", () => {
    const h = setup(AGENT_QUESTION);
    h.listen();
    h.candidate("release 2.1");

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

  it("walks an agent's questions one by one and sends them once, together", () => {
    const h = setup(TWO_QUESTIONS);
    h.listen();
    h.candidate("main");

    h.say("yes");

    expect(h.api.actSurface).not.toHaveBeenCalled();
    expect(h.latest().text).toContain("Question 2 of 2: Run the migration?");
    expect(h.card()).toMatchObject({
      questionIndex: 1,
      candidate: null,
      draft: [option(0, "main")],
    });

    h.heard(h.latest());
    h.candidate("hold off");
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
    (verb, approved) => {
      const h = setup(APPROVAL);
      h.listen();
      h.candidate(verb);
      expect(h.latest().text).toContain("Bash: rm -rf build");

      h.say("yes");

      expect(h.api.actSurface).toHaveBeenCalledWith(
        { kind: "decide", decision: { approved } },
        "act-1",
      );
      expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
    },
  );

  it("sends a skipped bot question as skipped, with the Skipped text", () => {
    const h = setup(BOT_QUESTION);
    h.listen();
    h.candidate("skip");
    expect(h.latest().text).toContain("Skip Release bot's question.");

    h.say("yes");

    expect(h.api.answerBotQuestion).toHaveBeenCalledWith({
      text: "Skipped",
      questionIndex: 1,
      skipped: true,
    });
  });

  it("sends a skipped agent question as a skip with no draft answers", () => {
    const h = setup(TWO_QUESTIONS);
    h.listen();
    h.candidate("main");
    h.say("yes");
    h.heard(h.latest());
    h.candidate("skip");

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

  it("is shown an approval as Allow and Deny with no Skip", () => {
    const h = setup(APPROVAL);
    h.listen();

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
    (choice, text, readBack) => {
      const h = setup(AGENT_QUESTION);
      h.listen();

      expect(h.route(choice, text)).toBe(true);

      expect(h.latest().text).toContain(readBack);
      expect(h.latest().delegationId).toBe("d-routed");
      expect(h.api.actSurface).not.toHaveBeenCalled();
    },
  );

  it("sends the person's own words as custom text once confirmed", () => {
    const h = setup(AGENT_QUESTION);
    h.listen();
    h.route(null, "use the hotfix branch");
    h.heard(h.latest());

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
  ])("asks which one for %s", (_name, content, choice, text) => {
    const h = setup(content);
    h.listen();

    expect(h.route(choice, text)).toBe(true);

    expect(h.latest().text).toBe(CARD_WHICH_TEXT);
    expect(h.card()?.candidate).toBeNull();
  });

  it("is not taken when no card waits", () => {
    const h = setup(BOT_QUESTION);

    expect(
      h.desk.answerRouted(0, "", "d-routed", { opening: 1, questionIndex: 0 }),
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
      h.listen();
      h.candidate(words);
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

      h.heard(h.latest());
      h.say("yes");

      expect(h.api.postInThread).toHaveBeenCalledWith(label);
      await vi.waitFor(() => expect(h.card()).toBeNull());
      expect(h.texts().at(-1)).toBe("Posted your answer in the thread.");
    },
  );

  it("is said as Someone when the records name nobody within the wait", async () => {
    const h = setup(AGENT_QUESTION);
    h.listen();
    h.candidate("main");
    refuseAsSettled(h, "agent-question");

    h.say("yes");
    await vi.waitFor(() => expect(h.card()?.state).toBe("refused"));
    const spokenBefore = h.spoken.length;

    h.advance(CARD_SETTLER_WAIT_MS - 1);
    expect(h.spoken).toHaveLength(spokenBefore);
    h.advance(1);

    expect(h.latest().text).toBe(settledElsewhere("Someone", "answered"));
    h.heard(h.latest());
    h.say("yes");
    expect(h.api.postInThread).toHaveBeenCalledWith("main");
  });

  it("is not claimed for a bot's send that failed while the records show the question still open", async () => {
    const h = setup(BOT_QUESTION);
    h.listen();
    h.candidate("Staging");
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
    h.listen();
    h.candidate("main");
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

  it("is said when the records show it while the person is still deciding, without sending", () => {
    const h = setup(BOT_QUESTION);
    h.listen();
    h.candidate("Staging");

    h.records.settledBy = "Dana";
    h.records.content = null;
    h.deliver();

    expect(h.latest().text).toBe(settledElsewhere("Dana", "answered"));
    expect(h.api.answerBotQuestion).not.toHaveBeenCalled();
  });

  it("is offered again when the person moves, and a yes before the new offer is heard posts nothing", async () => {
    const h = setup(BOT_QUESTION);
    h.listen();
    h.candidate("Production");
    h.records.settledBy = "Dana";
    refuseAsSettled(h, "bot-question");
    h.say("yes");
    await vi.waitFor(() =>
      expect(h.latest().text).toBe(settledElsewhere("Dana", "answered")),
    );
    const offer = h.latest();
    h.heard(offer);

    h.desk.invalidate("focus");

    expect(h.withdrawn).toEqual([offer.id]);
    expect(h.latest().text).toBe(
      "You moved, so nothing was posted. Want me to post your answer in the thread instead? Say yes or no.",
    );
    // Said over the new offer: spent by it, never routed as a request.
    expect(h.say("yes")).toBe("handled");
    expect(h.api.postInThread).not.toHaveBeenCalled();

    h.heard(h.latest());
    h.say("yes");
    expect(h.api.postInThread).toHaveBeenCalledWith("Production");
  });

  it("lets the offer go when the person says no", async () => {
    const h = setup(BOT_QUESTION);
    h.listen();
    h.candidate("Staging");
    h.records.settledBy = "Dana";
    refuseAsSettled(h, "bot-question");
    h.say("yes");
    await vi.waitFor(() => expect(h.latest().text).toContain("Dana"));
    h.heard(h.latest());

    h.say("no");

    expect(h.texts().at(-1)).toBe("Okay, nothing was posted.");
    expect(h.api.postInThread).not.toHaveBeenCalled();
    expect(h.card()).toBeNull();
  });
});

describe("an act forwarded to the task's machine", () => {
  async function forwarded(): Promise<Harness> {
    const h = setup(AGENT_QUESTION);
    h.listen();
    h.candidate("main");
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
    h.heard(h.latest());
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
  ])("is said %s and never acted on", (_name, afterCandidate) => {
    const h = setup(BOT_QUESTION);
    if (afterCandidate) {
      h.listen();
      h.candidate("Staging");
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

describe("a read-back confirmed by its first words", () => {
  it("counts as heard only once its playback is over: a yes said over the rest of it sends nothing", () => {
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
    const api: CardApi = {
      answerBotQuestion: () => Promise.resolve({ kind: "failed" }),
      actSurface,
      postInThread: () => Promise.resolve(true),
    };
    const cardDesk = createCardDesk({
      store: useVoiceSessionStore,
      speech: scheduler,
      schedule: timers.schedule,
      target: () => ({ family: "approval", ids: IDS }),
      newActionId: () => "act-1",
    });
    const speak = (words: string): void => {
      scheduler.noteOutputLevel(true);
      scheduler.noteOutputTranscript(words);
    };
    const endPlayback = (): void => {
      scheduler.noteOutputLevel(false);
      timers.advance(OUTPUT_HANGOVER_MS * 3);
    };

    cardDesk.open(ITEM, null);
    cardDesk.observe(
      ITEM,
      {
        content: APPROVAL,
        settledBy: () => null,
        gone: false,
        forwarded: () => null,
      },
      api,
    );
    speak("Bash. Allow or deny.");
    endPlayback();
    expect(scheduler.activity().outputPlaying).toBe(false);

    speakTo(cardDesk, "approve");
    expect(useVoiceSessionStore.getState().activeCard?.candidate).toEqual(
      option(0, "Allow"),
    );

    // The read-back is confirmed by its first word while the rest still plays.
    speak("Allow");
    expect(scheduler.activity().outputPlaying).toBe(true);
    speakTo(cardDesk, "yes");
    expect(actSurface).not.toHaveBeenCalled();

    endPlayback();
    expect(scheduler.activity().outputPlaying).toBe(false);
    speakTo(cardDesk, "yes");
    expect(actSurface).toHaveBeenCalledTimes(1);
    expect(actSurface).toHaveBeenCalledWith(
      { kind: "decide", decision: { approved: true } },
      "act-1",
    );
  });
});

describe("a card opened again while its act is out", () => {
  /** An approval of the first item allowed, its act pending; another card opened, then the first again. */
  function reopenedWhileOut(): {
    readonly h: Harness;
    readonly resolveAct: (response: "settled" | "forwarded") => void;
  } {
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
    h.listen();
    h.candidate("approve");
    h.say("yes");
    expect(h.api.actSurface).toHaveBeenCalledTimes(1);

    h.desk.open(OTHER_ITEM, "d-other");
    h.deliverItem(OTHER_ITEM);
    h.desk.open(ITEM, "d-again");
    h.deliver();
    return { h, resolveAct: (response) => resolveAct(response) };
  }

  it("shows that act as sending, says it is on its way, and never sends a second one", () => {
    const { h } = reopenedWhileOut();

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
      const { h, resolveAct } = reopenedWhileOut();
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
    h.listen();
    h.candidate("deny");
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
    h.heard(h.latest());
    h.say("yes");
    expect(h.api.postInThread).toHaveBeenCalledWith("Deny");
  });
});

describe("records that already carry the end of an act still out", () => {
  /** Approval denied with its act pending, and the records read meanwhile. */
  function actOutWhileRecordsRead(
    h: Harness,
    records: Pick<Records, "settledBy" | "forwarded">,
  ): () => void {
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
    h.listen();
    h.candidate("deny");
    h.say("yes");
    expect(h.card()?.state).toBe("sending");

    h.records.content = null;
    h.records.settledBy = records.settledBy;
    h.records.forwarded = records.forwarded;
    h.deliver();
    expect(h.card()?.state).toBe("sending");
    return () => forward();
  }

  it("closes the card when the call turns forwarded after the post already showed its resolution", async () => {
    const h = setup(APPROVAL);
    const forward = actOutWhileRecordsRead(h, {
      settledBy: "Alice",
      forwarded: null,
    });

    forward();

    await vi.waitFor(() => expect(h.card()).toBeNull());
  });

  it("says who decided first and offers the post when the call turns forwarded after its refusal was already recorded", async () => {
    const h = setup(APPROVAL);
    const forward = actOutWhileRecordsRead(h, {
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
    h.heard(h.latest());
    h.say("yes");
    expect(h.api.postInThread).toHaveBeenCalledWith("Deny");
  });
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

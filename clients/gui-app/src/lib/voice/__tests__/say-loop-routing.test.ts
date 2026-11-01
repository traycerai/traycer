import type {
  BotConversationSendResponse,
  BotThreadSummary,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type { OpenTextBlock } from "@traycer/protocol/persistence/epic/open-harness-records";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useVoiceSessionStore,
  type RouterCard,
  type VoiceCardDriver,
  type VoiceFocus,
} from "@/stores/voice/voice-session-store";
import {
  composeVoiceDirectory,
  tupleHolds,
  type DirectorySources,
  type BoundTarget,
  type VoiceDirectory,
} from "../directory";
import {
  CARD_STALE_ANSWER_TEXT,
  createCardDesk,
  type CardApi,
  type CardContent,
} from "../card-desk";
import { NOTHING_WAITING_NOTICE } from "../deferred-verbs";
import { resolveRoute, type RouterResult } from "../router";
import type { SpeechItem } from "../scheduler";
import { createVoiceQueue, type VoiceQueue } from "../voice-queue";
import {
  CONFIRM_ANSWER_WINDOW_MS,
  createSayLoop,
  type AskOutcome,
  type RouteRequest,
} from "../say-loop";

const NOW = 1_800_000_000_000;
const VIEWER = "user-me";
const PERSONAL = "env-personal";
const ACME = "env-acme";
const TRACY = "bot_tracy";
const CI = "bot_ci";
const RELEASE = "bot_release";
const HOSTS: ReadonlyMap<string, string> = new Map([
  [TRACY, "host-1"],
  [CI, "host-1"],
  [RELEASE, "host-2"],
]);

function environment(
  environmentId: string,
  kind: "personal" | "team",
): EnvironmentDescriptorV11 {
  return {
    environmentId,
    ownerKind: kind === "personal" ? "user" : "organization",
    ownerId: `owner-${environmentId}`,
    roomId: `room-${environmentId}`,
    label: environmentId,
    effectiveRole: kind === "personal" ? "owner" : "editor",
    kind,
    hostCount: 1,
    providerHandle: null,
  };
}

function bot(botId: string, environmentId: string): BotRecord {
  return {
    botId,
    environmentId,
    createdByUserId: VIEWER,
    title: botId,
    harness: "claude",
    model: "model-1",
    effort: null,
    profile: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId: null,
    hostEpoch: 0,
    createdAt: NOW - 1_000_000_000,
    archivedAt: null,
    directive: null,
    replyMode: "thread",
    appConversationChatId: null,
  };
}

const FOCUS_TRACY: VoiceFocus = {
  botId: TRACY,
  hostId: "host-1",
  threadId: null,
  anchorMessageId: null,
  anchorThread: null,
};

const SOURCES: DirectorySources = {
  environments: [environment(PERSONAL, "personal"), environment(ACME, "team")],
  bots: [bot(TRACY, PERSONAL), bot(CI, PERSONAL), bot(RELEASE, ACME)],
  threadsByBot: new Map(),
  followedThreads: new Set(),
  viewerUserId: VIEWER,
  focus: FOCUS_TRACY,
  queue: [],
  hostOf: (botId) => HOSTS.get(botId) ?? null,
  heldPostText: () => null,
};

const DIRECTORY: VoiceDirectory = composeVoiceDirectory(SOURCES);

function route(
  action: RouterResult["action"],
  botId: string | null,
  environmentId: string | null,
  segments: number,
): RouterResult {
  return {
    action,
    target: { environmentId, botId, threadId: null, itemId: null },
    span: { fromSegment: 0, toSegment: segments - 1 },
    uncertain: false,
    question: null,
    control: null,
    choice: null,
  };
}

/** The same route, marked as the router's guess. */
function uncertainly(result: RouterResult): RouterResult {
  return { ...result, uncertain: true };
}

const SEND_RESPONSE: BotConversationSendResponse = {
  messageId: "m-new",
  requestId: "r-1",
  delivery: "written",
  threadId: null,
};

const initial = useVoiceSessionStore.getState();

function speak(...chunks: string[]): void {
  chunks.forEach((chunk, index) => {
    useVoiceSessionStore.getState().appendInputSegment(chunk, index * 400);
  });
}

interface Wiring {
  recheckHolds: boolean;
  canSend: boolean;
}

/**
 * The say loop with the real route check against the given directory
 * ({@link DIRECTORY} or one the test composed); the model's answers are
 * queued by hand, so two routes can be out at once.
 */
function build(wiring: Wiring, directory: VoiceDirectory) {
  const sends: VoiceFocus[] = [];
  const requests: RouteRequest[] = [];
  const notices: string[] = [];
  const noticeDelegations: Array<string | null> = [];
  const navigations: BoundTarget[] = [];
  const asks: AskOutcome[] = [];
  const answers: Array<() => Promise<RouterResult>> = [];
  /** Timers the loop set, by the order it set them; run one with `.run()`. */
  const timers: Array<{ readonly ms: number; readonly run: () => void }> = [];
  const loop = createSayLoop({
    store: useVoiceSessionStore,
    send: (focus) => {
      sends.push(focus);
      return Promise.resolve(SEND_RESPONSE);
    },
    notify: (text, delegationId) => {
      notices.push(text);
      noticeDelegations.push(delegationId);
    },
    ask: (_text, _delegationId, outcome) => {
      asks.push(outcome);
      return () => undefined;
    },
    decide: async (request) => {
      requests.push(request);
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer queued");
      // The directory is read when the route is made, as the real one does.
      return resolveRoute(await next(), directory, request.segments.length);
    },
    recheck: (tuple) => wiring.recheckHolds && tupleHolds(directory, tuple),
    navigate: (target: BoundTarget) => {
      navigations.push(target);
      return Promise.resolve(true);
    },
    think: () => undefined,
    control: () => undefined,
    canSend: () => wiring.canSend,
    schedule: (fn, ms) => {
      let live = true;
      timers.push({
        ms,
        run: () => {
          if (live) fn();
        },
      });
      return () => {
        live = false;
      };
    },
    openThread: () => undefined,
    botTitle: (botId) => botId,
    onAccepted: () => undefined,
  });
  return {
    loop,
    sends,
    requests,
    notices,
    noticeDelegations,
    navigations,
    asks,
    answers,
    timers,
  };
}

/** A route the test answers when it chooses. */
function heldAnswer(): {
  readonly answer: () => Promise<RouterResult>;
  readonly release: (result: RouterResult) => void;
} {
  let release: (result: RouterResult) => void = () => undefined;
  const pending = new Promise<RouterResult>((resolve) => {
    release = resolve;
  });
  return { answer: () => pending, release: (result) => release(result) };
}

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
  useVoiceSessionStore.getState().setFocus(FOCUS_TRACY);
});

describe("a post bound to the focus while a later request navigates", () => {
  it("is never sent to where the voice moved: it is dropped, said, and its words are spent", async () => {
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
    const first = heldAnswer();
    h.answers.push(first.answer);
    h.answers.push(() => Promise.resolve(route("navigate", CI, PERSONAL, 2)));

    speak("tell", " tracy hello");
    const done = h.loop.onDelegationCreated("d-a");
    speak("go", " to CI");
    await h.loop.onDelegationCreated("d-b");
    expect(useVoiceSessionStore.getState().focus?.botId).toBe(CI);

    first.release(route("post", null, null, 2));
    await done;

    expect(h.sends).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatch(/^Nothing was posted/);
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });

  it("waiting for its channel, is dropped when the voice navigates elsewhere", async () => {
    const wiring: Wiring = { recheckHolds: true, canSend: false };
    const h = build(wiring, DIRECTORY);
    h.answers.push(() => Promise.resolve(route("post", null, null, 2)));
    h.answers.push(() => Promise.resolve(route("navigate", CI, PERSONAL, 2)));

    speak("hello", " tracy");
    await h.loop.onDelegationCreated("d-1");
    speak("go", " to CI");
    await h.loop.onDelegationCreated("d-2");
    wiring.canSend = true;
    await h.loop.onFocusResolved();

    expect(h.sends).toEqual([]);
    expect(h.notices[0]).toMatch(/^Nothing was posted/);
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });
});

describe("a confirmation", () => {
  it.each([
    ["an uncertain post", uncertainly(route("post", CI, PERSONAL, 2))],
    ["a post into another team's channel", route("post", RELEASE, ACME, 2)],
  ])(
    "for %s takes no yes said before its question was heard, and posts on one said after",
    async (_name, result) => {
      const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
      h.answers.push(() => Promise.resolve(result));

      speak("hello", " there bot");
      await h.loop.onDelegationCreated("d-1");
      expect(h.asks).toHaveLength(1);

      speak("yes");
      await h.loop.onDelegationCreated("d-2");
      expect(h.sends).toEqual([]);
      expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
        kind: "confirming",
        askState: "asking",
      });

      h.asks[0]?.onDelivered();
      expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
        kind: "confirming",
        askState: "heard",
      });
      speak("yes");
      await h.loop.onDelegationCreated("d-3");
      expect(h.sends.map((focus) => focus.botId)).toEqual([
        result.target.botId,
      ]);
    },
  );

  it("is the only one: a second route needing one while it waits is dropped and said, and the yes answers the first", async () => {
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
    const first = heldAnswer();
    const second = heldAnswer();
    h.answers.push(first.answer, second.answer);

    speak("ask", " the ci bot");
    const a = h.loop.onDelegationCreated("d-a");
    speak("tell", " the release bot");
    const b = h.loop.onDelegationCreated("d-b");
    first.release(uncertainly(route("post", CI, PERSONAL, 2)));
    await a;
    second.release(route("post", RELEASE, ACME, 2));
    await b;

    expect(h.asks).toHaveLength(1);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatch(/^Nothing was posted: an earlier post/);
    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "confirming",
      target: { botId: CI },
    });

    h.asks[0]?.onDelivered();
    speak("yes");
    await h.loop.onDelegationCreated("d-c");
    expect(h.sends.map((focus) => focus.botId)).toEqual([CI]);
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });
});

describe("a post that waited for its focus", () => {
  it("is checked again when it resumes, and refused when its target stopped holding", async () => {
    const wiring: Wiring = { recheckHolds: true, canSend: false };
    const h = build(wiring, DIRECTORY);
    h.answers.push(() => Promise.resolve(route("post", null, null, 2)));

    speak("hello", " tracy");
    await h.loop.onDelegationCreated("d-1");
    expect(h.sends).toEqual([]);

    wiring.recheckHolds = false;
    wiring.canSend = true;
    await h.loop.onFocusResolved();

    expect(h.sends).toEqual([]);
    expect(h.notices[0]).toMatch(/^Nothing was posted/);
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });
});

describe("a confirmation whose answer never closes an utterance", () => {
  it("is not answered by the next request: the held post is dropped and said, and the request routes on its own", async () => {
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    speak("hello", " ci bot");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();

    // "yes" closed no utterance; the next request arrives with it.
    speak("yes", " tell", " tracy hello");
    h.answers.push(() =>
      Promise.resolve({
        ...route("post", null, null, 3),
        span: { fromSegment: 1, toSegment: 2 },
      }),
    );
    await h.loop.onDelegationCreated("d-2");

    expect(h.sends.map((focus) => focus.botId)).toEqual([TRACY]);
    expect(h.notices).toEqual(["Okay, I did not post it."]);
    const state = useVoiceSessionStore.getState();
    expect(state.pendingAction).toBeNull();
    expect(state.segments).toEqual([]);
  });

  it("is dropped and said once the answer window after the heard question runs out", async () => {
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    speak("hello", " ci bot");
    await h.loop.onDelegationCreated("d-1");
    expect(h.timers).toEqual([]);

    h.asks[0]?.onDelivered();
    expect(h.timers.map((timer) => timer.ms)).toEqual([
      CONFIRM_ANSWER_WINDOW_MS,
    ]);
    h.timers[0]?.run();

    expect(h.sends).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatch(/^Nothing was posted: no yes came/);
    const state = useVoiceSessionStore.getState();
    expect(state.pendingAction).toBeNull();
    expect(state.segments).toEqual([]);
  });

  it("answered in time, cancels the window", async () => {
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    speak("hello", " ci bot");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();
    expect(h.timers).toHaveLength(1);
    speak("yes please");
    await h.loop.onDelegationCreated("d-2");
    h.timers[0]?.run();

    expect(h.sends.map((focus) => focus.botId)).toEqual([CI]);
    expect(h.notices).toEqual([]);
  });
});

describe("a routed verb on the queue", () => {
  /** The real voice queue under the store's driver, over a scheduler that records what it is given. */
  function liveQueue() {
    const enqueued: SpeechItem[] = [];
    const withdrawn: string[] = [];
    const queue = createVoiceQueue({
      scheduler: {
        enqueue: (item) => {
          enqueued.push(item);
        },
        withdraw: (itemId) => {
          withdrawn.push(itemId);
        },
      },
      publish: (items) => useVoiceSessionStore.getState().setQueue(items),
      botTitle: (botId) => botId,
      markRead: () => undefined,
      noteHeard: () => undefined,
      switchTo: () => undefined,
      isFocused: () => false,
      attention: () => ({
        answers: [],
        prompts: { approvals: [], questions: [] },
      }),
      onOfferHeard: () => undefined,
    });
    useVoiceSessionStore.setState({ phase: "live" });
    useVoiceSessionStore.getState().setQueueDriver({
      run: (verb) =>
        verb.kind === "status" || verb.kind === "open"
          ? "nothing"
          : queue.run(verb),
      noteSwitched: (itemId) => queue.noteSwitched(itemId),
    });
    return { queue, enqueued, withdrawn };
  }

  function routedItem(
    action: "read" | "later",
    itemId: string | null,
  ): RouterResult {
    return {
      ...route(action, null, null, 2),
      target: { environmentId: null, botId: null, threadId: null, itemId },
    };
  }

  const readOf = (itemId: string | null): RouterResult =>
    routedItem("read", itemId);

  /**
   * The live queue holding one waiting reply, `r-1` of the CI bot in
   * `threadId` (its channel for `null`), and the directory that lists it. `briefed`: it was waiting when the session
   * began; `arrived`: it came while the session ran, so it is offered.
   */
  function withWaitingItem(
    arrival: "briefed" | "arrived",
    threadId: string | null,
  ) {
    const live = liveQueue();
    const text: OpenTextBlock = {
      blockId: "block-1",
      status: "completed",
      timestamp: 1,
      parentBlockId: null,
      type: "text",
      text: "The Safari fix landed in build forty.",
      providerNotice: null,
    };
    const ref = {
      messageId: "r-1",
      botId: CI,
      threadId,
      chatId: threadId ?? "chan-ci",
      originHostId: "host-1",
      at: NOW,
      blocking: false,
    };
    if (arrival === "briefed") live.queue.begin([ref], () => "host-1");
    else live.queue.ingestReplies([ref], () => "host-1");
    live.queue.hydrated(
      "r-1",
      { role: "assistant", messageId: "r-1", blocks: [text] },
      null,
    );
    const directory = composeVoiceDirectory({
      ...SOURCES,
      queue: live.queue.items(),
    });
    return { ...live, directory };
  }

  it("reads the item it names, under the request's delegation, and posts nothing", async () => {
    const { enqueued, directory } = withWaitingItem("briefed", null);
    const h = build({ recheckHolds: true, canSend: true }, directory);
    h.answers.push(() => Promise.resolve(readOf("r-1")));

    speak("read", " it");
    await h.loop.onDelegationCreated("d-1");

    expect(enqueued.map((item) => [item.text, item.delegationId])).toEqual([
      ["bot_ci said: The Safari fix landed in build forty.", "d-1"],
    ]);
    expect(h.sends).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });

  it("does not read an item the person set aside while the route was being made", async () => {
    const { queue, enqueued, directory } = withWaitingItem("briefed", null);
    const h = build({ recheckHolds: true, canSend: true }, directory);
    const held = heldAnswer();
    h.answers.push(held.answer);

    speak("read", " it");
    const done = h.loop.onDelegationCreated("d-1");
    queue.run({ kind: "later", itemId: "r-1" });
    held.release(readOf("r-1"));
    await done;

    expect(enqueued).toEqual([]);
    expect(h.notices).toEqual([NOTHING_WAITING_NOTICE]);
    expect(h.noticeDelegations).toEqual(["d-1"]);
    expect(h.sends).toEqual([]);
  });

  it("does not set aside an item that was heard while the route was being made", async () => {
    const { queue, enqueued, directory } = withWaitingItem("briefed", null);
    const h = build({ recheckHolds: true, canSend: true }, directory);
    const held = heldAnswer();
    h.answers.push(held.answer);

    speak("put", " it off");
    const done = h.loop.onDelegationCreated("d-1");
    queue.run({ kind: "read", itemId: "r-1", delegationId: null });
    enqueued[0]?.onDelivered?.();
    expect(queue.items().map((item) => item.state)).toEqual(["heard"]);
    held.release(routedItem("later", "r-1"));
    await done;

    expect(queue.items().map((item) => item.state)).toEqual(["heard"]);
    expect(h.notices).toEqual([NOTHING_WAITING_NOTICE]);
    expect(h.noticeDelegations).toEqual(["d-1"]);
  });

  it("does not say the offer of an item the person is routed to", async () => {
    const { queue, enqueued, withdrawn, directory } = withWaitingItem(
      "arrived",
      null,
    );
    const offers = enqueued.filter((item) => item.text.endsWith("Want it?"));
    expect(offers).toHaveLength(1);
    const h = build({ recheckHolds: true, canSend: true }, directory);
    h.answers.push(() =>
      Promise.resolve({
        ...route("switch", null, null, 2),
        target: {
          environmentId: null,
          botId: null,
          threadId: null,
          itemId: "r-1",
        },
      }),
    );

    speak("go", " there");
    await h.loop.onDelegationCreated("d-1");

    expect(withdrawn).toEqual(offers.map((offer) => offer.id));
    expect(queue.items().map((item) => [item.id, item.state])).toEqual([
      ["r-1", "queued"],
    ]);
    expect(h.sends).toEqual([]);
  });

  describe("on the CI bot focused in thread A, with a reply of its in thread B only", () => {
    const FOCUS_THREAD_A: VoiceFocus = {
      botId: CI,
      hostId: "host-1",
      threadId: "thread-a",
      anchorMessageId: "msg-a",
      anchorThread: null,
    };
    const THREAD_A: BotThreadSummary = {
      threadId: "thread-a",
      conversationId: "conv-a",
      sessionChatId: "chat-a",
      anchor: {
        messageId: "msg-a",
        requestId: "req-a",
        senderUserId: VIEWER,
        sentAt: NOW - 1_000,
        resolvedAt: null,
        excerpt: null,
      },
      replyCount: 1,
      lastReplyAt: NOW - 500,
      openRequestCount: 0,
      costUsd: null,
    };

    /** The directory with the person in thread A of the CI bot, listing `queue`'s items. */
    function focusedOnThreadA(queue: VoiceQueue) {
      useVoiceSessionStore.getState().setFocus(FOCUS_THREAD_A);
      return composeVoiceDirectory({
        ...SOURCES,
        focus: FOCUS_THREAD_A,
        threadsByBot: new Map([[CI, [THREAD_A]]]),
        queue: queue.items(),
      });
    }

    function directoryOfThreadB() {
      const live = withWaitingItem("briefed", "thread-b");
      return { ...live, directory: focusedOnThreadA(live.queue) };
    }

    function readNaming(threadId: string | null): RouterResult {
      return {
        ...route("read", CI, PERSONAL, 2),
        target: {
          environmentId: PERSONAL,
          botId: CI,
          threadId,
          itemId: null,
        },
      };
    }

    it("reads the bot's reply of another thread when the route names only the bot", async () => {
      const { enqueued, directory } = directoryOfThreadB();
      const h = build({ recheckHolds: true, canSend: true }, directory);
      h.answers.push(() => Promise.resolve(readNaming(null)));

      speak("read", " ci");
      await h.loop.onDelegationCreated("d-1");

      expect(enqueued.map((item) => [item.text, item.delegationId])).toEqual([
        ["bot_ci said: The Safari fix landed in build forty.", "d-1"],
      ]);
      expect(h.notices).toEqual([]);
    });

    it("goes to the bot's channel for a channel item, not to the thread the focus is in, and does not say its offer", async () => {
      const live = withWaitingItem("arrived", null);
      const offers = live.enqueued.filter((item) =>
        item.text.endsWith("Want it?"),
      );
      expect(offers).toHaveLength(1);
      const h = build(
        { recheckHolds: true, canSend: true },
        focusedOnThreadA(live.queue),
      );
      h.answers.push(() =>
        Promise.resolve({
          ...route("switch", null, null, 2),
          target: {
            environmentId: null,
            botId: null,
            threadId: null,
            itemId: "r-1",
          },
        }),
      );

      speak("go", " there");
      await h.loop.onDelegationCreated("d-1");

      expect(
        h.navigations.map((target) => [
          target.tuple.botId,
          target.focus.threadId,
          target.focus.anchorMessageId,
          target.isFocus,
        ]),
      ).toEqual([[CI, null, null, false]]);
      expect(live.withdrawn).toEqual(offers.map((offer) => offer.id));
    });

    it("says that nothing is waiting when the route names the thread, which has none", async () => {
      const { enqueued, directory } = directoryOfThreadB();
      const h = build({ recheckHolds: true, canSend: true }, directory);
      h.answers.push(() => Promise.resolve(readNaming("thread-a")));

      speak("read", " thread a");
      await h.loop.onDelegationCreated("d-1");

      expect(enqueued).toEqual([]);
      expect(h.notices).toEqual([NOTHING_WAITING_NOTICE]);
      expect(h.noticeDelegations).toEqual(["d-1"]);
    });
  });

  it("says that nothing is waiting, under the request's delegation, when there is nothing to read", async () => {
    const { enqueued } = liveQueue();
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
    h.answers.push(() => Promise.resolve(readOf(null)));

    speak("read", " it");
    await h.loop.onDelegationCreated("d-1");

    expect(h.notices).toEqual([NOTHING_WAITING_NOTICE]);
    expect(h.noticeDelegations).toEqual(["d-1"]);
    expect(h.sends).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });
});

describe("the active card", () => {
  const CARD: RouterCard = {
    key: { opening: 4, questionIndex: 0 },
    question: "Which environment?",
    choices: ["Staging", "Production", "Skip"],
    takesText: false,
  };

  /** A card desk that waits for an answer and takes the verdict it is given. */
  function installDriver(verdict: "handled" | "route"): VoiceCardDriver {
    const driver: VoiceCardDriver = {
      open: vi.fn<VoiceCardDriver["open"]>(() => "appended"),
      awaitsAnswer: vi.fn<VoiceCardDriver["awaitsAnswer"]>(() => true),
      answer: vi.fn<VoiceCardDriver["answer"]>(() => verdict),
      answerRouted: vi.fn<VoiceCardDriver["answerRouted"]>(() => true),
      routerCard: vi.fn<VoiceCardDriver["routerCard"]>(() => CARD),
      dropCandidate: vi.fn<VoiceCardDriver["dropCandidate"]>(),
      invalidate: vi.fn<VoiceCardDriver["invalidate"]>(),
    };
    useVoiceSessionStore.getState().setCardDriver(driver);
    return driver;
  }

  it("takes the words it handles: they are never routed, posted or kept", async () => {
    const driver = installDriver("handled");
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);

    speak("the second", " one");
    await h.loop.onDelegationCreated("d-1");

    expect(driver.answer).toHaveBeenCalledTimes(1);
    const [words, delegationId] = vi.mocked(driver.answer).mock.calls[0];
    expect(words.text).toBe("the second one");
    expect(delegationId).toBe("d-1");
    expect(h.requests).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });

  it("routes the words it does not take with the card in view, and a post then drops the candidate", async () => {
    const driver = installDriver("route");
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
    h.answers.push(() => Promise.resolve(route("post", null, null, 2)));

    speak("tell", " tracy hello");
    await h.loop.onDelegationCreated("d-1");

    expect(h.requests.map((request) => request.card)).toEqual([CARD]);
    expect(h.sends.map((focus) => focus.botId)).toEqual([TRACY]);
    expect(driver.dropCandidate).toHaveBeenCalledTimes(1);
    const [key, seqs] = vi.mocked(driver.dropCandidate).mock.calls[0];
    expect(key).toEqual(CARD.key);
    expect(seqs).toHaveLength(2);
    expect(driver.answerRouted).not.toHaveBeenCalled();
  });

  it("keeps the candidate when the words routed were an unfinished request", async () => {
    const driver = installDriver("route");
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
    h.answers.push(() => Promise.resolve(route("fragment", null, null, 2)));

    speak("tell", " tracy");
    await h.loop.onDelegationCreated("d-1");

    expect(h.requests.map((request) => request.card)).toEqual([CARD]);
    expect(driver.dropCandidate).not.toHaveBeenCalled();
  });

  it("hands the router's answer to the card, with its choice and words, and posts nothing", async () => {
    const driver = installDriver("route");
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
    h.answers.push(() =>
      Promise.resolve({ ...route("answer", null, null, 2), choice: 1 }),
    );

    speak("hold", " it");
    await h.loop.onDelegationCreated("d-1");

    expect(driver.answerRouted).toHaveBeenCalledTimes(1);
    const [routed, delegationId] = vi.mocked(driver.answerRouted).mock.calls[0];
    expect(routed).toMatchObject({ choice: 1, text: "hold it", key: CARD.key });
    expect(routed.seqs).toHaveLength(2);
    expect(delegationId).toBe("d-1");
    expect(driver.dropCandidate).not.toHaveBeenCalled();
    expect(h.sends).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });

  it.each([
    ["no card waits", null],
    ["the card no longer waits", "closed"],
  ] as const)(
    "says so and posts nothing when the router answers and %s",
    async (_name, state) => {
      if (state === "closed") {
        const driver = installDriver("route");
        vi.mocked(driver.answerRouted).mockReturnValue(false);
        vi.mocked(driver.awaitsAnswer).mockReturnValue(false);
      }
      const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
      h.answers.push(() => Promise.resolve(route("answer", null, null, 2)));

      speak("the", " second one");
      await h.loop.onDelegationCreated("d-1");

      expect(h.requests.map((request) => request.card)).toEqual([null]);
      expect(h.sends).toEqual([]);
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toMatch(
        /^Nothing was sent: no question or approval/,
      );
      expect(useVoiceSessionStore.getState().segments).toEqual([]);
    },
  );

  it("leaves a card that waits for nothing out of the words' route", async () => {
    const driver = installDriver("route");
    vi.mocked(driver.awaitsAnswer).mockReturnValue(false);
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
    h.answers.push(() => Promise.resolve(route("post", null, null, 2)));

    speak("tell", " tracy hello");
    await h.loop.onDelegationCreated("d-1");

    expect(driver.answer).not.toHaveBeenCalled();
    expect(h.requests.map((request) => request.card)).toEqual([null]);
    expect(driver.dropCandidate).not.toHaveBeenCalled();
    expect(h.sends.map((focus) => focus.botId)).toEqual([TRACY]);
  });
});

describe("the card desk behind the say loop", () => {
  const APPROVAL: CardContent = {
    family: "approval",
    botTitle: "Release",
    place: "in its channel",
    questions: [],
    questionIndex: 0,
    approval: { tool: "Bash", summary: "delete production backups" },
    postText: "A task needs your approval.",
    actable: true,
  };

  /** The real desk, installed as the store's card driver, with the voice's speech captured. */
  function installDesk() {
    const spoken: SpeechItem[] = [];
    const withdrawn: string[] = [];
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
      schedule: () => () => undefined,
      target: (itemId) => ({
        family: "approval",
        ids: {
          itemId,
          botId: TRACY,
          hostId: "host-1",
          threadId: null,
          chatId: "chat-1",
          messageId: itemId,
        },
      }),
      newActionId: () => "act-1",
    });
    const actSurface = vi.fn<CardApi["actSurface"]>(() =>
      Promise.resolve({ kind: "failed" }),
    );
    const api: CardApi = {
      answerBotQuestion: () => Promise.resolve({ kind: "failed" }),
      actSurface,
      postInThread: () => Promise.resolve(true),
      canPost: true,
    };
    useVoiceSessionStore.getState().setCardDriver(cardDesk);
    return {
      spoken,
      withdrawn,
      actSurface,
      /** The card of this item is opened and its records read. */
      show: (itemId: string): void => {
        cardDesk.open(itemId, null);
        cardDesk.observe(
          itemId,
          {
            content: APPROVAL,
            settledBy: () => null,
            gone: false,
            forwarded: () => null,
          },
          api,
        );
      },
      /** The voice confirmed having said the newest thing. */
      heard: async (): Promise<void> => {
        spoken.at(-1)?.onDelivered?.();
        await Promise.resolve();
      },
    };
  }

  const activeCard = () => useVoiceSessionStore.getState().activeCard;

  it("never posts an approval said before the list was heard, and shows the router the card for other words", async () => {
    const desk = installDesk();
    desk.show("a");
    const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
    h.answers.push(() => Promise.resolve(route("post", null, null, 1)));

    speak("approve");
    await h.loop.onDelegationCreated("early");

    expect(h.requests).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(activeCard()?.candidate).toBeNull();

    speak("what is the weather");
    await h.loop.onDelegationCreated("other");

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.card).toMatchObject({
      question: "Allow or deny Bash?",
      choices: ["Allow", "Deny"],
    });
    expect(h.sends.map((focus) => focus.botId)).toEqual([TRACY]);
  });

  describe("a routed answer to words said around the list being heard", () => {
    /** The words are routed with the card shown; `heardFirst` says whether its list was heard before they were said. */
    async function routedAnswerForWords(heardFirst: boolean) {
      const desk = installDesk();
      desk.show("a");
      if (heardFirst) await desk.heard();
      const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
      const out = heldAnswer();
      h.answers.push(out.answer);
      speak("please permit that operation");
      const done = h.loop.onDelegationCreated("slow");
      expect(h.requests[0]?.card).toMatchObject({
        question: "Allow or deny Bash?",
      });
      if (!heardFirst) await desk.heard();
      const spokenBefore = desk.spoken.length;

      out.release({ ...route("answer", null, null, 1), choice: 0 });
      await done;
      return { desk, h, spokenBefore };
    }

    it("chooses nothing when the words were said while the list still played", async () => {
      const { desk, h, spokenBefore } = await routedAnswerForWords(false);

      expect(activeCard()?.candidate).toBeNull();
      expect(desk.spoken).toHaveLength(spokenBefore);
      expect(h.sends).toEqual([]);
      expect(h.notices).toEqual([]);
    });

    it("chooses the routed choice when the words were said after the list was heard", async () => {
      const { desk, h, spokenBefore } = await routedAnswerForWords(true);

      expect(activeCard()?.candidate).toEqual({
        kind: "option",
        index: 0,
        label: "Allow",
      });
      expect(desk.spoken).toHaveLength(spokenBefore + 1);
      expect(desk.spoken.at(-1)?.text).toContain("Allow Bash");
      expect(h.sends).toEqual([]);
    });
  });

  describe("a request routed while the card waited, coming back after the person made a choice", () => {
    /** The list is heard; "tell tracy hello" is routed (the answer is out), and the choice is made before or after it. */
    async function choiceAroundRoute(choiceFirst: boolean) {
      const desk = installDesk();
      desk.show("a");
      await desk.heard();
      const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
      const out = heldAnswer();
      h.answers.push(out.answer);
      const routeRequest = (): Promise<void> => {
        speak("tell tracy hello");
        return h.loop.onDelegationCreated("slow");
      };
      const choose = async (): Promise<void> => {
        speak("approve");
        await h.loop.onDelegationCreated("choose");
      };
      let done: Promise<void>;
      if (choiceFirst) {
        await choose();
        done = routeRequest();
      } else {
        done = routeRequest();
        await choose();
      }
      const readBack = desk.spoken.at(-1);
      if (readBack === undefined) throw new Error("no read-back was spoken");
      return { desk, h, out, done, readBack };
    }

    it("is ignored when it was said before the choice: the candidate and its read-back stand", async () => {
      const { desk, h, out, done } = await choiceAroundRoute(false);
      expect(activeCard()?.candidate).toMatchObject({ label: "Allow" });

      out.release(route("post", null, null, 1));
      await done;

      expect(h.sends.map((focus) => focus.botId)).toEqual([TRACY]);
      expect(activeCard()?.candidate).toMatchObject({ label: "Allow" });
      expect(desk.withdrawn).toEqual([]);

      await desk.heard();
      speak("yes");
      await h.loop.onDelegationCreated("yes");
      expect(desk.actSurface).toHaveBeenCalledTimes(1);
    });

    it("drops the candidate and takes back its read-back when it was said after the choice", async () => {
      const { desk, h, out, done, readBack } = await choiceAroundRoute(true);
      expect(activeCard()?.candidate).toMatchObject({ label: "Allow" });

      out.release(route("post", null, null, 1));
      await done;

      expect(h.sends.map((focus) => focus.botId)).toEqual([TRACY]);
      expect(activeCard()?.candidate).toBeNull();
      expect(desk.withdrawn).toEqual([readBack.id]);
    });
  });

  describe("routes made while the card waited, coming back out of order", () => {
    /** The list is heard; the card's answer to "use the first" is routed first and stays out. */
    async function olderAnswerOut(chooseExactlyFirst: boolean) {
      const desk = installDesk();
      desk.show("a");
      await desk.heard();
      const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
      if (chooseExactlyFirst) {
        speak("approve");
        await h.loop.onDelegationCreated("choose");
        expect(activeCard()?.candidate).toMatchObject({ label: "Allow" });
      }
      const older = heldAnswer();
      const newer = heldAnswer();
      h.answers.push(older.answer, newer.answer);
      speak("use the first");
      const olderDone = h.loop.onDelegationCreated("older");
      speak("tell tracy hello");
      const newerDone = h.loop.onDelegationCreated("newer");
      return { desk, h, older, newer, olderDone, newerDone };
    }

    it("never lets an older card answer choose after a newer request was routed elsewhere", async () => {
      const { desk, older, newer, olderDone, newerDone } =
        await olderAnswerOut(false);
      newer.release(route("post", null, null, 1));
      await newerDone;
      const spokenBefore = desk.spoken.length;

      older.release({ ...route("answer", null, null, 1), choice: 0 });
      await olderDone;

      expect(activeCard()?.candidate).toBeNull();
      expect(desk.spoken).toHaveLength(spokenBefore);
    });

    it("does so when the newer request dropped a candidate chosen before the older words", async () => {
      const { desk, older, newer, olderDone, newerDone } =
        await olderAnswerOut(true);
      newer.release(route("post", null, null, 1));
      await newerDone;
      expect(activeCard()?.candidate).toBeNull();
      const spokenBefore = desk.spoken.length;

      older.release({ ...route("answer", null, null, 1), choice: 1 });
      await olderDone;

      expect(activeCard()?.candidate).toBeNull();
      expect(desk.spoken).toHaveLength(spokenBefore);
    });

    it("still installs the candidate of a card answer made of words newer than the drop", async () => {
      const { desk, h, newer, newerDone } = await olderAnswerOut(false);
      newer.release(route("post", null, null, 1));
      await newerDone;
      const spokenBefore = desk.spoken.length;
      const latest = heldAnswer();
      h.answers.push(latest.answer);
      speak("use the first");
      const latestDone = h.loop.onDelegationCreated("latest");

      latest.release({ ...route("answer", null, null, 1), choice: 0 });
      await latestDone;

      expect(activeCard()?.candidate).toMatchObject({ label: "Allow" });
      expect(desk.spoken).toHaveLength(spokenBefore + 1);
    });
  });

  describe("a route made against a card that is no longer the open one", () => {
    /** A request routes against card A, still out when B is opened and heard. */
    async function routeOutWhileAnotherOpens() {
      const desk = installDesk();
      desk.show("a");
      await desk.heard();
      const h = build({ recheckHolds: true, canSend: true }, DIRECTORY);
      const out = heldAnswer();
      h.answers.push(out.answer);
      speak("please permit that operation");
      const done = h.loop.onDelegationCreated("slow");
      expect(h.requests).toHaveLength(1);
      desk.show("b");
      await desk.heard();
      return { desk, h, out, done };
    }

    it("chooses nothing on the other card when its answer arrives, and says so", async () => {
      const { desk, h, out, done } = await routeOutWhileAnotherOpens();

      out.release({ ...route("answer", null, null, 1), choice: 0 });
      await done;

      expect(activeCard()).toMatchObject({
        ids: { itemId: "b" },
        candidate: null,
      });
      expect(desk.spoken.at(-1)?.text).toBe(CARD_STALE_ANSWER_TEXT);
      expect(h.sends).toEqual([]);
    });

    it("leaves the other card's candidate alone when its words were posted", async () => {
      const { h, out, done } = await routeOutWhileAnotherOpens();
      speak("approve");
      await h.loop.onDelegationCreated("choose");
      expect(activeCard()?.candidate).toEqual({
        kind: "option",
        index: 0,
        label: "Allow",
      });

      out.release(route("post", null, null, 1));
      await done;

      expect(h.sends.map((focus) => focus.botId)).toEqual([TRACY]);
      expect(activeCard()).toMatchObject({
        ids: { itemId: "b" },
        candidate: { kind: "option", index: 0, label: "Allow" },
      });
    });
  });
});

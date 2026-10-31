import type { BotConversationSendResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import type { OpenTextBlock } from "@traycer/protocol/persistence/epic/open-harness-records";
import { beforeEach, describe, expect, it } from "vitest";
import {
  useVoiceSessionStore,
  type VoiceFocus,
} from "@/stores/voice/voice-session-store";
import {
  composeVoiceDirectory,
  tupleHolds,
  type DirectorySources,
  type BoundTarget,
  type VoiceDirectory,
} from "../directory";
import { NOTHING_WAITING_NOTICE } from "../deferred-verbs";
import { resolveRoute, type RouterResult } from "../router";
import type { SpeechItem } from "../scheduler";
import { createVoiceQueue } from "../voice-queue";
import {
  CONFIRM_ANSWER_WINDOW_MS,
  createSayLoop,
  type AskOutcome,
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
 * The say loop with the real route check against {@link DIRECTORY}; the
 * model's answers are queued by hand, so two routes can be out at once.
 */
function build(wiring: Wiring) {
  return buildFor(wiring, DIRECTORY);
}

/** {@link build} over a directory the test composed. */
function buildFor(wiring: Wiring, directory: VoiceDirectory) {
  const sends: VoiceFocus[] = [];
  const notices: string[] = [];
  const noticeDelegations: Array<string | null> = [];
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
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer queued");
      // The directory is read when the route is made, as the real one does.
      return resolveRoute(await next(), directory, request.segments.length);
    },
    recheck: (tuple) => wiring.recheckHolds && tupleHolds(directory, tuple),
    navigate: (_target: BoundTarget) => Promise.resolve(true),
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
  return { loop, sends, notices, noticeDelegations, asks, answers, timers };
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
    const h = build({ recheckHolds: true, canSend: true });
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
    const h = build(wiring);
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
      const h = build({ recheckHolds: true, canSend: true });
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
    const h = build({ recheckHolds: true, canSend: true });
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
    const h = build(wiring);
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
    const h = build({ recheckHolds: true, canSend: true });
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
    const h = build({ recheckHolds: true, canSend: true });
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
    const h = build({ recheckHolds: true, canSend: true });
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

describe("a routed read", () => {
  /** The real voice queue under the store's driver, over a scheduler that records what it is given. */
  function liveQueue() {
    const enqueued: SpeechItem[] = [];
    const queue = createVoiceQueue({
      scheduler: {
        enqueue: (item) => {
          enqueued.push(item);
        },
        withdraw: () => undefined,
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
    });
    useVoiceSessionStore.setState({ phase: "live" });
    useVoiceSessionStore.getState().setQueueDriver({
      run: (verb) => (verb.kind === "status" ? "nothing" : queue.run(verb)),
    });
    return { queue, enqueued };
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

  /** The live queue holding one waiting reply, `r-1` of the CI bot, and the directory that lists it. */
  function withWaitingItem() {
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
    live.queue.begin(
      [
        {
          messageId: "r-1",
          botId: CI,
          threadId: null,
          chatId: "chan-ci",
          originHostId: "host-1",
          at: NOW,
          blocking: false,
        },
      ],
      () => "host-1",
    );
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
    const { enqueued, directory } = withWaitingItem();
    const h = buildFor({ recheckHolds: true, canSend: true }, directory);
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
    const { queue, enqueued, directory } = withWaitingItem();
    const h = buildFor({ recheckHolds: true, canSend: true }, directory);
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
    const { queue, enqueued, directory } = withWaitingItem();
    const h = buildFor({ recheckHolds: true, canSend: true }, directory);
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

  it("says that nothing is waiting, under the request's delegation, when there is nothing to read", async () => {
    const { enqueued } = liveQueue();
    const h = build({ recheckHolds: true, canSend: true });
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

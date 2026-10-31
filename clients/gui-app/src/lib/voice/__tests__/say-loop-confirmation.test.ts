import type { BotConversationSendResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  useVoiceSessionStore,
  type VoiceFocus,
} from "@/stores/voice/voice-session-store";
import {
  composeVoiceDirectory,
  tupleHolds,
  type BoundTarget,
  type VoiceDirectory,
} from "../directory";
import { resolveRoute, type RouterResult } from "../router";
import {
  CONFIRM_ANSWER_WINDOW_MS,
  confirmationAnswer,
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

const DIRECTORY: VoiceDirectory = composeVoiceDirectory({
  environments: [environment(PERSONAL, "personal"), environment(ACME, "team")],
  bots: [bot(TRACY, PERSONAL), bot(CI, PERSONAL), bot(RELEASE, ACME)],
  threadsByBot: new Map(),
  followedThreads: new Set(),
  viewerUserId: VIEWER,
  focus: FOCUS_TRACY,
  queue: [],
  hostOf: (botId) => HOSTS.get(botId) ?? null,
  heldPostText: () => null,
});

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

/**
 * The say loop with the real route check against {@link DIRECTORY}; the
 * model's answers, the question's delivery, the answer window and the send's
 * acceptance are each released by hand.
 */
function build() {
  const sends: Array<{ focus: VoiceFocus; text: string }> = [];
  const notices: string[] = [];
  const asks: AskOutcome[] = [];
  /** The questions withdrawn, by their index in `asks`. */
  const withdrawn: number[] = [];
  const opened: string[] = [];
  const answers: Array<() => Promise<RouterResult>> = [];
  const timers: Array<{ readonly ms: number; readonly run: () => void }> = [];
  const sendGates: Array<(response: BotConversationSendResponse) => void> = [];
  let deferSends = false;
  const wiring = { recheck: true, holdNavigation: false, canSend: true };
  const navGates: Array<(landed: boolean) => void> = [];
  const loop = createSayLoop({
    store: useVoiceSessionStore,
    send: (focus, text) => {
      sends.push({ focus, text });
      if (!deferSends) return Promise.resolve(SEND_RESPONSE);
      return new Promise<BotConversationSendResponse>((resolve) => {
        sendGates.push(resolve);
      });
    },
    notify: (text) => {
      notices.push(text);
    },
    ask: (_text, _delegationId, outcome) => {
      asks.push(outcome);
      const index = asks.length - 1;
      return () => {
        withdrawn.push(index);
      };
    },
    decide: async (request) => {
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer queued");
      return resolveRoute(await next(), DIRECTORY, request.segments.length);
    },
    recheck: (tuple) => wiring.recheck && tupleHolds(DIRECTORY, tuple),
    navigate: (_target: BoundTarget) => {
      if (!wiring.holdNavigation) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        navGates.push(resolve);
      });
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
    openThread: (focus) => {
      opened.push(focus.botId);
    },
    botTitle: (botId) => botId,
    onAccepted: () => undefined,
  });
  return {
    loop,
    sends,
    notices,
    asks,
    opened,
    answers,
    timers,
    sendGates,
    wiring,
    navGates,
    withdrawn,
    deferSends: () => {
      deferSends = true;
    },
  };
}

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
  useVoiceSessionStore.getState().setFocus(FOCUS_TRACY);
});

/** Lets the loop act on what was released. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("a confirmation and a send, against the moments around them", () => {
  it("a yes said before the question was heard, with the boundary after it was heard, posts nothing", async () => {
    const h = build();
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    speak("hello", " there bot");
    await h.loop.onDelegationCreated("d-1");
    speak("yes");
    h.asks[0]?.onDelivered();
    await h.loop.onDelegationCreated("d-2");

    expect(h.sends).toEqual([]);
  });

  it("a yes left open when the answer window lapses is not sent inside the next request", async () => {
    const h = build();
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    // The spent "yes" is not among the router's segments: two remain.
    h.answers.push(() => Promise.resolve(route("post", null, null, 2)));
    speak("hello", " there bot");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();
    speak("yes");
    h.timers.find((timer) => timer.ms === CONFIRM_ANSWER_WINDOW_MS)?.run();

    speak("tell", " tracy hello");
    await h.loop.onDelegationCreated("d-2");

    expect(h.sends.map((send) => send.text)).toEqual(["tell tracy hello"]);
  });

  it("'is that okay?' to a heard question does not approve the held post", async () => {
    const h = build();
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    speak("hello", " there bot");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();
    speak("is", " that okay?");
    await h.loop.onDelegationCreated("d-2");

    expect(h.sends).toEqual([]);
  });

  it("an acceptance after the voice navigated elsewhere does not pull the focus or the rail back", async () => {
    const h = build();
    h.deferSends();
    h.answers.push(() => Promise.resolve(route("post", null, null, 2)));
    h.answers.push(() => Promise.resolve(route("navigate", CI, PERSONAL, 2)));
    speak("hello", " tracy");
    const first = h.loop.onDelegationCreated("d-a");
    await tick();
    expect(h.sends).toHaveLength(1);
    speak("go", " to CI");
    await h.loop.onDelegationCreated("d-b");
    expect(useVoiceSessionStore.getState().focus?.botId).toBe(CI);

    h.sendGates[0]?.({ ...SEND_RESPONSE, threadId: "thr-1" });
    await first;

    expect(useVoiceSessionStore.getState().focus?.botId).toBe(CI);
    expect(h.opened).toEqual([]);
    expect(h.notices).toEqual(["Posted in a thread with bot_tracy."]);
  });

  it("an old loop's answer-window timer after its session ended leaves the new session's confirmation and says nothing", async () => {
    const old = build();
    old.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    speak("hello", " there bot");
    await old.loop.onDelegationCreated("d-1");
    old.asks[0]?.onDelivered();
    const lapse = old.timers.find(
      (timer) => timer.ms === CONFIRM_ANSWER_WINDOW_MS,
    );

    useVoiceSessionStore.getState().sessionEnded("ended");
    useVoiceSessionStore.getState().sessionConnecting();
    useVoiceSessionStore.getState().setFocus(FOCUS_TRACY);
    const next = build();
    next.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    speak("hello", " again bot");
    await next.loop.onDelegationCreated("d-2");
    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "confirming",
    });

    lapse?.run();

    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "confirming",
    });
    expect(old.notices).toEqual([]);
  });
});

describe("a held post and a reply, against the words around the question", () => {
  it("a post whose navigation was held is not sent when its target stopped holding before the navigation landed", async () => {
    const h = build();
    h.wiring.holdNavigation = true;
    h.answers.push(() => Promise.resolve(route("post", CI, PERSONAL, 2)));
    speak("hello", " ci bot");
    const done = h.loop.onDelegationCreated("d-1");
    await tick();
    expect(h.navGates).toHaveLength(1);

    h.wiring.recheck = false;
    h.navGates[0]?.(true);
    await done;

    expect(h.sends).toEqual([]);
  });

  it("a genuine new request said before the question was heard drops the old held post and routes on its own", async () => {
    const h = build();
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    h.answers.push(() => Promise.resolve(route("post", null, null, 2)));
    speak("hello", " there bot");
    await h.loop.onDelegationCreated("d-1");
    speak("tell", " tracy hello");
    await h.loop.onDelegationCreated("d-2");

    expect(h.sends.map((send) => send.text)).toEqual(["tell tracy hello"]);
  });

  it("a don't said before the question was heard, with 'send it' after, does not approve the held post", async () => {
    const h = build();
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    speak("hello", " there bot");
    await h.loop.onDelegationCreated("d-1");
    speak("don't ");
    h.asks[0]?.onDelivered();
    speak("send it");
    await h.loop.onDelegationCreated("d-2");

    expect(h.sends).toEqual([]);
  });

  it("'do you post it' (no question mark) to a heard question does not approve the held post", async () => {
    const h = build();
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    speak("hello", " there bot");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();
    speak("do you post it");
    await h.loop.onDelegationCreated("d-2");

    expect(h.sends).toEqual([]);
  });
});

describe("confirmationAnswer", () => {
  it.each([
    ["Yes.", "yes"],
    ["yes please", "yes"],
    ["Okay, go ahead.", "yes"],
    ["do it", "yes"],
    ["thank you, post it", "yes"],
    ["that's right", "yes"],
    ["No.", "no"],
    ["no, don't post it", "no"],
    ["don't send it", "no"],
    ["cancel", "no"],
    ["is that okay?", "not-an-answer"],
    ["is that okay", "not-an-answer"],
    ["do you post it", "not-an-answer"],
    ["should I send it", "not-an-answer"],
    ["yes tell tracy hello", "not-an-answer"],
    ["post it to the release bot", "not-an-answer"],
    ["please", "not-an-answer"],
  ])("reads %j as %s, whole", (text, verdict) => {
    expect(confirmationAnswer(text)).toBe(verdict);
  });
});

describe("the answer window and the queue, settling what they hold", () => {
  it("an answer split around the question's delivery is spent whole when the answer window lapses, and none of it rides into the next request", async () => {
    const h = build();
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    // The next request covers every segment the router is given.
    h.answers.push(() => {
      const given = useVoiceSessionStore
        .getState()
        .segments.filter((segment) => segment.reservedBy !== null).length;
      return Promise.resolve(route("post", null, null, given));
    });
    speak("hello", " there bot");
    await h.loop.onDelegationCreated("d-1");
    speak("don't ");
    h.asks[0]?.onDelivered();
    speak("send it");
    h.timers.find((timer) => timer.ms === CONFIRM_ANSWER_WINDOW_MS)?.run();

    // The answer's fragments are spent with the dropped post.
    expect(
      useVoiceSessionStore.getState().segments.map((segment) => segment.text),
    ).toEqual([]);

    speak("tell", " tracy hello");
    await h.loop.onDelegationCreated("d-2");

    expect(h.sends.map((send) => send.text)).toEqual(["tell tracy hello"]);
  });

  it("two posts queued on a loading channel both go to the channel they bound, though the first's answer opened a thread", async () => {
    const h = build();
    h.wiring.canSend = false;
    h.deferSends();
    h.answers.push(() => Promise.resolve(route("post", null, null, 2)));
    h.answers.push(() => Promise.resolve(route("post", null, null, 2)));
    speak("first", " request");
    await h.loop.onDelegationCreated("d-1");
    speak("second", " request");
    await h.loop.onDelegationCreated("d-2");
    expect(h.sends).toEqual([]);

    h.wiring.canSend = true;
    const resumed = h.loop.onFocusResolved();
    await tick();
    expect(h.sends.map((send) => send.text)).toEqual(["first request"]);

    // The first post's answer opens a thread: the focus follows into it.
    h.sendGates[0]?.({ ...SEND_RESPONSE, threadId: "thr-1" });
    await tick();
    expect(useVoiceSessionStore.getState().focus).toMatchObject({
      botId: TRACY,
      threadId: "thr-1",
    });
    expect(h.sends.map((send) => send.text)).toEqual([
      "first request",
      "second request",
    ]);
    expect(h.sends[1]?.focus).toMatchObject({
      botId: TRACY,
      threadId: null,
      anchorMessageId: null,
    });

    h.sendGates[1]?.(SEND_RESPONSE);
    await resumed;
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });
});

describe("a confirmation that goes, and its question", () => {
  it.each([
    ["a new request in its place", "tell tracy hello"],
    ["a no", "no"],
  ])("withdraws the question on %s", async (_name, reply) => {
    const h = build();
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    h.answers.push(() => Promise.resolve(route("post", null, null, 3)));
    speak("hello", " there bot");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();
    speak(reply);
    await h.loop.onDelegationCreated("d-2");

    expect(h.withdrawn).toEqual([0]);
  });

  it("withdraws the question when the person moves", async () => {
    const h = build();
    h.answers.push(() =>
      Promise.resolve(uncertainly(route("post", CI, PERSONAL, 2))),
    );
    speak("hello", " there bot");
    await h.loop.onDelegationCreated("d-1");
    useVoiceSessionStore
      .getState()
      .selectionChanged({ ...FOCUS_TRACY, threadId: "thr-9" });
    h.loop.onSelectionChanged();

    expect(h.withdrawn).toEqual([0]);
  });
});

describe("a navigation to the focus that finishes after the voice moved", () => {
  it("is not reported as landed: it is refused and said, and the focus stays where the voice moved", async () => {
    const h = build();
    let releaseFirst: (result: RouterResult) => void = () => undefined;
    h.answers.push(
      () =>
        new Promise<RouterResult>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    h.answers.push(() => Promise.resolve(route("navigate", CI, PERSONAL, 2)));

    speak("stay", " with tracy");
    const first = h.loop.onDelegationCreated("d-a");
    speak("go", " to CI");
    await h.loop.onDelegationCreated("d-b");
    expect(useVoiceSessionStore.getState().focus?.botId).toBe(CI);

    releaseFirst(route("navigate", TRACY, PERSONAL, 2));
    await first;

    expect(useVoiceSessionStore.getState().focus?.botId).toBe(CI);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatch(
      /^Nothing was posted: that request was for where/,
    );
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });
});

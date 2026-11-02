import type { BotConversationSendResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommandItem } from "@/lib/commands/types";
import type { ActionId } from "@/lib/keybindings/actions";
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
import { EMPTY_VIEW } from "./fixtures/empty-view";
import {
  CONFIRM_ANSWER_WINDOW_MS,
  MOVED_ASK_TEXT,
  PAGE_CHANGED_ASK_TEXT,
  confirmationAnswer,
  createSayLoop,
  type AskOutcome,
} from "../say-loop";
import type { VerbOutcome } from "../deferred-verbs";
import {
  composeVoiceView,
  NO_PALETTE_ITEMS,
  type VoiceView,
  type VoiceViewRow,
} from "../view";

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
    target: {
      environmentId,
      botId,
      threadId: null,
      itemId: null,
      actionId: null,
      agentId: null,
    },
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

/**
 * The say loop with the real route check against {@link DIRECTORY}; the
 * model's answers, the question's delivery, the answer window and the send's
 * acceptance are each released by hand.
 */
function build() {
  const sends: Array<{ focus: VoiceFocus; text: string }> = [];
  const notices: string[] = [];
  const noticeDelegations: Array<string | null> = [];
  const asks: AskOutcome[] = [];
  /** What each question said and the request it was asked under, by its index in `asks`. */
  const askLog: Array<{ text: string; delegationId: string | null }> = [];
  const acts: Array<{ row: VoiceViewRow; text: string }> = [];
  const actGates: Array<(outcome: VerbOutcome) => void> = [];
  /** The questions withdrawn, by their index in `asks`. */
  const withdrawn: number[] = [];
  const opened: string[] = [];
  const answers: Array<() => Promise<RouterResult>> = [];
  const timers: Array<{ readonly ms: number; readonly run: () => void }> = [];
  const sendGates: Array<(response: BotConversationSendResponse) => void> = [];
  let deferSends = false;
  let holdActs = false;
  const wiring: {
    recheck: boolean;
    holdNavigation: boolean;
    canSend: boolean;
    /** The view the router answers against, as it was when the route was made. */
    routed: VoiceView;
    /** The view the loop reads when an act is about to run. */
    live: VoiceView;
    actOutcome: VerbOutcome;
  } = {
    recheck: true,
    holdNavigation: false,
    canSend: true,
    routed: EMPTY_VIEW,
    live: EMPTY_VIEW,
    actOutcome: { kind: "executed" },
  };
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
    notify: (text, delegationId) => {
      notices.push(text);
      noticeDelegations.push(delegationId);
    },
    ask: (text, delegationId, outcome) => {
      asks.push(outcome);
      askLog.push({ text, delegationId });
      const index = asks.length - 1;
      return () => {
        withdrawn.push(index);
      };
    },
    decide: async (request) => {
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer queued");
      return resolveRoute(
        await next(),
        DIRECTORY,
        wiring.routed,
        request.segments.length,
      );
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
    view: () => wiring.live,
    act: (row, text) => {
      acts.push({ row, text });
      if (!holdActs) return Promise.resolve(wiring.actOutcome);
      return new Promise<VerbOutcome>((resolve) => {
        actGates.push(resolve);
      });
    },
  });
  return {
    loop,
    sends,
    notices,
    noticeDelegations,
    asks,
    askLog,
    acts,
    actGates,
    holdActs: () => {
      holdActs = true;
    },
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

function paletteItem(
  id: string,
  label: string,
  actionId: ActionId | null,
): CommandItem {
  return {
    id,
    label,
    description: null,
    keywords: [],
    group: "actions",
    scope: "actions",
    shortcut: null,
    actionId,
    run: () => undefined,
    subpage: null,
  };
}

const PAGE_GENERATION = 3;

/** A task in front with an idle agent, a row that needs a yes and one that does not. */
const TASK_PAGE: VoiceView = composeVoiceView({
  page: { kind: "task", title: "Tracy Bots", tile: "Main agent" },
  agent: {
    chatId: "chat_1",
    title: "Main agent",
    state: "idle",
    waitingOn: null,
  },
  agentTurnRunning: false,
  approvals: [],
  palette: {
    ...NO_PALETTE_ITEMS,
    commands: [
      paletteItem("action:tab.close", "Close this tab", "tab.close"),
      paletteItem("action:tab.next", "Next tab", "tab.next"),
    ],
  },
  generation: PAGE_GENERATION,
});

/** The page after the person moved on: the same rows under the next generation. */
const MOVED_PAGE: VoiceView = { ...TASK_PAGE, generation: PAGE_GENERATION + 1 };

const CLOSE_QUESTION = "Close this tab: Main agent in Tracy Bots. Yes?";

/** The router chose the page action `actionId`, over the first `segments` segments. */
function actRoute(
  actionId: string,
  segments: number,
  uncertain: boolean,
): RouterResult {
  const base = route("act", null, null, segments);
  return { ...base, target: { ...base.target, actionId }, uncertain };
}

function rowOn(view: VoiceView, action: string): VoiceViewRow {
  const found = view.rows.find((row) => row.action === action);
  if (found === undefined) throw new Error(`the page has no row ${action}`);
  return found;
}

/** A loop showing {@link TASK_PAGE}, whose router has just chosen `actionId` for two segments. */
function buildOnTaskPage(actionId: string, uncertain: boolean) {
  const h = build();
  h.wiring.routed = TASK_PAGE;
  h.wiring.live = TASK_PAGE;
  h.answers.push(() => Promise.resolve(actRoute(actionId, 2, uncertain)));
  return h;
}

describe("a page action that needs a yes", () => {
  it("asks first with the row read back, runs nothing and posts nothing", async () => {
    const h = buildOnTaskPage("action:tab.close", false);

    speak("close", " this tab");
    await h.loop.onDelegationCreated("d-1");

    expect(h.askLog).toEqual([{ text: CLOSE_QUESTION, delegationId: "d-1" }]);
    expect(h.acts).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "confirming",
      target: null,
      text: "close this tab",
      delegationId: "d-1",
      askState: "asking",
    });
  });

  it("runs once on a yes said after the question was heard, spends the words and says nothing", async () => {
    const h = buildOnTaskPage("action:tab.close", false);
    speak("close", " this tab");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();

    speak("yes");
    await h.loop.onDelegationCreated("d-2");

    expect(h.acts).toEqual([
      { row: rowOn(TASK_PAGE, "action:tab.close"), text: "close this tab" },
    ]);
    expect(h.notices).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(useVoiceSessionStore.getState().focus).toEqual(FOCUS_TRACY);
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });

  it("passes the words of its span on to a row that takes them, after a yes", async () => {
    const h = buildOnTaskPage("agent.tell:chat_1", true);
    speak("tell", " it to stop");
    await h.loop.onDelegationCreated("d-1");
    expect(h.askLog.map((ask) => ask.text)).toEqual([
      "Tell the agent (Main agent) in Tracy Bots. Yes?",
    ]);
    h.asks[0]?.onDelivered();

    speak("yes");
    await h.loop.onDelegationCreated("d-2");

    expect(h.acts).toEqual([
      {
        row: rowOn(TASK_PAGE, "agent.tell:chat_1"),
        text: "tell it to stop",
      },
    ]);
    expect(h.sends).toEqual([]);
  });

  it("drops on a no: nothing runs, the voice says so, and the words are spent", async () => {
    const h = buildOnTaskPage("action:tab.close", false);
    speak("close", " this tab");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();

    speak("no");
    await h.loop.onDelegationCreated("d-2");

    expect(h.acts).toEqual([]);
    expect(h.notices).toEqual(["Okay, I did not do that."]);
    expect(h.sends).toEqual([]);
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });

  it("drops when no answer comes inside the window, and says nothing was done", async () => {
    const h = buildOnTaskPage("action:tab.close", false);
    speak("close", " this tab");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();

    h.timers.find((timer) => timer.ms === CONFIRM_ANSWER_WINDOW_MS)?.run();

    expect(h.acts).toEqual([]);
    expect(h.notices).toEqual([
      "Nothing was done: no yes came for it. The person can say it again.",
    ]);
    expect(h.noticeDelegations).toEqual(["d-1"]);
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
  });

  it("drops on words that are not an answer, and routes those words as a new request", async () => {
    const h = buildOnTaskPage("action:tab.close", false);
    h.answers.push(() =>
      Promise.resolve(actRoute("action:tab.next", 2, false)),
    );
    speak("close", " this tab");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();

    speak("go to", " the next tab");
    await h.loop.onDelegationCreated("d-2");

    expect(h.notices).toEqual(["Okay, I did not do that."]);
    expect(h.acts.map((act) => act.row.action)).toEqual(["action:tab.next"]);
  });

  it("is refused, with the earlier question left standing, while another decision waits for its yes", async () => {
    const h = build();
    h.wiring.routed = TASK_PAGE;
    h.wiring.live = TASK_PAGE;
    let releaseFirst: (result: RouterResult) => void = () => undefined;
    h.answers.push(
      () =>
        new Promise<RouterResult>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    h.answers.push(() =>
      Promise.resolve(actRoute("action:tab.close", 2, false)),
    );
    speak("close", " this tab");
    const first = h.loop.onDelegationCreated("d-1");
    speak("close", " the tab again");
    await h.loop.onDelegationCreated("d-2");
    expect(h.askLog.map((ask) => ask.delegationId)).toEqual(["d-2"]);

    releaseFirst(actRoute("action:tab.close", 2, false));
    await first;

    expect(h.notices).toEqual([
      "Nothing was done: an earlier request is still waiting for the person's yes or no. The person can say this one again after answering.",
    ]);
    expect(h.noticeDelegations).toEqual(["d-1"]);
    expect(h.askLog).toHaveLength(1);
    expect(h.acts).toEqual([]);
  });
});

describe("a page action that does not need a yes", () => {
  it("runs at once with the words of its span, says nothing, posts nothing and leaves the focus", async () => {
    const h = buildOnTaskPage("action:tab.next", false);

    speak("next", " tab");
    await h.loop.onDelegationCreated("d-1");

    expect(h.acts).toEqual([
      { row: rowOn(TASK_PAGE, "action:tab.next"), text: "next tab" },
    ]);
    expect(h.notices).toEqual([]);
    expect(h.askLog).toEqual([]);
    expect(h.sends).toEqual([]);
    expect(useVoiceSessionStore.getState().focus).toEqual(FOCUS_TRACY);
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
  });

  it.each([
    { when: "at once", needsYes: false, action: "action:tab.next" },
    { when: "after a yes", needsYes: true, action: "action:tab.close" },
  ])(
    "says a refusal the way a deferred verb does, under the request's delegation, $when",
    async ({ needsYes, action }) => {
      const h = buildOnTaskPage(action, false);
      h.wiring.actOutcome = { kind: "refused", say: "That didn't work." };
      speak("do", " it");
      await h.loop.onDelegationCreated("d-1");
      if (needsYes) {
        h.asks[0]?.onDelivered();
        speak("yes");
        await h.loop.onDelegationCreated("d-2");
      }

      expect(h.acts).toHaveLength(1);
      expect(h.notices).toEqual(["That didn't work."]);
      expect(h.noticeDelegations).toEqual(["d-1"]);
      expect(h.sends).toEqual([]);
    },
  );

  it("says nothing when it resolves after the session ended", async () => {
    const h = buildOnTaskPage("action:tab.next", false);
    h.holdActs();
    speak("next", " tab");
    const done = h.loop.onDelegationCreated("d-1");
    await tick();
    expect(h.acts).toHaveLength(1);

    useVoiceSessionStore.getState().sessionEnded("ended");
    h.actGates[0]?.({ kind: "refused", say: "That didn't work." });
    await done;

    expect(h.notices).toEqual([]);
  });
});

describe("a page action, against the page it was offered in", () => {
  const initialGeneration = useVoiceSessionStore.getState().viewGeneration;

  it.each([
    { name: "that needs a yes", action: "action:tab.close" },
    { name: "that does not", action: "action:tab.next" },
  ])(
    "an act $name is dropped when the page moved while the route was out: its words are held and the voice asks again",
    async ({ action }) => {
      const h = buildOnTaskPage(action, false);
      // The page moves; the store's own counter does not.
      h.wiring.live = MOVED_PAGE;

      speak("do", " that");
      await h.loop.onDelegationCreated("d-1");

      expect(h.acts).toEqual([]);
      expect(h.sends).toEqual([]);
      expect(h.askLog).toEqual([
        { text: PAGE_CHANGED_ASK_TEXT, delegationId: "d-1" },
      ]);
      expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
        kind: "interrupted",
        text: "do that",
        askState: "asking",
      });
      expect(useVoiceSessionStore.getState().viewGeneration).toBe(
        initialGeneration,
      );
    },
  );

  it("drops a yes' act when the page moved between the question and the yes: the yes is consumed and the voice asks again", async () => {
    const h = buildOnTaskPage("action:tab.close", false);
    speak("close", " this tab");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();
    h.wiring.live = MOVED_PAGE;

    speak("yes");
    await h.loop.onDelegationCreated("d-2");

    expect(h.acts).toEqual([]);
    expect(h.askLog.map((ask) => ask.text)).toEqual([
      CLOSE_QUESTION,
      PAGE_CHANGED_ASK_TEXT,
    ]);
    expect(h.askLog.at(1)?.delegationId).toBe("d-1");
    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "interrupted",
      text: "close this tab",
      askState: "asking",
    });
    expect(
      useVoiceSessionStore.getState().segments.map((segment) => segment.text),
    ).toEqual([]);
  });

  it("is released like a post when the person moves by hand while it waits for its yes", async () => {
    const h = buildOnTaskPage("action:tab.close", false);
    speak("close", " this tab");
    await h.loop.onDelegationCreated("d-1");
    h.asks[0]?.onDelivered();

    useVoiceSessionStore
      .getState()
      .selectionChanged({ ...FOCUS_TRACY, threadId: "thr-9" });
    h.loop.onSelectionChanged();

    expect(h.withdrawn).toEqual([0]);
    expect(h.askLog.at(1)?.text).toBe(MOVED_ASK_TEXT);
    expect(h.acts).toEqual([]);
    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "interrupted",
      text: "close this tab",
    });
  });
});

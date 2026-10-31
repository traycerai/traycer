import type { BotConversationSendResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import { beforeEach, describe, expect, it } from "vitest";
import {
  useVoiceSessionStore,
  type VoiceFocus,
} from "@/stores/voice/voice-session-store";
import { requestIdAnsweredIn, type ReplyRow } from "../focused-replies";
import {
  MOVED_ASK_TEXT,
  createSayLoop,
  type AcceptedRequest,
  type AskOutcome,
  type ReplyPlace,
  type SayLoop,
} from "../say-loop";

const FOCUS: VoiceFocus = {
  botId: "bot-1",
  hostId: "host-1",
  threadId: "thread-0",
  anchorMessageId: "msg-0",
  anchorThread: null,
};
const OTHER_FOCUS: VoiceFocus = { ...FOCUS, threadId: "thread-9" };

const initial = useVoiceSessionStore.getState();

interface Harness {
  readonly sends: Array<{ focus: VoiceFocus; text: string }>;
  readonly notices: string[];
  readonly noticeDelegations: Array<string | null>;
  readonly asks: string[];
  /** The outcome handed with each ask, in order. */
  readonly outcomes: AskOutcome[];
  readonly accepted: AcceptedRequest[];
  readonly opened: BotConversationSendResponse[];
  readonly loop: SayLoop;
  /** Settles the send at `index` (the oldest by default). */
  resolve(response: BotConversationSendResponse, index: number): void;
  reject(index: number): void;
}

function response(
  overrides: Partial<BotConversationSendResponse>,
): BotConversationSendResponse {
  return {
    messageId: "m-1",
    requestId: "r-1",
    delivery: "written",
    threadId: "thread-1",
    ...overrides,
  };
}

function placeOf(
  threadId: string | null,
  requestId: string | null,
): ReplyPlace {
  return {
    botId: FOCUS.botId,
    hostId: FOCUS.hostId,
    threadId,
    requestId,
  };
}

function harness(): Harness {
  const sends: Harness["sends"] = [];
  const notices: string[] = [];
  const noticeDelegations: Array<string | null> = [];
  const asks: string[] = [];
  const outcomes: AskOutcome[] = [];
  const accepted: AcceptedRequest[] = [];
  const opened: BotConversationSendResponse[] = [];
  const settles: Array<{
    resolve: (value: BotConversationSendResponse) => void;
    reject: (reason: Error) => void;
  }> = [];
  const loop = createSayLoop({
    store: useVoiceSessionStore,
    send: (focus, text) => {
      sends.push({ focus, text });
      return new Promise((resolve, reject) => {
        settles.push({ resolve, reject });
      });
    },
    notify: (text, delegationId) => {
      notices.push(text);
      noticeDelegations.push(delegationId);
    },
    ask: (text, outcome) => {
      asks.push(text);
      outcomes.push(outcome);
    },
    openThread: (_focus, answer) => opened.push(answer),
    botTitle: () => "Tracy",
    onAccepted: (request) => accepted.push(request),
  });
  return {
    sends,
    notices,
    noticeDelegations,
    asks,
    outcomes,
    accepted,
    opened,
    loop,
    resolve: (value, index) => settles[index]?.resolve(value),
    reject: (index) => settles[index]?.reject(new Error("refused")),
  };
}

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
  const store = useVoiceSessionStore.getState();
  store.setFocus(FOCUS);
  store.appendInputSegment("please check", 1);
  store.appendInputSegment(" the build", 2);
});

describe("a delegation", () => {
  it("posts the joined span once into the focused thread and consumes it, keeping the thread's anchor and rail", async () => {
    const h = harness();
    const done = h.loop.onDelegationCreated("d-1");
    h.resolve(response({ threadId: FOCUS.threadId }), 0);
    await done;

    expect(h.sends).toEqual([{ focus: FOCUS, text: "please check the build" }]);
    const state = useVoiceSessionStore.getState();
    expect(state.segments).toEqual([]);
    expect(state.pendingDelegationId).toBeNull();
    // The follow-up is not the thread's opening post: adopting it as the
    // anchor would rebuild the rail around it.
    expect(state.focus).toEqual(FOCUS);
    expect(h.opened).toEqual([]);
    expect(h.accepted).toEqual([
      {
        requestId: "r-1",
        botId: FOCUS.botId,
        hostId: FOCUS.hostId,
        threadId: "thread-0",
      },
    ]);
  });

  it("from the channel adopts the thread its post opened, by that post, and opens the rail on it", async () => {
    const h = harness();
    useVoiceSessionStore
      .getState()
      .setFocus({ ...FOCUS, threadId: null, anchorMessageId: null });
    const done = h.loop.onDelegationCreated("d-1");
    h.resolve(response({ messageId: "m-7", threadId: "thread-7" }), 0);
    await done;

    expect(useVoiceSessionStore.getState().focus).toEqual({
      ...FOCUS,
      threadId: "thread-7",
      anchorMessageId: "m-7",
    });
    expect(h.opened.map((answer) => answer.threadId)).toEqual(["thread-7"]);
  });

  it("under a row nobody has replied under follows the thread the reply landed in by that row, rail untouched, as a thread joined, not proven new", async () => {
    const h = harness();
    const unopened: VoiceFocus = {
      ...FOCUS,
      threadId: null,
      anchorMessageId: "q-1",
      anchorThread: "unopened",
    };
    useVoiceSessionStore.getState().setFocus(unopened);
    const done = h.loop.onDelegationCreated("d-1");
    h.resolve(response({ messageId: "m-7", threadId: "thread-q" }), 0);
    await done;

    expect(h.sends).toEqual([
      { focus: unopened, text: "please check the build" },
    ]);
    expect(useVoiceSessionStore.getState().focus).toEqual({
      ...unopened,
      threadId: "thread-q",
      anchorThread: null,
    });
    expect(h.opened).toEqual([]);
    // The list may have been behind on a thread under the row: its history
    // is not this request's answer.
    expect(h.loop.awaitedIn("thread-q")).toBe("joined");
    expect(h.loop.isAwaiting("r-1")).toBe(true);
  });
});

describe("a request closed while the anchor's thread is unresolved", () => {
  const RESOLVING: VoiceFocus = {
    ...FOCUS,
    threadId: null,
    anchorMessageId: "q-1",
    anchorThread: "resolving",
  };

  it("holds its words as its own and posts them under its delegation once the list says where; a later request keeps its own", async () => {
    const h = harness();
    const store = useVoiceSessionStore.getState();
    store.setFocus(RESOLVING);
    await h.loop.onDelegationCreated("d-1");
    expect(h.sends).toEqual([]);
    expect(store.openSpan()).toBe("");
    expect(useVoiceSessionStore.getState().pendingDelegationId).toBe("d-1");
    store.appendInputSegment(" and the tests", 3);
    await h.loop.onDelegationCreated("d-2");
    expect(h.sends).toEqual([]);

    const resolved: VoiceFocus = {
      ...RESOLVING,
      threadId: "thread-q",
      anchorThread: null,
    };
    store.setFocus(resolved);
    const resumed = h.loop.onFocusResolved();
    expect(h.sends).toEqual([
      { focus: resolved, text: "please check the build" },
    ]);
    h.resolve(response({ threadId: "thread-q" }), 0);
    await new Promise((settle) => setTimeout(settle, 0));
    expect(h.sends.map((send) => send.text)).toEqual([
      "please check the build",
      "and the tests",
    ]);
    h.resolve(
      response({ messageId: "m-2", requestId: "r-2", threadId: "thread-q" }),
      1,
    );
    await resumed;

    const after = useVoiceSessionStore.getState();
    expect(after.segments).toEqual([]);
    expect(after.pendingDelegationId).toBeNull();
    expect(after.focus).toEqual(resolved);
    expect(h.loop.placementFor(placeOf("thread-q", "r-1"))).toEqual({
      kind: "placed",
      delegationId: "d-1",
    });
    expect(h.loop.placementFor(placeOf("thread-q", "r-2"))).toEqual({
      kind: "placed",
      delegationId: "d-2",
    });
    expect(await h.loop.onFocusResolved()).toBeUndefined();
    expect(h.sends).toHaveLength(2);
  });

  it("is interrupted by a move like open words, and the resolution afterwards posts nothing", async () => {
    const h = harness();
    const store = useVoiceSessionStore.getState();
    store.setFocus(RESOLVING);
    await h.loop.onDelegationCreated("d-1");

    store.selectionChanged(OTHER_FOCUS);
    h.loop.onSelectionChanged();

    expect(h.asks).toEqual([MOVED_ASK_TEXT]);
    expect(useVoiceSessionStore.getState().pendingAction).toMatchObject({
      kind: "interrupted",
      text: "please check the build",
      delegationId: "d-1",
    });
    expect(useVoiceSessionStore.getState().segments).toEqual([]);

    store.setFocus({ ...RESOLVING, threadId: "thread-q", anchorThread: null });
    await h.loop.onFocusResolved();
    expect(h.sends).toEqual([]);
  });

  it("says a queued delivery as queued, never paused", async () => {
    const h = harness();
    const done = h.loop.onDelegationCreated("d-1");
    h.resolve(response({ delivery: "queued" }), 0);
    await done;

    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("queued");
    expect(h.notices[0]).not.toContain("paused");
  });

  it("does not reopen the rail when the person moved during the send, and says where it landed", async () => {
    const h = harness();
    const done = h.loop.onDelegationCreated("d-1");
    useVoiceSessionStore.getState().selectionChanged(OTHER_FOCUS);
    h.resolve(response({}), 0);
    await done;

    expect(h.opened).toEqual([]);
    expect(useVoiceSessionStore.getState().focus).toEqual(OTHER_FOCUS);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("a thread with Tracy");
  });

  it("covers moved and queued in one notice", async () => {
    const h = harness();
    const done = h.loop.onDelegationCreated("d-1");
    useVoiceSessionStore.getState().selectionChanged(OTHER_FOCUS);
    h.resolve(response({ delivery: "queued" }), 0);
    await done;

    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("moved");
    expect(h.notices[0]).toContain("queued");
    expect(h.notices[0]).not.toContain("paused");
  });

  it("clears the pending delegation on a rejected send, consumes only its own words and notifies once", async () => {
    const h = harness();
    const done = h.loop.onDelegationCreated("d-1");
    h.reject(0);
    await done;

    const state = useVoiceSessionStore.getState();
    expect(state.pendingDelegationId).toBeNull();
    expect(state.segments).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });
});

describe("two delegations before any acceptance", () => {
  it("posts each its own words, and an acceptance consumes only its own reservation", async () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting();
    useVoiceSessionStore.setState({ segments: [] });
    store.setFocus(FOCUS);
    const h = harness();
    store.appendInputSegment("Check build A.", 1);
    const first = h.loop.onDelegationCreated("d-1");
    store.appendInputSegment(" Then check build B.", 2);
    const second = h.loop.onDelegationCreated("d-2");

    expect(h.sends.map((send) => send.text)).toEqual([
      "Check build A.",
      "Then check build B.",
    ]);
    expect(h.loop.inFlightCount()).toBe(2);

    h.resolve(response({ requestId: "r-a", threadId: null }), 0);
    await first;
    expect(
      useVoiceSessionStore.getState().segments.map((s) => s.reservedBy),
    ).toEqual([`1:1:d-2`]);

    h.resolve(response({ requestId: "r-b", threadId: null }), 1);
    await second;
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });

  it("a failed first send consumes only its own words", async () => {
    const store = useVoiceSessionStore.getState();
    store.sessionConnecting();
    useVoiceSessionStore.setState({ segments: [] });
    store.setFocus(FOCUS);
    const h = harness();
    store.appendInputSegment("Check build A.", 1);
    const first = h.loop.onDelegationCreated("d-1");
    store.appendInputSegment(" Then check build B.", 2);
    void h.loop.onDelegationCreated("d-2");

    h.reject(0);
    await first;

    const segments = useVoiceSessionStore.getState().segments;
    expect(segments.map((s) => s.text)).toEqual([" Then check build B."]);
    expect(segments[0]?.reservedBy).toBe("1:1:d-2");
  });
});

describe("a selection change mid-utterance", () => {
  it("keeps a delegation after the ask from posting the held words", async () => {
    const h = harness();
    useVoiceSessionStore.getState().appendInputSegment(".", 3);
    useVoiceSessionStore.getState().selectionChanged(OTHER_FOCUS);
    h.loop.onSelectionChanged();

    expect(h.asks).toEqual([MOVED_ASK_TEXT]);
    const pending = useVoiceSessionStore.getState().pendingAction;
    expect(pending?.kind).toBe("interrupted");
    expect(pending?.text).toBe("please check the build.");
    expect(useVoiceSessionStore.getState().openSpan()).toBe("");

    await h.loop.onDelegationCreated("d-1");

    expect(h.sends).toEqual([]);
    expect(h.asks).toEqual([MOVED_ASK_TEXT]);
    expect(useVoiceSessionStore.getState().pendingAction?.text).toBe(
      "please check the build.",
    );
  });

  it("asks nothing when there are no open words", () => {
    const h = harness();
    useVoiceSessionStore.getState().dropOpenSpan();
    h.loop.onSelectionChanged();

    expect(h.asks).toEqual([]);
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
  });

  it("lets an in-flight send land as moved while the next delegation posts only its new words", async () => {
    const h = harness();
    const first = h.loop.onDelegationCreated("d-1");
    useVoiceSessionStore.getState().selectionChanged(OTHER_FOCUS);
    h.loop.onSelectionChanged();
    // Everything open was already reserved by the first send.
    expect(h.asks).toEqual([]);

    useVoiceSessionStore.getState().appendInputSegment("Now do this.", 3);
    const second = h.loop.onDelegationCreated("d-2");
    expect(h.sends.map((send) => send.text)).toEqual([
      "please check the build",
      "Now do this.",
    ]);

    h.resolve(response({ requestId: "r-1" }), 0);
    await first;
    expect(h.opened).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("before the person moved on");

    h.resolve(response({ requestId: "r-2", threadId: null }), 1);
    await second;
  });

  it("drops open words after a send began, asks once, closes the heard interruption at the next boundary and posts only the one after", async () => {
    const h = harness();
    const first = h.loop.onDelegationCreated("d-1");
    useVoiceSessionStore.getState().appendInputSegment("Delete the branch.", 3);
    useVoiceSessionStore.getState().selectionChanged(OTHER_FOCUS);
    h.loop.onSelectionChanged();

    expect(h.asks).toEqual([MOVED_ASK_TEXT]);
    h.outcomes[0]?.onDelivered();

    await h.loop.onDelegationCreated("d-2");
    expect(h.sends.map((send) => send.text)).toEqual([
      "please check the build",
    ]);

    useVoiceSessionStore.getState().appendInputSegment("Fresh words.", 4);
    const third = h.loop.onDelegationCreated("d-3");
    expect(h.sends.map((send) => send.text)).toEqual([
      "please check the build",
      "Fresh words.",
    ]);

    h.resolve(response({ requestId: "r-1" }), 0);
    await first;
    expect(h.opened).toEqual([]);
    expect(h.notices.join(" ")).toContain("before the person moved on");
    h.resolve(response({ requestId: "r-2", threadId: null }), 1);
    await third;
  });
});

describe("a session that ended or was replaced during a send", () => {
  it("changes nothing when it ended, and the request binding is void", async () => {
    const h = harness();
    useVoiceSessionStore.getState().sessionConnecting();
    useVoiceSessionStore.getState().setFocus(FOCUS);
    useVoiceSessionStore.getState().appendInputSegment("old words", 1);
    const done = h.loop.onDelegationCreated("d-1");
    useVoiceSessionStore.getState().sessionEnded(null);

    h.resolve(response({ requestId: "r-1" }), 0);
    await done;

    const state = useVoiceSessionStore.getState();
    expect(state.focus).toBeNull();
    expect(state.phase).toBe("idle");
    expect(h.opened).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.loop.placementFor(placeOf(null, "r-1"))).toEqual({
      kind: "pending",
    });
  });

  it("spends only its own reserved words when the session was replaced, leaving newer open words", async () => {
    const h = harness();
    useVoiceSessionStore.getState().sessionConnecting();
    useVoiceSessionStore.getState().setFocus(FOCUS);
    useVoiceSessionStore.getState().appendInputSegment("old words", 1);
    const done = h.loop.onDelegationCreated("d-1");
    useVoiceSessionStore.getState().sessionConnecting();
    useVoiceSessionStore.getState().appendInputSegment("new words", 2);

    h.resolve(response({ requestId: "r-1" }), 0);
    await done;

    const state = useVoiceSessionStore.getState();
    expect(state.openSpan()).toBe("new words");
    expect(state.segments).toHaveLength(1);
    expect(h.opened).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.loop.placementFor(placeOf(null, "r-1"))).toEqual({
      kind: "pending",
    });
  });
});

describe("placementFor", () => {
  it("returns the bound delegation once, then null", async () => {
    const h = harness();
    useVoiceSessionStore.getState().sessionConnecting();
    useVoiceSessionStore.getState().setFocus(FOCUS);
    useVoiceSessionStore.getState().appendInputSegment("hello", 1);
    const done = h.loop.onDelegationCreated("d-7");
    h.resolve(response({ requestId: "r-7", messageId: "u-7" }), 0);
    await done;

    const rows: ReadonlyArray<ReplyRow> = [
      {
        role: "user",
        messageId: "u-7",
        timestamp: 1,
        conversationRequest: {
          requestId: "r-7",
          resolvedAt: 2,
          resolvedByMessageId: "a-7",
        },
      },
    ];
    const requestId = requestIdAnsweredIn(
      { threadRows: [], channelRows: rows },
      "a-7",
    );
    expect(requestId).toBe("r-7");
    expect(h.loop.placementFor(placeOf(null, requestId))).toEqual({
      kind: "placed",
      delegationId: "d-7",
    });
    expect(h.loop.placementFor(placeOf(null, requestId))).toEqual({
      kind: "pending",
    });
  });

  it("finds the delegation by the thread an accepted post opened, once, before the records name the request", async () => {
    const h = harness();
    useVoiceSessionStore
      .getState()
      .setFocus({ ...FOCUS, threadId: null, anchorMessageId: null });
    const done = h.loop.onDelegationCreated("d-1");
    h.resolve(response({ threadId: "t1" }), 0);
    await done;

    expect(h.loop.awaitedIn("t1")).toBe("opened");
    expect(h.loop.placementFor(placeOf("t1", null))).toEqual({
      kind: "placed",
      delegationId: "d-1",
    });
    expect(h.loop.placementFor(placeOf("t1", null))).toEqual({
      kind: "pending",
    });
    expect(h.loop.awaitedIn("t1")).toBe("none");
  });

  it("calls a post into an existing thread joined, not opened", async () => {
    const h = harness();
    const done = h.loop.onDelegationCreated("d-1");
    h.resolve(response({ threadId: FOCUS.threadId }), 0);
    await done;

    expect(h.loop.awaitedIn("thread-0")).toBe("joined");
    expect(h.loop.isAwaiting("r-1")).toBe(true);
  });
});

describe("the interrupted utterance's continuation", () => {
  it("is consumed with the boundary that closes a heard interruption, and only the words after it post", async () => {
    const h = harness();
    useVoiceSessionStore.getState().dropOpenSpan();
    const store = useVoiceSessionStore.getState();
    store.appendInputSegment("Delete ", 1);
    store.selectionChanged(OTHER_FOCUS);
    h.loop.onSelectionChanged();
    expect(h.asks).toEqual([MOVED_ASK_TEXT]);
    store.appendInputSegment("the branch.", 2);
    h.outcomes[0]?.onDelivered();

    await h.loop.onDelegationCreated("d-1");

    expect(h.sends).toEqual([]);
    expect(h.asks).toHaveLength(1);
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
    expect(useVoiceSessionStore.getState().segments).toEqual([]);

    store.appendInputSegment("Check the build.", 3);
    const second = h.loop.onDelegationCreated("d-2");
    expect(h.sends.map((send) => send.text)).toEqual(["Check the build."]);
    h.resolve(response({ threadId: null }), 0);
    await second;
  });
});

describe("a delegation boundary handled once", () => {
  it("does nothing when the same id arrives while its send is pending, and the acceptance consumes exactly its words", async () => {
    const h = harness();
    const store = useVoiceSessionStore.getState();
    const first = h.loop.onDelegationCreated("d-1");
    store.appendInputSegment(" and newer words", 3);
    await h.loop.onDelegationCreated("d-1");

    expect(h.sends).toHaveLength(1);
    expect(
      useVoiceSessionStore.getState().segments.map((s) => s.reservedBy),
    ).toEqual(["0:0:d-1", "0:0:d-1", null]);

    h.resolve(response({ threadId: null }), 0);
    await first;

    const state = useVoiceSessionStore.getState();
    expect(state.segments.map((s) => s.text)).toEqual([" and newer words"]);
    expect(state.segments[0]?.reservedBy).toBeNull();
  });

  it("reserves nothing with no focus, and a later delegation with a focus posts the words", async () => {
    const h = harness();
    const store = useVoiceSessionStore.getState();
    store.setFocus(null);
    await h.loop.onDelegationCreated("d-1");

    expect(h.sends).toEqual([]);
    expect(
      useVoiceSessionStore.getState().segments.map((s) => s.reservedBy),
    ).toEqual([null, null]);
    expect(useVoiceSessionStore.getState().pendingDelegationId).toBeNull();

    store.setFocus(FOCUS);
    const second = h.loop.onDelegationCreated("d-2");
    expect(h.sends.map((send) => send.text)).toEqual([
      "please check the build",
    ]);
    h.resolve(response({ threadId: null }), 0);
    await second;
    expect(useVoiceSessionStore.getState().segments).toEqual([]);
  });
});

describe("an engine replacement during a send", () => {
  it("completes the acceptance as pending work: clears the delegation, opens the thread, notifies under none, and binds no delegation to the reply", async () => {
    const h = harness();
    useVoiceSessionStore.getState().sessionConnecting();
    useVoiceSessionStore
      .getState()
      .setFocus({ ...FOCUS, threadId: null, anchorMessageId: null });
    useVoiceSessionStore.getState().appendInputSegment("merge it", 1);
    const done = h.loop.onDelegationCreated("d-1");
    expect(useVoiceSessionStore.getState().pendingDelegationId).toBe("d-1");
    useVoiceSessionStore.getState().engineReplacing();
    useVoiceSessionStore.getState().appendInputSegment("later words", 2);

    h.resolve(response({ delivery: "queued", threadId: "t1" }), 0);
    await done;

    const state = useVoiceSessionStore.getState();
    expect(state.pendingDelegationId).toBeNull();
    expect(state.focus?.threadId).toBe("t1");
    expect(h.opened).toHaveLength(1);
    expect(h.noticeDelegations).toEqual([null]);
    expect(state.openSpan()).toBe("later words");
    expect(h.loop.placementFor(placeOf("t1", "r-1"))).toEqual({
      kind: "placed",
      delegationId: null,
    });
  });
});

describe("an interruption whose ask is not yet heard", () => {
  function interruptRun(h: Harness): void {
    const store = useVoiceSessionStore.getState();
    store.dropOpenSpan();
    store.appendInputSegment("Run", 10);
    store.selectionChanged(OTHER_FOCUS);
    h.loop.onSelectionChanged();
    expect(h.asks).toEqual([MOVED_ASK_TEXT]);
    expect(useVoiceSessionStore.getState().pendingAction?.askState).toBe(
      "asking",
    );
  }

  it("holds a boundary's words with the interrupted ones, and posts the next request normally once the ask is given up", async () => {
    const h = harness();
    interruptRun(h);
    const outcome = h.outcomes[0];

    useVoiceSessionStore.getState().appendInputSegment(" the new build.", 11);
    await h.loop.onDelegationCreated("d-1");

    expect(h.sends).toEqual([]);
    const held = useVoiceSessionStore.getState().pendingAction;
    expect(held?.text).toBe("Run the new build.");
    expect(held?.askState).toBe("asking");

    outcome.onGivenUp();
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();

    useVoiceSessionStore
      .getState()
      .appendInputSegment("Run the new build.", 12);
    const second = h.loop.onDelegationCreated("d-2");
    expect(h.sends.map((send) => send.text)).toEqual(["Run the new build."]);
    h.resolve(response({ threadId: null }), 0);
    await second;
  });

  it("closes the interruption at the first boundary after the ask was heard, without a send, and posts the following one", async () => {
    const h = harness();
    interruptRun(h);

    h.outcomes[0]?.onDelivered();
    expect(useVoiceSessionStore.getState().pendingAction?.askState).toBe(
      "heard",
    );

    useVoiceSessionStore.getState().appendInputSegment(" the new build.", 11);
    await h.loop.onDelegationCreated("d-1");
    expect(h.sends).toEqual([]);
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
    expect(useVoiceSessionStore.getState().segments).toEqual([]);

    useVoiceSessionStore.getState().appendInputSegment("Check the logs.", 12);
    const second = h.loop.onDelegationCreated("d-2");
    expect(h.sends.map((send) => send.text)).toEqual(["Check the logs."]);
    h.resolve(response({ threadId: null }), 0);
    await second;
  });
});

describe("an ask given up during an utterance", () => {
  it("fences the utterance under way through its boundary, then posts a fresh request", async () => {
    const h = harness();
    useVoiceSessionStore.getState().dropOpenSpan();
    const store = useVoiceSessionStore.getState();
    store.appendInputSegment("Delete ", 1);
    store.selectionChanged(OTHER_FOCUS);
    h.loop.onSelectionChanged();
    expect(h.asks).toEqual([MOVED_ASK_TEXT]);
    store.appendInputSegment("the branch.", 2);

    h.outcomes[0]?.onGivenUp();
    expect(useVoiceSessionStore.getState().pendingAction?.askState).toBe(
      "closing",
    );

    await h.loop.onDelegationCreated("d-1");
    expect(h.sends).toEqual([]);
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
    expect(useVoiceSessionStore.getState().openSpan()).toBe("");

    store.appendInputSegment("Run the build.", 3);
    const fresh = h.loop.onDelegationCreated("d-2");
    expect(h.sends.map((send) => send.text)).toEqual(["Run the build."]);
    h.resolve(response({ threadId: null }), 0);
    await fresh;
  });
});

describe("placementFor fallbacks", () => {
  it("spends nothing for a reply in an existing thread the records do not tie to a request", async () => {
    const h = harness();
    useVoiceSessionStore.getState().setFocus({ ...FOCUS, threadId: "t1" });
    const done = h.loop.onDelegationCreated("d-1");
    h.resolve(response({ requestId: "r-new", threadId: "t1" }), 0);
    await done;

    expect(h.loop.awaitedIn("t1")).toBe("joined");
    expect(h.loop.placementFor(placeOf("t1", null))).toEqual({
      kind: "pending",
    });
    expect(h.loop.placementFor(placeOf("t1", "r-new"))).toEqual({
      kind: "placed",
      delegationId: "d-1",
    });
  });

  async function acceptTopLevel(
    h: Harness,
    index: number,
    accept: {
      readonly focus: VoiceFocus;
      readonly delegationId: string;
      readonly requestId: string;
    },
  ): Promise<void> {
    const store = useVoiceSessionStore.getState();
    store.setFocus(accept.focus);
    store.appendInputSegment(`words for ${accept.delegationId}`, 20 + index);
    const done = h.loop.onDelegationCreated(accept.delegationId);
    h.resolve(response({ requestId: accept.requestId, threadId: null }), index);
    await done;
  }

  it("matches a top-level reply by bot and host, never taking another bot's binding", async () => {
    const h = harness();
    const botA: VoiceFocus = {
      ...FOCUS,
      botId: "A",
      hostId: "host-a",
      threadId: null,
    };
    const botB: VoiceFocus = { ...botA, botId: "B" };
    useVoiceSessionStore.getState().dropOpenSpan();
    await acceptTopLevel(h, 0, {
      focus: botA,
      delegationId: "d-a",
      requestId: "r-a",
    });
    await acceptTopLevel(h, 1, {
      focus: botB,
      delegationId: "d-b",
      requestId: "r-b",
    });

    const forB: ReplyPlace = {
      botId: "B",
      hostId: "host-a",
      threadId: null,
      requestId: null,
    };
    expect(h.loop.placementFor(forB)).toEqual({
      kind: "placed",
      delegationId: "d-b",
    });
    expect(h.loop.placementFor(forB)).toEqual({ kind: "pending" });
    expect(h.loop.isAwaiting("r-a")).toBe(true);
    expect(
      h.loop.placementFor({ ...forB, botId: "A", requestId: "r-a" }),
    ).toEqual({ kind: "placed", delegationId: "d-a" });
  });

  it("matches nothing when two requests of the same bot wait at the top level", async () => {
    const h = harness();
    const botA: VoiceFocus = {
      ...FOCUS,
      botId: "A",
      hostId: "host-a",
      threadId: null,
    };
    useVoiceSessionStore.getState().dropOpenSpan();
    await acceptTopLevel(h, 0, {
      focus: botA,
      delegationId: "d-1",
      requestId: "r-1",
    });
    await acceptTopLevel(h, 1, {
      focus: botA,
      delegationId: "d-2",
      requestId: "r-2",
    });

    const place: ReplyPlace = {
      botId: "A",
      hostId: "host-a",
      threadId: null,
      requestId: null,
    };
    expect(h.loop.placementFor(place)).toEqual({ kind: "pending" });
    expect(h.loop.isAwaiting("r-1")).toBe(true);
    expect(h.loop.isAwaiting("r-2")).toBe(true);
  });
});

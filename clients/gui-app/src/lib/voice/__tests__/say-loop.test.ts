import type { BotConversationSendResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import { beforeEach, describe, expect, it } from "vitest";
import {
  useVoiceSessionStore,
  type VoiceFocus,
} from "@/stores/voice/voice-session-store";
import { requestIdAnsweredBy, type ReplyRow } from "../focused-replies";
import { MOVED_ASK_TEXT, createSayLoop, type SayLoop } from "../say-loop";

const FOCUS: VoiceFocus = {
  botId: "bot-1",
  hostId: "host-1",
  threadId: "thread-0",
  anchorMessageId: "msg-0",
};
const OTHER_FOCUS: VoiceFocus = { ...FOCUS, threadId: "thread-9" };

const initial = useVoiceSessionStore.getState();

interface Harness {
  readonly sends: Array<{ focus: VoiceFocus; text: string }>;
  readonly notices: string[];
  readonly asks: string[];
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

function harness(): Harness {
  const sends: Harness["sends"] = [];
  const notices: string[] = [];
  const asks: string[] = [];
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
    notify: (text) => notices.push(text),
    ask: (text) => asks.push(text),
    openThread: (_focus, answer) => opened.push(answer),
    botTitle: () => "Tracy",
  });
  return {
    sends,
    notices,
    asks,
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
  it("posts the joined span once to the focus, consumes it and follows the new thread", async () => {
    const h = harness();
    const done = h.loop.onDelegationCreated("d-1");
    h.resolve(response({}), 0);
    await done;

    expect(h.sends).toEqual([{ focus: FOCUS, text: "please check the build" }]);
    const state = useVoiceSessionStore.getState();
    expect(state.segments).toEqual([]);
    expect(state.pendingDelegationId).toBeNull();
    expect(state.focus).toEqual({
      ...FOCUS,
      threadId: "thread-1",
      anchorMessageId: "m-1",
    });
    expect(h.opened).toHaveLength(1);
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
    ).toEqual([`1:d-2`]);

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
    expect(segments[0]?.reservedBy).toBe("1:d-2");
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
    expect(useVoiceSessionStore.getState().pendingAction).toBeNull();
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

  it("drops open words after a send began, asks once, and the next delegation posts only its own", async () => {
    const h = harness();
    const first = h.loop.onDelegationCreated("d-1");
    useVoiceSessionStore.getState().appendInputSegment("Delete the branch.", 3);
    useVoiceSessionStore.getState().selectionChanged(OTHER_FOCUS);
    h.loop.onSelectionChanged();

    expect(h.asks).toEqual([MOVED_ASK_TEXT]);

    useVoiceSessionStore.getState().appendInputSegment("Fresh words.", 4);
    const second = h.loop.onDelegationCreated("d-2");
    expect(h.sends.map((send) => send.text)).toEqual([
      "please check the build",
      "Fresh words.",
    ]);

    h.resolve(response({ requestId: "r-1" }), 0);
    await first;
    expect(h.opened).toEqual([]);
    expect(h.notices.join(" ")).toContain("before the person moved on");
    h.resolve(response({ requestId: "r-2", threadId: null }), 1);
    await second;
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
    expect(h.loop.delegationFor("r-1")).toBeNull();
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
    expect(h.loop.delegationFor("r-1")).toBeNull();
  });
});

describe("delegationFor", () => {
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
    const requestId = requestIdAnsweredBy(rows, "a-7");
    expect(requestId).toBe("r-7");
    expect(h.loop.delegationFor("r-7")).toBe("d-7");
    expect(h.loop.delegationFor("r-7")).toBeNull();
  });
});

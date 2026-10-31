import type { BotConversationSendResponse } from "@traycer/protocol/host/bot/conversation-schemas";
import { beforeEach, describe, expect, it } from "vitest";
import {
  useVoiceSessionStore,
  type VoiceFocus,
} from "@/stores/voice/voice-session-store";
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
  /** Settles the in-flight send. */
  resolve(response: BotConversationSendResponse): void;
  reject(): void;
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
  let settle: {
    resolve: (value: BotConversationSendResponse) => void;
    reject: (reason: Error) => void;
  } | null = null;
  const loop = createSayLoop({
    store: useVoiceSessionStore,
    send: (focus, text) => {
      sends.push({ focus, text });
      return new Promise((resolve, reject) => {
        settle = { resolve, reject };
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
    resolve: (value) => settle?.resolve(value),
    reject: () => settle?.reject(new Error("refused")),
  };
}

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
  const store = useVoiceSessionStore.getState();
  store.setFocus(FOCUS);
  store.appendInputSegment("please check", 1);
  store.appendInputSegment("the build", 2);
});

describe("a delegation", () => {
  it("posts the joined span once to the focus, consumes it and follows the new thread", async () => {
    const h = harness();
    const done = h.loop.onDelegationCreated("d-1");
    h.resolve(response({}));
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
    h.resolve(response({ delivery: "queued" }));
    await done;

    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("queued");
    expect(h.notices[0]).not.toContain("paused");
  });

  it("does not reopen the rail when the person moved during the send, and says where it landed", async () => {
    const h = harness();
    const done = h.loop.onDelegationCreated("d-1");
    useVoiceSessionStore.getState().selectionChanged(OTHER_FOCUS);
    h.resolve(response({}));
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
    h.resolve(response({ delivery: "queued" }));
    await done;

    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("moved");
    expect(h.notices[0]).toContain("queued");
    expect(h.notices[0]).not.toContain("paused");
  });

  it("clears the pending delegation on a rejected send, keeps the span and notifies once", async () => {
    const h = harness();
    const done = h.loop.onDelegationCreated("d-1");
    h.reject();
    await done;

    const state = useVoiceSessionStore.getState();
    expect(state.pendingDelegationId).toBeNull();
    expect(state.openSpan()).toBe("please check the build");
    expect(h.notices).toHaveLength(1);
  });
});

describe("a selection change mid-utterance", () => {
  it("asks nothing while the send is still in flight", () => {
    const h = harness();
    void h.loop.onDelegationCreated("d-1");
    useVoiceSessionStore.getState().selectionChanged(OTHER_FOCUS);
    h.loop.onSelectionChanged();

    expect(h.asks).toEqual([]);
  });

  it("asks once and keeps the words, posting nothing for that boundary", () => {
    const h = harness();
    useVoiceSessionStore.getState().selectionChanged(OTHER_FOCUS);
    h.loop.onSelectionChanged();

    expect(h.sends).toEqual([]);
    expect(h.asks).toEqual([MOVED_ASK_TEXT]);
    expect(useVoiceSessionStore.getState().openSpan()).toBe(
      "please check the build",
    );
  });
});

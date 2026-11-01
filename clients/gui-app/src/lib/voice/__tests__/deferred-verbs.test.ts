import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  useVoiceSessionStore,
  type QueueItem,
  type VoiceFocus,
  type VoiceQueueDriver,
} from "@/stores/voice/voice-session-store";
import type { BoundTarget } from "../directory";
import {
  executeDeferredVerb,
  NO_BOT_NOTICE,
  NOT_LIVE_NOTICE,
  NOTHING_TO_OPEN_NOTICE,
  NOTHING_WAITING_NOTICE,
  type VerbOutcome,
} from "../deferred-verbs";

const initial = useVoiceSessionStore.getState();

function queueItem(overrides: Partial<QueueItem>): QueueItem {
  return {
    id: "i-1",
    kind: "reply",
    botId: "bot-2",
    hostId: "host-a",
    threadId: "thread-x",
    chatId: "thread-x",
    messageId: "i-1",
    surfaceId: null,
    title: "A title",
    author: null,
    line: "A line",
    at: 1_000,
    state: "queued",
    ...overrides,
  };
}

function boundTo(botId: string, threadId: string | null): BoundTarget {
  const focus: VoiceFocus = {
    botId,
    hostId: "host-a",
    threadId,
    anchorMessageId: null,
    anchorThread: null,
  };
  return {
    tuple: { environmentId: "env-1", botId, threadId, hostId: "host-a" },
    focus,
    isFocus: false,
    botTitle: botId,
    environmentLabel: "Personal",
    environmentKind: "personal",
    anchorExcerpt: null,
  };
}

let run: Mock<VoiceQueueDriver["run"]>;

function goLive(queue: ReadonlyArray<QueueItem>): void {
  run = vi.fn<VoiceQueueDriver["run"]>(() => "appended");
  useVoiceSessionStore.setState({
    phase: "live",
    queue,
    queueDriver: {
      run,
      noteSwitched: vi.fn<VoiceQueueDriver["noteSwitched"]>(),
    },
  });
}

beforeEach(() => {
  useVoiceSessionStore.setState(initial, true);
});

describe("executeDeferredVerb", () => {
  it("reads the item the route names, under the request's delegation", () => {
    goLive([queueItem({})]);

    const outcome = executeDeferredVerb({
      verb: "read",
      target: null,
      itemId: "i-1",
      threadNamed: false,
      delegationId: "d-1",
    });

    expect(outcome).toEqual({ kind: "executed" });
    expect(run.mock.calls).toEqual([
      [{ kind: "read", itemId: "i-1", delegationId: "d-1" }],
    ]);
  });

  it("reads a named bot's newest waiting item when the route names the bot and no item", () => {
    goLive([
      queueItem({ id: "old", botId: "bot-2", at: 1_000 }),
      queueItem({ id: "new", botId: "bot-2", at: 3_000 }),
      queueItem({ id: "other-bot", botId: "bot-3", at: 5_000 }),
      queueItem({ id: "heard", botId: "bot-2", at: 4_000, state: "heard" }),
    ]);

    executeDeferredVerb({
      verb: "read",
      target: boundTo("bot-2", null),
      itemId: null,
      threadNamed: false,
      delegationId: "d-1",
    });

    expect(run.mock.calls).toEqual([
      [{ kind: "read", itemId: "new", delegationId: "d-1" }],
    ]);
  });

  it.each([
    [
      "searches all of the bot's threads when the route named only the bot",
      false,
      "in-b",
    ],
    ["keeps to the thread the route named", true, "in-a"],
  ])("a read that %s", (_name, threadNamed, expected) => {
    // The bot-only route is bound to the focused thread A, which says
    // nothing about which of the bot's threads the person means.
    goLive([
      queueItem({
        id: "in-a",
        botId: "bot-2",
        threadId: "thread-a",
        at: 1_000,
      }),
      queueItem({
        id: "in-b",
        botId: "bot-2",
        threadId: "thread-b",
        at: 3_000,
      }),
    ]);

    executeDeferredVerb({
      verb: "read",
      target: boundTo("bot-2", "thread-a"),
      itemId: null,
      threadNamed,
      delegationId: "d-1",
    });

    expect(run.mock.calls).toEqual([
      [{ kind: "read", itemId: expected, delegationId: "d-1" }],
    ]);
  });

  it("sets aside a bot's newest waiting item across its threads with later, when only the bot is named", () => {
    goLive([
      queueItem({
        id: "in-a",
        botId: "bot-2",
        threadId: "thread-a",
        at: 1_000,
      }),
      queueItem({
        id: "in-b",
        botId: "bot-2",
        threadId: "thread-b",
        at: 3_000,
      }),
    ]);

    executeDeferredVerb({
      verb: "later",
      target: boundTo("bot-2", "thread-a"),
      itemId: null,
      threadNamed: false,
      delegationId: "d-1",
    });

    expect(run.mock.calls).toEqual([[{ kind: "later", itemId: "in-b" }]]);
  });

  it("sets an item aside with later", () => {
    goLive([queueItem({})]);

    const outcome = executeDeferredVerb({
      verb: "later",
      target: null,
      itemId: "i-1",
      threadNamed: false,
      delegationId: "d-1",
    });

    expect(outcome).toEqual({ kind: "executed" });
    expect(run.mock.calls).toEqual([[{ kind: "later", itemId: "i-1" }]]);
  });

  it("refuses with what the voice says when the queue has nothing to run on", () => {
    goLive([]);
    run.mockReturnValue("nothing");

    expect(
      executeDeferredVerb({
        verb: "read",
        target: null,
        itemId: null,
        threadNamed: false,
        delegationId: "d-1",
      }),
    ).toEqual({ kind: "refused", say: NOTHING_WAITING_NOTICE });
  });

  it("asks which bot when a status finds none", () => {
    goLive([]);
    run.mockReturnValue("nothing");

    const outcome = executeDeferredVerb({
      verb: "status",
      target: null,
      itemId: null,
      threadNamed: false,
      delegationId: "d-1",
    });

    expect(run.mock.calls).toEqual([
      [{ kind: "status", botId: null, delegationId: "d-1" }],
    ]);
    expect(outcome).toEqual({ kind: "refused", say: NO_BOT_NOTICE });
  });

  it("runs a status of the named bot", () => {
    goLive([]);

    executeDeferredVerb({
      verb: "status",
      target: boundTo("bot-3", null),
      itemId: null,
      threadNamed: false,
      delegationId: "d-1",
    });

    expect(run.mock.calls).toEqual([
      [{ kind: "status", botId: "bot-3", delegationId: "d-1" }],
    ]);
  });

  it("refuses with the not-connected notice when no session is live", () => {
    goLive([queueItem({})]);
    useVoiceSessionStore.setState({ phase: "idle" });

    expect(
      executeDeferredVerb({
        verb: "brief",
        target: null,
        itemId: null,
        threadNamed: false,
        delegationId: "d-1",
      }),
    ).toEqual({ kind: "refused", say: NOT_LIVE_NOTICE });
    expect(run).not.toHaveBeenCalled();
  });

  describe("open", () => {
    function open(
      target: BoundTarget | null,
      itemId: string | null,
      threadNamed: boolean,
    ): VerbOutcome {
      return executeDeferredVerb({
        verb: "open",
        target,
        itemId,
        threadNamed,
        delegationId: "d-1",
      });
    }

    it("opens the item the route names, under the request's delegation", () => {
      goLive([queueItem({ id: "q-1", kind: "question" })]);

      expect(open(null, "q-1", false)).toEqual({ kind: "executed" });
      expect(run.mock.calls).toEqual([
        [{ kind: "open", itemId: "q-1", delegationId: "d-1" }],
      ]);
    });

    it("opens the newest waiting card over a newer reply when the route names nothing", () => {
      goLive([
        queueItem({ id: "reply-new", kind: "reply", at: 9_000 }),
        queueItem({ id: "card-old", kind: "surface", at: 2_000 }),
        queueItem({ id: "card-older", kind: "question", at: 1_000 }),
        queueItem({
          id: "card-heard",
          kind: "question",
          at: 8_000,
          state: "heard",
        }),
      ]);

      open(null, null, false);

      expect(run.mock.calls).toEqual([
        [{ kind: "open", itemId: "card-old", delegationId: "d-1" }],
      ]);
    });

    it.each([
      ["searches all of the bot's threads for its card", false, "card-in-b"],
      ["keeps to the thread the route named", true, "card-in-a"],
    ])("a named bot's open that %s", (_name, threadNamed, expected) => {
      goLive([
        queueItem({
          id: "other-bot",
          kind: "question",
          botId: "bot-3",
          at: 9_000,
        }),
        queueItem({
          id: "card-in-b",
          kind: "question",
          threadId: "thread-b",
          at: 5_000,
        }),
        queueItem({
          id: "card-in-a",
          kind: "surface",
          threadId: "thread-a",
          at: 3_000,
        }),
      ]);

      open(boundTo("bot-2", "thread-a"), null, threadNamed);

      expect(run.mock.calls).toEqual([
        [{ kind: "open", itemId: expected, delegationId: "d-1" }],
      ]);
    });

    it("falls back to the newest waiting item of the bot when it has no card", () => {
      goLive([
        queueItem({ id: "reply-old", kind: "reply", at: 1_000 }),
        queueItem({ id: "reply-new", kind: "reply", at: 4_000 }),
        queueItem({
          id: "other-card",
          kind: "question",
          botId: "bot-3",
          at: 9_000,
        }),
      ]);

      open(boundTo("bot-2", null), null, false);

      expect(run.mock.calls).toEqual([
        [{ kind: "open", itemId: "reply-new", delegationId: "d-1" }],
      ]);
    });

    it.each([
      ["the queue is empty", [], null],
      [
        "the named item was heard since the route was made",
        [queueItem({ id: "q-1", kind: "question", state: "heard" })],
        "q-1",
      ],
    ])("says there is nothing to open when %s", (_name, queue, itemId) => {
      goLive(queue);

      expect(open(null, itemId, false)).toEqual({
        kind: "refused",
        say: NOTHING_TO_OPEN_NOTICE,
      });
      expect(run).not.toHaveBeenCalled();
    });
  });

  it("does not read another bot's item when the named bot has none waiting", () => {
    goLive([queueItem({ id: "other-bot", botId: "bot-3" })]);
    run.mockImplementation((verb) =>
      verb.kind === "read" && verb.itemId === null ? "appended" : "nothing",
    );

    const outcome = executeDeferredVerb({
      verb: "read",
      target: boundTo("bot-2", null),
      itemId: null,
      threadNamed: false,
      delegationId: "d-1",
    });

    expect(outcome).toEqual({ kind: "refused", say: NOTHING_WAITING_NOTICE });
  });
});

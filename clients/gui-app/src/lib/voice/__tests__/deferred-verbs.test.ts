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
  NOTHING_WAITING_NOTICE,
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
    queueDriver: { run },
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
      delegationId: "d-1",
    });

    expect(run.mock.calls).toEqual([
      [{ kind: "read", itemId: "new", delegationId: "d-1" }],
    ]);
  });

  it("sets an item aside with later", () => {
    goLive([queueItem({})]);

    const outcome = executeDeferredVerb({
      verb: "later",
      target: null,
      itemId: "i-1",
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
        delegationId: "d-1",
      }),
    ).toEqual({ kind: "refused", say: NOT_LIVE_NOTICE });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses open with a spoken not-yet, whatever is live", () => {
    goLive([queueItem({})]);

    const outcome = executeDeferredVerb({
      verb: "open",
      target: null,
      itemId: "i-1",
      delegationId: "d-1",
    });

    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" ? outcome.say : "").toContain("Not yet");
    expect(run).not.toHaveBeenCalled();
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
      delegationId: "d-1",
    });

    expect(outcome).toEqual({ kind: "refused", say: NOTHING_WAITING_NOTICE });
  });
});

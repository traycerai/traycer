import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatSubscribeWindowedClientFrameSchema,
  openChatSubscribeWindowedServerFrameSchema,
  type ChatSubscribeWindowedClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatIndexChange } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { BotConversationRecord } from "@traycer/protocol/host/bot/conversation-schemas";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { TRANSCRIPT_RANGE_MAX_BYTES } from "@traycer/protocol/persistence/chat-transcript/read-range";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { BOT_HOST_UPDATE_MESSAGE } from "../../internal/bot-host";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandResult } from "../../runner/runner";
import {
  BOT_ID_A,
  BOT_ID_B,
  CONVERSATION_ID,
  OTHER_HOST_ID,
  REPLY_MESSAGE_ID,
  REQUEST_ID,
  THIS_HOST_ID,
  THREAD_ID,
  FakeStreamClient,
  type FakeStreamSession,
  assistantRow,
  botRecord,
  chatSnapshotFrame,
  conversationRecord,
  fatalClose,
  indexChangedFrame,
  type IndexChange,
  makeCtx,
  rangeFrame,
  routeRpc,
  skeletonChunkFrame,
  skeletonEntry,
  unsupportedRpcError,
  userRow,
} from "./bot-test-support";
import {
  buildBotSendCommand,
  firstConversation,
  parseWaitDuration,
  touchedOrdinals,
  waitForBotReply,
  type BotReplyOutcome,
} from "../bot-send";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
  noopLogger: loggerMock,
}));

const hoisted = vi.hoisted(() => ({
  callHostRpc: vi.fn(),
  resolveEndpoint: vi.fn(),
  openLocalStreamClient: vi.fn(),
}));

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return {
    ...actual,
    callHostRpc: hoisted.callHostRpc,
    resolveEndpoint: hoisted.resolveEndpoint,
  };
});

vi.mock("../../internal/bot-host", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/bot-host")
  >("../../internal/bot-host");
  return { ...actual, openLocalStreamClient: hoisted.openLocalStreamClient };
});

const ENDPOINT = {
  hostId: THIS_HOST_ID,
  websocketUrl: "ws://127.0.0.1:9999/rpc",
};

beforeEach(() => {
  vi.resetAllMocks();
  hoisted.resolveEndpoint.mockResolvedValue(ENDPOINT);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- command: choosing the bot and conversation ------------------------- //

function stageSend(input: {
  readonly bots: readonly BotRecord[];
  readonly conversations: readonly BotConversationRecord[];
  readonly delivery: "written" | "queued";
}): void {
  hoisted.callHostRpc.mockImplementation(
    routeRpc({
      "bot.list": () => ({ bots: input.bots }),
      "bot.conversation.list": () => ({ conversations: input.conversations }),
      "bot.conversation.send": () => ({
        messageId: "msg-sent",
        requestId: REQUEST_ID,
        threadId: THREAD_ID,
        delivery: input.delivery,
      }),
    }),
  );
}

/** The params of every `callHostRpc(method, ...)` so far. */
function paramsOfCalls(method: string): unknown[] {
  return hoisted.callHostRpc.mock.calls
    .filter((call) => call[0] === method)
    .map((call) => call[1]);
}

function send(input: {
  readonly bot: string;
  readonly conversationId: string | null;
  readonly wait: string | null;
}): Promise<CommandResult> {
  return buildBotSendCommand({
    bot: input.bot,
    text: "ship it",
    conversationId: input.conversationId,
    wait: input.wait,
  })(makeCtx());
}

async function rejection(run: Promise<CommandResult>): Promise<CliError> {
  const error: unknown = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CliError)) {
    throw new Error("expected the command to reject with a CliError");
  }
  return error;
}

describe("bot send", () => {
  const tracy = botRecord({ botId: BOT_ID_A, title: "Tracy" });

  it("sends into the conversation with the smallest createdAt when none is named", async () => {
    stageSend({
      bots: [tracy],
      conversations: [
        conversationRecord({ conversationId: "conv-late", createdAt: 3_000 }),
        conversationRecord({ conversationId: "conv-first", createdAt: 1_000 }),
        conversationRecord({ conversationId: "conv-mid", createdAt: 2_000 }),
      ],
      delivery: "written",
    });

    const result = await send({
      bot: BOT_ID_A,
      conversationId: null,
      wait: null,
    });

    expect(paramsOfCalls("bot.conversation.list")).toEqual([
      { botId: BOT_ID_A },
    ]);
    expect(paramsOfCalls("bot.conversation.send")).toEqual([
      {
        botId: BOT_ID_A,
        conversationId: "conv-first",
        text: "ship it",
        threadId: null,
      },
    ]);
    expect(result.human).toBe(
      `Sent to Tracy (request ${REQUEST_ID}, delivered).`,
    );
    expect(result.data).toEqual({
      botId: BOT_ID_A,
      conversationId: "conv-first",
      messageId: "msg-sent",
      requestId: REQUEST_ID,
      threadId: THREAD_ID,
      delivery: "written",
    });
    expect(result.exitCode).toBe(0);
    // Without --wait nothing follows the conversation.
    expect(hoisted.openLocalStreamClient).not.toHaveBeenCalled();
  });

  it("sends into the named conversation, even when it is not the first", async () => {
    stageSend({
      bots: [tracy],
      conversations: [
        conversationRecord({ conversationId: "conv-first", createdAt: 1_000 }),
        conversationRecord({ conversationId: "conv-named", createdAt: 9_000 }),
      ],
      delivery: "written",
    });

    const result = await send({
      bot: BOT_ID_A,
      conversationId: "conv-named",
      wait: null,
    });

    expect(paramsOfCalls("bot.conversation.send")).toEqual([
      {
        botId: BOT_ID_A,
        conversationId: "conv-named",
        text: "ship it",
        threadId: null,
      },
    ]);
    expect(result.data).toMatchObject({ conversationId: "conv-named" });
  });

  it("refuses a named conversation the bot does not have, and sends nothing", async () => {
    stageSend({
      bots: [tracy],
      conversations: [conversationRecord({ conversationId: "conv-first" })],
      delivery: "written",
    });

    const error = await rejection(
      send({ bot: BOT_ID_A, conversationId: "conv-nope", wait: null }),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.NOT_FOUND);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe("traycer: Tracy has no conversation conv-nope.");
    expect(paramsOfCalls("bot.conversation.send")).toEqual([]);
  });

  it("refuses a bot with no conversations, and sends nothing", async () => {
    stageSend({ bots: [tracy], conversations: [], delivery: "written" });

    const error = await rejection(
      send({ bot: BOT_ID_A, conversationId: null, wait: null }),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.NOT_FOUND);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe(
      "traycer: Tracy has no conversation yet - open it in the Traycer app first.",
    );
    expect(paramsOfCalls("bot.conversation.send")).toEqual([]);
  });

  it("says a queued message waits for the bot's host", async () => {
    stageSend({
      bots: [tracy],
      conversations: [conversationRecord({})],
      delivery: "queued",
    });

    const result = await send({
      bot: BOT_ID_A,
      conversationId: null,
      wait: null,
    });

    expect(result.human).toBe(
      `Sent to Tracy (request ${REQUEST_ID}, queued until the bot's host is back).`,
    );
    expect(result.data).toMatchObject({ delivery: "queued" });
  });

  it("finds the bot by its exact id", async () => {
    stageSend({
      bots: [
        botRecord({ botId: BOT_ID_A, title: "Tracy" }),
        botRecord({ botId: BOT_ID_B, title: "Scout" }),
      ],
      conversations: [conversationRecord({ botId: BOT_ID_B })],
      delivery: "written",
    });

    const result = await send({
      bot: BOT_ID_B,
      conversationId: null,
      wait: null,
    });

    expect(paramsOfCalls("bot.conversation.send")).toMatchObject([
      { botId: BOT_ID_B },
    ]);
    expect(result.human).toMatch(/^Sent to Scout /);
  });

  it("finds the bot by its title, ignoring case", async () => {
    stageSend({
      bots: [
        botRecord({ botId: BOT_ID_A, title: "Tracy" }),
        botRecord({ botId: BOT_ID_B, title: "Scout" }),
      ],
      conversations: [conversationRecord({})],
      delivery: "written",
    });

    const result = await send({
      bot: "sCoUt",
      conversationId: null,
      wait: null,
    });

    expect(paramsOfCalls("bot.conversation.list")).toEqual([
      { botId: BOT_ID_B },
    ]);
    expect(result.human).toMatch(/^Sent to Scout /);
  });

  it("refuses an ambiguous title and lists both ids", async () => {
    stageSend({
      bots: [
        botRecord({ botId: BOT_ID_A, title: "Twin" }),
        botRecord({ botId: BOT_ID_B, title: "twin" }),
      ],
      conversations: [conversationRecord({})],
      delivery: "written",
    });

    const error = await rejection(
      send({ bot: "TWIN", conversationId: null, wait: null }),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe(
      `traycer: more than one bot is called 'TWIN' - name it by id: ${BOT_ID_A}, ${BOT_ID_B}.`,
    );
    expect(paramsOfCalls("bot.conversation.send")).toEqual([]);
  });

  it("refuses a bot nobody has by that name", async () => {
    stageSend({ bots: [tracy], conversations: [], delivery: "written" });

    const error = await rejection(
      send({ bot: "Nobody", conversationId: null, wait: null }),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.NOT_FOUND);
    expect(error.message).toBe(
      "traycer: no bot called 'Nobody' - run `traycer bot list` to see yours.",
    );
    expect(paramsOfCalls("bot.conversation.send")).toEqual([]);
  });

  it("rejects an invalid --wait before any host call", async () => {
    stageSend({ bots: [tracy], conversations: [], delivery: "written" });

    const error = await rejection(
      send({ bot: BOT_ID_A, conversationId: null, wait: "5" }),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(hoisted.callHostRpc).not.toHaveBeenCalled();
  });
});

describe("bot send --wait on a bot bound to another host", () => {
  it("refuses with the exact copy and never calls bot.conversation.send", async () => {
    const away = botRecord({
      botId: BOT_ID_A,
      title: "Tracy",
      boundHostId: OTHER_HOST_ID,
    });
    stageSend({
      bots: [away],
      conversations: [conversationRecord({})],
      delivery: "queued",
    });

    const error = await rejection(
      send({ bot: BOT_ID_A, conversationId: null, wait: "30s" }),
    );

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe(
      "traycer: Tracy runs on another of your hosts; --wait works only there. Send without --wait to queue it.",
    );
    expect(paramsOfCalls("bot.conversation.send")).toEqual([]);
    expect(hoisted.openLocalStreamClient).not.toHaveBeenCalled();
  });

  it("still sends without --wait, queued for the bot's host", async () => {
    const away = botRecord({ botId: BOT_ID_A, boundHostId: OTHER_HOST_ID });
    stageSend({
      bots: [away],
      conversations: [conversationRecord({})],
      delivery: "queued",
    });

    const result = await send({
      bot: BOT_ID_A,
      conversationId: null,
      wait: null,
    });

    expect(paramsOfCalls("bot.conversation.send")).toHaveLength(1);
    expect(result.exitCode).toBe(0);
  });
});

describe("bot send on a host without bots", () => {
  it.each(["bot.list", "bot.conversation.list", "bot.conversation.send"])(
    "rejects with the update message when %s is unsupported",
    async (missing) => {
      hoisted.callHostRpc.mockImplementation(
        routeRpc({
          "bot.list": () => {
            if (missing === "bot.list") throw unsupportedRpcError(missing);
            return { bots: [botRecord({ botId: BOT_ID_A })] };
          },
          "bot.conversation.list": () => {
            if (missing === "bot.conversation.list") {
              throw unsupportedRpcError(missing);
            }
            return { conversations: [conversationRecord({})] };
          },
          "bot.conversation.send": () => {
            throw unsupportedRpcError(missing);
          },
        }),
      );

      const error = await rejection(
        send({ bot: BOT_ID_A, conversationId: null, wait: null }),
      );

      expect(error.message).toBe(BOT_HOST_UPDATE_MESSAGE);
      expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
      expect(error.exitCode).toBe(1);
    },
  );
});

// ---- command: --wait, end to end ---------------------------------------- //

/** Starts a `--wait` run and returns once it is following the conversation. */
async function startWaitingSend(wait: string): Promise<{
  readonly run: Promise<CommandResult>;
  readonly client: FakeStreamClient;
  readonly session: FakeStreamSession;
}> {
  stageSend({
    bots: [botRecord({ botId: BOT_ID_A, title: "Tracy" })],
    conversations: [conversationRecord({ conversationId: CONVERSATION_ID })],
    delivery: "written",
  });
  const client = new FakeStreamClient(() => undefined);
  hoisted.openLocalStreamClient.mockResolvedValue({
    client,
    endpoint: ENDPOINT,
  });
  const run = send({ bot: BOT_ID_A, conversationId: null, wait });
  // Let the command get through its RPCs and subscribe.
  await vi.advanceTimersByTimeAsync(0);
  const session = client.sessions[0];
  if (session === undefined) throw new Error("the command never subscribed");
  return { run, client, session };
}

function resolvedSnapshot(
  resolvedBy: string | null,
  extraRows: readonly Record<string, unknown>[],
) {
  return chatSnapshotFrame({
    botId: BOT_ID_A,
    conversationId: CONVERSATION_ID,
    epoch: 1,
    rowCount: 1 + extraRows.length,
    indexRevision: null,
    tailFromOrdinal: 0,
    messages: [
      userRow({
        messageId: "msg-sent",
        requestId: REQUEST_ID,
        resolvedAt: 5_000,
        resolvedByMessageId: resolvedBy,
      }),
      ...extraRows,
    ],
  });
}

/** The thread's frames: the same shapes as the channel's, on `THREAD_ID`. */
function threadSnapshot(messages: readonly Record<string, unknown>[]) {
  return chatSnapshotFrame({
    botId: BOT_ID_A,
    conversationId: THREAD_ID,
    epoch: 1,
    rowCount: messages.length,
    indexRevision: null,
    tailFromOrdinal: 0,
    messages,
  });
}

function threadSkeleton(entries: readonly Record<string, unknown>[]) {
  return skeletonChunkFrame({
    botId: BOT_ID_A,
    conversationId: THREAD_ID,
    epoch: 1,
    fromOrdinal: 0,
    entries,
    isFinal: true,
  });
}

/** The second subscription: opened once the channel names the reply. */
async function threadSessionOf(
  client: FakeStreamClient,
): Promise<FakeStreamSession> {
  await vi.advanceTimersByTimeAsync(0);
  const session = client.sessions[1];
  if (session === undefined) throw new Error("the thread was never followed");
  return session;
}

describe("bot send --wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("prints the reply and exits 0 once the request is resolved", async () => {
    const { run, client, session } = await startWaitingSend("30s");

    expect(session.method).toBe("chat.subscribe");
    expect(session.params).toEqual({
      epicId: BOT_ID_A,
      chatId: CONVERSATION_ID,
      resume: null,
    });
    // The channel names the reply; the reply row itself is on the thread.
    session.pushFrame(resolvedSnapshot(REPLY_MESSAGE_ID, []));
    const threadSession = await threadSessionOf(client);
    expect(threadSession.params).toEqual({
      epicId: BOT_ID_A,
      chatId: THREAD_ID,
      resume: null,
    });
    threadSession.pushFrame(
      threadSnapshot([
        assistantRow({
          messageId: REPLY_MESSAGE_ID,
          texts: ["All shipped."],
        }),
      ]),
    );
    const result = await run;

    expect(result.human).toBe(
      `Sent to Tracy (request ${REQUEST_ID}, delivered).\nTracy replied:\nAll shipped.`,
    );
    expect(result.data).toEqual({
      botId: BOT_ID_A,
      conversationId: CONVERSATION_ID,
      messageId: "msg-sent",
      requestId: REQUEST_ID,
      threadId: THREAD_ID,
      delivery: "written",
      outcome: {
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: "All shipped.",
      },
    });
    expect(result.exitCode).toBe(0);
    expect(session.closeCount).toBe(1);
    expect(threadSession.closeCount).toBe(1);
    expect(client.closeReasons).toEqual(["bot-send-wait-settled"]);
  });

  it("names the reply message when its text could not be read back", async () => {
    const { run, client, session } = await startWaitingSend("30s");

    session.pushFrame(resolvedSnapshot(REPLY_MESSAGE_ID, []));
    const threadSession = await threadSessionOf(client);
    threadSession.pushFrame(threadSnapshot([]));
    threadSession.pushFrame(threadSkeleton([]));
    // No assistant row is left to read on the thread: the command asks for a
    // fresh snapshot, which also lacks the reply.
    expect(resnapshots(threadSession)).toHaveLength(1);
    threadSession.pushFrame(threadSnapshot([]));
    threadSession.pushFrame(threadSkeleton([]));
    const result = await run;

    expect(result.human).toBe(
      `Sent to Tracy (request ${REQUEST_ID}, delivered).\nTracy replied (message ${REPLY_MESSAGE_ID}).`,
    );
    expect(result.data).toMatchObject({
      outcome: {
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: null,
      },
    });
    expect(result.exitCode).toBe(0);
  });

  it("says the bot closed the request without a reply, and exits 0", async () => {
    const { run, session } = await startWaitingSend("30s");

    session.pushFrame(resolvedSnapshot(null, []));
    const result = await run;

    expect(result.human).toBe(
      `Sent to Tracy (request ${REQUEST_ID}, delivered).\nTracy closed the request without a reply.`,
    );
    expect(result.data).toMatchObject({
      outcome: { kind: "resolved-without-reply" },
    });
    expect(result.exitCode).toBe(0);
  });

  it("exits 1 and leaves the request open when the wait runs out", async () => {
    const { run, client, session } = await startWaitingSend("30s");

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await run;

    expect(result.human).toBe(
      `Sent to Tracy (request ${REQUEST_ID}, delivered).\nNo reply from Tracy within 30s. The request stays open.`,
    );
    expect(result.data).toMatchObject({ outcome: { kind: "timed-out" } });
    expect(result.exitCode).toBe(1);
    expect(session.closeCount).toBe(1);
    expect(client.closeReasons).toEqual(["bot-send-wait-settled"]);
  });

  it("closes the stream client when following the conversation fails", async () => {
    const { run, client, session } = await startWaitingSend("30s");

    session.pushStatus(
      "closed",
      fatalClose({
        code: "INTERNAL",
        reason: "host blew up",
        incompatibleMethod: null,
      }),
    );

    const error = await rejection(run);
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNREACHABLE);
    expect(client.closeReasons).toEqual(["bot-send-wait-settled"]);
  });

  it("prints the host-update line when chat.subscribe closes as incompatible during the wait", async () => {
    const { run, client, session } = await startWaitingSend("30s");

    session.pushStatus(
      "closed",
      fatalClose({
        code: "INCOMPATIBLE",
        reason: "host does not offer chat.subscribe",
        incompatibleMethod: "chat.subscribe",
      }),
    );

    const error = await rejection(run);
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
    expect(error.message).toBe(BOT_HOST_UPDATE_MESSAGE);
    expect(error.exitCode).toBe(1);
    expect(client.closeReasons).toEqual(["bot-send-wait-settled"]);
  });
});

// ---- the pure helpers --------------------------------------------------- //

describe("firstConversation", () => {
  it("is null for no conversations", () => {
    expect(firstConversation([])).toBeNull();
  });

  it("picks the smallest createdAt wherever it sits in the list", () => {
    const early = conversationRecord({
      conversationId: "early",
      createdAt: 10,
    });
    const middle = conversationRecord({
      conversationId: "middle",
      createdAt: 20,
    });
    const late = conversationRecord({ conversationId: "late", createdAt: 30 });

    expect(firstConversation([late, early, middle])).toBe(early);
    expect(firstConversation([early, middle, late])).toBe(early);
    expect(firstConversation([middle, late, early])).toBe(early);
  });

  it("keeps the earlier-listed one on a tie", () => {
    const one = conversationRecord({ conversationId: "one", createdAt: 10 });
    const two = conversationRecord({ conversationId: "two", createdAt: 10 });

    expect(firstConversation([one, two])).toBe(one);
  });
});

describe("parseWaitDuration", () => {
  it.each([
    { value: "30s", ms: 30_000 },
    { value: "5m", ms: 300_000 },
    { value: "2h", ms: 7_200_000 },
    { value: "  45s  ", ms: 45_000 },
    // The largest whole hours that still fit one timer (2^31 - 1 ms).
    { value: "596h", ms: 2_145_600_000 },
  ])("accepts '$value' as $ms ms", ({ value, ms }) => {
    expect(parseWaitDuration(value)).toBe(ms);
  });

  it.each([
    "0s",
    "0m",
    "5",
    "5d",
    "-1m",
    "",
    "s",
    "1.5h",
    "30 s",
    "1w",
    // One hour past the largest timer.
    "597h",
    "2147484s",
    "9".repeat(400) + "h",
  ])("rejects %j with the duration message", (value) => {
    let thrown: unknown = null;
    try {
      parseWaitDuration(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliError);
    if (!(thrown instanceof CliError)) return;
    expect(thrown.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(thrown.exitCode).toBe(1);
    expect(thrown.message).toBe(
      "traycer: --wait takes a duration such as 30s, 5m or 2h (at most 24 days).",
    );
  });
});

function skeleton(rowId: string): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1_000,
    role: "user",
    byteLength: 10,
    bodyDigest: `digest-${rowId}`,
  };
}

function appended(count: number): ChatIndexChange {
  return {
    type: "appended",
    entries: Array.from({ length: count }, (_, index) =>
      skeleton(`new-${index}`),
    ),
  };
}

function updated(...ordinals: readonly number[]): ChatIndexChange {
  return {
    type: "updated",
    entries: ordinals.map((ordinal) => ({
      ordinal,
      entry: skeleton(`row-${ordinal}`),
    })),
  };
}

const reindexed: ChatIndexChange = { type: "reindexed" };

describe("touchedOrdinals", () => {
  it("spans the appended rows at the end of the index", () => {
    expect(touchedOrdinals([appended(3)], 10)).toEqual({ from: 7, to: 9 });
  });

  it("spans the updated ordinals, whatever order they come in", () => {
    expect(touchedOrdinals([updated(4, 2, 3)], 10)).toEqual({
      from: 2,
      to: 4,
    });
  });

  it("covers an updated row and the appended rows in one inclusive span", () => {
    expect(touchedOrdinals([updated(3), appended(2)], 10)).toEqual({
      from: 3,
      to: 9,
    });
  });

  it("adds the rows of several appended changes", () => {
    expect(touchedOrdinals([appended(1), appended(2)], 10)).toEqual({
      from: 7,
      to: 9,
    });
  });

  it("is a single ordinal for one appended row", () => {
    expect(touchedOrdinals([appended(1)], 5)).toEqual({ from: 4, to: 4 });
  });

  it("never starts below ordinal 0", () => {
    expect(touchedOrdinals([appended(3)], 1)).toEqual({ from: 0, to: 0 });
  });

  it.each([
    { name: "no changes", changes: [] },
    { name: "a reindex alone", changes: [reindexed] },
    { name: "an appended change with no entries", changes: [appended(0)] },
    { name: "an updated change with no entries", changes: [updated()] },
  ])("is null for $name", ({ changes }) => {
    expect(touchedOrdinals(changes, 10)).toBeNull();
  });
});

// ---- waitForBotReply, driven frame by frame ------------------------------ //

type Row = Record<string, unknown>;
type LoadRangeRequest = Extract<
  ChatSubscribeWindowedClientFrame,
  { kind: "loadRange" }
>["request"];

function sentFrames(
  session: FakeStreamSession,
): ChatSubscribeWindowedClientFrame[] {
  return session.sent.map((frame) =>
    chatSubscribeWindowedClientFrameSchema.parse(frame),
  );
}

function loadRanges(session: FakeStreamSession): LoadRangeRequest[] {
  return sentFrames(session).flatMap((frame) =>
    frame.kind === "loadRange" ? [frame.request] : [],
  );
}

/** Each loadRange sent so far as `[fromOrdinal, toOrdinal]`. */
function loadSpans(session: FakeStreamSession): (readonly [number, number])[] {
  return loadRanges(session).map((request): readonly [number, number] => [
    request.fromOrdinal,
    request.toOrdinal,
  ]);
}

function newestLoad(session: FakeStreamSession): LoadRangeRequest {
  const asked = loadRanges(session);
  const last = asked[asked.length - 1];
  if (last === undefined) throw new Error("no loadRange was sent");
  return last;
}

function resnapshots(session: FakeStreamSession) {
  return sentFrames(session).filter((frame) => frame.kind === "resnapshot");
}

interface StartedWait {
  readonly session: FakeStreamSession;
  readonly client: FakeStreamClient;
  readonly outcome: Promise<BotReplyOutcome>;
  readonly settled: () => boolean;
}

/** Follows a request that opened no thread: the reply is on the same chat. */
function startWait(timeoutMs: number): StartedWait {
  return startWaitIn(timeoutMs, null);
}

function startWaitIn(timeoutMs: number, threadId: string | null): StartedWait {
  const client = new FakeStreamClient(() => undefined);
  let done = false;
  const outcome = waitForBotReply({
    client,
    botId: BOT_ID_A,
    conversationId: CONVERSATION_ID,
    threadId,
    requestId: REQUEST_ID,
    timeoutMs,
  }).finally(() => {
    done = true;
  });
  // A test that ends on a rejection reads it itself; this keeps the ones
  // that end earlier from reporting an unhandled rejection.
  outcome.catch(() => undefined);
  const session = client.sessions[0];
  if (session === undefined)
    throw new Error("waitForBotReply never subscribed");
  return { session, client, outcome, settled: () => done };
}

const openUserRow = userRow({
  messageId: "msg-sent",
  requestId: REQUEST_ID,
  resolvedAt: null,
  resolvedByMessageId: null,
});

function resolvedUserRow(resolvedByMessageId: string | null) {
  return userRow({
    messageId: "msg-sent",
    requestId: REQUEST_ID,
    resolvedAt: 5_000,
    resolvedByMessageId,
  });
}

/** A resolved user row of some other request, as an older turn left it. */
function otherRequestRow(n: number, resolvedBy: string) {
  return userRow({
    messageId: `msg-other-${n}`,
    requestId: `req-other-${n}`,
    resolvedAt: 4_000,
    resolvedByMessageId: resolvedBy,
  });
}

const replyRow = assistantRow({
  messageId: REPLY_MESSAGE_ID,
  texts: ["Hello", "", "world"],
});

const REPLY_TEXT = "Hello\nworld";

/** A snapshot of `rowCount` rows whose tail starts at `tailFromOrdinal`. */
function snapshotAt(input: {
  readonly epoch: number;
  readonly rowCount: number;
  readonly indexRevision: number | null;
  readonly tailFromOrdinal: number;
  readonly messages: readonly Row[];
}) {
  return chatSnapshotFrame({
    botId: BOT_ID_A,
    conversationId: CONVERSATION_ID,
    ...input,
  });
}

/** A fresh-index snapshot whose tail is the whole of `messages`. */
function snapshotOf(messages: readonly Row[], epoch: number) {
  return snapshotAt({
    epoch,
    rowCount: messages.length,
    indexRevision: null,
    tailFromOrdinal: 0,
    messages,
  });
}

function chunkAt(
  epoch: number,
  fromOrdinal: number,
  entries: readonly Row[],
  isFinal: boolean,
) {
  return skeletonChunkFrame({
    botId: BOT_ID_A,
    conversationId: CONVERSATION_ID,
    epoch,
    fromOrdinal,
    entries,
    isFinal,
  });
}

/** The whole skeleton in one final chunk. */
function skeletonOf(epoch: number, entries: readonly Row[]) {
  return chunkAt(epoch, 0, entries, true);
}

function changedAt(input: {
  readonly epoch: number;
  readonly rowCount: number;
  readonly indexRevision: number;
  readonly changes: readonly IndexChange[];
}) {
  return indexChangedFrame({
    botId: BOT_ID_A,
    conversationId: CONVERSATION_ID,
    ...input,
  });
}

function rangeOf(input: {
  readonly requestId: string;
  readonly epoch: number;
  readonly fromOrdinal: number;
  readonly rowIds: readonly string[];
  readonly messages: readonly Row[];
  readonly truncatedAtOrdinal: number | null;
}) {
  return rangeFrame({
    botId: BOT_ID_A,
    conversationId: CONVERSATION_ID,
    incompleteRowIds: null,
    ...input,
  });
}

/** Answers `request` the way the host would, with the rows named. */
function serve(
  session: FakeStreamSession,
  request: LoadRangeRequest,
  served: {
    readonly rowIds: readonly string[];
    readonly messages: readonly Row[];
    readonly incompleteRowIds: readonly string[] | null;
    readonly truncatedAtOrdinal: number | null;
  },
): void {
  session.pushFrame(
    rangeFrame({
      botId: BOT_ID_A,
      conversationId: CONVERSATION_ID,
      requestId: request.requestId,
      epoch: request.epoch,
      fromOrdinal: request.fromOrdinal,
      ...served,
    }),
  );
}

/** `serve` for a whole answer: no incomplete rows, nothing cut short. */
function serveWhole(
  session: FakeStreamSession,
  request: LoadRangeRequest,
  rowIds: readonly string[],
  messages: readonly Row[],
): void {
  serve(session, request, {
    rowIds,
    messages,
    incompleteRowIds: null,
    truncatedAtOrdinal: null,
  });
}

describe("fixtures", () => {
  it("are accepted by the real windowed chat.subscribe schema", () => {
    const frames = [
      snapshotOf([resolvedUserRow(REPLY_MESSAGE_ID), replyRow], 3),
      snapshotAt({
        epoch: 3,
        rowCount: 2,
        indexRevision: 7,
        tailFromOrdinal: 1,
        messages: [replyRow],
      }),
      chunkAt(3, 0, [skeletonEntry("r0", "user")], false),
      chunkAt(3, 1, [skeletonEntry("r1", "assistant")], true),
      indexChangedFrame({
        botId: BOT_ID_A,
        conversationId: CONVERSATION_ID,
        epoch: 3,
        rowCount: 4,
        indexRevision: 1,
        changes: [
          { type: "appended", entries: [skeletonEntry("r3", "assistant")] },
          {
            type: "updated",
            entries: [{ ordinal: 1, entry: skeletonEntry("r1", "user") }],
          },
          { type: "reindexed" },
        ],
      }),
      rangeFrame({
        botId: BOT_ID_A,
        conversationId: CONVERSATION_ID,
        requestId: "range-1",
        epoch: 3,
        fromOrdinal: 0,
        rowIds: ["r0", "r1"],
        incompleteRowIds: ["r1"],
        messages: [resolvedUserRow(REPLY_MESSAGE_ID), replyRow],
        truncatedAtOrdinal: 1,
      }),
      rangeOf({
        requestId: "range-2",
        epoch: 3,
        fromOrdinal: 0,
        rowIds: ["r0"],
        messages: [],
        truncatedAtOrdinal: null,
      }),
    ];

    for (const frame of frames) {
      expect(
        openChatSubscribeWindowedServerFrameSchema.safeParse(frame),
      ).toMatchObject({ success: true });
    }
  });
});

describe("waitForBotReply", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("follows the conversation the request was sent into", () => {
    const { session } = startWait(60_000);

    expect(session.method).toBe("chat.subscribe");
    expect(session.params).toEqual({
      epicId: BOT_ID_A,
      chatId: CONVERSATION_ID,
      resume: null,
    });
    expect(session.sent).toEqual([]);
  });

  it("replies from the snapshot tail when the request is resolved and the reply row is there", async () => {
    const { session, outcome } = startWait(60_000);

    session.pushFrame(
      snapshotOf([resolvedUserRow(REPLY_MESSAGE_ID), replyRow], 1),
    );

    // Text blocks join with a newline; an empty block adds nothing.
    await expect(outcome).resolves.toEqual({
      kind: "replied",
      replyMessageId: REPLY_MESSAGE_ID,
      text: REPLY_TEXT,
    });
    expect(session.closeCount).toBe(1);
    expect(session.sent).toEqual([]);
  });

  it("reads the reply row even when it sits before the resolved user row", async () => {
    const { session, outcome } = startWait(60_000);

    session.pushFrame(
      snapshotOf([replyRow, resolvedUserRow(REPLY_MESSAGE_ID)], 1),
    );

    await expect(outcome).resolves.toMatchObject({
      kind: "replied",
      text: REPLY_TEXT,
    });
  });

  it("reports resolved-without-reply when the request names no reply message", async () => {
    const { session, outcome } = startWait(60_000);

    session.pushFrame(snapshotOf([resolvedUserRow(null)], 1));

    await expect(outcome).resolves.toEqual({ kind: "resolved-without-reply" });
    expect(session.closeCount).toBe(1);
    expect(session.sent).toEqual([]);
  });

  describe("a request that opened a thread", () => {
    const THREAD_REPLY_TEXT = "THE-ANSWER-9d1c0e";
    const threadReplyRow = assistantRow({
      messageId: REPLY_MESSAGE_ID,
      texts: [THREAD_REPLY_TEXT],
    });

    /** The channel holds the resolved anchor and no reply row. */
    function resolveChannel(session: FakeStreamSession): void {
      session.pushFrame(
        snapshotAt({
          epoch: 1,
          rowCount: 1,
          indexRevision: null,
          tailFromOrdinal: 1,
          messages: [],
        }),
      );
      session.pushFrame(skeletonOf(1, [skeletonEntry("u0", "user")]));
      expect(loadSpans(session)).toEqual([[0, 0]]);
      serveWhole(
        session,
        newestLoad(session),
        ["u0"],
        [resolvedUserRow(REPLY_MESSAGE_ID)],
      );
    }

    it("reads the reply from the thread the channel's resolution names", async () => {
      const { session, client, outcome } = startWaitIn(60_000, THREAD_ID);

      resolveChannel(session);
      // The channel has said which reply resolved the request; it is closed
      // and the thread is followed for that row.
      expect(session.closeCount).toBe(1);
      const threadSession = await threadSessionOf(client);
      expect(client.sessions).toHaveLength(2);
      expect(
        client.sessions.map((followed) => [followed.method, followed.params]),
      ).toEqual([
        [
          "chat.subscribe",
          { epicId: BOT_ID_A, chatId: CONVERSATION_ID, resume: null },
        ],
        [
          "chat.subscribe",
          { epicId: BOT_ID_A, chatId: THREAD_ID, resume: null },
        ],
      ]);
      expect(threadSession.closeCount).toBe(0);

      threadSession.pushFrame(threadSnapshot([threadReplyRow]));
      threadSession.pushFrame(
        threadSkeleton([skeletonEntry("a0", "assistant")]),
      );

      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: THREAD_REPLY_TEXT,
      });
      expect(session.closeCount).toBe(1);
      expect(threadSession.closeCount).toBe(1);
      expect(threadSession.sent).toEqual([]);
    });

    it("reports the reply by its id when the thread never shows it within the time left", async () => {
      const { session, client, outcome, settled } = startWaitIn(
        30_000,
        THREAD_ID,
      );

      await vi.advanceTimersByTimeAsync(10_000);
      resolveChannel(session);
      const threadSession = await threadSessionOf(client);

      // The thread follower gets what is left of the wait, not a fresh one.
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled()).toBe(false);
      expect(threadSession.closeCount).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: null,
      });
      expect(session.closeCount).toBe(1);
      expect(threadSession.closeCount).toBe(1);
    });

    it("stays timed out when the channel never resolves the request", async () => {
      const { session, client, outcome } = startWaitIn(30_000, THREAD_ID);

      session.pushFrame(snapshotOf([openUserRow], 1));
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(outcome).resolves.toEqual({ kind: "timed-out" });
      expect(client.sessions).toHaveLength(1);
      expect(session.closeCount).toBe(1);
    });
  });

  it("keeps waiting while the request is open, and while another request is the resolved one", async () => {
    const { session, outcome, settled } = startWait(60_000);

    session.pushFrame(
      snapshotOf(
        [otherRequestRow(1, REPLY_MESSAGE_ID), openUserRow, replyRow],
        1,
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled()).toBe(false);
    expect(session.closeCount).toBe(0);
    expect(session.sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(outcome).resolves.toEqual({ kind: "timed-out" });
  });

  describe("an index change", () => {
    it("asks for one loadRange over the updated and appended rows, and settles on the range answer", async () => {
      const { session, outcome } = startWait(60_000);
      session.pushFrame(
        snapshotAt({
          epoch: 4,
          rowCount: 2,
          indexRevision: null,
          tailFromOrdinal: 0,
          messages: [openUserRow],
        }),
      );

      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 4,
          indexRevision: 1,
          changes: [
            {
              type: "updated",
              entries: [{ ordinal: 1, entry: skeletonEntry("r1", "user") }],
            },
            {
              type: "appended",
              entries: [
                skeletonEntry("r2", "assistant"),
                skeletonEntry("r3", "assistant"),
              ],
            },
          ],
        }),
      );

      // updated ordinal 1, appended rows 2..3 of a 4-row index: 1..3 inclusive.
      const asked = loadRanges(session);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        epoch: 4,
        fromOrdinal: 1,
        toOrdinal: 3,
        maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
      });
      expect(session.sent).toHaveLength(1);
      expect(session.closeCount).toBe(0);

      serveWhole(
        session,
        asked[0],
        ["r1", "r2", "r3"],
        [resolvedUserRow(REPLY_MESSAGE_ID), replyRow],
      );

      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: REPLY_TEXT,
      });
      expect(session.closeCount).toBe(1);
      // The answer arrived whole: nothing more was asked for.
      expect(session.sent).toHaveLength(1);
    });

    it("asks for nothing when an index change touches no row", () => {
      const { session } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));

      session.pushFrame(
        changedAt({ epoch: 4, rowCount: 1, indexRevision: 1, changes: [] }),
      );

      expect(session.sent).toEqual([]);
    });

    it("asks for a fresh snapshot, and no range, when the index was reindexed", async () => {
      const { session, settled } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));

      session.pushFrame(
        changedAt({
          epoch: 5,
          rowCount: 3,
          indexRevision: 1,
          // A reindex among other changes still wins: their ordinals are stale.
          changes: [
            { type: "appended", entries: [skeletonEntry("r2", "assistant")] },
            { type: "reindexed" },
          ],
        }),
      );

      expect(sentFrames(session)).toEqual([
        {
          kind: "resnapshot",
          hasBinaryPayload: false,
          epicId: BOT_ID_A,
          chatId: CONVERSATION_ID,
        },
      ]);
      expect(loadRanges(session)).toEqual([]);
      expect(settled()).toBe(false);
    });

    it("asks for a fresh snapshot on a reindex within the same epoch", () => {
      const { session } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));

      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 1,
          indexRevision: 1,
          changes: [{ type: "reindexed" }],
        }),
      );

      expect(resnapshots(session)).toHaveLength(1);
      expect(loadRanges(session)).toEqual([]);
    });

    it("asks for a fresh snapshot on a newer epoch, and ignores an older one", () => {
      const { session } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));

      session.pushFrame(
        changedAt({
          epoch: 3,
          rowCount: 5,
          indexRevision: 1,
          changes: [
            { type: "appended", entries: [skeletonEntry("r1", "assistant")] },
          ],
        }),
      );
      expect(session.sent).toEqual([]);

      session.pushFrame(
        changedAt({
          epoch: 5,
          rowCount: 1,
          indexRevision: 1,
          changes: [],
        }),
      );
      expect(resnapshots(session)).toHaveLength(1);
      expect(session.sent).toHaveLength(1);
    });

    it("adopts the first revision as the baseline, ignores a repeat or a straggler, and resnapshots on a gap", () => {
      const { session } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));
      const append = (rowCount: number, indexRevision: number) =>
        changedAt({
          epoch: 4,
          rowCount,
          indexRevision,
          changes: [
            {
              type: "appended",
              entries: [skeletonEntry(`n${rowCount}`, "assistant")],
            },
          ],
        });

      // The first concrete revision, whatever its number, is the baseline.
      session.pushFrame(append(2, 7));
      expect(loadSpans(session)).toEqual([[1, 1]]);

      // The same revision again, and an older one: dropped, nothing asked.
      session.pushFrame(append(3, 7));
      session.pushFrame(append(3, 6));
      expect(loadSpans(session)).toEqual([[1, 1]]);
      expect(resnapshots(session)).toHaveLength(0);

      // The next revision is applied.
      session.pushFrame(append(3, 8));
      expect(loadSpans(session)).toEqual([
        [1, 1],
        [2, 2],
      ]);

      // A revision other than the next is a lost frame.
      session.pushFrame(append(4, 10));
      expect(resnapshots(session)).toHaveLength(1);
      expect(loadSpans(session)).toHaveLength(2);
    });

    it("asks for a fresh snapshot when rows were appended past a gap in the index", () => {
      const { session } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));

      // Five rows appended onto a one-row index: the rows between were lost.
      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 6,
          indexRevision: 1,
          changes: [
            { type: "appended", entries: [skeletonEntry("r5", "assistant")] },
          ],
        }),
      );

      expect(resnapshots(session)).toHaveLength(1);
      expect(loadRanges(session)).toEqual([]);
    });
  });

  describe("a snapshot after the first", () => {
    it("asks for a fresh snapshot when it names a different epoch", () => {
      const { session } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));

      session.pushFrame(
        snapshotAt({
          epoch: 5,
          rowCount: 1,
          indexRevision: 1,
          tailFromOrdinal: 0,
          messages: [resolvedUserRow(null)],
        }),
      );

      expect(resnapshots(session)).toHaveLength(1);
    });

    it("asks for a fresh snapshot when its revision is above the one held", () => {
      const { session } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));
      session.pushFrame(
        changedAt({ epoch: 4, rowCount: 1, indexRevision: 2, changes: [] }),
      );

      session.pushFrame(
        snapshotAt({
          epoch: 4,
          rowCount: 1,
          indexRevision: 4,
          tailFromOrdinal: 0,
          messages: [resolvedUserRow(null)],
        }),
      );
      expect(resnapshots(session)).toHaveLength(1);
    });

    it("takes the first concrete revision as the baseline and applies its tail", async () => {
      const { session, outcome } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));

      // Same epoch, no revision held yet: not a gap, and its tail is read.
      session.pushFrame(
        snapshotAt({
          epoch: 4,
          rowCount: 1,
          indexRevision: 7,
          tailFromOrdinal: 0,
          messages: [resolvedUserRow(null)],
        }),
      );

      await expect(outcome).resolves.toEqual({
        kind: "resolved-without-reply",
      });
      expect(session.sent).toEqual([]);
    });

    it("applies a snapshot at the held revision", async () => {
      const { session, outcome } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));
      session.pushFrame(
        changedAt({ epoch: 4, rowCount: 1, indexRevision: 2, changes: [] }),
      );

      session.pushFrame(
        snapshotAt({
          epoch: 4,
          rowCount: 1,
          indexRevision: 2,
          tailFromOrdinal: 0,
          messages: [resolvedUserRow(null)],
        }),
      );

      await expect(outcome).resolves.toEqual({
        kind: "resolved-without-reply",
      });
      expect(session.sent).toEqual([]);
    });
  });

  describe("a request row outside the snapshot tail (P1-1)", () => {
    it("loads the newest user row, then older user rows until the request is found, then reads the reply", async () => {
      const { session, outcome, settled } = startWait(60_000);
      // Six rows, none in the tail. The request is row 2; rows 4 and 5 are a
      // later request and its reply, rows 0 and 1 an earlier pair.
      session.pushFrame(
        snapshotAt({
          epoch: 1,
          rowCount: 6,
          indexRevision: null,
          tailFromOrdinal: 6,
          messages: [],
        }),
      );
      // Nothing is asked for before the skeleton is whole.
      session.pushFrame(
        chunkAt(
          1,
          0,
          [
            skeletonEntry("u0", "user"),
            skeletonEntry("a1", "assistant"),
            skeletonEntry("u2", "user"),
          ],
          false,
        ),
      );
      expect(session.sent).toEqual([]);
      session.pushFrame(
        chunkAt(
          1,
          3,
          [
            skeletonEntry("a3", "assistant"),
            skeletonEntry("u4", "user"),
            skeletonEntry("a5", "assistant"),
          ],
          true,
        ),
      );

      // The newest user row first, one row only.
      expect(loadSpans(session)).toEqual([[4, 4]]);
      serveWhole(
        session,
        newestLoad(session),
        ["u4"],
        [otherRequestRow(2, "msg-a5")],
      );

      // Another request's row: the next user row down.
      expect(loadSpans(session)).toEqual([
        [4, 4],
        [2, 2],
      ]);
      serveWhole(
        session,
        newestLoad(session),
        ["u2"],
        [resolvedUserRow(REPLY_MESSAGE_ID)],
      );

      // The request is resolved by a reply not read yet: assistant rows now,
      // newest first. Row 0 was never needed.
      expect(loadSpans(session)).toEqual([
        [4, 4],
        [2, 2],
        [5, 5],
      ]);
      serveWhole(
        session,
        newestLoad(session),
        ["a5"],
        [assistantRow({ messageId: "msg-a5", texts: ["a later answer"] })],
      );
      expect(settled()).toBe(false);
      expect(loadSpans(session)).toEqual([
        [4, 4],
        [2, 2],
        [5, 5],
        [3, 3],
      ]);
      serveWhole(session, newestLoad(session), ["a3"], [replyRow]);

      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: REPLY_TEXT,
      });
      expect(resnapshots(session)).toHaveLength(0);
      expect(session.closeCount).toBe(1);
    });

    it("loads an open request row from an empty tail, then waits for deltas", async () => {
      const { session, outcome, settled } = startWait(60_000);
      session.pushFrame(
        snapshotAt({
          epoch: 1,
          rowCount: 1,
          indexRevision: null,
          tailFromOrdinal: 1,
          messages: [],
        }),
      );
      session.pushFrame(skeletonOf(1, [skeletonEntry("u0", "user")]));

      expect(loadSpans(session)).toEqual([[0, 0]]);
      serveWhole(session, newestLoad(session), ["u0"], [openUserRow]);
      await vi.advanceTimersByTimeAsync(5_000);

      // Open: nothing more to look for until the host says something changed.
      expect(settled()).toBe(false);
      expect(loadSpans(session)).toEqual([[0, 0]]);
      expect(resnapshots(session)).toHaveLength(0);

      session.pushFrame(
        changedAt({
          epoch: 1,
          rowCount: 2,
          indexRevision: 1,
          changes: [
            {
              type: "updated",
              entries: [{ ordinal: 0, entry: skeletonEntry("u0", "user") }],
            },
            { type: "appended", entries: [skeletonEntry("a1", "assistant")] },
          ],
        }),
      );
      expect(loadSpans(session)).toEqual([
        [0, 0],
        [0, 1],
      ]);
      serveWhole(
        session,
        newestLoad(session),
        ["u0", "a1"],
        [resolvedUserRow(REPLY_MESSAGE_ID), replyRow],
      );

      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: REPLY_TEXT,
      });
    });

    it("does not search before the skeleton is final, and waits when no user row is left unread", async () => {
      const { session, settled } = startWait(60_000);
      session.pushFrame(
        snapshotAt({
          epoch: 1,
          rowCount: 2,
          indexRevision: null,
          tailFromOrdinal: 2,
          messages: [],
        }),
      );
      session.pushFrame(chunkAt(1, 0, [skeletonEntry("u0", "user")], false));
      expect(session.sent).toEqual([]);

      session.pushFrame(
        chunkAt(1, 1, [skeletonEntry("a1", "assistant")], true),
      );
      serveWhole(
        session,
        newestLoad(session),
        ["u0"],
        [otherRequestRow(1, "x")],
      );
      await vi.advanceTimersByTimeAsync(1_000);

      // The only user row was another request's: the request row is not in
      // this index yet, so the wait goes on for a delta.
      expect(settled()).toBe(false);
      expect(loadSpans(session)).toEqual([[0, 0]]);
      expect(resnapshots(session)).toHaveLength(0);
    });
  });

  describe("an update-only change lost on the wire (P1-2)", () => {
    it("resnapshots once when an update-only change is lost and a later append skips a revision", async () => {
      const { session, outcome, settled } = startWait(60_000);
      session.pushFrame(
        snapshotAt({
          epoch: 1,
          rowCount: 1,
          indexRevision: null,
          tailFromOrdinal: 0,
          messages: [openUserRow],
        }),
      );
      session.pushFrame(skeletonOf(1, [skeletonEntry("u0", "user")]));

      // Revision 1: an unrelated append, taken as the baseline.
      session.pushFrame(
        changedAt({
          epoch: 1,
          rowCount: 2,
          indexRevision: 1,
          changes: [
            { type: "appended", entries: [skeletonEntry("x1", "assistant")] },
          ],
        }),
      );
      serveWhole(session, newestLoad(session), ["x1"], []);

      // Revision 2 - the host resolving the request without a reply, as an
      // update to row 0 - is never delivered. Revision 3 arrives.
      session.pushFrame(
        changedAt({
          epoch: 1,
          rowCount: 3,
          indexRevision: 3,
          changes: [
            { type: "appended", entries: [skeletonEntry("x2", "assistant")] },
          ],
        }),
      );

      expect(resnapshots(session)).toHaveLength(1);
      expect(loadSpans(session)).toEqual([[1, 1]]);
      expect(settled()).toBe(false);

      // The rebuilt index shows the row resolved without a reply.
      session.pushFrame(
        snapshotAt({
          epoch: 1,
          rowCount: 3,
          indexRevision: null,
          tailFromOrdinal: 0,
          messages: [resolvedUserRow(null)],
        }),
      );

      await expect(outcome).resolves.toEqual({
        kind: "resolved-without-reply",
      });
      expect(resnapshots(session)).toHaveLength(1);
    });
  });

  describe("a reply cut short by truncatedAtOrdinal (P2-3)", () => {
    /**
     * The request row is updated and two assistant rows are appended; the host
     * serves only row 0 and says it stopped at ordinal 1.
     */
    function startTruncated() {
      const started = startWait(60_000);
      const { session } = started;
      session.pushFrame(
        snapshotAt({
          epoch: 4,
          rowCount: 1,
          indexRevision: null,
          tailFromOrdinal: 0,
          messages: [openUserRow],
        }),
      );
      session.pushFrame(skeletonOf(4, [skeletonEntry("u0", "user")]));
      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 3,
          indexRevision: 1,
          changes: [
            {
              type: "updated",
              entries: [{ ordinal: 0, entry: skeletonEntry("u0", "user") }],
            },
            {
              type: "appended",
              entries: [
                skeletonEntry("a1", "assistant"),
                skeletonEntry("a2", "assistant"),
              ],
            },
          ],
        }),
      );
      expect(loadSpans(session)).toEqual([[0, 2]]);
      serve(session, newestLoad(session), {
        rowIds: ["u0"],
        messages: [resolvedUserRow(REPLY_MESSAGE_ID)],
        incompleteRowIds: null,
        truncatedAtOrdinal: 1,
      });
      return started;
    }

    it("waits for the remainder instead of resnapshotting, then settles with the reply text", async () => {
      const { session, outcome, settled } = startTruncated();

      // The request is resolved by a reply not read yet, and the rest of the
      // range is on its way: no second search, no fresh snapshot.
      expect(loadSpans(session)).toEqual([
        [0, 2],
        [1, 2],
      ]);
      expect(resnapshots(session)).toHaveLength(0);
      expect(settled()).toBe(false);

      serveWhole(session, newestLoad(session), ["a1", "a2"], [replyRow]);

      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: REPLY_TEXT,
      });
      expect(resnapshots(session)).toHaveLength(0);
    });

    it("reports the reply by id only after one resnapshot whose rebuild also lacks it", async () => {
      const { session, outcome, settled } = startTruncated();

      // The remainder arrives and holds no reply row.
      serveWhole(session, newestLoad(session), ["a1", "a2"], []);
      expect(resnapshots(session)).toHaveLength(1);
      expect(settled()).toBe(false);

      // The rebuilt index does not hold it either.
      session.pushFrame(
        snapshotAt({
          epoch: 4,
          rowCount: 3,
          indexRevision: null,
          tailFromOrdinal: 0,
          messages: [resolvedUserRow(REPLY_MESSAGE_ID)],
        }),
      );
      expect(settled()).toBe(false);
      session.pushFrame(
        skeletonOf(4, [
          skeletonEntry("u0", "user"),
          skeletonEntry("a1", "assistant"),
          skeletonEntry("a2", "assistant"),
        ]),
      );

      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: null,
      });
      expect(resnapshots(session)).toHaveLength(1);
    });
  });

  it("asks for the remainder when a range stops early at truncatedAtOrdinal", async () => {
    const { session, outcome } = startWait(60_000);
    session.pushFrame(snapshotOf([openUserRow], 4));
    session.pushFrame(
      changedAt({
        epoch: 4,
        rowCount: 6,
        indexRevision: 1,
        changes: [
          {
            type: "appended",
            entries: [1, 2, 3, 4, 5].map((n) =>
              skeletonEntry(`r${n}`, "assistant"),
            ),
          },
        ],
      }),
    );
    const [first] = loadRanges(session);
    expect(first).toMatchObject({ fromOrdinal: 1, toOrdinal: 5 });

    session.pushFrame(
      rangeOf({
        requestId: first.requestId,
        epoch: 4,
        fromOrdinal: 1,
        rowIds: ["r1", "r2"],
        messages: [],
        truncatedAtOrdinal: 3,
      }),
    );

    const afterTruncation = loadRanges(session);
    expect(afterTruncation).toHaveLength(2);
    expect(afterTruncation[1]).toMatchObject({
      epoch: 4,
      fromOrdinal: 3,
      toOrdinal: 5,
      maxBytes: TRANSCRIPT_RANGE_MAX_BYTES,
    });
    expect(afterTruncation[1].requestId).not.toBe(first.requestId);

    // A repeat of the answered range asks for nothing more.
    session.pushFrame(
      rangeOf({
        requestId: first.requestId,
        epoch: 4,
        fromOrdinal: 1,
        rowIds: ["r1", "r2"],
        messages: [],
        truncatedAtOrdinal: 3,
      }),
    );
    expect(loadRanges(session)).toHaveLength(2);

    session.pushFrame(
      rangeOf({
        requestId: afterTruncation[1].requestId,
        epoch: 4,
        fromOrdinal: 3,
        rowIds: ["r3", "r4", "r5"],
        messages: [resolvedUserRow(null)],
        truncatedAtOrdinal: null,
      }),
    );
    await expect(outcome).resolves.toEqual({ kind: "resolved-without-reply" });
  });

  describe("a fresh snapshot for the reply", () => {
    it("asks once when the reply row was not read, then reports its id without text", async () => {
      const { session, outcome, settled } = startWait(60_000);

      session.pushFrame(snapshotOf([resolvedUserRow(REPLY_MESSAGE_ID)], 1));
      // The skeleton is not whole yet, so nothing can be said to be missing.
      expect(session.sent).toEqual([]);
      session.pushFrame(skeletonOf(1, [skeletonEntry("u0", "user")]));
      await vi.advanceTimersByTimeAsync(0);

      expect(resnapshots(session)).toHaveLength(1);
      expect(session.sent).toHaveLength(1);
      expect(settled()).toBe(false);
      expect(session.closeCount).toBe(0);

      // The fresh snapshot's tail does not hold the reply row either.
      session.pushFrame(snapshotOf([resolvedUserRow(REPLY_MESSAGE_ID)], 1));
      expect(settled()).toBe(false);
      session.pushFrame(skeletonOf(1, [skeletonEntry("u0", "user")]));

      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: null,
      });
      expect(session.sent).toHaveLength(1);
      expect(session.closeCount).toBe(1);
    });

    it("reports the reply text when the fresh snapshot does hold the reply row", async () => {
      const { session, outcome } = startWait(60_000);

      session.pushFrame(snapshotOf([resolvedUserRow(REPLY_MESSAGE_ID)], 1));
      session.pushFrame(skeletonOf(1, [skeletonEntry("u0", "user")]));
      session.pushFrame(
        snapshotOf([resolvedUserRow(REPLY_MESSAGE_ID), replyRow], 1),
      );

      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: REPLY_TEXT,
      });
      expect(resnapshots(session)).toHaveLength(1);
    });

    it("does not settle on a range that resolves the request without the reply row", async () => {
      const { session, outcome, settled } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));
      session.pushFrame(skeletonOf(4, [skeletonEntry("u0", "user")]));
      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 2,
          indexRevision: 1,
          changes: [
            { type: "appended", entries: [skeletonEntry("r1", "assistant")] },
          ],
        }),
      );
      const [asked] = loadRanges(session);

      serveWhole(session, asked, ["r1"], [resolvedUserRow(REPLY_MESSAGE_ID)]);

      // Only a rebuilt snapshot may report the id without text: a range is
      // asked for its rows, and the reply may still be on its way.
      expect(resnapshots(session)).toHaveLength(1);
      expect(settled()).toBe(false);

      session.pushFrame(snapshotOf([resolvedUserRow(REPLY_MESSAGE_ID)], 4));
      expect(settled()).toBe(false);
      session.pushFrame(skeletonOf(4, [skeletonEntry("u0", "user")]));
      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: null,
      });
    });
  });

  describe("a range that does not belong to the index (P2-4)", () => {
    it("ignores a range answered with a stale epoch after a reindex", async () => {
      const { session, outcome, settled } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));
      session.pushFrame(skeletonOf(4, [skeletonEntry("u0", "user")]));
      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 1,
          indexRevision: 1,
          changes: [{ type: "reindexed" }],
        }),
      );
      expect(resnapshots(session)).toHaveLength(1);

      // The rebuilt index has a new epoch and nothing in its tail: the
      // follower goes looking for the request row.
      session.pushFrame(
        snapshotAt({
          epoch: 5,
          rowCount: 1,
          indexRevision: null,
          tailFromOrdinal: 1,
          messages: [],
        }),
      );
      session.pushFrame(skeletonOf(5, [skeletonEntry("u0", "user")]));
      const asked = newestLoad(session);
      expect(asked).toMatchObject({ epoch: 5, fromOrdinal: 0, toOrdinal: 0 });

      // The answer carries the old epoch: whatever it says is not this index.
      session.pushFrame(
        rangeOf({
          requestId: asked.requestId,
          epoch: 4,
          fromOrdinal: 0,
          rowIds: ["u0"],
          messages: [resolvedUserRow(null)],
          truncatedAtOrdinal: null,
        }),
      );

      expect(settled()).toBe(false);
      expect(resnapshots(session)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(outcome).resolves.toEqual({ kind: "timed-out" });
    });

    it("resnapshots, and does not apply the bodies, when the served row ids differ from the skeleton", async () => {
      const { session, outcome, settled } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));
      session.pushFrame(skeletonOf(4, [skeletonEntry("u0", "user")]));
      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 2,
          indexRevision: 1,
          changes: [
            { type: "appended", entries: [skeletonEntry("r1", "assistant")] },
          ],
        }),
      );
      const asked = newestLoad(session);

      // Ordinal 1 is `r1` in this index; the host served some other row.
      serveWhole(session, asked, ["some-other-row"], [resolvedUserRow(null)]);

      expect(resnapshots(session)).toHaveLength(1);
      expect(settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(outcome).resolves.toEqual({ kind: "timed-out" });
    });

    it("ignores a range for a request sent before a resnapshot", async () => {
      const { session, outcome, settled } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));
      session.pushFrame(skeletonOf(4, [skeletonEntry("u0", "user")]));
      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 2,
          indexRevision: 1,
          changes: [
            { type: "appended", entries: [skeletonEntry("r1", "assistant")] },
          ],
        }),
      );
      const stale = newestLoad(session);
      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 2,
          indexRevision: 2,
          changes: [{ type: "reindexed" }],
        }),
      );
      expect(resnapshots(session)).toHaveLength(1);

      // Same epoch, same ordinals, and the right row id: only the request id
      // says it was asked of the index that is gone.
      serveWhole(session, stale, ["r1"], [resolvedUserRow(null)]);

      expect(settled()).toBe(false);
      expect(resnapshots(session)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(outcome).resolves.toEqual({ kind: "timed-out" });
    });

    it("forgets the reply rows read from the index a resnapshot replaces", async () => {
      const { session, outcome, settled } = startWait(60_000);
      // The request is open and the reply row is already in the tail.
      session.pushFrame(snapshotOf([openUserRow, replyRow], 4));
      session.pushFrame(
        skeletonOf(4, [
          skeletonEntry("u0", "user"),
          skeletonEntry("a1", "assistant"),
        ]),
      );
      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 2,
          indexRevision: 1,
          changes: [{ type: "reindexed" }],
        }),
      );
      expect(resnapshots(session)).toHaveLength(1);

      // The rebuilt index resolves the request by that reply and no longer
      // holds the reply row: the old text must not be reported for it.
      session.pushFrame(snapshotOf([resolvedUserRow(REPLY_MESSAGE_ID)], 5));
      session.pushFrame(skeletonOf(5, [skeletonEntry("u0", "user")]));

      expect(settled()).toBe(false);
      // The one extra fresh snapshot the follower allows itself.
      expect(resnapshots(session)).toHaveLength(2);

      session.pushFrame(
        snapshotOf([resolvedUserRow(REPLY_MESSAGE_ID), replyRow], 5),
      );
      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: REPLY_TEXT,
      });
    });

    it("forgets the request row read from the index a resnapshot replaces", async () => {
      const { session } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));
      session.pushFrame(skeletonOf(4, [skeletonEntry("u0", "user")]));
      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 1,
          indexRevision: 1,
          changes: [{ type: "reindexed" }],
        }),
      );
      expect(loadRanges(session)).toEqual([]);

      // The rebuilt tail is empty: the request is not known to be open any
      // more, so the follower has to find its row again.
      session.pushFrame(
        snapshotAt({
          epoch: 5,
          rowCount: 1,
          indexRevision: null,
          tailFromOrdinal: 1,
          messages: [],
        }),
      );
      session.pushFrame(skeletonOf(5, [skeletonEntry("u0", "user")]));

      expect(loadSpans(session)).toEqual([[0, 0]]);
      expect(newestLoad(session).epoch).toBe(5);
    });
  });

  describe("a reconnect's fresh snapshot", () => {
    it("re-reads where the request stands, as it may have been resolved while the stream was down", async () => {
      const { session, outcome, settled } = startWait(60_000);
      // Before the drop the request row is read from the tail, open.
      session.pushFrame(snapshotOf([openUserRow], 1));
      session.pushFrame(skeletonOf(1, [skeletonEntry("u0", "user")]));
      expect(settled()).toBe(false);
      expect(loadRanges(session)).toEqual([]);

      // The stream drops; the follower ignores it and waits for the next
      // snapshot.
      session.pushStatus("reconnecting", null);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled()).toBe(false);

      // The host rebuilt its index. The request was resolved meanwhile, and
      // its row and the reply are both outside the empty tail.
      session.pushFrame(
        snapshotAt({
          epoch: 2,
          rowCount: 2,
          indexRevision: null,
          tailFromOrdinal: 2,
          messages: [],
        }),
      );
      session.pushFrame(
        skeletonOf(2, [
          skeletonEntry("u0", "user"),
          skeletonEntry("a1", "assistant"),
        ]),
      );

      // The open request read before the drop is forgotten: its row is looked
      // for again, on the new epoch.
      expect(loadSpans(session)).toEqual([[0, 0]]);
      expect(newestLoad(session).epoch).toBe(2);
      serveWhole(
        session,
        newestLoad(session),
        ["u0"],
        [resolvedUserRow(REPLY_MESSAGE_ID)],
      );

      // Resolved by a reply not read yet: the reply row is read next.
      expect(loadSpans(session)).toEqual([
        [0, 0],
        [1, 1],
      ]);
      expect(newestLoad(session).epoch).toBe(2);
      serveWhole(session, newestLoad(session), ["a1"], [replyRow]);

      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: REPLY_TEXT,
      });
      expect(resnapshots(session)).toHaveLength(0);
      expect(session.closeCount).toBe(1);
    });
  });

  describe("a rebuild that has not arrived", () => {
    it("asks once, however many snapshots of the old index arrive first", async () => {
      const { session, outcome } = startWait(60_000);
      session.pushFrame(snapshotOf([openUserRow], 4));
      session.pushFrame(skeletonOf(4, [skeletonEntry("u0", "user")]));
      session.pushFrame(
        changedAt({
          epoch: 4,
          rowCount: 1,
          indexRevision: 1,
          changes: [{ type: "reindexed" }],
        }),
      );
      expect(resnapshots(session)).toHaveLength(1);

      // Snapshots still on the wire from the old index: a different epoch,
      // and a revision above any held.
      session.pushFrame(
        snapshotAt({
          epoch: 4,
          rowCount: 1,
          indexRevision: 5,
          tailFromOrdinal: 0,
          messages: [openUserRow],
        }),
      );
      session.pushFrame(
        snapshotAt({
          epoch: 3,
          rowCount: 1,
          indexRevision: 6,
          tailFromOrdinal: 0,
          messages: [resolvedUserRow(null)],
        }),
      );

      expect(resnapshots(session)).toHaveLength(1);
      expect(session.sent).toHaveLength(1);

      // The rebuild arrives and is followed; the old snapshots settled nothing.
      session.pushFrame(snapshotOf([resolvedUserRow(null)], 6));
      await expect(outcome).resolves.toEqual({
        kind: "resolved-without-reply",
      });
      expect(resnapshots(session)).toHaveLength(1);
    });
  });

  describe("a search for an incomplete row", () => {
    it("does not ask again for a row the host served as incomplete, and moves to the next older candidate", async () => {
      const { session, outcome } = startWait(60_000);
      session.pushFrame(
        snapshotAt({
          epoch: 1,
          rowCount: 4,
          indexRevision: null,
          tailFromOrdinal: 4,
          messages: [],
        }),
      );
      session.pushFrame(
        skeletonOf(1, [
          skeletonEntry("u0", "user"),
          skeletonEntry("a1", "assistant"),
          skeletonEntry("a2", "assistant"),
          skeletonEntry("a3", "assistant"),
        ]),
      );
      serveWhole(
        session,
        newestLoad(session),
        ["u0"],
        [resolvedUserRow(REPLY_MESSAGE_ID)],
      );
      expect(loadSpans(session)).toEqual([
        [0, 0],
        [3, 3],
      ]);

      // The newest assistant row comes back without its whole body.
      serve(session, newestLoad(session), {
        rowIds: ["a3"],
        messages: [],
        incompleteRowIds: ["a3"],
        truncatedAtOrdinal: null,
      });

      // Not row 3 again: the next older one.
      expect(loadSpans(session)).toEqual([
        [0, 0],
        [3, 3],
        [2, 2],
      ]);
      serveWhole(session, newestLoad(session), ["a2"], [replyRow]);

      await expect(outcome).resolves.toEqual({
        kind: "replied",
        replyMessageId: REPLY_MESSAGE_ID,
        text: REPLY_TEXT,
      });
    });
  });

  it("times out after exactly the wait, leaves the request open, and closes the session", async () => {
    const { session, outcome, settled } = startWait(30_000);
    session.pushFrame(snapshotOf([openUserRow], 1));

    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled()).toBe(false);
    expect(session.closeCount).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toEqual({ kind: "timed-out" });
    expect(session.closeCount).toBe(1);
  });

  describe("a fatal close of the stream (P3-6)", () => {
    it("rejects with E_HOST_UNREACHABLE on a fatal close, and closes the session", async () => {
      const { session, outcome } = startWait(60_000);

      session.pushStatus(
        "closed",
        fatalClose({
          code: "INTERNAL",
          reason: "lost the host",
          incompatibleMethod: null,
        }),
      );

      await expect(outcome).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_UNREACHABLE,
        exitCode: 1,
        message:
          "traycer: stopped following the conversation - lost the host. The message was sent; the request stays open.",
      });
      expect(session.closeCount).toBe(1);
    });

    it("rejects with the host-update line when the close is incompatible for chat.subscribe", async () => {
      const { session, outcome } = startWait(60_000);

      session.pushStatus(
        "closed",
        fatalClose({
          code: "INCOMPATIBLE",
          reason: "host does not offer chat.subscribe",
          incompatibleMethod: "chat.subscribe",
        }),
      );

      await expect(outcome).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_UNSUPPORTED,
        exitCode: 1,
        message: BOT_HOST_UPDATE_MESSAGE,
      });
      expect(session.closeCount).toBe(1);
    });

    it("rejects with the host-update line when the client reports chat.subscribe unsupported", async () => {
      const { session, client, outcome } = startWait(60_000);
      client.methodSupport = "unsupported";

      session.pushStatus(
        "closed",
        fatalClose({
          code: "INTERNAL",
          reason: "anything",
          incompatibleMethod: null,
        }),
      );

      await expect(outcome).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_UNSUPPORTED,
        message: BOT_HOST_UPDATE_MESSAGE,
      });
    });

    it("does not read an incompatible close about another method as missing bots", async () => {
      const { session, outcome } = startWait(60_000);

      session.pushStatus(
        "closed",
        fatalClose({
          code: "INCOMPATIBLE",
          reason: "protocol skew",
          incompatibleMethod: "bot.subscribe",
        }),
      );

      await expect(outcome).rejects.toMatchObject({
        code: CLI_ERROR_CODES.HOST_UNREACHABLE,
      });
    });
  });

  it("rides out a reconnect or a caller close and stays bounded by the timeout", async () => {
    const { session, outcome, settled } = startWait(30_000);

    session.pushStatus("reconnecting", null);
    session.pushStatus("closed", { kind: "caller" });
    session.pushStatus("open", null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(outcome).resolves.toEqual({ kind: "timed-out" });
  });

  it("rejects with E_HOST_INCOMPATIBLE on a row-bearing frame it cannot read", async () => {
    const { session, outcome } = startWait(60_000);

    session.pushFrame({
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: BOT_ID_A,
      chatId: CONVERSATION_ID,
      snapshot: { rowCount: "many" },
    });

    await expect(outcome).rejects.toMatchObject({
      code: CLI_ERROR_CODES.HOST_INCOMPATIBLE,
      exitCode: 1,
    });
    expect(session.closeCount).toBe(1);
  });

  it("ignores a frame it cannot read that carries no rows", async () => {
    const { session, outcome, settled } = startWait(30_000);

    session.pushFrame({ kind: "turnStateChanged", hasBinaryPayload: false });
    session.pushFrame({ kind: "somethingNew", hasBinaryPayload: false });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled()).toBe(false);
    expect(session.sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(outcome).resolves.toEqual({ kind: "timed-out" });
  });

  it("settles once: later frames, status changes and the timer do nothing", async () => {
    const { session, outcome } = startWait(30_000);
    session.pushFrame(snapshotOf([resolvedUserRow(null)], 1));
    await expect(outcome).resolves.toEqual({ kind: "resolved-without-reply" });

    session.pushFrame(
      changedAt({
        epoch: 2,
        rowCount: 2,
        indexRevision: 1,
        changes: [{ type: "reindexed" }],
      }),
    );
    session.pushStatus(
      "closed",
      fatalClose({
        code: "INTERNAL",
        reason: "late",
        incompatibleMethod: null,
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);

    // Closed once, at the moment it settled; nothing after it closes it again
    // or asks for anything - not a range, not a fresh snapshot.
    expect(session.closeCount).toBe(1);
    expect(session.sent).toEqual([]);
  });
});

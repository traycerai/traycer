import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import { BOT_HOST_UPDATE_MESSAGE } from "../../internal/bot-host";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandResult } from "../../runner/runner";
import {
  BOT_ID_A,
  OTHER_HOST_ID,
  THIS_HOST_ID,
  botRecord,
  makeCtx,
  routeRpc,
  unsupportedRpcError,
} from "./bot-test-support";
import { buildBotThreadsCommand } from "../bot-threads";

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

beforeEach(() => {
  vi.resetAllMocks();
  hoisted.resolveEndpoint.mockResolvedValue({
    hostId: THIS_HOST_ID,
    websocketUrl: "ws://127.0.0.1:9999/rpc",
  });
});

/** Two threads as the host lists them, most recent activity first. */
const THREADS = [
  {
    threadId: "thread-2",
    conversationId: "conv-1",
    sessionChatId: "session-2",
    anchor: {
      messageId: "msg-2",
      requestId: "req-2",
      senderUserId: "user-1",
      text: "Ship the release\nwith the notes",
      sentAt: 3_000,
      resolvedAt: null,
    },
    replyCount: 3,
    lastReplyAt: Date.UTC(2026, 9, 23, 14, 2, 11),
    openRequestCount: 2,
    costUsd: 0.4234,
  },
  {
    threadId: "thread-1",
    conversationId: "conv-1",
    sessionChatId: "session-1",
    anchor: null,
    replyCount: 0,
    lastReplyAt: null,
    openRequestCount: 1,
    costUsd: null,
  },
];

function stage(input: {
  readonly bot: BotRecord;
  readonly threads: () => unknown;
}): void {
  hoisted.callHostRpc.mockImplementation(
    routeRpc({
      "bot.list": () => ({ bots: [input.bot] }),
      "bot.thread.list": () => input.threads(),
    }),
  );
}

function threads(bot: string): Promise<CommandResult> {
  return buildBotThreadsCommand({ bot })(makeCtx());
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

function threadListCalls(): unknown[] {
  return hoisted.callHostRpc.mock.calls
    .filter((call) => call[0] === "bot.thread.list")
    .map((call) => call[1]);
}

describe("bot threads", () => {
  const tracy = botRecord({ botId: BOT_ID_A, title: "Tracy" });

  it("lists each thread with its post, replies, open requests and cost, in the host's order", async () => {
    stage({ bot: tracy, threads: () => ({ threads: THREADS }) });

    const result = await threads("tracy");

    expect(threadListCalls()).toEqual([{ botId: BOT_ID_A }]);
    expect(result.human).toBe(
      [
        "Tracy",
        '  thread-2  "Ship the release"  3 replies, last 2026-10-23T14:02:11Z  2 open requests  $0.42',
        "  thread-1  (post removed)  no replies  1 open request  cost unknown",
      ].join("\n"),
    );
    expect(result.data).toEqual({ botId: BOT_ID_A, threads: THREADS });
    expect(result.exitCode).toBe(0);
  });

  it("says when the bot has no threads", async () => {
    stage({ bot: tracy, threads: () => ({ threads: [] }) });

    const result = await threads(BOT_ID_A);

    expect(result.human).toBe("Tracy has no threads yet.");
    expect(result.exitCode).toBe(0);
  });

  it("rejects a listing the protocol schema does not accept", async () => {
    stage({
      bot: tracy,
      threads: () => ({
        threads: [{ ...THREADS[0], openRequestCount: -1 }],
      }),
    });

    const error = await rejection(threads(BOT_ID_A));

    expect(error.code).toBe(CLI_ERROR_CODES.HOST_INCOMPATIBLE);
  });

  it("refuses a bot bound to another host before asking for its threads", async () => {
    stage({
      bot: botRecord({ botId: BOT_ID_A, boundHostId: OTHER_HOST_ID }),
      threads: () => ({ threads: THREADS }),
    });

    const error = await rejection(threads(BOT_ID_A));

    expect(error.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe(
      "traycer: Tracy runs on another of your hosts; its threads are listed only there.",
    );
    expect(threadListCalls()).toEqual([]);
  });

  it("refuses a bot no host runs", async () => {
    stage({
      bot: botRecord({ botId: BOT_ID_A, boundHostId: null }),
      threads: () => ({ threads: THREADS }),
    });

    const error = await rejection(threads(BOT_ID_A));

    expect(error.message).toBe(
      "traycer: no host runs Tracy; move it to a host first.",
    );
    expect(threadListCalls()).toEqual([]);
  });
});

describe("bot threads on a host without them", () => {
  it.each(["bot.list", "bot.thread.list"])(
    "prints the update line when %s is unsupported",
    async (missing) => {
      hoisted.callHostRpc.mockImplementation(
        routeRpc({
          "bot.list": () => {
            if (missing === "bot.list") throw unsupportedRpcError(missing);
            return { bots: [botRecord({ botId: BOT_ID_A })] };
          },
          "bot.thread.list": () => {
            throw unsupportedRpcError(missing);
          },
        }),
      );

      const error = await rejection(threads(BOT_ID_A));

      expect(error.message).toBe(BOT_HOST_UPDATE_MESSAGE);
      expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
      expect(error.exitCode).toBe(1);
    },
  );
});

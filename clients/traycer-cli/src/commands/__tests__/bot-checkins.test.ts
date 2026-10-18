import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import {
  BOT_HOST_UPDATE_MESSAGE,
  BOT_SNAPSHOT_DEADLINE_MS,
  formatBotTime,
  readBotSnapshot,
} from "../../internal/bot-host";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import type { CommandResult } from "../../runner/runner";
import {
  BOT_ID_A,
  BOT_ID_B,
  THIS_HOST_ID,
  FakeStreamClient,
  botDeletedFrame,
  botRecord,
  botSnapshotFrame,
  botSubscribeClient,
  fatalClose,
  makeCtx,
  routeRpc,
  taskEntry,
  unsupportedRpcError,
} from "./bot-test-support";
import { buildBotCheckinsCommand, renderCheckins } from "../bot-checkins";

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

// 2023-11-14T22:13:20Z, and one hour later.
const T0 = 1_700_000_000_000;
const T1 = T0 + 3_600_000;

const tracy = botRecord({ botId: BOT_ID_A, title: "Tracy" });

function stage(input: {
  readonly bots: readonly BotRecord[];
  readonly client: FakeStreamClient;
}): void {
  hoisted.callHostRpc.mockImplementation(
    routeRpc({ "bot.list": () => ({ bots: input.bots }) }),
  );
  hoisted.openLocalStreamClient.mockResolvedValue({
    client: input.client,
    endpoint: ENDPOINT,
  });
}

function run(input: {
  readonly bot: string;
  readonly taskId: string | null;
}): Promise<CommandResult> {
  return buildBotCheckinsCommand(input)(makeCtx());
}

async function rejection(promise: Promise<CommandResult>): Promise<CliError> {
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CliError)) {
    throw new Error("expected the command to reject with a CliError");
  }
  return error;
}

beforeEach(() => {
  vi.resetAllMocks();
  hoisted.resolveEndpoint.mockResolvedValue(ENDPOINT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatBotTime", () => {
  it("is UTC to the second, with no milliseconds", () => {
    expect(formatBotTime(T0)).toBe("2023-11-14T22:13:20Z");
    expect(formatBotTime(T0 + 999)).toBe("2023-11-14T22:13:20Z");
    expect(formatBotTime(T1)).toBe("2023-11-14T23:13:20Z");
  });
});

describe("bot checkins", () => {
  it("renders each task's cadence, state, last check-in and next one", async () => {
    const tasks = [
      taskEntry({
        taskId: "task-hourly",
        cadence: { kind: "every", seconds: 3600 },
        lastCheckinAt: T0,
        nextAt: T1,
      }),
      taskEntry({
        taskId: "task-90s",
        cadence: { kind: "every", seconds: 90 },
        lastCheckinAt: null,
        nextAt: T0,
      }),
      taskEntry({
        taskId: "task-once",
        cadence: { kind: "on-completion" },
        lastCheckinAt: null,
        nextAt: null,
      }),
      taskEntry({
        taskId: "task-done",
        cadence: { kind: "on-completion" },
        lastCheckinAt: T1,
        state: "ended",
        endedReason: "completed",
      }),
      taskEntry({
        taskId: "task-muted",
        cadence: { kind: "none" },
        lastCheckinAt: T0,
        state: "ended",
        endedReason: "by-bot",
      }),
    ];
    stage({
      bots: [tracy],
      client: botSubscribeClient({
        [BOT_ID_A]: botSnapshotFrame(tracy, tasks, 0),
      }),
    });

    const result = await run({ bot: BOT_ID_A, taskId: null });

    expect(result.human).toBe(
      [
        "Tracy",
        "  task-hourly  every 1h  following  last check-in 2023-11-14T22:13:20Z  next 2023-11-14T23:13:20Z",
        "  task-90s  every 90s  following  last check-in never  next 2023-11-14T22:13:20Z",
        "  task-once  when finished  following  last check-in never",
        "  task-done  when finished  stopped: task finished  last check-in 2023-11-14T23:13:20Z",
        "  task-muted  no check-ins  stopped by the bot  last check-in 2023-11-14T22:13:20Z",
      ].join("\n"),
    );
    expect(result.data).toEqual({ botId: BOT_ID_A, tasks });
    expect(result.exitCode).toBe(0);
  });

  it("shows 'next' only for a task that has a due time, and never for the other cadences", async () => {
    const tasks = [
      taskEntry({
        taskId: "task-every",
        cadence: { kind: "every", seconds: 60 },
        nextAt: T1,
      }),
      taskEntry({
        taskId: "task-every-ended",
        cadence: { kind: "every", seconds: 60 },
        nextAt: null,
        state: "ended",
        endedReason: "deleted",
      }),
      taskEntry({
        taskId: "task-completion",
        cadence: { kind: "on-completion" },
      }),
      taskEntry({ taskId: "task-none", cadence: { kind: "none" } }),
    ];
    stage({
      bots: [tracy],
      client: botSubscribeClient({
        [BOT_ID_A]: botSnapshotFrame(tracy, tasks, 0),
      }),
    });

    const result = await run({ bot: BOT_ID_A, taskId: null });

    const lines = (result.human ?? "").split("\n");
    expect(lines.filter((line) => line.includes("  next "))).toEqual([
      "  task-every  every 1m  following  last check-in never  next 2023-11-14T23:13:20Z",
    ]);
  });

  it.each([
    { reason: "by-bot", text: "stopped by the bot" },
    { reason: "deleted", text: "stopped: task deleted" },
    { reason: "archived", text: "stopped: task archived" },
    { reason: "completed", text: "stopped: task finished" },
  ] as const)(
    "says '$text' for a task that ended as $reason",
    async ({ reason, text }) => {
      const tasks = [
        taskEntry({ taskId: "task-1", state: "ended", endedReason: reason }),
      ];
      stage({
        bots: [tracy],
        client: botSubscribeClient({
          [BOT_ID_A]: botSnapshotFrame(tracy, tasks, 0),
        }),
      });

      const result = await run({ bot: BOT_ID_A, taskId: null });

      expect(result.human).toBe(
        `Tracy\n  task-1  every 1h  ${text}  last check-in never`,
      );
    },
  );

  it.each([
    { seconds: 86_400, text: "every 1d" },
    { seconds: 172_800, text: "every 2d" },
    { seconds: 7_200, text: "every 2h" },
    { seconds: 300, text: "every 5m" },
    { seconds: 90, text: "every 90s" },
    { seconds: 45, text: "every 45s" },
    { seconds: 3_660, text: "every 61m" },
  ])("writes a $seconds second cadence as '$text'", ({ seconds, text }) => {
    const rendered = renderCheckins("Tracy", [
      taskEntry({ cadence: { kind: "every", seconds } }),
    ]);

    expect(rendered).toBe(
      `Tracy\n  task-1  ${text}  following  last check-in never`,
    );
  });

  it("limits the answer to the named task", async () => {
    const tasks = [
      taskEntry({ taskId: "task-1" }),
      taskEntry({ taskId: "task-2", cadence: { kind: "on-completion" } }),
      taskEntry({ taskId: "task-3", cadence: { kind: "none" } }),
    ];
    stage({
      bots: [tracy],
      client: botSubscribeClient({
        [BOT_ID_A]: botSnapshotFrame(tracy, tasks, 0),
      }),
    });

    const result = await run({ bot: BOT_ID_A, taskId: "task-2" });

    expect(result.human).toBe(
      "Tracy\n  task-2  when finished  following  last check-in never",
    );
    expect(result.data).toEqual({ botId: BOT_ID_A, tasks: [tasks[1]] });
  });

  it("refuses a task the bot does not follow", async () => {
    stage({
      bots: [tracy],
      client: botSubscribeClient({
        [BOT_ID_A]: botSnapshotFrame(
          tracy,
          [taskEntry({ taskId: "task-1" })],
          0,
        ),
      }),
    });

    const error = await rejection(run({ bot: BOT_ID_A, taskId: "task-9" }));

    expect(error.code).toBe(CLI_ERROR_CODES.NOT_FOUND);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe("traycer: Tracy does not follow task task-9.");
  });

  it("refuses a named task when the bot follows no tasks at all", async () => {
    stage({
      bots: [tracy],
      client: botSubscribeClient({
        [BOT_ID_A]: botSnapshotFrame(tracy, [], 0),
      }),
    });

    const error = await rejection(run({ bot: BOT_ID_A, taskId: "task-1" }));

    expect(error.code).toBe(CLI_ERROR_CODES.NOT_FOUND);
    expect(error.message).toBe("traycer: Tracy does not follow task task-1.");
  });

  it("says so when the bot follows no tasks", async () => {
    stage({
      bots: [tracy],
      client: botSubscribeClient({
        [BOT_ID_A]: botSnapshotFrame(tracy, [], 0),
      }),
    });

    const result = await run({ bot: BOT_ID_A, taskId: null });

    expect(result.human).toBe("Tracy follows no tasks.");
    expect(result.data).toEqual({ botId: BOT_ID_A, tasks: [] });
    expect(result.exitCode).toBe(0);
  });

  it("refuses a bot whose snapshot answers deleted", async () => {
    stage({
      bots: [tracy],
      client: botSubscribeClient({ [BOT_ID_A]: botDeletedFrame() }),
    });

    const error = await rejection(run({ bot: BOT_ID_A, taskId: null }));

    expect(error.code).toBe(CLI_ERROR_CODES.NOT_FOUND);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe("traycer: the bot 'Tracy' was deleted.");
  });

  it("finds the bot by its title, ignoring case, and reads that bot's stream", async () => {
    const scout = botRecord({ botId: BOT_ID_B, title: "Scout" });
    const client = botSubscribeClient({
      [BOT_ID_A]: botSnapshotFrame(tracy, [], 0),
      [BOT_ID_B]: botSnapshotFrame(scout, [taskEntry({ taskId: "task-s" })], 0),
    });
    stage({ bots: [tracy, scout], client });

    const result = await run({ bot: "sCoUt", taskId: null });

    expect(client.sessions.map((session) => session.params)).toEqual([
      { botId: BOT_ID_B },
    ]);
    expect(result.human).toMatch(/^Scout\n {2}task-s /);
  });

  it("refuses an ambiguous title and a bot nobody has, without opening a stream", async () => {
    const twin = botRecord({ botId: BOT_ID_B, title: "tracy" });
    stage({
      bots: [tracy, twin],
      client: botSubscribeClient({}),
    });

    const ambiguous = await rejection(run({ bot: "TRACY", taskId: null }));
    expect(ambiguous.code).toBe(CLI_ERROR_CODES.INVALID_ARGUMENT);
    expect(ambiguous.message).toBe(
      `traycer: more than one bot is called 'TRACY' - name it by id: ${BOT_ID_A}, ${BOT_ID_B}.`,
    );

    const unknown = await rejection(run({ bot: "Nobody", taskId: null }));
    expect(unknown.code).toBe(CLI_ERROR_CODES.NOT_FOUND);
    expect(unknown.message).toBe(
      "traycer: no bot called 'Nobody' - run `traycer bot list` to see yours.",
    );

    expect(hoisted.openLocalStreamClient).not.toHaveBeenCalled();
  });

  it("closes the session and the stream client once the snapshot is read", async () => {
    const client = botSubscribeClient({
      [BOT_ID_A]: botSnapshotFrame(tracy, [taskEntry({ taskId: "task-1" })], 0),
    });
    stage({ bots: [tracy], client });

    await run({ bot: BOT_ID_A, taskId: null });

    expect(client.sessions.map((session) => session.method)).toEqual([
      "bot.subscribe",
    ]);
    expect(client.sessions[0].closeCount).toBe(1);
    expect(client.closeReasons).toEqual(["bot-checkins-settled"]);
  });

  it("closes the stream client when the read fails or the task is refused", async () => {
    const failing = new FakeStreamClient((session) => {
      session.pushStatus(
        "closed",
        fatalClose({
          code: "INTERNAL",
          reason: "host blew up",
          incompatibleMethod: null,
        }),
      );
    });
    stage({ bots: [tracy], client: failing });

    const error = await rejection(run({ bot: BOT_ID_A, taskId: null }));
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNREACHABLE);
    expect(failing.closeReasons).toEqual(["bot-checkins-settled"]);

    const refusing = botSubscribeClient({
      [BOT_ID_A]: botSnapshotFrame(tracy, [], 0),
    });
    stage({ bots: [tracy], client: refusing });

    await rejection(run({ bot: BOT_ID_A, taskId: "task-1" }));
    expect(refusing.closeReasons).toEqual(["bot-checkins-settled"]);
  });
});

describe("bot checkins on a host without bots", () => {
  async function expectUpdateMessage(promise: Promise<CommandResult>) {
    const error = await rejection(promise);
    expect(error.message).toBe(BOT_HOST_UPDATE_MESSAGE);
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNSUPPORTED);
    expect(error.exitCode).toBe(1);
  }

  it("rejects with the update message when bot.list is unsupported", async () => {
    hoisted.callHostRpc.mockImplementation(
      routeRpc({
        "bot.list": () => {
          throw unsupportedRpcError("bot.list");
        },
      }),
    );

    await expectUpdateMessage(run({ bot: BOT_ID_A, taskId: null }));

    expect(hoisted.openLocalStreamClient).not.toHaveBeenCalled();
  });

  it("rejects with the update message when bot.subscribe closes as incompatible for that method", async () => {
    const client = new FakeStreamClient((session) => {
      session.pushStatus(
        "closed",
        fatalClose({
          code: "INCOMPATIBLE",
          reason: "host does not offer bot.subscribe",
          incompatibleMethod: "bot.subscribe",
        }),
      );
    });
    stage({ bots: [tracy], client });

    await expectUpdateMessage(run({ bot: BOT_ID_A, taskId: null }));

    expect(client.closeReasons).toEqual(["bot-checkins-settled"]);
  });

  it("rejects with the update message when the client reports bot.subscribe unsupported", async () => {
    const client = new FakeStreamClient((session) => {
      session.pushStatus("closed", { kind: "caller" });
    });
    client.methodSupport = "unsupported";
    stage({ bots: [tracy], client });

    await expectUpdateMessage(run({ bot: BOT_ID_A, taskId: null }));
  });
});

describe("a bot.subscribe read that never answers", () => {
  const NO_ANSWER_MESSAGE =
    "traycer: could not read the bot from this host - no answer in time. Try again.";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("readBotSnapshot rejects with E_HOST_UNREACHABLE after the deadline and closes its session", async () => {
    const client = new FakeStreamClient(() => undefined);
    const read = readBotSnapshot(client, BOT_ID_A).then(
      () => null,
      (caught: unknown) => caught,
    );

    await vi.advanceTimersByTimeAsync(BOT_SNAPSHOT_DEADLINE_MS - 1);
    expect(client.sessions[0].closeCount).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    const error = await read;

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("expected a CliError");
    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNREACHABLE);
    expect(error.exitCode).toBe(1);
    expect(error.message).toBe(NO_ANSWER_MESSAGE);
    expect(client.sessions[0].closeCount).toBe(1);
  });

  it("readBotSnapshot ignores a snapshot that arrives after the deadline", async () => {
    const client = new FakeStreamClient(() => undefined);
    const read = readBotSnapshot(client, BOT_ID_A).then(
      () => null,
      (caught: unknown) => caught,
    );
    await vi.advanceTimersByTimeAsync(BOT_SNAPSHOT_DEADLINE_MS);
    await read;

    client.sessions[0].pushFrame(botSnapshotFrame(tracy, [], 3));

    expect(client.sessions[0].closeCount).toBe(1);
  });

  it("readBotSnapshot spends no deadline once it has an answer", async () => {
    const client = botSubscribeClient({
      [BOT_ID_A]: botSnapshotFrame(tracy, [], 3),
    });

    const snapshot = await readBotSnapshot(client, BOT_ID_A);
    await vi.advanceTimersByTimeAsync(BOT_SNAPSHOT_DEADLINE_MS);

    expect(snapshot).toMatchObject({ openRequestCount: 3 });
    expect(vi.getTimerCount()).toBe(0);
    expect(client.sessions[0].closeCount).toBe(1);
  });

  it("bot checkins rejects with E_HOST_UNREACHABLE after the deadline and closes the client", async () => {
    const client = new FakeStreamClient(() => undefined);
    stage({ bots: [tracy], client });

    const outcome = rejection(run({ bot: BOT_ID_A, taskId: null }));
    await vi.advanceTimersByTimeAsync(BOT_SNAPSHOT_DEADLINE_MS);
    const error = await outcome;

    expect(error.code).toBe(CLI_ERROR_CODES.HOST_UNREACHABLE);
    expect(error.message).toBe(NO_ANSWER_MESSAGE);
    expect(client.sessions[0].closeCount).toBe(1);
    expect(client.closeReasons).toEqual(["bot-checkins-settled"]);
  });
});

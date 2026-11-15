import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  MANAGED_COMMAND_MAX_WINDOW_LINES,
  managedCommandSubscribeOutputOpenRequestSchema,
  managedCommandSubscribeOutputServerFrameSchema,
  managedCommandSubscribeOutputServerFrameSchemaV10,
} from "@traycer/protocol/host/managed-command/subscribe";

/**
 * `managedCommand.subscribeBotOutput@1.0`: the bot-scoped sibling of the output
 * window. A bot's shell output is read by a viewer who may read the bot and the
 * viewed session; the stream names all three identities, and the existing epic
 * stream keeps meaning exactly what it does now.
 */

const BOT_METHOD = "managedCommand.subscribeBotOutput";
const EPIC_METHOD = "managedCommand.subscribeOutput";

const POSITION = { segmentId: "66310:12:1710000000123", byteOffset: 4_096 };

const RUNNING_COMMAND = {
  id: "cmd-deploy",
  monitoring: true,
  description: "deploy watcher",
  relaunchOnHostRestart: true,
  status: {
    state: "running" as const,
    pid: 4410,
    startedAtMs: 1_700_000_000_000,
  },
  chatId: "chat-a",
  createdAtMs: 1_699_999_000_000,
  updatedAtMs: 1_700_000_000_000,
};

function botLine() {
  const entry = Object.entries(hostStreamRpcRegistry).find(
    ([name]) => name === BOT_METHOD,
  );
  return entry === undefined ? null : entry[1];
}

describe("managedCommand.subscribeBotOutput registry membership", () => {
  it("installs the bot output stream at 1.0 under its own method name", () => {
    const line = botLine();
    expect(line).not.toBeNull();
    expect(line?.[1].latestMinor).toBe(0);
    expect(line?.[1].versions[0].contract.method).toBe(BOT_METHOD);
  });

  it("stays off the released floor: an older host lacks it per call, never at the handshake", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(BOT_METHOD);
  });

  it("leaves the epic output stream's line exactly where it was", () => {
    const line = hostStreamRpcRegistry[EPIC_METHOD];
    expect(line[1].latestMinor).toBe(1);
    expect(botLine()).not.toBe(line);
  });
});

describe("managedCommand.subscribeBotOutput open request", () => {
  const openSchema = () =>
    botLine()?.[1].versions[0].contract.openRequestSchema;

  it("carries the bot, the viewed session's chat and the command", () => {
    const schema = openSchema();
    expect(schema).toBeDefined();
    expect(
      schema?.safeParse({
        botId: "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1",
        sessionChatId: "chat-thread-1",
        commandId: "cmd-deploy",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["no session", { botId: "bot-1", commandId: "cmd-1" }],
    ["no bot", { sessionChatId: "chat-1", commandId: "cmd-1" }],
    ["no command", { botId: "bot-1", sessionChatId: "chat-1" }],
    [
      "an epic id in place of the bot",
      { epicId: "bot-1", sessionChatId: "chat-1", commandId: "cmd-1" },
    ],
  ])("refuses a request with %s", (_name, request) => {
    const schema = openSchema();
    expect(schema).toBeDefined();
    expect(schema?.safeParse(request).success).toBe(false);
  });

  it("never lets the epic request carry a bot identity", () => {
    expect(
      managedCommandSubscribeOutputOpenRequestSchema.safeParse({
        botId: "bot-1",
        sessionChatId: "chat-1",
        commandId: "cmd-1",
      }).success,
    ).toBe(false);
    expect(
      managedCommandSubscribeOutputOpenRequestSchema.safeParse({
        epicId: "epic-1",
        commandId: "cmd-1",
      }).success,
    ).toBe(true);
  });
});

describe("managedCommand.subscribeBotOutput frames", () => {
  const serverSchema = () =>
    botLine()?.[1].versions[0].contract.serverFrameSchema;
  const clientSchema = () =>
    botLine()?.[1].versions[0].contract.clientFrameSchema;

  it.each(["live", "holding"] as const)(
    "carries the host's word that delivery is %s",
    (state) => {
      const schema = serverSchema();
      expect(schema).toBeDefined();
      expect(
        schema?.safeParse({
          kind: "liveness",
          state,
          hasBinaryPayload: false,
        }).success,
      ).toBe(true);
    },
  );

  it("refuses a liveness state the host does not define", () => {
    const schema = serverSchema();
    expect(schema).toBeDefined();
    expect(
      schema?.safeParse({
        kind: "liveness",
        state: "revoked",
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
  });

  it("serves the same snapshot, output and older frames as the epic stream", () => {
    const schema = serverSchema();
    expect(schema).toBeDefined();
    const line = {
      channel: "stdout" as const,
      text: "listening on 3000",
      atMs: 1_700_000_001_000,
    };
    expect(
      schema?.safeParse({
        kind: "snapshot",
        command: RUNNING_COMMAND,
        lines: [line],
        start: POSITION,
        reachedStart: false,
        hasBinaryPayload: false,
      }).success,
    ).toBe(true);
    expect(
      schema?.safeParse({
        kind: "output",
        lines: [line],
        start: POSITION,
        hasBinaryPayload: false,
      }).success,
    ).toBe(true);
    expect(
      schema?.safeParse({
        kind: "older",
        requestId: "older-1",
        lines: [line],
        start: POSITION,
        reachedStart: true,
        hasBinaryPayload: false,
      }).success,
    ).toBe(true);
  });

  it("keeps the older-output page bounded and takes no lifecycle or input frame", () => {
    const schema = clientSchema();
    expect(schema).toBeDefined();
    expect(
      schema?.safeParse({
        kind: "loadOlder",
        requestId: "older-1",
        before: POSITION,
        maxLines: MANAGED_COMMAND_MAX_WINDOW_LINES,
        hasBinaryPayload: false,
      }).success,
    ).toBe(true);
    expect(
      schema?.safeParse({
        kind: "loadOlder",
        requestId: "older-2",
        before: POSITION,
        maxLines: MANAGED_COMMAND_MAX_WINDOW_LINES + 1,
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
    for (const kind of ["stdin", "stop", "restart", "write"]) {
      expect(schema?.safeParse({ kind, hasBinaryPayload: false }).success).toBe(
        false,
      );
    }
  });
});

describe("an epic-only client against a host that also serves the bot stream", () => {
  it("never receives a liveness frame on the epic method, in either shipped minor", () => {
    const frame = { kind: "liveness", state: "live", hasBinaryPayload: false };
    expect(
      managedCommandSubscribeOutputServerFrameSchema.safeParse(frame).success,
    ).toBe(false);
    expect(
      managedCommandSubscribeOutputServerFrameSchemaV10.safeParse(frame)
        .success,
    ).toBe(false);
  });

  it("keeps the epic stream's open request and 1.1 line exactly as an epic-only client sends them", () => {
    expect(
      managedCommandSubscribeOutputOpenRequestSchema.safeParse({
        epicId: "epic-1",
        commandId: "cmd-1",
      }).success,
    ).toBe(true);
    expect(
      Object.keys(hostStreamRpcRegistry[EPIC_METHOD][1].versions),
    ).toHaveLength(2);
  });
});

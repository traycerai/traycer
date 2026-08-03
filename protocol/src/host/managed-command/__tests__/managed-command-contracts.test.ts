import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  MANAGED_COMMAND_MAX_WINDOW_LINES,
  managedCommandSubscribeListServerFrameSchema,
  managedCommandSubscribeListV10,
  managedCommandSubscribeOutputClientFrameSchema,
  managedCommandSubscribeOutputServerFrameSchema,
} from "@traycer/protocol/host/managed-command/subscribe";

/**
 * `managedCommand.*@1.0` contract fixtures + registry membership.
 *
 * The behaviour under test is `UI.md`'s: the list is epic-level (every command
 * in the epic, whichever chat made it), rows are kind-explicit, and each row
 * carries the backlink to its creating chat.
 */

const RUNNING_COMMAND = {
  id: "cmd-deploy",
  kind: "monitor" as const,
  description: "deploy watcher",
  status: { state: "running" as const, pid: 4410, startedAtMs: 1_700_000_000_000 },
  chatId: "chat-a",
  createdAtMs: 1_699_999_000_000,
  updatedAtMs: 1_700_000_000_000,
};

describe("managedCommand.subscribeList@1.0 open request", () => {
  it("is scoped to one epic and nothing narrower", () => {
    expect(
      managedCommandSubscribeListV10.openRequestSchema.parse({
        epicId: "epic-1",
        chatId: "chat-a",
      }),
    ).toEqual({ epicId: "epic-1" });
    expect(() =>
      managedCommandSubscribeListV10.openRequestSchema.parse({}),
    ).toThrow();
  });
});

describe("managedCommand.subscribeList@1.0 server frames", () => {
  it("carries the epic's commands regardless of which chat created them", () => {
    const parsed = managedCommandSubscribeListServerFrameSchema.parse({
      kind: "snapshot",
      commands: [
        RUNNING_COMMAND,
        {
          id: "cmd-migrate",
          kind: "shell",
          description: "db migration",
          status: {
            state: "exited",
            exitCode: 1,
            signal: null,
            exitedAtMs: 1_700_000_500_000,
          },
          chatId: "chat-b",
          createdAtMs: 1_699_999_500_000,
          updatedAtMs: 1_700_000_500_000,
        },
      ],
      hasBinaryPayload: false,
    });
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.commands.map((command) => command.chatId)).toEqual([
      "chat-a",
      "chat-b",
    ]);
    expect(parsed.commands.map((command) => command.kind)).toEqual([
      "monitor",
      "shell",
    ]);
  });

  it("pushes a whole command on change and only an id on removal", () => {
    const changed = managedCommandSubscribeListServerFrameSchema.parse({
      kind: "changed",
      command: RUNNING_COMMAND,
      hasBinaryPayload: false,
    });
    if (changed.kind !== "changed") throw new Error("expected changed");
    expect(changed.command.status.state).toBe("running");

    const removed = managedCommandSubscribeListServerFrameSchema.parse({
      kind: "removed",
      commandId: "cmd-deploy",
      hasBinaryPayload: false,
    });
    if (removed.kind !== "removed") throw new Error("expected removed");
    expect(removed.commandId).toBe("cmd-deploy");
  });

  it("rejects a status state outside the supervisor's lifecycle", () => {
    expect(() =>
      managedCommandSubscribeListServerFrameSchema.parse({
        kind: "changed",
        command: { ...RUNNING_COMMAND, status: { state: "queued" } },
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });
});

describe("managedCommand.subscribeOutput@1.0 frames", () => {
  const POSITION = { segmentId: "66310:12:1710000000123", byteOffset: 4_096 };

  it("interleaves output and lifecycle rows on one timeline", () => {
    const parsed = managedCommandSubscribeOutputServerFrameSchema.parse({
      kind: "snapshot",
      command: RUNNING_COMMAND,
      lines: [
        {
          channel: "lifecycle",
          text: "started (pid 4410, manual, shell: /bin/sh)",
          atMs: 1_700_000_000_000,
        },
        { channel: "stdout", text: "listening on 3000", atMs: 1_700_000_001_000 },
        { channel: "stderr", text: "deprecation warning", atMs: 1_700_000_002_000 },
      ],
      start: POSITION,
      reachedStart: false,
      hasBinaryPayload: false,
    });
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.lines.map((line) => line.channel)).toEqual([
      "lifecycle",
      "stdout",
      "stderr",
    ]);
    // A crash can leave a record with no readable timestamp; the viewer is told
    // so rather than being handed an invented one.
    expect(
      managedCommandSubscribeOutputServerFrameSchema.parse({
        kind: "output",
        lines: [{ channel: "stdout", text: "partial", atMs: null }],
        hasBinaryPayload: false,
      }),
    ).toBeDefined();
  });

  it("bounds one load-older window", () => {
    expect(() =>
      managedCommandSubscribeOutputClientFrameSchema.parse({
        kind: "loadOlder",
        requestId: "req-1",
        before: POSITION,
        maxLines: MANAGED_COMMAND_MAX_WINDOW_LINES + 1,
        hasBinaryPayload: false,
      }),
    ).toThrow();
    expect(() =>
      managedCommandSubscribeOutputClientFrameSchema.parse({
        kind: "loadOlder",
        requestId: "req-1",
        before: POSITION,
        maxLines: 0,
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });
});

describe("managedCommand stream registry membership", () => {
  it("installs the list stream at 1.0", () => {
    const line = hostStreamRpcRegistry["managedCommand.subscribeList"];
    expect(line[1].latestMinor).toBe(0);
    expect(line[1].versions[0].contract.method).toBe(
      "managedCommand.subscribeList",
    );
  });

  it("stays off the released floor", () => {
    // Brand-new methods: an older host simply lacks them, which is a per-call
    // absence rather than a handshake failure. Adding one to the floor would
    // claim every shipped host serves it.
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "managedCommand.subscribeList",
    );
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("managedCommand.start");
  });
});

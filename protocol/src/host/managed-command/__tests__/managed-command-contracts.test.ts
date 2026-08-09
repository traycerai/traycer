import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  MANAGED_COMMAND_MAX_WINDOW_LINES,
  managedCommandSubscribeOutputClientFrameSchema,
  managedCommandSubscribeOutputServerFrameSchema,
} from "@traycer/protocol/host/managed-command/subscribe";

/**
 * `managedCommand.*@1.0` contract fixtures + registry membership.
 *
 * Only the output window is a stream of its own. The SET of a chat's commands
 * rides `chat.subscribe` and is covered by that contract's suite.
 */

const RUNNING_COMMAND = {
  id: "cmd-deploy",
  monitoring: true,
  description: "deploy watcher",
  status: {
    state: "running" as const,
    pid: 4410,
    startedAtMs: 1_700_000_000_000,
  },
  chatId: "chat-a",
  createdAtMs: 1_699_999_000_000,
  updatedAtMs: 1_700_000_000_000,
};

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
        {
          channel: "stdout",
          text: "listening on 3000",
          atMs: 1_700_000_001_000,
        },
        {
          channel: "stderr",
          text: "deprecation warning",
          atMs: 1_700_000_002_000,
        },
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
  it("installs the output stream at 1.0", () => {
    const line = hostStreamRpcRegistry["managedCommand.subscribeOutput"];
    expect(line[1].latestMinor).toBe(0);
    expect(line[1].versions[0].contract.method).toBe(
      "managedCommand.subscribeOutput",
    );
  });

  it("has no epic-wide list stream", () => {
    // The set of a chat's commands rides `chat.subscribe`. A future global
    // panel would re-add a list method here; nothing depends on its absence.
    expect(hostStreamRpcRegistry).not.toHaveProperty(
      "managedCommand.subscribeList",
    );
  });

  it("stays off the released floor", () => {
    // Brand-new methods: an older host simply lacks them, which is a per-call
    // absence rather than a handshake failure. Adding one to the floor would
    // claim every shipped host serves it.
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "managedCommand.subscribeOutput",
    );
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("managedCommand.start");
  });
});

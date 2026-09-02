import { describe, expect, it } from "vitest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  managedCommandSchema,
  managedCommandSchemaPreRelaunch,
  managedCommandWithoutRelaunchFlag,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  managedCommandStartUpgradeV10ToV11,
  managedCommandStartV10,
  managedCommandStartV11,
  managedCommandStopUpgradeV10ToV11,
} from "@traycer/protocol/host/managed-command/contracts";
import {
  MANAGED_COMMAND_MAX_WINDOW_LINES,
  managedCommandSubscribeOutputClientFrameSchema,
  managedCommandSubscribeOutputServerFrameSchema,
  managedCommandSubscribeOutputServerFrameSchemaV10,
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
        start: POSITION,
        hasBinaryPayload: false,
      }),
    ).toBeDefined();

    expect(() =>
      managedCommandSubscribeOutputServerFrameSchema.parse({
        kind: "output",
        lines: [{ channel: "stdout", text: "unpositioned", atMs: null }],
        hasBinaryPayload: false,
      }),
    ).toThrow();
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

  it("accepts a fieldless resnapshot request - the viewer's ask for a fresh live tail after detaching", () => {
    // No `requestId`: unlike `loadOlder`, a resnapshot is answered with the
    // same `snapshot` frame a reconnect produces, which the client already
    // treats as a full reset regardless of which request produced it.
    const parsed = managedCommandSubscribeOutputClientFrameSchema.parse({
      kind: "resnapshot",
      hasBinaryPayload: false,
    });
    expect(parsed).toEqual({ kind: "resnapshot", hasBinaryPayload: false });
  });
});

describe("managedCommand stream registry membership", () => {
  it("installs the output stream at 1.1, with 1.0 pinned to the shipped headers", () => {
    const line = hostStreamRpcRegistry["managedCommand.subscribeOutput"];
    expect(line[1].latestMinor).toBe(1);
    expect(line[1].versions[0].contract.method).toBe(
      "managedCommand.subscribeOutput",
    );
    expect(line[1].versions[0].contract.serverFrameSchema).toBe(
      managedCommandSubscribeOutputServerFrameSchemaV10,
    );
    expect(line[1].versions[1].contract.serverFrameSchema).toBe(
      managedCommandSubscribeOutputServerFrameSchema,
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
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(
      "managedCommand.configure",
    );
  });

  it("installs configure at 1.0 on the same unsupported-degrade channel as the lifecycle three", () => {
    const line = hostRpcRegistry["managedCommand.configure"];
    expect(line.degrade).toEqual({ kind: "unsupported" });
    expect(line[1].latestMinor).toBe(0);
    expect(line[1].versions[0].contract.method).toBe(
      "managedCommand.configure",
    );
    expect(
      line[1].versions[0].contract.requestSchema.parse({
        epicId: "epic-1",
        commandId: "cmd-1",
        relaunchOnHostRestart: true,
      }),
    ).toEqual({
      epicId: "epic-1",
      commandId: "cmd-1",
      relaunchOnHostRestart: true,
    });
  });

  it("opens start/stop at 1.1 for the relaunch flag and keeps 1.0 on the shipped response", () => {
    // cli-v1.2.0 shipped `start@1.0` / `stop@1.0` returning the command
    // without `relaunchOnHostRestart`; the released gate treats growth of a
    // shipped host→client shape as breaking, so the flag rides `1.1`.
    for (const method of [
      "managedCommand.start",
      "managedCommand.stop",
    ] as const) {
      const line = hostRpcRegistry[method];
      expect(line[1].latestMinor).toBe(1);
      expect(line[1].versions[1].upgradeFromPreviousVersion).not.toBeNull();
    }
    const live = { ...RUNNING_COMMAND, relaunchOnHostRestart: true };
    // The pinned 1.0 response is what a 1.0 peer's frozen schema describes:
    // the host's within-major projection parses through it, dropping the key.
    expect(
      managedCommandStartV10.responseSchema.parse({ command: live }).command,
    ).not.toHaveProperty("relaunchOnHostRestart");
    expect(
      managedCommandStartV11.responseSchema.parse({ command: live }).command
        .relaunchOnHostRestart,
    ).toBe(true);
    // A 1.0 response upgrades by filling the default - a host that never
    // offered the choice never relaunched.
    const shippedResponse = managedCommandStartV10.responseSchema.parse({
      command: RUNNING_COMMAND,
    });
    for (const bridge of [
      managedCommandStartUpgradeV10ToV11,
      managedCommandStopUpgradeV10ToV11,
    ]) {
      expect(
        bridge.upgradeResponse(shippedResponse).command.relaunchOnHostRestart,
      ).toBe(false);
      expect(
        bridge.upgradeRequest({ epicId: "epic-1", commandId: "cmd-1" }),
      ).toEqual({ epicId: "epic-1", commandId: "cmd-1" });
    }
  });

  it("keeps the pre-relaunch literal equal to the live shape minus the flag", () => {
    // The pre-image is hand-written so a future live addition cannot leak
    // onto the shipped lines; this pins that it drifts in NO other way.
    expect(Object.keys(managedCommandSchemaPreRelaunch.shape).sort()).toEqual(
      Object.keys(managedCommandSchema.shape)
        .filter((key) => key !== "relaunchOnHostRestart")
        .sort(),
    );
    const live = managedCommandSchema.parse({
      ...RUNNING_COMMAND,
      relaunchOnHostRestart: true,
    });
    const stripped = managedCommandWithoutRelaunchFlag(live);
    expect(stripped).not.toHaveProperty("relaunchOnHostRestart");
    expect(managedCommandSchemaPreRelaunch.parse(stripped)).toEqual(stripped);
    // And the 1.0 output-stream headers bind the pre-image, not the live shape.
    const header = managedCommandSubscribeOutputServerFrameSchemaV10.parse({
      kind: "status",
      hasBinaryPayload: false,
      command: live,
    });
    expect(header).not.toHaveProperty("command.relaunchOnHostRestart");
  });

  it("defaults relaunchOnHostRestart to false on a command an older host sends without it", () => {
    // Which is also what such a host does: it never offered the choice, and
    // a command it left interrupted at boot stays interrupted.
    const parsed = managedCommandSchema.parse({
      id: "cmd-1",
      monitoring: false,
      description: "deploy watcher",
      status: { state: "stopped", stoppedAtMs: 1 },
      chatId: "chat-1",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    expect(parsed.relaunchOnHostRestart).toBe(false);
  });
});

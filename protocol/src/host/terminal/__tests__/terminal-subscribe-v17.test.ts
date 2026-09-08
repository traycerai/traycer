/**
 * `terminal.subscribe@1.7` schema coverage (D19/D21, critique M14): the
 * three session-carrying server-frame arms (`snapshot`, `binarySnapshot`,
 * `sessionUpdated`) gain `spawnConfigRevision`/`restartRequired`. Additive
 * minor - no upgrade path (stream entries carry only `contract`, see the
 * existing minors) and `terminalSubscribeServerFrameSchemaV15` stays frozen.
 */
import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  terminalSubscribeServerFrameSchemaV15,
  terminalSubscribeServerFrameSchemaV17,
} from "@traycer/protocol/host/terminal/subscribe";
import type { CanonicalTerminalSessionInfoWithSpawnConfig } from "@traycer/protocol/host/terminal/unary-schemas";

function session(): CanonicalTerminalSessionInfoWithSpawnConfig {
  return {
    sessionId: "term-1",
    scope: { kind: "epic", epicId: "epic-1" },
    sessionKind: "terminal",
    cwd: "/work/launch",
    currentCwd: "/work/live",
    lifecycleOwner: "manager",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: 1,
    title: null,
    activeProcessName: null,
    spawnConfigRevision: "rev-1",
    restartRequired: true,
  };
}

describe("terminal.subscribe@1.7 spawnConfigRevision/restartRequired", () => {
  it("registers at minor 7 as the new latest", () => {
    expect(hostStreamRpcRegistry["terminal.subscribe"][1].latestMinor).toBe(7);
    expect(
      hostStreamRpcRegistry["terminal.subscribe"][1].versions[7].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 7 });
  });

  it("parses a sessionUpdated frame carrying both new fields", () => {
    const parsed = terminalSubscribeServerFrameSchemaV17.safeParse({
      kind: "sessionUpdated",
      hasBinaryPayload: false,
      sessionId: "term-1",
      session: session(),
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (parsed.data.kind !== "sessionUpdated") throw new Error("wrong kind");
    expect(parsed.data.session.spawnConfigRevision).toBe("rev-1");
    expect(parsed.data.session.restartRequired).toBe(true);
  });

  it("parses a snapshot frame carrying both new fields", () => {
    const parsed = terminalSubscribeServerFrameSchemaV17.safeParse({
      kind: "snapshot",
      hasBinaryPayload: false,
      sessionId: "term-1",
      session: session(),
      scrollback: "",
    });
    expect(parsed.success).toBe(true);
  });

  it("requires spawnConfigRevision/restartRequired on the session-carrying arms", () => {
    const {
      spawnConfigRevision: _r,
      restartRequired: _b,
      ...v15Session
    } = session();
    expect(
      terminalSubscribeServerFrameSchemaV17.safeParse({
        kind: "sessionUpdated",
        hasBinaryPayload: false,
        sessionId: "term-1",
        session: v15Session,
      }).success,
    ).toBe(false);
  });

  it("the frozen v1.5 schema still accepts everything it used to (no field lost)", () => {
    const {
      spawnConfigRevision: _r,
      restartRequired: _b,
      ...v15Session
    } = session();
    const parsed = terminalSubscribeServerFrameSchemaV15.safeParse({
      kind: "sessionUpdated",
      hasBinaryPayload: false,
      sessionId: "term-1",
      session: v15Session,
    });
    expect(parsed.success).toBe(true);

    // Also still parses `data`/`resized`/`exit`/`actionAck`/`pong`/
    // `binaryData` - the four arms this minor never touched.
    expect(
      terminalSubscribeServerFrameSchemaV15.safeParse({
        kind: "data",
        hasBinaryPayload: false,
        sessionId: "term-1",
        chunk: "hello",
      }).success,
    ).toBe(true);
    expect(
      terminalSubscribeServerFrameSchemaV15.safeParse({
        kind: "pong",
        hasBinaryPayload: false,
      }).success,
    ).toBe(true);
  });
});

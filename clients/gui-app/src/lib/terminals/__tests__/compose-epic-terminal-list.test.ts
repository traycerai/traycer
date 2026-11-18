import { describe, expect, it } from "vitest";
import type { PlainTerminalRecord } from "@traycer/protocol/host/terminal/plain-schemas";
import type { TerminalSidebarSessionRow } from "@/lib/terminals/reconcile-terminal-sidebar-sessions";
import { withEnvironmentArmTerminals } from "../compose-epic-terminal-list";

function record(hostId: string, terminalId: string): PlainTerminalRecord {
  return {
    terminalId,
    hostId,
    scope: { kind: "epic", epicId: "epic-1" },
    launch: { cwd: "/work", shellCommand: "zsh", shellArgs: ["-l"] },
    manualTitle: "Build",
    revision: 1,
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
  };
}

function reconciled(
  hostId: string,
  terminalId: string,
): TerminalSidebarSessionRow {
  return {
    session: {
      sessionId: terminalId,
      scope: { kind: "epic", epicId: "epic-1" },
      sessionKind: "terminal",
      cwd: "/live",
      shellCommand: "zsh",
      shellArgs: [],
      cols: 100,
      rows: 30,
      status: "running",
      exitCode: null,
      exitReason: null,
      createdAt: 1,
      title: null,
      activeProcessName: null,
    },
    hostId,
    durable: true,
    runtimeStatus: "running",
  };
}

describe("withEnvironmentArmTerminals", () => {
  it("returns the same rows for an empty arm", () => {
    const rows = [reconciled("host-1", "t-1")];
    expect(withEnvironmentArmTerminals(rows, [])).toBe(rows);
  });

  it("drops an arm record a reconciled row already names by host and terminal", () => {
    const rows = [reconciled("host-1", "t-1")];

    const composed = withEnvironmentArmTerminals(rows, [
      record("host-1", "t-1"),
    ]);

    expect(composed).toBe(rows);
  });

  it("adds other records as durable rows with an unknown runtime", () => {
    const rows = [reconciled("host-1", "t-1")];

    const composed = withEnvironmentArmTerminals(rows, [
      record("host-2", "t-1"),
      record("host-1", "t-1"),
    ]);

    expect(composed).toHaveLength(2);
    expect(composed[0]).toBe(rows[0]);
    expect(composed[1]).toMatchObject({
      hostId: "host-2",
      durable: true,
      runtimeStatus: "unknown",
      session: {
        sessionId: "t-1",
        cwd: "/work",
        title: "Build",
        createdAt: Date.parse("2026-01-02T03:04:05.000Z"),
        shellArgs: ["-l"],
      },
    });
  });
});

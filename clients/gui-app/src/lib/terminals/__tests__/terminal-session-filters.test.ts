import { describe, expect, it } from "vitest";
import type { TerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import { isVisibleRawTerminalSession } from "../terminal-session-filters";

function session(
  sessionId: string,
  sessionKind: TerminalSessionInfo["sessionKind"],
  status: TerminalSessionInfo["status"],
): TerminalSessionInfo {
  return {
    sessionId,
    epicId: "epic-1",
    sessionKind,
    cwd: "/tmp",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status,
    exitCode: status === "exited" ? 130 : null,
    createdAt: 1,
    title: null,
  };
}

describe("terminal session filters", () => {
  it("keeps only running raw terminal sessions, excluding terminal-agents", () => {
    // A worktree-setup shell is a plain `terminal` that stays running after
    // setup, so it is shown like any other running terminal; exited sessions
    // (and terminal-agents) are not.
    expect(
      [
        session("term-1", "terminal", "running"),
        session("term-2", "terminal", "exited"),
        session("agent-1", "terminal-agent", "running"),
        session("agent-2", "terminal-agent", "exited"),
      ]
        .filter(isVisibleRawTerminalSession)
        .map((s) => s.sessionId),
    ).toEqual(["term-1"]);
  });
});

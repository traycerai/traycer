import { describe, expect, it } from "vitest";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  isVisibleEpicTerminalSession,
  isVisibleRawTerminalSession,
} from "../terminal-session-filters";

function session(
  sessionId: string,
  sessionKind: CanonicalTerminalSessionInfo["sessionKind"],
  status: CanonicalTerminalSessionInfo["status"],
): CanonicalTerminalSessionInfo {
  return {
    sessionId,
    scope: { kind: "epic", epicId: "epic-1" },
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

function withScope(
  base: CanonicalTerminalSessionInfo,
  scope: CanonicalTerminalSessionInfo["scope"],
): CanonicalTerminalSessionInfo {
  return { ...base, scope };
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

  it("scopes an epic surface to its own epic, hiding landing and foreign-epic sessions", () => {
    // Every session below is a running raw terminal, so only the scope tag can
    // tell them apart: a host serves one epic's terminals alongside another
    // epic's and the epic-less landing ones over the same `terminal.list`.
    expect(
      [
        session("term-1", "terminal", "running"),
        withScope(session("term-2", "terminal", "running"), {
          kind: "epic",
          epicId: "epic-2",
        }),
        withScope(session("term-3", "terminal", "running"), {
          kind: "independent",
        }),
        session("term-4", "terminal", "exited"),
        session("agent-1", "terminal-agent", "running"),
      ]
        .filter((s) => isVisibleEpicTerminalSession(s, "epic-1"))
        .map((s) => s.sessionId),
    ).toEqual(["term-1"]);
  });
});

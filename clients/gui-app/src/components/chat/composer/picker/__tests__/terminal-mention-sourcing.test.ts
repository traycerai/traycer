import { describe, expect, it } from "vitest";

import type {
  CanonicalTerminalSessionInfo,
  TerminalScope,
} from "@traycer/protocol/host/terminal/unary-schemas";
import { isVisibleEpicTerminalSession } from "@/lib/terminals/terminal-session-filters";
import { epicTerminalMentionEntriesFromSessions } from "../use-mention-items";

function session(
  fields: Partial<CanonicalTerminalSessionInfo> & { sessionId: string },
): CanonicalTerminalSessionInfo {
  const epicScope: TerminalScope = { kind: "epic", epicId: "epic-1" };
  return {
    scope: epicScope,
    sessionKind: "terminal",
    cwd: "/repo",
    shellCommand: "/bin/zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    createdAt: 0,
    title: null,
    activeProcessName: null,
    ...fields,
  };
}

/**
 * The picker's terminal rows and the Task's Terminals panel read the same host
 * rows through the same query and the same visibility predicate, so "listed in
 * the panel" and "mentionable" are one fact. These cases pin that they cannot
 * drift apart.
 */
describe("terminal mention sourcing", () => {
  it("lists exactly what the Terminals panel lists", () => {
    const sessions = [
      session({ sessionId: "term-1", title: "build" }),
      session({ sessionId: "term-2", cwd: "/repo/apps/web" }),
      // Excluded by the shared predicate, each for its own reason.
      session({ sessionId: "agent-pty", sessionKind: "terminal-agent" }),
      session({ sessionId: "gone", status: "exited", exitCode: 0 }),
      session({
        sessionId: "other-task",
        scope: { kind: "epic", epicId: "epic-2" },
      }),
      session({ sessionId: "landing", scope: { kind: "independent" } }),
    ];

    const entries = epicTerminalMentionEntriesFromSessions(sessions, "epic-1");

    expect(entries.map((entry) => entry.terminalId)).toEqual([
      "term-1",
      "term-2",
    ]);
    expect(
      sessions
        .filter((row) => isVisibleEpicTerminalSession(row, "epic-1"))
        .map((row) => row.sessionId),
    ).toEqual(entries.map((entry) => entry.terminalId));
  });

  it("titles a row the way the sidebar titles it, and carries its cwd", () => {
    const [named, derived] = epicTerminalMentionEntriesFromSessions(
      [
        session({ sessionId: "term-1", title: "Release build" }),
        session({
          sessionId: "term-2",
          cwd: "/repo/apps/web",
          activeProcessName: "vite",
        }),
      ],
      "epic-1",
    );

    expect(named).toMatchObject({
      kind: "epic-terminal",
      label: "Release build",
      cwd: "/repo",
      description: "/repo",
      terminalId: "term-1",
      epicId: "epic-1",
      token: "terminal:epic-1/term-1",
    });
    // No stored title: the sidebar's directory · process fallback, verbatim.
    expect(derived.label).toBe("web · vite");
  });

  it("returns nothing for a Task with no terminals of its own", () => {
    expect(
      epicTerminalMentionEntriesFromSessions(
        [session({ sessionId: "landing", scope: { kind: "independent" } })],
        "epic-1",
      ),
    ).toEqual([]);
  });
});

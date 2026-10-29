import { describe, expect, it } from "vitest";
import {
  sandboxDestroySessionsSentence,
  sandboxRestingPreview,
  sandboxStopDestroySentence,
} from "@/components/hosts/sandbox-confirm-model";
import {
  agentSessionFixture,
  liveSessionReport,
  terminalSessionFixture,
} from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import { formatSandboxDate } from "@/lib/sandboxes/sandbox-row-lines";

describe("sandboxRestingPreview", () => {
  it("says Never in whole sentences, ended", () => {
    expect(sandboxRestingPreview(null, 1_791_100_000_000)).toBe(
      "Kept until you destroy it. Never applies to idle cleanup. Out-of-credit sandboxes are deleted after 30 days frozen.",
    );
  });
});

describe("sandboxDestroySessionsSentence", () => {
  const agent = (sessionId: string) => agentSessionFixture({ sessionId });
  const terminal = (sessionId: string) => terminalSessionFixture({ sessionId });
  // How the host lists a session another member owns: no task, no name.
  const othersAgent = (sessionId: string) =>
    agentSessionFixture({ sessionId, taskId: null, name: null });
  const othersTerminal = (sessionId: string) =>
    terminalSessionFixture({ sessionId, taskId: null, name: null });

  it("names the live split of agents and terminals from the host's list", () => {
    expect(
      sandboxDestroySessionsSentence(
        liveSessionReport(
          {
            agents: [agent("a1")],
            terminals: [terminal("t1"), terminal("t2")],
          },
          true,
        ),
        false,
      ),
    ).toBe("Destroying ends 1 agent and 2 terminals.");
  });

  it("names other members' agents when the list holds one", () => {
    expect(
      sandboxDestroySessionsSentence(
        liveSessionReport(
          {
            agents: [othersAgent("a1")],
            terminals: [terminal("t1"), terminal("t2")],
          },
          true,
        ),
        false,
      ),
    ).toBe(
      "Destroying ends 1 agent and 2 terminals, including other members' running agents.",
    );
  });

  it("names no other members for the viewer's own terminal alone", () => {
    expect(
      sandboxDestroySessionsSentence(
        liveSessionReport({ agents: [], terminals: [terminal("t1")] }, false),
        false,
      ),
    ).toBe("Destroying ends 1 terminal.");
  });

  it("names no other members' agents for another member's plain terminal", () => {
    expect(
      sandboxDestroySessionsSentence(
        liveSessionReport(
          { agents: [agent("a1")], terminals: [othersTerminal("t1")] },
          false,
        ),
        false,
      ),
    ).toBe("Destroying ends 1 agent and 1 terminal.");
  });

  it("falls back to every running session, naming no one, for a report that is no longer live", () => {
    expect(
      sandboxDestroySessionsSentence(
        { kind: "stale", count: 2, at: 1_000 },
        false,
      ),
    ).toBe("Destroying ends every running session.");
  });

  it("says nothing runs on a sandbox whose processes have ended, or a live list of none", () => {
    expect(sandboxDestroySessionsSentence({ kind: "unknown" }, true)).toBe(
      "Nothing is running on it.",
    );
    expect(
      sandboxDestroySessionsSentence(
        liveSessionReport({ agents: [], terminals: [] }, false),
        false,
      ),
    ).toBe("Nothing is running on it.");
  });
});

describe("sandboxStopDestroySentence", () => {
  const NOW = new Date(2026, 9, 25, 10, 36).getTime();

  it("dates the destroy to the minute, counted from now", () => {
    const sentence = sandboxStopDestroySentence(60, NOW);
    expect(sentence).toBe(
      `Destroyed on ${formatSandboxDate(new Date(2026, 9, 25, 11, 36).getTime(), true)} unless started.`,
    );
    expect(sentence).toBe("Destroyed on Oct 25 at 11:36 unless started.");
  });

  it("says nothing for a sandbox kept until destroyed, null or 0", () => {
    expect(sandboxStopDestroySentence(null, NOW)).toBeNull();
    expect(sandboxStopDestroySentence(0, NOW)).toBeNull();
  });
});

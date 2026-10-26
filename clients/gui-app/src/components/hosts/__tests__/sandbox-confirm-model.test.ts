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
        false,
      ),
    ).toBe("Destroying ends 1 agent and 2 terminals.");
  });

  it("counts an idle terminal the busy count leaves out", () => {
    expect(
      sandboxDestroySessionsSentence(
        liveSessionReport({ agents: [], terminals: [terminal("t1")] }, false),
        false,
        false,
      ),
    ).toBe("Destroying ends 1 terminal.");
  });

  it("names the other members' agents on a team", () => {
    expect(
      sandboxDestroySessionsSentence(
        liveSessionReport(
          {
            agents: [agent("a1")],
            terminals: [terminal("t1"), terminal("t2")],
          },
          true,
        ),
        true,
        false,
      ),
    ).toBe(
      "Destroying ends 1 agent and 2 terminals, including other members' running agents.",
    );
  });

  it("falls back to the count of a report that is no longer live", () => {
    expect(
      sandboxDestroySessionsSentence(
        { kind: "stale", count: 2, at: 1_000 },
        false,
        false,
      ),
    ).toBe("Destroying ends every running session.");
  });

  it("says nothing runs on a sandbox whose processes have ended, or a live list of none", () => {
    expect(
      sandboxDestroySessionsSentence({ kind: "unknown" }, false, true),
    ).toBe("Nothing is running on it.");
    expect(
      sandboxDestroySessionsSentence(
        liveSessionReport({ agents: [], terminals: [] }, false),
        false,
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

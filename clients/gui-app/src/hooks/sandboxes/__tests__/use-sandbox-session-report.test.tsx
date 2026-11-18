import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HostBusyBreakdown,
  HostStatusSessions,
} from "@traycer/protocol/host/status/contracts";
import { useSandboxSessionReport } from "@/hooks/sandboxes/use-sandbox-session-report";
import { sandboxSessionPills } from "@/lib/sandboxes/sandbox-row-lines";

interface StatusAnswer {
  readonly data: {
    readonly busy: boolean;
    readonly busySessionCount: number | null;
    readonly busyBreakdown: HostBusyBreakdown | null;
    readonly sessions: HostStatusSessions | null;
  } | null;
}

const status = vi.hoisted(() => ({
  answer: { data: null } as StatusAnswer,
  dataUpdatedAt: 1_000,
  isError: false,
}));

// The host's `host.status` answer is the network boundary of the report.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => ({}),
}));
vi.mock("@/components/settings/panels/host-overview-rpc", () => ({
  useHostOverviewStatusQuery: () => ({
    ...status.answer,
    isError: status.isError,
    isStale: false,
    fetchStatus: "idle",
    dataUpdatedAt: status.dataUpdatedAt,
  }),
}));

const ONE_IDLE_TERMINAL: HostStatusSessions = {
  agents: [],
  terminals: [{ taskId: "task-1", sessionId: "term-1", name: "build" }],
};

function answerWith(sessions: HostStatusSessions | null): void {
  status.answer = {
    data: {
      busy: false,
      // What an update drain waits for: an idle terminal is not in it.
      busySessionCount: 0,
      busyBreakdown: {
        workingAgents: 0,
        activeTerminalAgents: 0,
        busyTerminals: 0,
      },
      sessions,
    },
  };
}

function report() {
  return renderHook(() => useSandboxSessionReport("host-sbx", true)).result
    .current.report;
}

describe("useSandboxSessionReport", () => {
  beforeEach(() => {
    status.dataUpdatedAt = 1_000;
    status.isError = false;
  });

  it("counts an idle terminal the busy count leaves out, and names it in the pills", () => {
    answerWith(ONE_IDLE_TERMINAL);

    expect(report()).toEqual({
      kind: "live",
      count: 1,
      busy: false,
      kinds: { agents: 0, terminals: 1 },
      sessions: ONE_IDLE_TERMINAL,
    });
  });

  it("splits the host's list into agents and terminals, agents first in the pills", () => {
    const sessions: HostStatusSessions = {
      agents: [
        {
          kind: "chat",
          taskId: "task-1",
          sessionId: "chat-1",
          name: "Planner",
          working: true,
        },
        {
          kind: "terminal-agent",
          taskId: "task-1",
          sessionId: "ta-1",
          name: null,
          working: false,
        },
      ],
      terminals: [
        { taskId: "task-1", sessionId: "term-1", name: "build" },
        { taskId: null, sessionId: "term-2", name: null },
      ],
    };
    answerWith(sessions);

    const live = report();

    expect(live).toMatchObject({
      kind: "live",
      count: 4,
      kinds: { agents: 2, terminals: 2 },
    });
    expect(sandboxSessionPills(live)).toEqual([
      { key: "agent:chat-1", label: "Planner", working: true },
      { key: "agent:ta-1", label: "Terminal agent", working: false },
      { key: "terminal:term-1", label: "build", working: false },
      { key: "terminal:term-2", label: "Terminal", working: false },
    ]);
  });

  it("reads a chat the host sends no name for as Agent", () => {
    answerWith({
      agents: [
        {
          kind: "chat",
          taskId: "task-9",
          sessionId: "chat-9",
          name: null,
          working: false,
        },
      ],
      terminals: [],
    });

    expect(sandboxSessionPills(report())).toEqual([
      { key: "agent:chat-9", label: "Agent", working: false },
    ]);
  });

  it("is unknown, never a zero, when the host sends no list", () => {
    answerWith(null);

    expect(report()).toEqual({ kind: "unknown" });
  });

  it("is unknown with no answer", () => {
    status.answer = { data: null };

    expect(report()).toEqual({ kind: "unknown" });
  });

  it("reads an answer that is no longer live as its list's count as of then, and unknown with no time", () => {
    answerWith(ONE_IDLE_TERMINAL);
    status.isError = true;

    status.dataUpdatedAt = 1_000;
    expect(report()).toEqual({ kind: "stale", count: 1, at: 1_000 });
    status.dataUpdatedAt = 0;
    expect(report()).toEqual({ kind: "unknown" });
  });
});

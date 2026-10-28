import type {
  SandboxOperation,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import type {
  HostStatusAgentSession,
  HostStatusSessions,
  HostStatusTerminalSession,
} from "@traycer/protocol/host/status/contracts";
import type { SandboxSessionReport } from "@/lib/sandboxes/sandbox-row-lines";

/** One sandbox row as `GET /api/sandboxes` carries it, with overrides. */
export function sandboxSummaryFixture(
  overrides: Partial<SandboxSummary>,
): SandboxSummary {
  return {
    id: "sbx_1",
    hostId: "host-sbx-1",
    kind: "agent",
    provider: "tensorlake",
    region: "us-east",
    os: "linux",
    cpus: 2,
    memoryMb: 4096,
    diskMb: 20480,
    displayName: "build-box",
    state: "awake",
    frozen: false,
    failureCode: null,
    idleMinutes: null,
    burst: false,
    createdByHostId: null,
    createdByAgentId: null,
    createdAt: 1_791_000_000_000,
    lastTransitionAt: 1_791_000_010_000,
    lastActivityAt: null,
    destroyedAt: null,
    frozenAt: null,
    guestConfigured: null,
    guestConfigFailureReason: null,
    phase: null,
    routes: null,
    priceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
    environmentId: null,
    createdBy: null,
    wakePayer: null,
    keptBy: null,
    restingSince: null,
    destroyAfterRestingMinutes: null,
    destroyAt: null,
    createdByTaskId: null,
    createdByAgentName: null,
    createdByTaskTitle: null,
    keptAt: null,
    operation: null,
    regionLabel: null,
    stopRequestedAt: null,
    ...overrides,
  };
}

/** One running agent in `host.status`'s `sessions`, with overrides. */
export function agentSessionFixture(
  overrides: Partial<HostStatusAgentSession>,
): HostStatusAgentSession {
  return {
    kind: "chat",
    taskId: "task-1",
    sessionId: "chat-1",
    name: "Planner",
    working: false,
    ...overrides,
  };
}

/** One open terminal in `host.status`'s `sessions`, with overrides. */
export function terminalSessionFixture(
  overrides: Partial<HostStatusTerminalSession>,
): HostStatusTerminalSession {
  return {
    taskId: "task-1",
    sessionId: "term-1",
    name: "build",
    ...overrides,
  };
}

/** The report a live read of `sessions` gives: its count and split. */
export function liveSessionReport(
  sessions: HostStatusSessions,
  busy: boolean,
): SandboxSessionReport {
  return {
    kind: "live",
    count: sessions.agents.length + sessions.terminals.length,
    busy,
    kinds: {
      agents: sessions.agents.length,
      terminals: sessions.terminals.length,
    },
    sessions,
  };
}

/** The operation a row's state comes from, with overrides. */
export function sandboxOperationFixture(
  overrides: Partial<SandboxOperation>,
): SandboxOperation {
  return {
    at: 1_791_000_020_000,
    fromState: "awake",
    state: "destroying",
    cause: "verb",
    outcomeCause: "verb",
    outcomeDetail: null,
    actor: { userId: "u-me", displayName: "Me" },
    gesture: null,
    ...overrides,
  };
}

import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";

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
    priceMcPerHour: { awakeMc: 120, suspendedMc: 4, stoppedMc: 2 },
    ...overrides,
  };
}

import { describe, expect, it, vi } from "vitest";
import type { HostUpdateAttemptRecord } from "@traycer-clients/shared/host-update";

// `unwrapContenderOutcome`'s `nonterminal-attempt` message
// (`describeNonterminalAttempt`, `host/update-contender.ts`): the
// 2026-09-27 staging outage left an operator with a parked record and no
// command that said how to get out - `host ensure` yielded to the same
// record, and the refusal message named no recovery. This file drives
// `withCliUpdateContenderContext` with `withUpdateContender` (shared) mocked
// to resolve a `nonterminal-attempt` outcome directly, so it can pin the
// wording for a PARKED record versus an ACTIVE one without touching the real
// attempt lock or any host-home I/O.

const mocks = vi.hoisted(() => ({
  withUpdateContenderMock: vi.fn(),
}));

vi.mock("@traycer-clients/shared/host-update", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@traycer-clients/shared/host-update")>();
  return { ...actual, withUpdateContender: mocks.withUpdateContenderMock };
});

import { withCliUpdateContenderContext } from "../update-contender";

function record(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "2.0.0",
    phase: "waiting-to-activate",
    execution: "parked",
    continuation: "activate",
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

describe("withCliUpdateContenderContext — nonterminal-attempt message", () => {
  it("a PARKED record's refusal names 'traycer host update' to resume it", async () => {
    const rec = record({});
    mocks.withUpdateContenderMock.mockResolvedValue({
      kind: "nonterminal-attempt",
      disposition: "refuse",
      record: rec,
    });

    await expect(
      withCliUpdateContenderContext(
        {
          environment: "production",
          reason: "test-reason",
          waitMs: 0,
          pollIntervalMs: 0,
          admission: "recovery-maintenance",
        },
        async () => "unreachable",
      ),
    ).rejects.toMatchObject({
      code: "E_HOST_UPDATE_ATTEMPT_ACTIVE",
      message: expect.stringContaining(
        "run 'traycer host update' to resume it",
      ),
      details: { attemptId: rec.attemptId, phase: rec.phase },
    });
  });

  it("an ACTIVE record's refusal names 'wait for the running update to finish'", async () => {
    const rec = record({
      phase: "restarting",
      execution: "active",
      continuation: "activate",
    });
    mocks.withUpdateContenderMock.mockResolvedValue({
      kind: "nonterminal-attempt",
      disposition: "refuse",
      record: rec,
    });

    await expect(
      withCliUpdateContenderContext(
        {
          environment: "production",
          reason: "test-reason",
          waitMs: 0,
          pollIntervalMs: 0,
          admission: "recovery-maintenance",
        },
        async () => "unreachable",
      ),
    ).rejects.toMatchObject({
      code: "E_HOST_UPDATE_ATTEMPT_ACTIVE",
      message: expect.stringContaining(
        "wait for the running update to finish",
      ),
      details: { attemptId: rec.attemptId, phase: rec.phase },
    });
  });
});

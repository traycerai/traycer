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
    await importOriginal<
      typeof import("@traycer-clients/shared/host-update")
    >();
  return { ...actual, withUpdateContender: mocks.withUpdateContenderMock };
});

import {
  describeUpdateLockHolder,
  updateLockBusyMessage,
  withCliUpdateContenderContext,
  withCliUpdateExecutionSegment,
} from "../update-contender";

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
      message: expect.stringContaining("wait for the running update to finish"),
      details: { attemptId: rec.attemptId, phase: rec.phase },
    });
  });
});

describe("who holds the update lock", () => {
  const holder = (reason: string) => ({
    pid: 1,
    reason,
    startedAt: "2026-01-01T00:00:00.000Z",
    hostname: null,
    token: null,
    processStartedAtMs: null,
    processStartIdentity: null,
  });

  it.each([
    ["desktop:host-download", "The Traycer app is downloading a host update"],
    ["desktop:host-apply", "The Traycer app is installing a host update"],
    ["host-controller-activate", "The Traycer app is changing the host"],
    [
      "desktop-force-restart-continuation",
      "The Traycer app is changing the host",
    ],
    ["host-update", "Another Traycer command is updating the host"],
    ["host-download", "Another Traycer command is downloading a host update"],
    ["host-ensure", "Another Traycer command is changing the host"],
  ])("%s", (reason, expected) => {
    expect(describeUpdateLockHolder(holder(reason))).toBe(expected);
  });

  it("a lock whose record could not be read still answers", () => {
    expect(describeUpdateLockHolder(null)).toBe(
      "Another Traycer process is changing the host",
    );
  });

  it("the refusal names the holder and what to do", async () => {
    mocks.withUpdateContenderMock.mockResolvedValue({
      kind: "busy",
      holder: holder("desktop:host-download"),
    });
    await expect(
      withCliUpdateExecutionSegment(
        {
          environment: "production",
          reason: "host-stop",
          waitMs: 0,
          pollIntervalMs: 25,
          admission: "service-maintenance",
        },
        async () => undefined,
      ),
    ).rejects.toThrow(updateLockBusyMessage(holder("desktop:host-download")));
    expect(updateLockBusyMessage(null)).toContain("traycer host status");
  });

  it.each([
    ["desktop", "desktop:host-download"],
    [undefined, "host-download"],
  ])(
    "a run initiated by %s takes the lock as %s",
    async (initiator, reason) => {
      mocks.withUpdateContenderMock.mockClear();
      mocks.withUpdateContenderMock.mockResolvedValue({
        kind: "ran",
        result: "done",
      });
      vi.stubEnv("TRAYCER_HOST_UPDATE_INITIATOR", initiator);
      try {
        await withCliUpdateExecutionSegment(
          {
            environment: "production",
            reason: "host-download",
            waitMs: 0,
            pollIntervalMs: 25,
            admission: "stage-maintenance",
          },
          async () => undefined,
        );
      } finally {
        vi.unstubAllEnvs();
      }
      expect(mocks.withUpdateContenderMock.mock.calls[0]?.[0]).toMatchObject({
        reason,
      });
    },
  );
});

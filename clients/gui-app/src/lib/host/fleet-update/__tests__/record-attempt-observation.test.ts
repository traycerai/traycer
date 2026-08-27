import { describe, expect, it } from "vitest";
import type { LocalAttemptFacts } from "@traycer-clients/shared/platform/runner-host";
import { recordObservationFromLocalAttempt } from "@/lib/host/fleet-update/record-attempt-observation";

// `recordObservationFromLocalAttempt` turns Desktop's published durable-record
// FACTS into the projector's record-derived arm (Ticket 07 §5.2.7). See the
// module's own doc: FACTS ONLY — nothing here may invent `execution`,
// `trigger`, `liveness`, busy counts, or an error, since those are things only
// a RUNNING host can report. `toEqual` (exact shape), never `toMatchObject`,
// for every non-null case below — a subset match would not notice a future
// edit that started fabricating one of those fields.

function facts(overrides: Partial<LocalAttemptFacts>): LocalAttemptFacts {
  return {
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    targetVersion: "2.1.0",
    phase: "preparing",
    continuation: null,
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  };
}

const HOST_ID = "host-1";
const OBSERVED_AT_MS = 1_000_000;

describe("recordObservationFromLocalAttempt", () => {
  it("null facts -> null", () => {
    expect(
      recordObservationFromLocalAttempt({
        hostId: HOST_ID,
        localAttempt: null,
        observedAtMs: OBSERVED_AT_MS,
      }),
    ).toBeNull();
  });

  it("an unrecognised phase string -> null (refusing beats guessing a newer vocabulary)", () => {
    expect(
      recordObservationFromLocalAttempt({
        hostId: HOST_ID,
        localAttempt: facts({
          phase: "some-future-phase-this-build-does-not-know",
        }),
        observedAtMs: OBSERVED_AT_MS,
      }),
    ).toBeNull();
  });

  it.each(["complete", "failed", "superseded"] as const)(
    "a TERMINAL phase (%s) -> null — a finished attempt is not the host-down window",
    (phase) => {
      expect(
        recordObservationFromLocalAttempt({
          hostId: HOST_ID,
          localAttempt: facts({ phase }),
          observedAtMs: OBSERVED_AT_MS,
        }),
      ).toBeNull();
    },
  );

  it.each([
    "downloading",
    "preparing",
    "applying",
    "waiting-for-work",
    "waiting-to-activate",
    "restarting",
    "verifying",
  ] as const)(
    "a NON-terminal phase (%s) carries the facts, exactly and only",
    (phase) => {
      const input = facts({
        phase,
        attemptId: "attempt-non-terminal",
        targetVersion: "3.0.0",
      });
      const result = recordObservationFromLocalAttempt({
        hostId: HOST_ID,
        localAttempt: input,
        observedAtMs: OBSERVED_AT_MS,
      });
      // Exact shape, not a subset: no fabricated `execution`, `trigger`,
      // `liveness`, busy counts, or an error — those are things only a
      // RUNNING host can report, and this arm exists for when there is none.
      expect(result).toEqual({
        hostId: HOST_ID,
        source: "durable-record",
        observedAtMs: OBSERVED_AT_MS,
        attemptId: "attempt-non-terminal",
        targetVersion: "3.0.0",
        phase,
      });
    },
  );
});

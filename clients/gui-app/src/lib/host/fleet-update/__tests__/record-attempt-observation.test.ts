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
    // `LocalAttemptFacts["phase"]` is now the closed `HostUpdateAttemptPhase`
    // union, so this can no longer be built through `facts({ phase: ... })`
    // without a value the type already rejects. Widen explicitly to a plain
    // `string` for the one field under test, then cross to the real type with
    // a single assertion between comparable shapes — never `as any` / `as
    // unknown as` — to still exercise a wire payload from a newer build this
    // one does not recognise.
    const futureFacts: Omit<LocalAttemptFacts, "phase"> & {
      readonly phase: string;
    } = {
      ...facts({}),
      phase: "some-future-phase-this-build-does-not-know",
    };
    expect(
      recordObservationFromLocalAttempt({
        hostId: HOST_ID,
        localAttempt: futureFacts as LocalAttemptFacts,
        observedAtMs: OBSERVED_AT_MS,
      }),
    ).toBeNull();
  });

  it.each(["complete", "superseded"] as const)(
    "a terminal phase with nothing to act on (%s) -> null",
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

  // Codex round 3. `failed` used to be dropped with the other two, which meant
  // the one terminal phase the LIVE path renders (it maps `failed` -> `failed`
  // and only collapses `superseded` -> `idle`) was discarded exactly when the
  // host is unreachable and this record is the only evidence there is -
  // packaged-macOS activation failing after bootout being the concrete case.
  //
  // It is carried as FACTS here; the projector renders it as `kind: "unknown"`
  // with `lastKnownKind: "failed"`, so no surface can present it as current.
  it("a FAILED phase carries the facts — the host-down window is when it matters most", () => {
    expect(
      recordObservationFromLocalAttempt({
        hostId: HOST_ID,
        localAttempt: facts({ phase: "failed", attemptId: "attempt-failed" }),
        observedAtMs: OBSERVED_AT_MS,
      }),
    ).toEqual({
      hostId: HOST_ID,
      source: "durable-record",
      observedAtMs: OBSERVED_AT_MS,
      attemptId: "attempt-failed",
      targetVersion: "2.1.0",
      phase: "failed",
    });
  });

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

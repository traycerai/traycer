import { describe, expect, it } from "vitest";
import {
  checkJournalSuccessor,
  currentComponentHandshake,
  migrationJournalSchema,
  plannedJournal,
  type MigrationJournal,
} from "../data-migration-contracts";

function planned(): MigrationJournal {
  return plannedJournal({
    id: "m-00000000-aaaa-bbbb-cccc-000000000002",
    previousLocation: null,
    source: { path: "/home/u/.traycer", volumeId: null, directoryId: null },
    destination: { path: "/data/traycer", volumeId: "v1", directoryId: "d1" },
    nextGeneration: 1,
    coordinatorBuild: currentComponentHandshake("cli", "1.0.0"),
    coordinatorExecutableSha256: null,
    coordinator: { pid: 100, startIdentity: "start-100", lockNonce: "nonce-1" },
    now: "2026-10-17T00:00:00.000Z",
  });
}

function next(
  current: MigrationJournal,
  impactReviewRequested: boolean,
): MigrationJournal {
  return { ...current, revision: current.revision + 1, impactReviewRequested };
}

describe("journal impactReviewRequested", () => {
  it("plannedJournal starts it false", () => {
    expect(planned().impactReviewRequested).toBe(false);
  });

  it("round-trips true and false through the schema", () => {
    for (const value of [true, false]) {
      const parsed = migrationJournalSchema.safeParse({
        ...planned(),
        impactReviewRequested: value,
      });
      expect(parsed.success).toBe(true);
      expect(parsed.success ? parsed.data.impactReviewRequested : null).toBe(
        value,
      );
    }
  });

  it("rejects a journal missing the field and any non-boolean value", () => {
    const without = Object.fromEntries(
      Object.entries(planned()).filter(
        ([key]) => key !== "impactReviewRequested",
      ),
    );
    expect(migrationJournalSchema.safeParse(without).success).toBe(false);
    for (const bad of ["true", 1, 0, null]) {
      expect(
        migrationJournalSchema.safeParse({
          ...planned(),
          impactReviewRequested: bad,
        }).success,
      ).toBe(false);
    }
  });

  it("checkJournalSuccessor accepts false to true and true to true in the same phase", () => {
    const base = planned();
    const requested = next(base, true);
    expect(checkJournalSuccessor(base, requested)).toBeNull();
    expect(checkJournalSuccessor(requested, next(requested, true))).toBeNull();
  });

  it("checkJournalSuccessor refuses true to false with immutable-field-changed", () => {
    const requested = next(planned(), true);
    expect(checkJournalSuccessor(requested, next(requested, false))?.code).toBe(
      "immutable-field-changed",
    );
  });
});

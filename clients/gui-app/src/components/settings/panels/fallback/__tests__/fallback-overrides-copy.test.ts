import { describe, expect, it } from "vitest";
import {
  EXCLUDED_FALLBACK_REASONS,
  REASON_ELIGIBLE_RUNGS,
} from "@traycer/protocol/host/fallback-policy";
import { HOST_NOTIFICATION_STOPPED_REASONS } from "@traycer/protocol/host/notifications/payloads";
import {
  EXCLUDED_MATRIX_REASONS,
  MATRIX_REASONS,
  RUNG_INELIGIBILITY_COPY,
} from "@/components/settings/panels/fallback/fallback-overrides-copy";
import { FALLBACK_MATRIX_RUNGS } from "@/components/settings/panels/fallback/fallback-rung-copy";

describe("MATRIX_REASONS", () => {
  it("equals the shared taxonomy minus the excluded set - computed from the two imports, not restated as a literal list", () => {
    const expected = HOST_NOTIFICATION_STOPPED_REASONS.filter(
      (reason) => !EXCLUDED_FALLBACK_REASONS.has(reason),
    );
    expect(MATRIX_REASONS).toEqual(expected);
    // The Done-when this row exists to satisfy: every reason is in exactly
    // one of the matrix's rows or the excluded line, never both, never
    // neither.
    expect(MATRIX_REASONS.length + EXCLUDED_MATRIX_REASONS.length).toBe(
      HOST_NOTIFICATION_STOPPED_REASONS.length,
    );
    for (const reason of HOST_NOTIFICATION_STOPPED_REASONS) {
      const inMatrix = MATRIX_REASONS.includes(reason);
      const inExcluded = EXCLUDED_MATRIX_REASONS.includes(reason);
      expect(inMatrix).toBe(!inExcluded);
    }
  });
});

describe("RUNG_INELIGIBILITY_COPY", () => {
  it("is null exactly where REASON_ELIGIBLE_RUNGS lists the rung, over the window the matrix actually reads (MATRIX_REASONS x FALLBACK_MATRIX_RUNGS)", () => {
    // Deliberately scoped to this window and not the whole record: the
    // `notify` column and the five excluded reasons are null-throughout for a
    // DIFFERENT reason (unreachable cells, not "eligible everywhere"), which
    // the doc comment on the constant calls out by name. Stating the
    // invariant over the whole record would be false for those two
    // documented exclusions - this test must not "fix" them by widening scope.
    for (const reason of MATRIX_REASONS) {
      for (const rung of FALLBACK_MATRIX_RUNGS) {
        const isNull = RUNG_INELIGIBILITY_COPY[reason][rung] === null;
        const isEligible = REASON_ELIGIBLE_RUNGS[reason].includes(rung);
        expect(isNull).toBe(isEligible);
      }
    }
  });

  it("gives a non-empty sentence to every ineligible cell in the window, never an empty string", () => {
    for (const reason of MATRIX_REASONS) {
      for (const rung of FALLBACK_MATRIX_RUNGS) {
        const why = RUNG_INELIGIBILITY_COPY[reason][rung];
        if (why !== null) {
          expect(why.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

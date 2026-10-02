/**
 * Cold-review F1 re-review minimum: `composeAttemptHolderVerdict`'s full
 * tri-state-liveness × identity-comparison cross product.
 *
 * The defect this guards: an indeterminate OS probe (`EIO`, an unexpected
 * errno, a probe that could not run) must never become positive death
 * evidence. Only `dead` (POSITIVE proof — `ESRCH` and nothing else) may
 * short-circuit to `"dead"`. An `indeterminate` liveness still consults the
 * independent identity comparison, because a matching creation stamp is
 * positive evidence of life even when the liveness probe itself could not
 * answer — the epic's "indeterminate counts as alive" invariant.
 *
 * `composeAttemptHolderVerdict`'s third argument is an `ObservedProcessStart`
 * (the exact token, or - only for a Windows read that was DENIED - WMI's
 * creation time), not a raw token: every call below wraps a plain identity
 * string with `identityObservation` so the cross product stays readable.
 */
import { describe, expect, it } from "vitest";
import { composeAttemptHolderVerdict } from "../host-update-attempt-liveness";
import {
  formatLinuxProcessStartIdentity,
  formatWindowsProcessStartIdentity,
  type ObservedProcessStart,
} from "@traycer/protocol/host/lifecycle/process-start-identity";

const IDENTITY_A = formatLinuxProcessStartIdentity("boot-id-fixed", 100);
const IDENTITY_A_AGAIN = formatLinuxProcessStartIdentity("boot-id-fixed", 100);
const IDENTITY_B = formatLinuxProcessStartIdentity("boot-id-fixed", 200);

if (IDENTITY_A === null || IDENTITY_A_AGAIN === null || IDENTITY_B === null) {
  throw new Error("fixture identity tokens failed to format");
}

function identityObservation(
  identity: string | null,
): ObservedProcessStart | null {
  return identity === null ? null : { kind: "identity", identity };
}

describe("composeAttemptHolderVerdict — tri-state liveness × identity cross product", () => {
  it("dead liveness always short-circuits to dead, regardless of identity comparison", () => {
    expect(
      composeAttemptHolderVerdict(
        "dead",
        IDENTITY_A,
        identityObservation(IDENTITY_A_AGAIN),
      ),
    ).toBe("dead");
    expect(
      composeAttemptHolderVerdict(
        "dead",
        IDENTITY_A,
        identityObservation(IDENTITY_B),
      ),
    ).toBe("dead");
    expect(composeAttemptHolderVerdict("dead", null, null)).toBe("dead");
    expect(composeAttemptHolderVerdict("dead", IDENTITY_A, null)).toBe("dead");
  });

  it("alive liveness + matching identity -> alive-same", () => {
    expect(
      composeAttemptHolderVerdict(
        "alive",
        IDENTITY_A,
        identityObservation(IDENTITY_A_AGAIN),
      ),
    ).toBe("alive-same");
  });

  it("alive liveness + differing identity -> alive-different (a recycled pid)", () => {
    expect(
      composeAttemptHolderVerdict(
        "alive",
        IDENTITY_A,
        identityObservation(IDENTITY_B),
      ),
    ).toBe("alive-different");
  });

  it("alive liveness + an unknown identity comparison (either side null) -> indeterminate, never alive-different", () => {
    expect(
      composeAttemptHolderVerdict(
        "alive",
        null,
        identityObservation(IDENTITY_A),
      ),
    ).toBe("indeterminate");
    expect(composeAttemptHolderVerdict("alive", IDENTITY_A, null)).toBe(
      "indeterminate",
    );
    expect(composeAttemptHolderVerdict("alive", null, null)).toBe(
      "indeterminate",
    );
  });

  it("indeterminate liveness + matching identity -> alive-same — the 'indeterminate counts as alive' invariant", () => {
    // The load-bearing case: the liveness probe itself could not answer
    // (EIO, an unexpected errno), but the independent identity read still
    // positively confirms the SAME process. That must read as alive, not
    // as unknown and never as dead.
    expect(
      composeAttemptHolderVerdict(
        "indeterminate",
        IDENTITY_A,
        identityObservation(IDENTITY_A_AGAIN),
      ),
    ).toBe("alive-same");
  });

  it("indeterminate liveness + differing identity -> alive-different", () => {
    expect(
      composeAttemptHolderVerdict(
        "indeterminate",
        IDENTITY_A,
        identityObservation(IDENTITY_B),
      ),
    ).toBe("alive-different");
  });

  it("indeterminate liveness + unknown identity comparison -> indeterminate (the only cell with no positive evidence either way)", () => {
    expect(
      composeAttemptHolderVerdict(
        "indeterminate",
        null,
        identityObservation(IDENTITY_A),
      ),
    ).toBe("indeterminate");
    expect(composeAttemptHolderVerdict("indeterminate", IDENTITY_A, null)).toBe(
      "indeterminate",
    );
    expect(composeAttemptHolderVerdict("indeterminate", null, null)).toBe(
      "indeterminate",
    );
  });

  it("dead never arises from anything but the dead liveness arm — full sweep", () => {
    const nonDeadLivenessValues = ["alive", "indeterminate"] as const;
    const identityPairs: ReadonlyArray<
      readonly [string | null, string | null]
    > = [
      [IDENTITY_A, IDENTITY_A_AGAIN],
      [IDENTITY_A, IDENTITY_B],
      [null, IDENTITY_A],
      [IDENTITY_A, null],
      [null, null],
    ];
    for (const liveness of nonDeadLivenessValues) {
      for (const [recorded, observed] of identityPairs) {
        expect(
          composeAttemptHolderVerdict(
            liveness,
            recorded,
            identityObservation(observed),
          ),
        ).not.toBe("dead");
      }
    }
  });
});

// A Windows denied-read observation: WMI's creation time rather than the
// exact token. `composeAttemptHolderVerdict` never sees the platform or the
// reason the exact read failed - it only sees `ObservedProcessStart` and
// delegates the decision to `compareObservedProcessStart` - so these three
// rows pin that the SAME mapping (liveness × comparison -> verdict) covers
// this observation kind too, not a parallel one.
describe("composeAttemptHolderVerdict — a Windows denied-read observation", () => {
  const WINDOWS_RECORDED_TOKEN = formatWindowsProcessStartIdentity(
    "2026-03-04T05:06:07.1234567Z",
  );
  if (WINDOWS_RECORDED_TOKEN === null) {
    throw new Error("fixture Windows token failed to format");
  }
  // Truncated to six fractional digits, exactly as the recorded token's text
  // is read.
  const WINDOWS_RECORDED_MICROS =
    Date.UTC(2026, 2, 4, 5, 6, 7) * 1000 + 123_456;

  function deniedReadObservation(creationMicros: number): ObservedProcessStart {
    return { kind: "windows-denied-read", creationMicros };
  }

  it("a WMI creation time equal to the recorded token -> alive-same", () => {
    expect(
      composeAttemptHolderVerdict(
        "alive",
        WINDOWS_RECORDED_TOKEN,
        deniedReadObservation(WINDOWS_RECORDED_MICROS),
      ),
    ).toBe("alive-same");
  });

  it("a WMI creation time 2 microseconds later -> alive-different", () => {
    expect(
      composeAttemptHolderVerdict(
        "alive",
        WINDOWS_RECORDED_TOKEN,
        deniedReadObservation(WINDOWS_RECORDED_MICROS + 2),
      ),
    ).toBe("alive-different");
  });

  it("a WMI creation time against a non-Windows recorded identity -> indeterminate (nothing to compare it to)", () => {
    expect(
      composeAttemptHolderVerdict(
        "alive",
        IDENTITY_A,
        deniedReadObservation(WINDOWS_RECORDED_MICROS),
      ),
    ).toBe("indeterminate");
  });
});

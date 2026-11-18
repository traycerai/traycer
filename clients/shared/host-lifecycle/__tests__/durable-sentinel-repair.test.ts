import { describe, expect, it } from "vitest";
import type { DurableBytes } from "../durable/decoder";
import type { BooleanSentinelKey } from "../durable/sentinel";
import {
  booleanSentinelToEvidence,
  decodeBooleanSentinel,
} from "../durable/sentinel";
import type { DurableRepairTarget } from "../durable/repair";
import {
  CANONICAL_BOOLEAN_SENTINEL_VERSION,
  canonicalBooleanSentinelBytes,
  repairCanonical,
  repairCanonicalVerdict,
  repairTargetSentinelKey,
  sentinelDecodeIsFaulted,
  sentinelPriorDecode,
} from "../durable/repair";

/**
 * Keyed sentinel decode (§I2a job 2) and canonical repair (§I2a second half).
 *
 * **Every case here is driven by a byte sequence through the real decoder**,
 * not by a hand-built `BooleanSentinelRecord`. This changeset's dominant defect
 * class is fixture vacuity — assertions that are perfectly sound over inputs
 * production cannot produce — and a record object handed straight to a
 * classifier proves nothing about what the decoder does with bytes.
 *
 * The repaired side of every round trip is produced by the **real encoder**
 * (`canonicalBooleanSentinelBytes`) for the same reason: if the encoder and
 * decoder ever disagree about "canonical shape", repair stops converging and
 * the loop this arm exists to close reopens silently.
 */

const bytes = (text: string): DurableBytes => ({ kind: "bytes", text });
const KEYS: readonly BooleanSentinelKey[] = ["removedByUser", "stoppedByUser"];
const TARGETS: readonly DurableRepairTarget[] = [
  "removed-by-user",
  "stopped-by-user",
];

/**
 * The shipped desktop writer's byte-for-byte output:
 * `host-removal-state.ts` → `createJsonFileStore` → `JSON.stringify(v, null, 2)`.
 * The writer↔reader pinning that *runs* that writer lives in
 * `clients/desktop/src/electron-main/host/__tests__/host-removal-state-sentinel-contract.test.ts`
 * (the only place it can run); this is the same shape, kept here so the keyed
 * rules are stated against real bytes rather than a convenient one-liner.
 */
const SHIPPED_REMOVED_TRUE = '{\n  "removedByUser": true\n}';
const SHIPPED_REMOVED_FALSE = '{\n  "removedByUser": false\n}';

describe("decodeBooleanSentinel is keyed to the sentinel it is reading", () => {
  // The measured defect. `observed(true)` is the ONLY verdict that suppresses
  // a start, so a stray or mis-keyed file decoding to it silently prevents the
  // host from ever running — on macOS the planner goes straight to
  // `none / already-removed`.
  it("rejects the other sentinel's key rather than honouring it", () => {
    expect(
      decodeBooleanSentinel(bytes('{"stoppedByUser":true}'), "removedByUser"),
    ).toEqual({ kind: "corrupt" });
    expect(
      decodeBooleanSentinel(bytes(SHIPPED_REMOVED_TRUE), "stoppedByUser"),
    ).toEqual({ kind: "corrupt" });
  });

  // A versioned envelope carrying an unversioned-era key is a shape no writer
  // emits. Half-honouring it is how a malformed file becomes a lockout.
  it("rejects a versioned envelope carrying a legacy key", () => {
    for (const key of KEYS) {
      expect(
        decodeBooleanSentinel(bytes('{"v":1,"removedByUser":true}'), key),
      ).toEqual({ kind: "corrupt" });
      expect(
        decodeBooleanSentinel(bytes('{"v":1,"stoppedByUser":true}'), key),
      ).toEqual({ kind: "corrupt" });
    }
  });

  it("rejects a file carrying both sentinel keys, on either key", () => {
    const both = '{"removedByUser":true,"stoppedByUser":false}';
    for (const key of KEYS) {
      expect(decodeBooleanSentinel(bytes(both), key)).toEqual({
        kind: "corrupt",
      });
    }
  });

  /**
   * The canonical envelope carries the fact twice (`value` + the file's own
   * legacy key, so the shipped desktop reader can still read it). Two
   * encodings of one fact can therefore contradict — the encoder never does
   * it, a torn write or a hand edit does. Neither key wins: a record that
   * disagrees with itself is unattributable, same principle as the
   * cross-sentinel rule.
   *
   * This is the shape that matters most in the `true`/`false` direction: if
   * the reader resolved it by whichever key it checked first, a half-written
   * file would decide whether the user's removal is honoured.
   */
  it("rejects a record that disagrees with itself", () => {
    expect(
      decodeBooleanSentinel(
        bytes('{"v":1,"value":true,"removedByUser":false}'),
        "removedByUser",
      ),
    ).toEqual({ kind: "corrupt" });
    expect(
      decodeBooleanSentinel(
        bytes('{"v":1,"value":false,"removedByUser":true}'),
        "removedByUser",
      ),
    ).toEqual({ kind: "corrupt" });
    // Unversioned too — the disagreement is the defect, not the envelope.
    expect(
      decodeBooleanSentinel(
        bytes('{"value":true,"stoppedByUser":false}'),
        "stoppedByUser",
      ),
    ).toEqual({ kind: "corrupt" });
    // A present-but-non-boolean own key is equally unattributable.
    expect(
      decodeBooleanSentinel(
        bytes('{"v":1,"value":true,"removedByUser":"yes"}'),
        "removedByUser",
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("still decodes each shipped shape at its own path", () => {
    expect(
      decodeBooleanSentinel(bytes(SHIPPED_REMOVED_FALSE), "removedByUser"),
    ).toEqual({ kind: "observed", value: false });
    expect(
      decodeBooleanSentinel(bytes(SHIPPED_REMOVED_TRUE), "removedByUser"),
    ).toEqual({ kind: "observed", value: true });
    expect(
      decodeBooleanSentinel(bytes('{"stoppedByUser":true}'), "stoppedByUser"),
    ).toEqual({ kind: "observed", value: true });
  });

  // Key-agnostic shapes must stay key-agnostic: the canonical envelope is what
  // repair writes, and a repaired file is read by whichever sentinel owns it.
  it("accepts the canonical and bare shapes under both keys", () => {
    for (const key of KEYS) {
      expect(decodeBooleanSentinel(bytes('{"v":1,"value":true}'), key)).toEqual(
        { kind: "observed", value: true },
      );
      expect(decodeBooleanSentinel(bytes("false"), key)).toEqual({
        kind: "observed",
        value: false,
      });
    }
  });

  // The property, not a sample: nothing outside each key's own accepted shapes
  // may reach the one verdict that suppresses a start.
  it("has no cross-sentinel or malformed byte sequence that suppresses a start", () => {
    // Each pair is bytes that carry `true` and the key they are NOT attributable
    // to. Every one of them decoded to `observed(true)` before this change.
    const foreignTrue: readonly (readonly [string, BooleanSentinelKey])[] = [
      ['{"stoppedByUser":true}', "removedByUser"],
      [SHIPPED_REMOVED_TRUE, "stoppedByUser"],
      ['{"v":1,"removedByUser":true}', "removedByUser"],
      ['{"v":1,"removedByUser":true}', "stoppedByUser"],
      ['{"v":1,"stoppedByUser":true}', "removedByUser"],
      ['{"v":1,"stoppedByUser":true}', "stoppedByUser"],
      ['{"removedByUser":true,"stoppedByUser":true}', "removedByUser"],
      ['{"removedByUser":true,"stoppedByUser":true}', "stoppedByUser"],
      ['{"v":1,"value":true,"stoppedByUser":true}', "removedByUser"],
    ];
    for (const [text, key] of foreignTrue) {
      expect(decodeBooleanSentinel(bytes(text), key)).toEqual({
        kind: "corrupt",
      });
    }
  });
});

describe("canonical repair encoder", () => {
  it("stamps the canonical envelope", () => {
    expect(
      JSON.parse(canonicalBooleanSentinelBytes("removed-by-user", true)),
    ).toEqual({
      v: CANONICAL_BOOLEAN_SENTINEL_VERSION,
      value: true,
      removedByUser: true,
    });
    expect(
      JSON.parse(canonicalBooleanSentinelBytes("stopped-by-user", false)),
    ).toEqual({
      v: CANONICAL_BOOLEAN_SENTINEL_VERSION,
      value: false,
      stoppedByUser: false,
    });
  });

  // The fixed-point property. If this fails, repair does not repair: the next
  // tick reads the repaired file and still sees a fault.
  it("round-trips through the real decoder at its own key", () => {
    for (const target of TARGETS) {
      for (const value of [true, false]) {
        expect(
          decodeBooleanSentinel(
            bytes(canonicalBooleanSentinelBytes(target, value)),
            repairTargetSentinelKey(target),
          ),
        ).toEqual({ kind: "observed", value });
      }
    }
  });

  // A repaired file copied to the other sentinel's path is unattributable. The
  // legacy key that makes it readable to the shipped desktop reader is also
  // what stops it masquerading as the other sentinel.
  it("is corrupt at the other sentinel's key", () => {
    for (const target of TARGETS) {
      const otherKey: BooleanSentinelKey =
        target === "removed-by-user" ? "stoppedByUser" : "removedByUser";
      expect(
        decodeBooleanSentinel(
          bytes(canonicalBooleanSentinelBytes(target, true)),
          otherKey,
        ),
      ).toEqual({ kind: "corrupt" });
    }
  });

  it("maps each target to the key its file is decoded with", () => {
    expect(repairTargetSentinelKey("removed-by-user")).toBe("removedByUser");
    expect(repairTargetSentinelKey("stopped-by-user")).toBe("stoppedByUser");
  });
});

describe("repairCanonical", () => {
  // Prior decode is derived from bytes, so the evidence doctor prints is the
  // verdict the decoder actually reached — not a label chosen at the call site.
  it.each([
    ['{"v":1,"value":true}', "observed"],
    ["{ not json", "corrupt"],
    ['{"stoppedByUser":true}', "corrupt"],
    ['{"v":9,"value":true}', "unsupported-version"],
  ])("records the prior decode of %s as %s", (text, expected) => {
    const evidence = booleanSentinelToEvidence(
      decodeBooleanSentinel(bytes(text), "removedByUser"),
    );
    expect(repairCanonical("removed-by-user", true, evidence).priorDecode).toBe(
      expected,
    );
  });

  it("records absent and unreadable from their own decode arms", () => {
    expect(
      sentinelPriorDecode(
        booleanSentinelToEvidence(
          decodeBooleanSentinel({ kind: "missing" }, "removedByUser"),
        ),
      ),
    ).toBe("absent");
    expect(
      sentinelPriorDecode(
        booleanSentinelToEvidence(
          decodeBooleanSentinel(
            { kind: "unreadable", cause: "EACCES" },
            "removedByUser",
          ),
        ),
      ),
    ).toBe("unreadable");
  });

  // A platform cause that did not come from the sentinel decoder is reported
  // as `indeterminate`, never folded into a decoder verdict we never made.
  it("does not invent a decode verdict for a foreign indeterminate cause", () => {
    expect(
      sentinelPriorDecode({
        kind: "indeterminate",
        cause: "launchctl-timeout",
      }),
    ).toBe("indeterminate");
  });

  it("flags exactly the arms that make a fault permanent", () => {
    for (const text of ["{ not json", '{"stoppedByUser":true}', '{"v":9}']) {
      expect(
        sentinelDecodeIsFaulted(
          booleanSentinelToEvidence(
            decodeBooleanSentinel(bytes(text), "removedByUser"),
          ),
        ),
      ).toBe(true);
    }
    for (const input of [
      bytes('{"v":1,"value":false}'),
      { kind: "missing" } as const,
    ]) {
      expect(
        sentinelDecodeIsFaulted(
          booleanSentinelToEvidence(
            decodeBooleanSentinel(input, "removedByUser"),
          ),
        ),
      ).toBe(false);
    }
  });

  it("carries the repair into evidence (I3)", () => {
    const effect = repairCanonical("stopped-by-user", true, {
      kind: "indeterminate",
      cause: "sentinel-corrupt",
    });
    expect(repairCanonicalVerdict(effect)).toBe(
      "stopped-by-user rewritten to canonical true (prior decode: corrupt)",
    );
  });
});

/**
 * The harm this arm exists to remove, played out over ticks against a
 * simulated disk. `host stop` on a faulted stop sentinel: without a repair the
 * bytes never change, so the monitor re-reads the same fault every tick, sees
 * no refusal, and restarts the host forever — the user cannot stop their host,
 * and the undo the permissive direction is justified by is the mechanism that
 * is broken.
 */
describe("stop converges after one repair, from every faulted start state", () => {
  const monitorWouldRestart = (disk: string): boolean => {
    const decoded = decodeBooleanSentinel(bytes(disk), "stoppedByUser");
    // The direction split: only `observed(true)` suppresses a start.
    return !(decoded.kind === "observed" && decoded.value);
  };

  const faulted: readonly string[] = [
    "{ not json",
    "{}",
    '{"removedByUser":true}',
    '{"v":1,"stoppedByUser":true}',
    '{"v":9,"value":true}',
    '{"stoppedByUser":"yes"}',
    "[]",
  ];

  it.each(faulted)("repairs %s and stops looping", (start) => {
    let disk = start;

    // Tick 1 — the fault is real: the monitor would restart the stopped host.
    expect(monitorWouldRestart(disk)).toBe(true);

    // `stop` establishes stopped-by-user := true. The effect rewrites rather
    // than preserving, which is the entire fix.
    const effect = repairCanonical(
      "stopped-by-user",
      true,
      booleanSentinelToEvidence(
        decodeBooleanSentinel(bytes(disk), "stoppedByUser"),
      ),
    );
    expect(effect.kind).toBe("repair-canonical");
    disk = canonicalBooleanSentinelBytes(effect.target, effect.value);

    // Tick 2 and every tick after — the refusal is readable and honoured.
    expect(monitorWouldRestart(disk)).toBe(false);
    expect(decodeBooleanSentinel(bytes(disk), "stoppedByUser")).toEqual({
      kind: "observed",
      value: true,
    });

    // Repair is idempotent: a second repair of the repaired file is a no-op.
    const second = repairCanonical(
      "stopped-by-user",
      true,
      booleanSentinelToEvidence(
        decodeBooleanSentinel(bytes(disk), "stoppedByUser"),
      ),
    );
    expect(second.priorDecode).toBe("observed");
    expect(canonicalBooleanSentinelBytes(second.target, second.value)).toBe(
      disk,
    );
  });

  // `restart` establishes the same sentinel to `false`, and must also leave
  // readable bytes behind — otherwise restart-after-a-corrupt-stop leaves the
  // fault on disk for the next `stop` to trip over.
  it("clears through the same arm, leaving canonical bytes", () => {
    const cleared = repairCanonical("stopped-by-user", false, {
      kind: "indeterminate",
      cause: "sentinel-corrupt",
    });
    const disk = canonicalBooleanSentinelBytes(cleared.target, cleared.value);
    expect(decodeBooleanSentinel(bytes(disk), "stoppedByUser")).toEqual({
      kind: "observed",
      value: false,
    });
    expect(monitorWouldRestart(disk)).toBe(true);
  });
});

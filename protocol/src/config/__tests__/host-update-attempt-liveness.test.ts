/**
 * Table-driven cross-product for `deriveAttemptLiveness` (design §2.4):
 * every `HostUpdateAttemptRead` shape the decoder can produce, times every
 * holder observation the probe can report. The load-bearing claims are
 * negative ones, so each is proven by construction rather than by a single
 * example:
 *
 *   - `interrupted` arises ONLY for a valid, ACTIVE, STALE record with
 *     `no-holder` evidence. Every other cell - including every parked or
 *     terminal cell, at any age, with any holder - must not be `interrupted`.
 *   - A parked record is never `interrupted` at any age (checked before the
 *     holder is even consulted).
 *   - A future-dated `updatedAt` is not stale.
 *   - An unparseable `updatedAt` is `indeterminate`, never `interrupted`.
 */
import { describe, expect, it } from "vitest";
import {
  deriveAttemptLiveness,
  type AttemptHolderObservation,
  type AttemptLiveness,
} from "../host-update-attempt-liveness";
import {
  executionForPhase,
  parkContinuationFor,
  type HostUpdateAttemptPhase,
  type HostUpdateAttemptRead,
  type HostUpdateAttemptRecord,
} from "../host-update-attempt";

const NOW_MS = 1_700_000_000_000;
const STALENESS_MS = 120_000;

function isoAt(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

function recordFor(
  phase: HostUpdateAttemptPhase,
  updatedAt: string,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "1.2.3",
    phase,
    execution: executionForPhase(phase),
    continuation: parkContinuationFor(phase),
    progress: null,
    startedAt: isoAt(-STALENESS_MS * 10),
    updatedAt,
    completedAt: null,
    error: null,
  };
}

const HOLDERS: Record<string, AttemptHolderObservation> = {
  "no-holder": { kind: "no-holder" },
  "holder-live": { kind: "holder-live" },
  indeterminate: { kind: "indeterminate", cause: "probe-failed" },
};

function derive(
  current: HostUpdateAttemptRead,
  holderKey: keyof typeof HOLDERS,
): AttemptLiveness {
  return deriveAttemptLiveness({
    current,
    holder: HOLDERS[holderKey],
    nowMs: NOW_MS,
    stalenessMs: STALENESS_MS,
  });
}

const ACTIVE_FRESH_RECORD = recordFor("downloading", isoAt(-1_000));
const ACTIVE_STALE_RECORD = recordFor(
  "downloading",
  isoAt(-STALENESS_MS - 1_000),
);
const PARKED_FRESH_RECORD = recordFor("waiting-for-work", isoAt(-1_000));
const PARKED_ANCIENT_RECORD = recordFor(
  "waiting-for-work",
  isoAt(-STALENESS_MS * 1000),
);
const TERMINAL_RECORD = recordFor("complete", isoAt(-1_000));

const READS: Record<string, HostUpdateAttemptRead> = {
  absent: { kind: "absent" },
  corrupt: { kind: "corrupt" },
  unreadable: { kind: "unreadable", cause: "eacces" },
  "unsupported-version": { kind: "unsupported-version", version: 3 },
  "active-fresh": { kind: "valid", value: ACTIVE_FRESH_RECORD, version: 2 },
  "active-stale": { kind: "valid", value: ACTIVE_STALE_RECORD, version: 2 },
  "parked-fresh": { kind: "valid", value: PARKED_FRESH_RECORD, version: 2 },
  "parked-ancient": {
    kind: "valid",
    value: PARKED_ANCIENT_RECORD,
    version: 2,
  },
  terminal: { kind: "valid", value: TERMINAL_RECORD, version: 2 },
};

const PARKED_RECORDS: Record<
  "parked-fresh" | "parked-ancient",
  HostUpdateAttemptRecord
> = {
  "parked-fresh": PARKED_FRESH_RECORD,
  "parked-ancient": PARKED_ANCIENT_RECORD,
};

const HOLDER_KEYS = Object.keys(HOLDERS) as ReadonlyArray<keyof typeof HOLDERS>;

describe("deriveAttemptLiveness — full cross-product", () => {
  it("absent: always none, regardless of holder", () => {
    for (const holderKey of HOLDER_KEYS) {
      expect(derive(READS.absent, holderKey)).toEqual({ kind: "none" });
    }
  });

  it("corrupt: always indeterminate/record-corrupt, regardless of holder", () => {
    for (const holderKey of HOLDER_KEYS) {
      expect(derive(READS.corrupt, holderKey)).toEqual({
        kind: "indeterminate",
        cause: "record-corrupt",
        record: null,
      });
    }
  });

  it("unreadable: always indeterminate/<cause>, regardless of holder", () => {
    for (const holderKey of HOLDER_KEYS) {
      expect(derive(READS.unreadable, holderKey)).toEqual({
        kind: "indeterminate",
        cause: "eacces",
        record: null,
      });
    }
  });

  it("unsupported-version: always indeterminate/<version-tagged cause>, regardless of holder", () => {
    for (const holderKey of HOLDER_KEYS) {
      expect(derive(READS["unsupported-version"], holderKey)).toEqual({
        kind: "indeterminate",
        cause: "record-unsupported-version-3",
        record: null,
      });
    }
  });

  it("active-fresh: active on no-holder or holder-live; indeterminate on indeterminate holder — never interrupted", () => {
    const record = ACTIVE_FRESH_RECORD;
    expect(derive(READS["active-fresh"], "no-holder")).toEqual({
      kind: "active",
      record,
    });
    expect(derive(READS["active-fresh"], "holder-live")).toEqual({
      kind: "active",
      record,
    });
    expect(derive(READS["active-fresh"], "indeterminate")).toEqual({
      kind: "indeterminate",
      cause: "probe-failed",
      record,
    });
  });

  it("active-stale: interrupted ONLY on no-holder; active on holder-live; indeterminate on indeterminate holder", () => {
    const record = ACTIVE_STALE_RECORD;
    expect(derive(READS["active-stale"], "no-holder")).toEqual({
      kind: "interrupted",
      record,
    });
    expect(derive(READS["active-stale"], "holder-live")).toEqual({
      kind: "active",
      record,
    });
    expect(derive(READS["active-stale"], "indeterminate")).toEqual({
      kind: "indeterminate",
      cause: "probe-failed",
      record,
    });
  });

  it("parked (fresh or ancient): always parked, for every holder observation — the holder is never consulted", () => {
    for (const parkedKey of ["parked-fresh", "parked-ancient"] as const) {
      const record = PARKED_RECORDS[parkedKey];
      for (const holderKey of HOLDER_KEYS) {
        expect(derive(READS[parkedKey], holderKey)).toEqual({
          kind: "parked",
          record,
        });
      }
    }
  });

  it("terminal: always terminal, for every holder observation — the holder is never consulted", () => {
    const record = TERMINAL_RECORD;
    for (const holderKey of HOLDER_KEYS) {
      expect(derive(READS.terminal, holderKey)).toEqual({
        kind: "terminal",
        record,
      });
    }
  });

  it("interrupted arises in exactly one cell of the whole table: active + stale + no-holder", () => {
    const interruptedCells: string[] = [];
    for (const [readKey, read] of Object.entries(READS)) {
      for (const holderKey of HOLDER_KEYS) {
        if (derive(read, holderKey).kind === "interrupted") {
          interruptedCells.push(`${readKey}/${holderKey}`);
        }
      }
    }
    expect(interruptedCells).toEqual(["active-stale/no-holder"]);
  });

  it("a future-dated updatedAt is not stale — active + no-holder stays active, not interrupted", () => {
    const futureRead: HostUpdateAttemptRead = {
      kind: "valid",
      value: recordFor("downloading", isoAt(STALENESS_MS * 10)),
      version: 2,
    };
    expect(derive(futureRead, "no-holder")).toEqual({
      kind: "active",
      record: futureRead.value,
    });
  });

  it("an unparseable updatedAt is indeterminate, never interrupted, even with no-holder", () => {
    const unparseableRead: HostUpdateAttemptRead = {
      kind: "valid",
      value: recordFor("downloading", "not-a-timestamp"),
      version: 2,
    };
    expect(derive(unparseableRead, "no-holder")).toEqual({
      kind: "indeterminate",
      cause: "record-updated-at-unparseable",
      record: unparseableRead.value,
    });
    expect(derive(unparseableRead, "holder-live").kind).not.toBe("interrupted");
  });
});

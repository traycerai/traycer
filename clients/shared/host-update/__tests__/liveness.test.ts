import { describe, expect, it } from "vitest";
import type { HostUpdateAttemptRead } from "../decode";
import type { AttemptHolderEvidence, LockMetadata } from "../lock";
import { deriveAttemptLiveness } from "../liveness";
import type { HostUpdateAttemptRecord } from "../record";

const NOW_MS = Date.parse("2026-01-01T01:00:00.000Z");
const STALENESS_MS = 120_000;

function makeRecord(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "1.2.3",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

const NO_HOLDER: AttemptHolderEvidence = { kind: "no-holder" };
const INDETERMINATE_HOLDER: AttemptHolderEvidence = {
  kind: "indeterminate",
  cause: "lock-unparseable",
};
function holderLive(): AttemptHolderEvidence {
  const holder: LockMetadata = {
    pid: 1,
    reason: "test",
    startedAt: "2026-01-01T00:00:00.000Z",
    hostname: null,
    token: "token",
    processStartedAtMs: null,
    processStartIdentity: null,
  };
  return { kind: "holder-live", holder };
}

describe("deriveAttemptLiveness - none / terminal", () => {
  it("reports none for an absent record", () => {
    const result = deriveAttemptLiveness({
      current: { kind: "absent" },
      holder: NO_HOLDER,
      nowMs: NOW_MS,
      stalenessMs: STALENESS_MS,
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("reports terminal for a terminal record regardless of holder evidence", () => {
    const record = makeRecord({ phase: "complete", execution: "terminal" });
    for (const holder of [NO_HOLDER, holderLive(), INDETERMINATE_HOLDER]) {
      const result = deriveAttemptLiveness({
        current: { kind: "valid", version: 2, value: record },
        holder,
        nowMs: NOW_MS,
        stalenessMs: STALENESS_MS,
      });
      expect(result).toEqual({ kind: "terminal", record });
    }
  });
});

describe("deriveAttemptLiveness - parked is never interrupted", () => {
  it("stays parked with a fresh updatedAt and no-holder evidence", () => {
    const record = makeRecord({
      phase: "waiting-for-work",
      execution: "parked",
      continuation: "resume-apply",
      updatedAt: "2026-01-01T00:59:59.000Z",
    });
    const result = deriveAttemptLiveness({
      current: { kind: "valid", version: 2, value: record },
      holder: NO_HOLDER,
      nowMs: NOW_MS,
      stalenessMs: STALENESS_MS,
    });
    expect(result).toEqual({ kind: "parked", record });
  });

  it("stays parked however stale, whatever the holder evidence", () => {
    const record = makeRecord({
      phase: "waiting-to-activate",
      execution: "parked",
      continuation: "activate",
      updatedAt: "2020-01-01T00:00:00.000Z", // years stale
    });
    for (const holder of [NO_HOLDER, holderLive(), INDETERMINATE_HOLDER]) {
      const result = deriveAttemptLiveness({
        current: { kind: "valid", version: 2, value: record },
        holder,
        nowMs: NOW_MS,
        stalenessMs: STALENESS_MS,
      });
      expect(result).toEqual({ kind: "parked", record });
    }
  });
});

describe("deriveAttemptLiveness - interrupted requires every clause", () => {
  const staleActive = makeRecord({
    phase: "downloading",
    execution: "active",
    updatedAt: "2026-01-01T00:00:00.000Z", // 1 hour stale, way past STALENESS_MS
  });

  it("is interrupted only when valid + active + stale + no-holder all hold", () => {
    const result = deriveAttemptLiveness({
      current: { kind: "valid", version: 2, value: staleActive },
      holder: NO_HOLDER,
      nowMs: NOW_MS,
      stalenessMs: STALENESS_MS,
    });
    expect(result).toEqual({ kind: "interrupted", record: staleActive });
  });

  it("is active, not interrupted, when the record is stale but a holder is live", () => {
    const result = deriveAttemptLiveness({
      current: { kind: "valid", version: 2, value: staleActive },
      holder: holderLive(),
      nowMs: NOW_MS,
      stalenessMs: STALENESS_MS,
    });
    expect(result).toEqual({ kind: "active", record: staleActive });
  });

  it("is active, not interrupted, when a holder is missing but the record is fresh", () => {
    const fresh = makeRecord({
      phase: "downloading",
      execution: "active",
      updatedAt: new Date(NOW_MS - 1000).toISOString(),
    });
    const result = deriveAttemptLiveness({
      current: { kind: "valid", version: 2, value: fresh },
      holder: NO_HOLDER,
      nowMs: NOW_MS,
      stalenessMs: STALENESS_MS,
    });
    expect(result).toEqual({ kind: "active", record: fresh });
  });

  it("is indeterminate, not interrupted, when the holder probe itself is indeterminate", () => {
    const result = deriveAttemptLiveness({
      current: { kind: "valid", version: 2, value: staleActive },
      holder: INDETERMINATE_HOLDER,
      nowMs: NOW_MS,
      stalenessMs: STALENESS_MS,
    });
    expect(result).toEqual({
      kind: "indeterminate",
      cause: "lock-unparseable",
      record: staleActive,
    });
  });

  it("reads a future-dated updatedAt as active, not interrupted", () => {
    const futureDated = makeRecord({
      phase: "downloading",
      execution: "active",
      updatedAt: new Date(NOW_MS + 60_000).toISOString(),
    });
    const result = deriveAttemptLiveness({
      current: { kind: "valid", version: 2, value: futureDated },
      holder: NO_HOLDER,
      nowMs: NOW_MS,
      stalenessMs: STALENESS_MS,
    });
    expect(result).toEqual({ kind: "active", record: futureDated });
  });
});

describe("deriveAttemptLiveness - indeterminate for a fail-closed record", () => {
  it.each([
    ["corrupt", { kind: "corrupt" } as HostUpdateAttemptRead, "record-corrupt"],
    [
      "unreadable",
      { kind: "unreadable", cause: "EACCES" } as HostUpdateAttemptRead,
      "EACCES",
    ],
    [
      "unsupported-version",
      { kind: "unsupported-version", version: 9 } as HostUpdateAttemptRead,
      "record-unsupported-version-9",
    ],
  ])(
    "maps a %s record to indeterminate with cause %s",
    (_label, current, cause) => {
      const result = deriveAttemptLiveness({
        current,
        holder: holderLive(),
        nowMs: NOW_MS,
        stalenessMs: STALENESS_MS,
      });
      expect(result).toEqual({ kind: "indeterminate", cause, record: null });
    },
  );
});

describe("deriveAttemptLiveness - unparseable updatedAt", () => {
  it("is indeterminate when updatedAt cannot be parsed as a date", () => {
    const record = makeRecord({
      phase: "downloading",
      execution: "active",
      updatedAt: "not-a-date",
    });
    const result = deriveAttemptLiveness({
      current: { kind: "valid", version: 2, value: record },
      holder: NO_HOLDER,
      nowMs: NOW_MS,
      stalenessMs: STALENESS_MS,
    });
    expect(result).toEqual({
      kind: "indeterminate",
      cause: "record-updated-at-unparseable",
      record,
    });
  });
});

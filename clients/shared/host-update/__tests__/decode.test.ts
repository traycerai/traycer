import { describe, expect, it } from "vitest";
import type { DurableBytes } from "../decode";
import { decodeHostUpdateAttempt } from "../decode";

const missing: DurableBytes = { kind: "missing" };
const unreadable: DurableBytes = { kind: "unreadable", cause: "EACCES" };
const bytes = (text: string): DurableBytes => ({ kind: "bytes", text });

// A minimally valid v2 record - `downloading` is active, so `execution` and
// `continuation` are the values every other field-corruption test mutates
// away from.
const VALID_ACTIVE: Record<string, unknown> = {
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
};

const VALID_PARKED: Record<string, unknown> = {
  ...VALID_ACTIVE,
  phase: "waiting-for-work",
  execution: "parked",
  continuation: "resume-apply",
};

function json(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...VALID_ACTIVE, ...overrides });
}

describe("decodeHostUpdateAttempt", () => {
  it("reports absent for a missing file", () => {
    expect(decodeHostUpdateAttempt(missing)).toEqual({ kind: "absent" });
  });

  it("reports unreadable with the cause for an fs read error", () => {
    expect(decodeHostUpdateAttempt(unreadable)).toEqual({
      kind: "unreadable",
      cause: "EACCES",
    });
  });

  it("decodes a fully populated valid active record", () => {
    const result = decodeHostUpdateAttempt(bytes(json({})));
    expect(result).toEqual({
      kind: "valid",
      version: 2,
      value: VALID_ACTIVE,
    });
  });

  it("decodes a valid parked record", () => {
    const result = decodeHostUpdateAttempt(bytes(JSON.stringify(VALID_PARKED)));
    expect(result).toEqual({
      kind: "valid",
      version: 2,
      value: VALID_PARKED,
    });
  });

  it("decodes a valid terminal record with completedAt and an error set", () => {
    const record = {
      ...VALID_ACTIVE,
      phase: "failed",
      execution: "terminal",
      continuation: null,
      completedAt: "2026-01-01T00:05:00.000Z",
      error: { code: "download-failed", message: "boom", phase: "downloading" },
    };
    const result = decodeHostUpdateAttempt(bytes(JSON.stringify(record)));
    expect(result).toEqual({ kind: "valid", version: 2, value: record });
  });

  it("decodes a valid record with populated progress", () => {
    const record = {
      ...VALID_ACTIVE,
      progress: { percent: 42.5, bytes: 1024, totalBytes: 4096 },
    };
    const result = decodeHostUpdateAttempt(bytes(JSON.stringify(record)));
    expect(result).toEqual({ kind: "valid", version: 2, value: record });
  });

  // ---- corrupt: malformed bytes / shape --------------------------------

  it("reports corrupt for invalid JSON", () => {
    expect(decodeHostUpdateAttempt(bytes("{not json"))).toEqual({
      kind: "corrupt",
    });
  });

  it("reports corrupt for a JSON array instead of an object", () => {
    expect(decodeHostUpdateAttempt(bytes("[]"))).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt for a JSON null", () => {
    expect(decodeHostUpdateAttempt(bytes("null"))).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt for a bare JSON string or number", () => {
    expect(decodeHostUpdateAttempt(bytes('"hello"'))).toEqual({
      kind: "corrupt",
    });
    expect(decodeHostUpdateAttempt(bytes("42"))).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when schemaVersion is missing or the wrong type", () => {
    const { schemaVersion: _drop, ...withoutVersion } = VALID_ACTIVE;
    expect(
      decodeHostUpdateAttempt(bytes(JSON.stringify(withoutVersion))),
    ).toEqual({ kind: "corrupt" });
    expect(
      decodeHostUpdateAttempt(bytes(json({ schemaVersion: "2" }))),
    ).toEqual({ kind: "corrupt" });
  });

  // NaN/Infinity are not valid JSON syntax, so bytes carrying either fail
  // JSON.parse itself and land here rather than in the progress parser -
  // still `corrupt`, which is the contract that matters to callers.
  it("reports corrupt for NaN or Infinity literals anywhere in the bytes", () => {
    expect(
      decodeHostUpdateAttempt(
        bytes(
          json({}).replace(
            '"progress":null',
            '"progress":{"percent":NaN,"bytes":null,"totalBytes":null}',
          ),
        ),
      ),
    ).toEqual({ kind: "corrupt" });
    expect(
      decodeHostUpdateAttempt(
        bytes(
          json({}).replace(
            '"progress":null',
            '"progress":{"percent":Infinity,"bytes":null,"totalBytes":null}',
          ),
        ),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it.each([
    ["attemptId", { attemptId: 42 }],
    ["attemptId empty", { attemptId: "" }],
    ["generation zero", { generation: 0 }],
    ["generation negative", { generation: -1 }],
    ["generation non-integer", { generation: 1.5 }],
    ["generation string", { generation: "1" }],
    ["sequence zero", { sequence: 0 }],
    ["sequence string", { sequence: "1" }],
    ["trigger unknown", { trigger: "someone-clicked-it" }],
    ["trigger wrong type", { trigger: 1 }],
    ["targetVersion empty", { targetVersion: "" }],
    ["targetVersion wrong type", { targetVersion: 123 }],
    ["phase unknown", { phase: "downloading-but-not-really" }],
    ["startedAt wrong type", { startedAt: 12345 }],
    ["updatedAt wrong type", { updatedAt: null }],
    ["completedAt wrong type", { completedAt: 12345 }],
  ])("reports corrupt for %s", (_label, overrides) => {
    expect(decodeHostUpdateAttempt(bytes(json(overrides)))).toEqual({
      kind: "corrupt",
    });
  });

  it("reports corrupt when continuation has an unrecognized string value", () => {
    expect(
      decodeHostUpdateAttempt(bytes(json({ continuation: "reboot" }))),
    ).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when progress is not an object or array", () => {
    expect(decodeHostUpdateAttempt(bytes(json({ progress: "half" })))).toEqual({
      kind: "corrupt",
    });
    expect(decodeHostUpdateAttempt(bytes(json({ progress: [] })))).toEqual({
      kind: "corrupt",
    });
  });

  it.each([
    ["percent", { percent: "50" }],
    ["bytes", { bytes: "1024" }],
    ["totalBytes", { totalBytes: "4096" }],
  ])("reports corrupt when progress.%s has the wrong type", (key, patch) => {
    expect(
      decodeHostUpdateAttempt(
        bytes(
          json({
            progress: {
              percent: null,
              bytes: null,
              totalBytes: null,
              ...patch,
            },
          }),
        ),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when error is present but missing a required field", () => {
    expect(
      decodeHostUpdateAttempt(
        bytes(json({ error: { code: "x", message: "y" } })),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when error is not an object", () => {
    expect(decodeHostUpdateAttempt(bytes(json({ error: "boom" })))).toEqual({
      kind: "corrupt",
    });
  });

  // ---- corrupt: the two load-bearing semantic-consistency rejections -----

  it("reports corrupt when the stored execution disagrees with executionForPhase(phase)", () => {
    // `downloading` is active; a record claiming it is parked or terminal
    // is a contradiction recovery must never resolve by trusting either half.
    expect(
      decodeHostUpdateAttempt(bytes(json({ execution: "parked" }))),
    ).toEqual({ kind: "corrupt" });
    expect(
      decodeHostUpdateAttempt(bytes(json({ execution: "terminal" }))),
    ).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when a terminal phase disagrees with its execution", () => {
    expect(
      decodeHostUpdateAttempt(
        bytes(
          json({
            phase: "complete",
            execution: "active",
            completedAt: "2026-01-01T00:05:00.000Z",
          }),
        ),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when a parked phase carries the wrong continuation", () => {
    expect(
      decodeHostUpdateAttempt(
        bytes(
          JSON.stringify({
            ...VALID_PARKED,
            continuation: "activate",
          }),
        ),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when a parked phase carries a null continuation", () => {
    expect(
      decodeHostUpdateAttempt(
        bytes(
          JSON.stringify({
            ...VALID_PARKED,
            continuation: null,
          }),
        ),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when waiting-to-activate carries resume-apply instead of activate", () => {
    expect(
      decodeHostUpdateAttempt(
        bytes(
          JSON.stringify({
            ...VALID_ACTIVE,
            phase: "waiting-to-activate",
            execution: "parked",
            continuation: "resume-apply",
          }),
        ),
      ),
    ).toEqual({ kind: "corrupt" });
  });

  // ---- required nullable fields: a missing key is corrupt, not null --------

  it.each([
    ["continuation", { continuation: undefined }],
    ["progress", { progress: undefined }],
    ["completedAt", { completedAt: undefined }],
    ["error", { error: undefined }],
  ])(
    "reports corrupt when the required nullable field %s is missing entirely",
    (_label, overrides) => {
      expect(decodeHostUpdateAttempt(bytes(json(overrides)))).toEqual({
        kind: "corrupt",
      });
    },
  );

  it.each([
    ["percent", { bytes: null, totalBytes: null }],
    ["bytes", { percent: null, totalBytes: null }],
    ["totalBytes", { percent: null, bytes: null }],
  ])(
    "reports corrupt when progress is present but missing the required key %s",
    (_missingKey, partialProgress) => {
      expect(
        decodeHostUpdateAttempt(bytes(json({ progress: partialProgress }))),
      ).toEqual({ kind: "corrupt" });
    },
  );

  // ---- corrupt: counters beyond the safe-integer range ----------------------

  it.each([
    ["generation", { generation: Number.MAX_SAFE_INTEGER + 1 }],
    ["sequence", { sequence: Number.MAX_SAFE_INTEGER + 1 }],
  ])(
    "reports corrupt when %s is a positive integer beyond Number.MAX_SAFE_INTEGER",
    (_label, overrides) => {
      expect(decodeHostUpdateAttempt(bytes(json(overrides)))).toEqual({
        kind: "corrupt",
      });
    },
  );

  // ---- unsupported-version -------------------------------------------------

  it("reports unsupported-version for schemaVersion 1 (the legacy coarse marker)", () => {
    expect(decodeHostUpdateAttempt(bytes(json({ schemaVersion: 1 })))).toEqual({
      kind: "unsupported-version",
      version: 1,
    });
  });

  it("reports unsupported-version for schemaVersion 3 (a future, unreleased schema)", () => {
    expect(decodeHostUpdateAttempt(bytes(json({ schemaVersion: 3 })))).toEqual({
      kind: "unsupported-version",
      version: 3,
    });
  });

  // ---- recovery provenance ---------------------------------------------

  const VALID_COMPLETE_RECOVERY = {
    recoveredBy: "attempt-executor" as const,
    outcome: "complete" as const,
    evidence: {
      installed: { kind: "verified" as const, version: "1.2.3" },
      staged: { kind: "absent" as const, version: null },
      running: {
        kind: "verified" as const,
        version: "1.2.3",
        ownerBound: true,
      },
    },
  };

  function completeTerminalJson(overrides: Record<string, unknown>): string {
    return JSON.stringify({
      ...VALID_ACTIVE,
      phase: "complete",
      execution: "terminal",
      completedAt: "2026-01-01T00:05:00.000Z",
      recovery: VALID_COMPLETE_RECOVERY,
      ...overrides,
    });
  }

  it("decodes a valid recovery-provenance object attached to a matching terminal outcome", () => {
    const result = decodeHostUpdateAttempt(bytes(completeTerminalJson({})));
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.value.recovery).toEqual(VALID_COMPLETE_RECOVERY);
    }
  });

  it.each([
    ["installed", "absent"],
    ["staged", "absent"],
    ["running", "absent"],
  ] as const)(
    "reports corrupt when the %s leg is %s but carries a non-null version",
    (leg, kind) => {
      const evidence = {
        ...VALID_COMPLETE_RECOVERY.evidence,
        [leg]:
          leg === "running"
            ? { kind, version: "9.9.9", ownerBound: false }
            : { kind, version: "9.9.9" },
      };
      const result = decodeHostUpdateAttempt(
        bytes(
          completeTerminalJson({
            recovery: { ...VALID_COMPLETE_RECOVERY, evidence },
          }),
        ),
      );
      expect(result).toEqual({ kind: "corrupt" });
    },
  );

  it.each(["installed", "staged"] as const)(
    "reports corrupt when the %s leg is verified but carries a null version",
    (leg) => {
      const evidence = {
        ...VALID_COMPLETE_RECOVERY.evidence,
        [leg]: { kind: "verified", version: null },
      };
      const result = decodeHostUpdateAttempt(
        bytes(
          completeTerminalJson({
            recovery: { ...VALID_COMPLETE_RECOVERY, evidence },
          }),
        ),
      );
      expect(result).toEqual({ kind: "corrupt" });
    },
  );

  it("reports corrupt when recovery is attached to a live (non-terminal) phase", () => {
    const result = decodeHostUpdateAttempt(
      bytes(json({ recovery: VALID_COMPLETE_RECOVERY })),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when recovery.outcome disagrees with the record's own terminal phase", () => {
    const result = decodeHostUpdateAttempt(
      bytes(
        completeTerminalJson({
          recovery: { ...VALID_COMPLETE_RECOVERY, outcome: "failed" },
        }),
      ),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });
});

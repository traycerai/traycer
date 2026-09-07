import { describe, expect, it } from "vitest";
import type { DurableBytes } from "../host-update-attempt";
import { decodeHostUpdateAttempt } from "../host-update-attempt";

// Protocol-level pins for `decodeHostUpdateAttempt`. The contract is
// currently defended only from `clients/shared/host-update/__tests__/decode.test.ts`,
// a different package exercising the same decoder through its re-export. This
// suite pins the same guarantees against the module that actually defines
// them, importing directly from `../host-update-attempt` rather than through
// `@traycer-clients/shared/host-update`.
//
// Scope is deliberately narrow: `claim`, `recovery`, the forward-compat
// asymmetry between them, unknown-key tolerance, and the never-CORRUPT
// boundary. Everything else about this decoder (identity/ordering,
// counter-overflow rejection, the base field grammar) is out of scope here.

const bytes = (text: string): DurableBytes => ({ kind: "bytes", text });

// A minimally valid v2 record - `downloading` is active, so every claim/
// recovery test starts from a phase that is neither parked nor terminal.
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

const VALID_CLAIM = {
  installedVersion: "1.0.0",
  installGeneration: "gen-a",
  stageFingerprint: "fp-a",
  allowDowngrade: true,
};

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
    ...overrides,
  });
}

describe("decodeHostUpdateAttempt (protocol module, imported directly)", () => {
  // ---- claim: additive, optional, legal on ANY phase ----------------------

  describe("claim baseline", () => {
    it("decodes a claim baseline attached to an ACTIVE record", () => {
      const result = decodeHostUpdateAttempt(bytes(json({ claim: VALID_CLAIM })));
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") expect(result.value.claim).toEqual(VALID_CLAIM);
    });

    it("decodes a claim baseline attached to a PARKED record", () => {
      const result = decodeHostUpdateAttempt(
        bytes(JSON.stringify({ ...VALID_PARKED, claim: VALID_CLAIM })),
      );
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") expect(result.value.claim).toEqual(VALID_CLAIM);
    });

    it("decodes a claim baseline attached to a TERMINAL record", () => {
      const result = decodeHostUpdateAttempt(
        bytes(completeTerminalJson({ claim: VALID_CLAIM })),
      );
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") expect(result.value.claim).toEqual(VALID_CLAIM);
    });

    it("decodes with no claim key at all when claim is omitted, never inventing a claim", () => {
      const result = decodeHostUpdateAttempt(bytes(json({})));
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") expect("claim" in result.value).toBe(false);
    });

    it("preserves allowDowngrade verbatim as the consent the claim was made under, rather than recomputing it from version order", () => {
      // installedVersion (9.9.9) is newer than targetVersion (1.0.0) - a
      // downgrade by version order - yet the claim on record says consent
      // was withheld. The decoder must carry that value through unchanged,
      // not infer consent from the version comparison.
      const claim = { ...VALID_CLAIM, installedVersion: "9.9.9", allowDowngrade: false };
      const result = decodeHostUpdateAttempt(
        bytes(json({ claim, targetVersion: "1.0.0" })),
      );
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") {
        expect(result.value.claim?.allowDowngrade).toBe(false);
      }
    });

    it("reports corrupt when claim is explicitly null rather than omitted", () => {
      expect(decodeHostUpdateAttempt(bytes(json({ claim: null })))).toEqual({
        kind: "corrupt",
      });
    });
  });

  // ---- recovery: additive, optional, but describes a TERMINAL conclusion --

  describe("recovery provenance", () => {
    it("decodes a recovery record attached to a matching TERMINAL phase", () => {
      const result = decodeHostUpdateAttempt(
        bytes(completeTerminalJson({ recovery: VALID_COMPLETE_RECOVERY })),
      );
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") {
        expect(result.value.recovery).toEqual(VALID_COMPLETE_RECOVERY);
      }
    });

    it("reports corrupt when recovery is attached to an ACTIVE (non-terminal) phase", () => {
      const result = decodeHostUpdateAttempt(
        bytes(json({ recovery: VALID_COMPLETE_RECOVERY })),
      );
      expect(result).toEqual({ kind: "corrupt" });
    });

    it("reports corrupt when recovery is attached to a PARKED (non-terminal) phase", () => {
      const result = decodeHostUpdateAttempt(
        bytes(JSON.stringify({ ...VALID_PARKED, recovery: VALID_COMPLETE_RECOVERY })),
      );
      expect(result).toEqual({ kind: "corrupt" });
    });

    it("decodes with no recovery key at all when recovery is omitted", () => {
      const result = decodeHostUpdateAttempt(
        bytes(completeTerminalJson({})),
      );
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") expect("recovery" in result.value).toBe(false);
    });
  });

  // ---- the phase-legality asymmetry between claim and recovery is deliberate

  describe("claim vs. recovery: phase legality is asymmetric by design", () => {
    it("accepts claim but rejects recovery on the very same active record", () => {
      const withClaim = decodeHostUpdateAttempt(bytes(json({ claim: VALID_CLAIM })));
      expect(withClaim.kind).toBe("valid");

      const withRecovery = decodeHostUpdateAttempt(
        bytes(json({ recovery: VALID_COMPLETE_RECOVERY })),
      );
      expect(withRecovery).toEqual({ kind: "corrupt" });
    });

    it("accepts both claim and recovery together once the phase is terminal, since only recovery was ever phase-restricted", () => {
      const result = decodeHostUpdateAttempt(
        bytes(
          completeTerminalJson({ claim: VALID_CLAIM, recovery: VALID_COMPLETE_RECOVERY }),
        ),
      );
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") {
        expect(result.value.claim).toEqual(VALID_CLAIM);
        expect(result.value.recovery).toEqual(VALID_COMPLETE_RECOVERY);
      }
    });
  });

  // ---- forward-compat: a field grown without a schema bump must decode ----

  describe("forward compatibility of fields added without a schema bump", () => {
    it("decodes a schemaVersion-2 record that predates both claim and recovery (neither key present) exactly as before", () => {
      const result = decodeHostUpdateAttempt(bytes(json({})));
      expect(result).toEqual({ kind: "valid", version: 2, value: VALID_ACTIVE });
    });

    it("decodes a schemaVersion-2 record carrying recovery - the field grown without a version bump - as valid, not corrupt", () => {
      // This is the header comment's own example (host-update-attempt.ts:18-20):
      // a decoder that had not learned about `recovery` would read this
      // perfectly good record as corrupt. It must not.
      const result = decodeHostUpdateAttempt(
        bytes(completeTerminalJson({ recovery: VALID_COMPLETE_RECOVERY })),
      );
      expect(result.kind).toBe("valid");
    });

    it("decodes a schemaVersion-2 record carrying claim, the second field grown the same way, as valid on a phase recovery could never legally occupy", () => {
      const result = decodeHostUpdateAttempt(
        bytes(JSON.stringify({ ...VALID_PARKED, claim: VALID_CLAIM })),
      );
      expect(result.kind).toBe("valid");
    });
  });

  // ---- unknown-key tolerance ------------------------------------------------

  describe("unknown-key tolerance", () => {
    it("does not treat an unrecognized top-level key as corrupt", () => {
      const result = decodeHostUpdateAttempt(
        bytes(json({ someFutureFieldNoDecoderKnowsAboutYet: "x" })),
      );
      expect(result.kind).toBe("valid");
    });

    it("drops an unrecognized top-level key rather than carrying it into the decoded value", () => {
      const result = decodeHostUpdateAttempt(
        bytes(json({ someFutureFieldNoDecoderKnowsAboutYet: "x" })),
      );
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") {
        expect("someFutureFieldNoDecoderKnowsAboutYet" in result.value).toBe(false);
      }
    });

    it("tolerates an unrecognized key alongside a legal claim and recovery pair on the same record", () => {
      // The realistic forward-compat shape: a future writer adds a field
      // this build has never heard of, on a record that is otherwise
      // entirely legal by today's rules.
      const result = decodeHostUpdateAttempt(
        bytes(
          completeTerminalJson({
            claim: VALID_CLAIM,
            recovery: VALID_COMPLETE_RECOVERY,
            aFieldFromTheFuture: { anything: "goes" },
          }),
        ),
      );
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") {
        expect("aFieldFromTheFuture" in result.value).toBe(false);
        expect(result.value.claim).toEqual(VALID_CLAIM);
        expect(result.value.recovery).toEqual(VALID_COMPLETE_RECOVERY);
      }
    });
  });

  // ---- never-CORRUPT: which inputs do, which realistic ones must not ------

  describe("the corrupt verdict: precise, not a catch-all", () => {
    it("reports corrupt for unparseable JSON, the one input with no shape to inspect at all", () => {
      expect(decodeHostUpdateAttempt(bytes("{not json"))).toEqual({
        kind: "corrupt",
      });
    });

    it("reports corrupt when claim is present but violates its own shape, distinct from a bad recovery", () => {
      const claim = { ...VALID_CLAIM, allowDowngrade: "yes" };
      expect(decodeHostUpdateAttempt(bytes(json({ claim })))).toEqual({
        kind: "corrupt",
      });
    });

    it("reports corrupt when recovery is present but its outcome disagrees with the record's own terminal phase", () => {
      const result = decodeHostUpdateAttempt(
        bytes(
          completeTerminalJson({
            recovery: { ...VALID_COMPLETE_RECOVERY, outcome: "failed" },
          }),
        ),
      );
      expect(result).toEqual({ kind: "corrupt" });
    });

    it("does NOT report corrupt for the realistic forward-compat record: known-good base fields, an unknown extra key, and a legal claim - the case the header comment exists to keep decodable", () => {
      const result = decodeHostUpdateAttempt(
        bytes(
          json({
            claim: VALID_CLAIM,
            aHypotheticalFutureDiagnosticField: 42,
          }),
        ),
      );
      expect(result.kind).toBe("valid");
    });
  });
});

import { describe, expect, it } from "vitest";
import type { DurableBytes } from "../durable/decoder";
import {
  decodeInstallRecord,
  decodePendingActivation,
  decodeSubstrateRecord,
  decodeTransitionJournal,
  fileReadToDurableBytes,
} from "../durable/decoder";
import {
  booleanSentinelToEvidence,
  decodeBooleanSentinel,
} from "../durable/sentinel";

const missing: DurableBytes = { kind: "missing" };
const unreadable: DurableBytes = { kind: "unreadable", cause: "EACCES" };
const bytes = (text: string): DurableBytes => ({ kind: "bytes", text });

describe("decodeSubstrateRecord", () => {
  it("decodes a valid v1 record with a string attestation", () => {
    const result = decodeSubstrateRecord(
      bytes(
        JSON.stringify({
          v: 1,
          active: "smappservice",
          since: "2026-01-01T00:00:00.000Z",
          reason: "install",
          attestation: "attested-token",
        }),
      ),
    );
    expect(result).toEqual({
      kind: "valid",
      version: 1,
      value: {
        active: "smappservice",
        since: "2026-01-01T00:00:00.000Z",
        reason: "install",
        attestation: "attested-token",
      },
    });
  });

  it("decodes a valid v1 record with a null attestation", () => {
    const result = decodeSubstrateRecord(
      bytes(
        JSON.stringify({
          v: 1,
          active: "raw-fallback",
          since: "2026-01-01T00:00:00.000Z",
          reason: "fallback",
          attestation: null,
        }),
      ),
    );
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.value.attestation).toBeNull();
    }
  });

  it("reports absent for a missing file", () => {
    expect(decodeSubstrateRecord(missing)).toEqual({ kind: "absent" });
  });

  it("reports unreadable with the cause for an fs read error", () => {
    expect(decodeSubstrateRecord(unreadable)).toEqual({
      kind: "unreadable",
      cause: "EACCES",
    });
  });

  it("reports corrupt for invalid JSON", () => {
    expect(decodeSubstrateRecord(bytes("{not json"))).toEqual({
      kind: "corrupt",
    });
  });

  it("reports corrupt for a JSON array instead of an object", () => {
    expect(decodeSubstrateRecord(bytes("[]"))).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when `active` is outside the closed set", () => {
    const result = decodeSubstrateRecord(
      bytes(
        JSON.stringify({
          v: 1,
          active: "something-else",
          since: "2026-01-01T00:00:00.000Z",
          reason: "install",
        }),
      ),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when attestation has a non-string, non-null type", () => {
    const result = decodeSubstrateRecord(
      bytes(
        JSON.stringify({
          v: 1,
          active: "smappservice",
          since: "2026-01-01T00:00:00.000Z",
          reason: "install",
          attestation: 42,
        }),
      ),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("reports unsupported-version for an unknown schema version", () => {
    const result = decodeSubstrateRecord(
      bytes(
        JSON.stringify({
          v: 99,
          active: "smappservice",
          since: "2026-01-01T00:00:00.000Z",
          reason: "install",
        }),
      ),
    );
    expect(result).toEqual({ kind: "unsupported-version", version: 99 });
  });

  it("reports corrupt when the version field is missing entirely", () => {
    const result = decodeSubstrateRecord(
      bytes(
        JSON.stringify({
          active: "smappservice",
          since: "2026-01-01T00:00:00.000Z",
          reason: "install",
        }),
      ),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("accepts `version` as an alias for `v`", () => {
    const result = decodeSubstrateRecord(
      bytes(
        JSON.stringify({
          version: 1,
          active: "smappservice",
          since: "2026-01-01T00:00:00.000Z",
          reason: "install",
        }),
      ),
    );
    expect(result.kind).toBe("valid");
  });
});

describe("decodeTransitionJournal", () => {
  const base = {
    v: 1,
    transitionId: "t-1",
    probeNonce: "nonce-1",
    from: "raw-fallback",
    to: "smappservice",
    phase: "started",
    startedAt: "2026-01-01T00:00:00.000Z",
    expectedIdentities: ["ai.traycer.host.agent"],
  };

  it("decodes a valid record with governor and compensation both null", () => {
    const result = decodeTransitionJournal(
      bytes(JSON.stringify({ ...base, governor: null, compensation: null })),
    );
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.value.governor).toBeNull();
      expect(result.value.compensation).toBeNull();
    }
  });

  it("decodes a valid record with a fully populated governor", () => {
    const result = decodeTransitionJournal(
      bytes(
        JSON.stringify({
          ...base,
          compensation: "rollback",
          governor: {
            lastAttemptedBuildId: "build-1",
            lastAttemptedCDHash: "cdhash-1",
            failureClass: "spawn-failed",
            attemptCount: 2,
            nextEligibleAt: "2026-01-02T00:00:00.000Z",
            breaker: "open",
            lastSustainedHealthAt: null,
          },
        }),
      ),
    );
    expect(result.kind).toBe("valid");
    if (result.kind === "valid") {
      expect(result.value.governor).toEqual({
        lastAttemptedBuildId: "build-1",
        lastAttemptedCDHash: "cdhash-1",
        failureClass: "spawn-failed",
        attemptCount: 2,
        nextEligibleAt: "2026-01-02T00:00:00.000Z",
        breaker: "open",
        lastSustainedHealthAt: null,
      });
    }
  });

  it("reports corrupt when `from` is outside the closed set", () => {
    const result = decodeTransitionJournal(
      bytes(JSON.stringify({ ...base, from: "bogus" })),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when `to` is outside the closed set", () => {
    const result = decodeTransitionJournal(
      bytes(JSON.stringify({ ...base, to: "bogus" })),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when expectedIdentities is not an array", () => {
    const result = decodeTransitionJournal(
      bytes(JSON.stringify({ ...base, expectedIdentities: "nope" })),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when expectedIdentities contains a non-string entry", () => {
    const result = decodeTransitionJournal(
      bytes(JSON.stringify({ ...base, expectedIdentities: ["ok", 5] })),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when governor is present but missing attemptCount", () => {
    const result = decodeTransitionJournal(
      bytes(JSON.stringify({ ...base, governor: { breaker: "open" } })),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("reports absent / unreadable / unsupported-version like other decoders", () => {
    expect(decodeTransitionJournal(missing)).toEqual({ kind: "absent" });
    expect(decodeTransitionJournal(unreadable)).toEqual({
      kind: "unreadable",
      cause: "EACCES",
    });
    expect(
      decodeTransitionJournal(bytes(JSON.stringify({ ...base, v: 7 }))),
    ).toEqual({ kind: "unsupported-version", version: 7 });
  });
});

describe("decodeInstallRecord", () => {
  it("decodes a valid record carrying an explicit v field", () => {
    const result = decodeInstallRecord(
      bytes(
        JSON.stringify({
          v: 1,
          version: "1.2.3",
          installedAt: "2026-01-01T00:00:00.000Z",
          installId: "install-1",
          archiveSha256: "a".repeat(64),
          platform: "darwin",
          arch: "arm64",
        }),
      ),
    );
    expect(result).toEqual({
      kind: "valid",
      version: 1,
      value: {
        version: "1.2.3",
        installedAt: "2026-01-01T00:00:00.000Z",
        installId: "install-1",
        archiveSha256: "a".repeat(64),
        platform: "darwin",
        arch: "arm64",
      },
    });
  });

  it("synthesizes version 1 for a legacy record with no top-level v field", () => {
    const result = decodeInstallRecord(
      bytes(
        JSON.stringify({
          version: "1.0.0",
          installedAt: "2025-01-01T00:00:00.000Z",
        }),
      ),
    );
    expect(result).toEqual({
      kind: "valid",
      version: 1,
      value: {
        version: "1.0.0",
        installedAt: "2025-01-01T00:00:00.000Z",
        installId: null,
        archiveSha256: null,
        platform: null,
        arch: null,
      },
    });
  });

  it("reports unsupported-version when v is present but unknown", () => {
    const result = decodeInstallRecord(
      bytes(
        JSON.stringify({
          v: 5,
          version: "1.0.0",
          installedAt: "2025-01-01T00:00:00.000Z",
        }),
      ),
    );
    expect(result).toEqual({ kind: "unsupported-version", version: 5 });
  });

  it("reports corrupt when installedAt is missing", () => {
    const result = decodeInstallRecord(
      bytes(JSON.stringify({ version: "1.0.0" })),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt when version has the wrong type", () => {
    const result = decodeInstallRecord(
      bytes(
        JSON.stringify({
          version: 123,
          installedAt: "2025-01-01T00:00:00.000Z",
        }),
      ),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("reports corrupt for invalid JSON and non-object shapes", () => {
    expect(decodeInstallRecord(bytes("{broken"))).toEqual({ kind: "corrupt" });
    expect(decodeInstallRecord(bytes("[]"))).toEqual({ kind: "corrupt" });
  });

  it("reports absent for a missing file and unreadable for an fs error", () => {
    expect(decodeInstallRecord(missing)).toEqual({ kind: "absent" });
    expect(decodeInstallRecord(unreadable)).toEqual({
      kind: "unreadable",
      cause: "EACCES",
    });
  });
});

describe("decodePendingActivation", () => {
  it("decodes a valid record", () => {
    const result = decodePendingActivation(
      bytes(
        JSON.stringify({
          v: 1,
          toGeneration: "gen-2",
          requestedAt: "2026-01-01T00:00:00.000Z",
          cause: "busy-host",
        }),
      ),
    );
    expect(result).toEqual({
      kind: "valid",
      version: 1,
      value: {
        toGeneration: "gen-2",
        requestedAt: "2026-01-01T00:00:00.000Z",
        cause: "busy-host",
      },
    });
  });

  it("reports corrupt when a required field is missing", () => {
    const result = decodePendingActivation(
      bytes(JSON.stringify({ v: 1, toGeneration: "gen-2" })),
    );
    expect(result).toEqual({ kind: "corrupt" });
  });

  it("reports absent / unreadable / unsupported-version", () => {
    expect(decodePendingActivation(missing)).toEqual({ kind: "absent" });
    expect(decodePendingActivation(unreadable)).toEqual({
      kind: "unreadable",
      cause: "EACCES",
    });
    expect(
      decodePendingActivation(
        bytes(
          JSON.stringify({
            v: 99,
            toGeneration: "gen-2",
            requestedAt: "2026-01-01T00:00:00.000Z",
            cause: "busy-host",
          }),
        ),
      ),
    ).toEqual({ kind: "unsupported-version", version: 99 });
  });
});

describe("fileReadToDurableBytes", () => {
  it("maps a not-found fs result to missing", () => {
    expect(fileReadToDurableBytes({ kind: "not-found" })).toEqual({
      kind: "missing",
    });
  });

  it("maps an fs error result to unreadable with cause", () => {
    expect(fileReadToDurableBytes({ kind: "error", cause: "EPERM" })).toEqual({
      kind: "unreadable",
      cause: "EPERM",
    });
  });

  it("maps an ok fs result to bytes with the text", () => {
    expect(fileReadToDurableBytes({ kind: "ok", text: "{}" })).toEqual({
      kind: "bytes",
      text: "{}",
    });
  });
});

/**
 * The sentinel decoder is the fix for a lockout-class blocker: the previous
 * per-platform reader recognised a bare boolean or `{"value": bool}` and fell
 * through **everything else** to `observed(true)`, while the only writer in
 * either repo emits `{"removedByUser": bool}`.
 *
 * Every arm below is reachable from bytes the product can actually produce.
 * The writer↔reader pinning — running the real desktop writer and decoding its
 * literal output — lives in
 * `clients/desktop/src/electron-main/host/__tests__/host-removal-state-sentinel-contract.test.ts`,
 * because that is the only place the real writer can run.
 */
describe("decodeBooleanSentinel", () => {
  it("is absent when the file does not exist", () => {
    expect(decodeBooleanSentinel(missing, "removedByUser")).toEqual({
      kind: "absent",
    });
  });

  it("is unreadable — with the cause — on an IO error", () => {
    expect(decodeBooleanSentinel(unreadable, "removedByUser")).toEqual({
      kind: "unreadable",
      cause: "EACCES",
    });
  });

  it("decodes the canonical versioned envelope", () => {
    expect(
      decodeBooleanSentinel(bytes('{"v":1,"value":true}'), "removedByUser"),
    ).toEqual({
      kind: "observed",
      value: true,
    });
    expect(
      decodeBooleanSentinel(bytes('{"v":1,"value":false}'), "removedByUser"),
    ).toEqual({
      kind: "observed",
      value: false,
    });
  });

  // The shape the shipped desktop writes today. Previously `corrupt`-adjacent:
  // it fell through to `observed(true)`, inverting `false`.
  it("decodes the shipped desktop shapes on their own keys", () => {
    expect(
      decodeBooleanSentinel(bytes('{"removedByUser":false}'), "removedByUser"),
    ).toEqual({ kind: "observed", value: false });
    expect(
      decodeBooleanSentinel(bytes('{"removedByUser":true}'), "removedByUser"),
    ).toEqual({ kind: "observed", value: true });
    expect(
      decodeBooleanSentinel(bytes('{"stoppedByUser":false}'), "stoppedByUser"),
    ).toEqual({ kind: "observed", value: false });
  });

  it("decodes the legacy bare boolean", () => {
    expect(decodeBooleanSentinel(bytes("true"), "removedByUser")).toEqual({
      kind: "observed",
      value: true,
    });
    expect(decodeBooleanSentinel(bytes("false"), "removedByUser")).toEqual({
      kind: "observed",
      value: false,
    });
  });

  it("is unsupported-version for a future envelope, rather than guessing", () => {
    expect(
      decodeBooleanSentinel(bytes('{"v":2,"value":true}'), "removedByUser"),
    ).toEqual({
      kind: "unsupported-version",
      version: 2,
    });
  });

  // The heart of the blocker: an unrecognised shape must NEVER become a value,
  // and specifically never `observed(true)` — a durable refusal to start.
  it.each([
    ['{"somethingElse":true}', "an unknown key"],
    ["{}", "an empty object"],
    ["[]", "an array"],
    ["null", "JSON null"],
    ['"true"', "a quoted string"],
    ["42", "a number"],
    ['{"removedByUser":"yes"}', "a non-boolean value on a known key"],
    ["{ not json", "unparseable bytes"],
  ])("is corrupt for %s (%s) — never observed(true)", (text) => {
    const decoded = decodeBooleanSentinel(bytes(text), "removedByUser");
    expect(decoded).toEqual({ kind: "corrupt" });
  });

  it("has no arm that produces a value from an unrecognised shape", () => {
    // Enumerated rather than sampled: whatever the decoder does with junk, it
    // must not be `observed`.
    for (const text of [
      "{}",
      "[]",
      "0",
      '""',
      '{"v":1}',
      '{"value":"true"}',
      '{"removedByUser":null}',
    ]) {
      expect(decodeBooleanSentinel(bytes(text), "removedByUser").kind).not.toBe(
        "observed",
      );
    }
  });
});

describe("booleanSentinelToEvidence", () => {
  it("passes observed and absent through unchanged", () => {
    expect(
      booleanSentinelToEvidence({ kind: "observed", value: false }),
    ).toEqual({ kind: "observed", value: false });
    expect(booleanSentinelToEvidence({ kind: "absent" })).toEqual({
      kind: "absent",
    });
  });

  // I3 — evidence travels. Doctor has to be able to tell a user *why* their
  // sentinel could not be read, so the failed arms keep distinct causes rather
  // than collapsing onto one generic `probe-error`.
  it("maps each failed arm to its own distinguishable cause", () => {
    expect(booleanSentinelToEvidence({ kind: "corrupt" })).toEqual({
      kind: "indeterminate",
      cause: "sentinel-corrupt",
    });
    expect(
      booleanSentinelToEvidence({ kind: "unreadable", cause: "EACCES" }),
    ).toEqual({ kind: "indeterminate", cause: "sentinel-unreadable" });
    expect(
      booleanSentinelToEvidence({ kind: "unsupported-version", version: 9 }),
    ).toEqual({
      kind: "indeterminate",
      cause: "sentinel-unsupported-version",
    });
  });

  it("never yields a value for a failed arm", () => {
    for (const record of [
      { kind: "corrupt" } as const,
      { kind: "unreadable", cause: "EIO" } as const,
      { kind: "unsupported-version", version: 3 } as const,
    ]) {
      expect(booleanSentinelToEvidence(record).kind).toBe("indeterminate");
    }
  });
});

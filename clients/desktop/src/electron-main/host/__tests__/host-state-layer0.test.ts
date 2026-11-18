import { describe, expect, it } from "vitest";
import { decodeHostLayer0Record } from "../host-state";

/**
 * Layer-0 pid.json decode is the only skew guard on this surface (not in any
 * RPC or persistence registry). These fixtures pin fail-open behavior:
 * absence stays absent; an unknown cause stays diagnostic, never dropped.
 */
describe("decodeHostLayer0Record skew", () => {
  /**
   * Older host: pid.json with no `layer0` key means the field is not
   * recorded. That must decode as null, never as a fabricated healthy
   * acquired verdict.
   */
  it("decodes an older-host missing layer0 field as absent/null", () => {
    expect(decodeHostLayer0Record(undefined)).toBeNull();
    expect(decodeHostLayer0Record(null)).toBeNull();
  });

  /**
   * Newer host: a degraded record whose cause this desktop does not know
   * yet must fail open as `unrecognized` with the raw JSON intact. Narrowing
   * to a parse failure would destroy the diagnostic T1 exists to preserve.
   */
  it("decodes a newer-host degraded record with an unknown cause as unrecognized, preserving raw JSON", () => {
    const newerHostLayer0 = {
      status: "degraded",
      attemptId: "future-host-attempt",
      cause: "future-unknown-cause",
      evidence: "host emits a cause this desktop build does not list yet",
    };

    expect(decodeHostLayer0Record(newerHostLayer0)).toEqual({
      status: "unrecognized",
      raw: JSON.stringify(newerHostLayer0),
    });
  });

  it("decodes a structured os-error cause without flattening it to a string", () => {
    expect(
      decodeHostLayer0Record({
        status: "degraded",
        attemptId: "host-4242",
        cause: {
          kind: "os-error",
          syscall: "open",
          code: "EACCES",
          fsType: null,
        },
        evidence: "kernel lifecycle lock acquisition was not determinable",
      }),
    ).toEqual({
      status: "degraded",
      attemptId: "host-4242",
      cause: {
        kind: "os-error",
        syscall: "open",
        code: "EACCES",
        fsType: null,
      },
      evidence: "kernel lifecycle lock acquisition was not determinable",
    });
  });

  it("decodes a known string cause without loss", () => {
    expect(
      decodeHostLayer0Record({
        status: "degraded",
        attemptId: "sea-addon-degraded",
        cause: "addon-load-failed",
        evidence: "Cannot find module 'lifecycle_lock.node'",
      }),
    ).toEqual({
      status: "degraded",
      attemptId: "sea-addon-degraded",
      cause: "addon-load-failed",
      evidence: "Cannot find module 'lifecycle_lock.node'",
    });
  });
});

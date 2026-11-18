import { describe, expect, it } from "vitest";
import { decodeLayer0Record } from "../pid-metadata";

/**
 * The bytes under test are the ones the host really writes.
 *
 * `traycer-host/src/lifecycle/layer0-startup-record.ts` builds the record and
 * `buildHostPidMetadata` embeds it verbatim, so these fixtures are copied from
 * that shape rather than invented here — a decoder tested against inputs the
 * writer cannot produce proves the assertion and not the contract.
 *
 * The field exists because every other channel the host has for "I started
 * without the single-writer guarantee" is ephemeral: the framed status pipe
 * usually has no reader, and the stderr line scrolls out of the log tail the
 * support attachment captures. Dropping it here would restore that silence.
 */
describe("decodeLayer0Record", () => {
  it("decodes the acquired record the host publishes", () => {
    expect(
      decodeLayer0Record({ status: "acquired", attemptId: "host-4242" }),
    ).toEqual({ status: "acquired", attemptId: "host-4242" });
  });

  it("decodes a degraded record with a string cause", () => {
    expect(
      decodeLayer0Record({
        status: "degraded",
        attemptId: "host-4242",
        cause: "addon-load-failed",
        evidence: "Cannot find module 'lifecycle_lock.node'",
      }),
    ).toEqual({
      status: "degraded",
      attemptId: "host-4242",
      cause: "addon-load-failed",
      evidence: "Cannot find module 'lifecycle_lock.node'",
    });
  });

  /**
   * The host's `os-error` cause is an object. Rendering it rather than
   * dropping it keeps the syscall and errno — the two facts that separate
   * "this filesystem cannot do it" from "this user cannot" — in the report.
   */
  it("renders the structured os-error cause instead of discarding it", () => {
    const decoded = decodeLayer0Record({
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

    expect(decoded?.status).toBe("degraded");
    expect(decoded).toMatchObject({
      cause: JSON.stringify({
        kind: "os-error",
        syscall: "open",
        code: "EACCES",
        fsType: null,
      }),
    });
  });

  /** Absence is "not recorded" — every pid.json older than the field. */
  it("reads an absent record as null rather than as healthy", () => {
    expect(decodeLayer0Record(undefined)).toBeNull();
    expect(decodeLayer0Record(null)).toBeNull();
  });

  /**
   * A CLI older than its host must say "I cannot confirm the guarantee", not
   * fall silent. Collapsing an unknown status to `null` would reintroduce
   * exactly the silence this field removes.
   */
  it("reports an unfamiliar status as unrecognized, never as absent", () => {
    expect(
      decodeLayer0Record({ status: "quarantined", attemptId: "h" }),
    ).toEqual({
      status: "unrecognized",
      raw: JSON.stringify({ status: "quarantined", attemptId: "h" }),
    });
    expect(decodeLayer0Record("degraded")).toEqual({
      status: "unrecognized",
      raw: '"degraded"',
    });
  });

  /**
   * A well-known status with no attempt id is not a usable record: the attempt
   * id is what ties the verdict to one start. It must not silently pass as
   * acquired.
   */
  it("does not accept an acquired record with no attempt id", () => {
    expect(decodeLayer0Record({ status: "acquired" })?.status).toBe(
      "unrecognized",
    );
  });
});

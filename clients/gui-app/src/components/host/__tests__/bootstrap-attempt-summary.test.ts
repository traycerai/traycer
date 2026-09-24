import { describe, expect, it } from "vitest";
import type { BootstrapMarkerEntry } from "@traycer-clients/shared/platform/runner-host";
import { describeOutcome } from "@/components/host/bootstrap-attempt-summary";

// O-WIN-1: on Windows, a requested stop is recorded as `phase=killed` with
// the handle-bound kill's exit CODE and NO signal - the same shape a POSIX
// signal death used to be the only way to reach `killed`. `describeOutcome`
// has to tell the two apart: a code with no signal reads as a requested
// stop, never as "signal unknown".

function killedMarker(
  fields: Readonly<Partial<Record<string, string>>>,
): BootstrapMarkerEntry {
  return {
    timestamp: "2026-01-01T00:00:03.000Z",
    phase: "killed",
    fields,
  };
}

describe("describeOutcome - killed", () => {
  it("reports a requested-stop exit code when a code is present with no signal", () => {
    expect(describeOutcome(killedMarker({ code: "4294967295" }))).toBe(
      "Host was stopped on request (exit code 4294967295).",
    );
  });

  it("keeps the signal text when a signal is present", () => {
    expect(describeOutcome(killedMarker({ signal: "SIGTERM" }))).toBe(
      "Host was killed with signal SIGTERM.",
    );
  });

  it("falls back to 'signal unknown' when neither a code nor a signal is present", () => {
    expect(describeOutcome(killedMarker({}))).toBe(
      "Host was killed with signal unknown.",
    );
  });
});

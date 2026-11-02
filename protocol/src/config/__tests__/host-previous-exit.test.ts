import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOST_PREVIOUS_EXIT_KINDS,
  hostPreviousExitPath,
  parseHostPreviousExit,
} from "../host-previous-exit";

const GOOD = {
  v: 1,
  attemptId: "attempt-1",
  endedAt: "2026-11-02T10:00:00.000Z",
  kind: "out-of-memory",
  exitCode: null,
  signal: "SIGABRT",
  heapLimitBytes: 4831838208,
  heapUsedBytes: 4100000000,
};

describe("parseHostPreviousExit", () => {
  it("accepts a good record unchanged, for every kind", () => {
    for (const kind of HOST_PREVIOUS_EXIT_KINDS) {
      expect(parseHostPreviousExit({ ...GOOD, kind })).toEqual({
        ...GOOD,
        kind,
      });
    }
  });

  it("accepts a clean exit with no heap numbers and no signal", () => {
    const record = {
      ...GOOD,
      kind: "exited",
      exitCode: 0,
      signal: null,
      heapLimitBytes: null,
      heapUsedBytes: null,
    };
    expect(parseHostPreviousExit(record)).toEqual(record);
  });

  it.each([
    ["a non-object", "nope"],
    ["null", null],
    ["an array", [GOOD]],
    ["a wrong version", { ...GOOD, v: 2 }],
    ["an empty attemptId", { ...GOOD, attemptId: "" }],
    ["a too-long attemptId", { ...GOOD, attemptId: "a".repeat(129) }],
    ["a non-string attemptId", { ...GOOD, attemptId: 7 }],
    ["an unparsable endedAt", { ...GOOD, endedAt: "yesterday" }],
    ["a numeric endedAt", { ...GOOD, endedAt: 1_700_000_000_000 }],
    ["an unknown kind", { ...GOOD, kind: "melted" }],
    ["a fractional exitCode", { ...GOOD, exitCode: 1.5 }],
    ["a string exitCode", { ...GOOD, exitCode: "1" }],
    ["an empty signal", { ...GOOD, signal: "" }],
    ["a negative heapLimitBytes", { ...GOOD, heapLimitBytes: -1 }],
    ["a negative heapUsedBytes", { ...GOOD, heapUsedBytes: -1 }],
    ["a fractional heapUsedBytes", { ...GOOD, heapUsedBytes: 1.5 }],
    ["a missing heapLimitBytes", { ...GOOD, heapLimitBytes: undefined }],
  ])("rejects %s", (_name, value) => {
    expect(parseHostPreviousExit(value)).toBeNull();
  });
});

describe("hostPreviousExitPath", () => {
  it("is previous-exit.json inside the host home", () => {
    expect(hostPreviousExitPath(join("/h", "home"))).toBe(
      join("/h", "home", "previous-exit.json"),
    );
  });
});

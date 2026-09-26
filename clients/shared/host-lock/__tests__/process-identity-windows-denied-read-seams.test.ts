import { afterEach, describe, expect, it, vi } from "vitest";
import { formatWindowsProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import {
  __setAsyncProcessLivenessReaderForTest,
  __setAsyncProcessStartIdentityReaderForTest,
  __setAsyncWindowsDeniedReadCreationReaderForTest,
  __setProcessStartIdentityReaderForTest,
  __setWindowsDeniedReadCreationReaderForTest,
  matchLiveProcessStartIdentity,
  verifyProcessIdentityAsync,
  type ProcessIdentityToken,
} from "../process-identity";

// Post-fix-only coverage of the Windows denied-read fallback, through the
// READER seams rather than the spawn boundary - `__setWindowsDeniedRead
// CreationReaderForTest` and `__setAsyncWindowsDeniedReadCreationReaderForTest`
// do not exist on the pre-fix bytes, so this file is deliberately kept out of
// the red-proof swap (see the sibling `process-identity-windows-denied-
// read.test.ts` for the red-first coverage that drives the real spawn).
//
// `matchLiveProcessStartIdentity` never probes liveness itself (it answers
// only "is the live process at this pid the one `recorded` names", for a
// caller that already knows the pid is worth asking about), so it is the sync
// vehicle here - unlike `verifyProcessIdentity`, it has no own-pid special
// case to dodge, and any pid works.

const RECORDED_ISO = "2026-01-02T03:04:05.1234567Z";
const RECORDED_TOKEN = formatWindowsProcessStartIdentity(RECORDED_ISO);
if (RECORDED_TOKEN === null) {
  throw new Error("fixture Windows token failed to format");
}
// Truncated to six fractional digits, exactly as `windowsProcessStartIdentity
// Micros` reads it from the token's text.
const RECORDED_MICROS = Date.UTC(2026, 0, 2, 3, 4, 5) * 1000 + 123_456;

const ARBITRARY_PID = 4242;

afterEach(() => {
  __setProcessStartIdentityReaderForTest(null);
  __setWindowsDeniedReadCreationReaderForTest(null);
  __setAsyncProcessLivenessReaderForTest(null);
  __setAsyncProcessStartIdentityReaderForTest(null);
  __setAsyncWindowsDeniedReadCreationReaderForTest(null);
});

describe("matchLiveProcessStartIdentity: the WMI tolerance edge", () => {
  it("WMI exactly 1 microsecond off the recorded token compares as same", () => {
    __setProcessStartIdentityReaderForTest(() => null);
    __setWindowsDeniedReadCreationReaderForTest(() => RECORDED_MICROS + 1);

    expect(matchLiveProcessStartIdentity(ARBITRARY_PID, RECORDED_TOKEN)).toBe(
      "same",
    );
  });

  it("WMI 2 microseconds off the recorded token compares as different", () => {
    __setProcessStartIdentityReaderForTest(() => null);
    __setWindowsDeniedReadCreationReaderForTest(() => RECORDED_MICROS + 2);

    expect(matchLiveProcessStartIdentity(ARBITRARY_PID, RECORDED_TOKEN)).toBe(
      "different",
    );
  });

  it("a non-Windows recorded token never consults the fallback, and stays unknown", () => {
    __setProcessStartIdentityReaderForTest(() => null);
    const fallback = vi.fn((): number | null => RECORDED_MICROS);
    __setWindowsDeniedReadCreationReaderForTest(fallback);

    expect(
      matchLiveProcessStartIdentity(ARBITRARY_PID, "linux:boot-a 4242"),
    ).toBe("unknown");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("a null recorded token is unknown without probing anything", () => {
    const exactRead = vi.fn((): string | null => null);
    __setProcessStartIdentityReaderForTest(exactRead);
    const fallback = vi.fn((): number | null => RECORDED_MICROS);
    __setWindowsDeniedReadCreationReaderForTest(fallback);

    expect(matchLiveProcessStartIdentity(ARBITRARY_PID, null)).toBe("unknown");
    expect(exactRead).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("verifyProcessIdentityAsync: the WMI tolerance edge, through the async seams", () => {
  // Offset from this real test-runner's own pid so the token can never
  // collide with `process.pid` and trip the own-process special case.
  const token: ProcessIdentityToken = {
    pid: process.pid + 555_555,
    startedAtMs: null,
    startIdentity: RECORDED_TOKEN,
  };

  it("WMI exactly 1 microsecond off the recorded token -> alive-same", async () => {
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    __setAsyncProcessStartIdentityReaderForTest(() => Promise.resolve(null));
    __setAsyncWindowsDeniedReadCreationReaderForTest(() =>
      Promise.resolve(RECORDED_MICROS + 1),
    );

    await expect(verifyProcessIdentityAsync(token)).resolves.toBe("alive-same");
  });

  it("WMI 2 microseconds off the recorded token -> alive-different", async () => {
    __setAsyncProcessLivenessReaderForTest(() => Promise.resolve("alive"));
    __setAsyncProcessStartIdentityReaderForTest(() => Promise.resolve(null));
    __setAsyncWindowsDeniedReadCreationReaderForTest(() =>
      Promise.resolve(RECORDED_MICROS + 2),
    );

    await expect(verifyProcessIdentityAsync(token)).resolves.toBe(
      "alive-different",
    );
  });
});

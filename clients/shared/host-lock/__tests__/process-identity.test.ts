import { afterEach, describe, expect, it } from "vitest";
import {
  __processStartTimeMsFromElapsedSecondsForTest,
  __setAsyncProcessLivenessReaderForTest,
  __setAsyncProcessStartTimeReaderForTest,
  getPublishedProcessIdentityVerdict,
} from "../process-identity";

const PUBLISHED_AT = "2026-01-01T00:00:00.000Z";
const PUBLISHED_AT_MS = Date.parse(PUBLISHED_AT);
const NOW_MS = Date.parse("2026-07-22T00:00:00.000Z");

describe("POSIX elapsed-time validation", () => {
  it("converts a plausible elapsed time into an epoch start time", () => {
    expect(
      __processStartTimeMsFromElapsedSecondsForTest(30, NOW_MS, 3_600),
    ).toBe(NOW_MS - 30_000);
  });

  it("allows one-second ps resolution slack but rejects the next second", () => {
    expect(
      __processStartTimeMsFromElapsedSecondsForTest(3_601, NOW_MS, 3_600),
    ).toBe(NOW_MS - 3_601_000);
    expect(
      __processStartTimeMsFromElapsedSecondsForTest(3_602, NOW_MS, 3_600),
    ).toBeNull();
  });

  it("rejects the absurd elapsed value observed on loaded GitHub runners", () => {
    const observedDriftMs = 38_109_073_018_720_000;
    expect(
      __processStartTimeMsFromElapsedSecondsForTest(
        observedDriftMs / 1_000,
        NOW_MS,
        3_600,
      ),
    ).toBeNull();
  });
});

afterEach(() => {
  __setAsyncProcessLivenessReaderForTest(null);
  __setAsyncProcessStartTimeReaderForTest(null);
});

describe("getPublishedProcessIdentityVerdict", () => {
  it("reports current only for a live PID whose start predates publication", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "alive");
    __setAsyncProcessStartTimeReaderForTest(async () => PUBLISHED_AT_MS);

    await expect(
      getPublishedProcessIdentityVerdict(1234, PUBLISHED_AT),
    ).resolves.toBe("current");
  });

  it("reports dead as positive evidence even when no start time can be read", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "dead");
    __setAsyncProcessStartTimeReaderForTest(async () => null);

    await expect(
      getPublishedProcessIdentityVerdict(999_999, PUBLISHED_AT),
    ).resolves.toBe("dead");
  });

  it("reports dead before considering a missing or malformed publication time", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "dead");

    await expect(
      getPublishedProcessIdentityVerdict(999_999, null),
    ).resolves.toBe("dead");
    await expect(
      getPublishedProcessIdentityVerdict(999_999, "not-a-timestamp"),
    ).resolves.toBe("dead");
  });

  it("reports mismatch for a live recycled PID which started after publication", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "alive");
    __setAsyncProcessStartTimeReaderForTest(
      async () => PUBLISHED_AT_MS + 2_000,
    );

    await expect(
      getPublishedProcessIdentityVerdict(1234, PUBLISHED_AT),
    ).resolves.toBe("mismatch");
  });

  it("keeps a failed liveness probe indeterminate instead of treating it as down", async () => {
    __setAsyncProcessLivenessReaderForTest(async () => "indeterminate");
    __setAsyncProcessStartTimeReaderForTest(async () => null);

    await expect(
      getPublishedProcessIdentityVerdict(1234, PUBLISHED_AT),
    ).resolves.toBe("indeterminate");
  });
});

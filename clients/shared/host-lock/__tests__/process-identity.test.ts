import { afterEach, describe, expect, it } from "vitest";
import {
  __setAsyncProcessLivenessReaderForTest,
  __setAsyncProcessStartTimeReaderForTest,
  getPublishedProcessIdentityVerdict,
} from "../process-identity";

const PUBLISHED_AT = "2026-01-01T00:00:00.000Z";
const PUBLISHED_AT_MS = Date.parse(PUBLISHED_AT);

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

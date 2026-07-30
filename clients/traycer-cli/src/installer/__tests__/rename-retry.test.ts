import { beforeEach, describe, expect, it, vi } from "vitest";

// Queue-driven rename stub: each entry is the error code the next call
// throws; an exhausted queue means the call succeeds. Keeps the tests
// independent of real filesystem lock behavior, which cannot be produced
// deterministically cross-platform.
const mocks = vi.hoisted(() => ({
  failureCodes: [] as string[],
  renameCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async () => {
      mocks.renameCalls += 1;
      const code = mocks.failureCodes.shift();
      if (code !== undefined) {
        throw Object.assign(new Error(`simulated ${code}`), { code });
      }
    },
  };
});

import { renameWithRetryPlan } from "../rename-retry";

describe("renameWithRetryPlan", () => {
  beforeEach(() => {
    mocks.failureCodes = [];
    mocks.renameCalls = 0;
  });

  it("invokes onRetry between retryable attempts and succeeds once the lock clears", async () => {
    mocks.failureCodes = ["EBUSY", "EPERM"];
    const onRetry = vi.fn(async () => {});

    await renameWithRetryPlan("/from", "/to", {
      delaysMs: [1, 1, 1],
      onRetry,
      maxTotalMs: null,
    });

    expect(mocks.renameCalls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("throws a non-retryable code immediately without invoking onRetry", async () => {
    mocks.failureCodes = ["EIO"];
    const onRetry = vi.fn(async () => {});

    await expect(
      renameWithRetryPlan("/from", "/to", {
        delaysMs: [1, 1],
        onRetry,
        maxTotalMs: null,
      }),
    ).rejects.toMatchObject({ code: "EIO" });

    expect(mocks.renameCalls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("exhausts the schedule and rethrows the final retryable error", async () => {
    mocks.failureCodes = ["EBUSY", "EBUSY", "EBUSY"];
    const onRetry = vi.fn(async () => {});

    await expect(
      renameWithRetryPlan("/from", "/to", {
        delaysMs: [1, 1],
        onRetry,
        maxTotalMs: null,
      }),
    ).rejects.toMatchObject({ code: "EBUSY" });

    // One initial attempt + one per schedule entry, with onRetry before
    // each retry but NOT after the final failure - there is no attempt
    // left for it to help.
    expect(mocks.renameCalls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("swallows an onRetry failure rather than masking the rename outcome", async () => {
    mocks.failureCodes = ["EBUSY"];

    await renameWithRetryPlan("/from", "/to", {
      delaysMs: [1],
      onRetry: async () => {
        throw new Error("kill failed");
      },
      maxTotalMs: null,
    });

    expect(mocks.renameCalls).toBe(2);
  });

  it("stops retrying once the wall-clock ceiling is exceeded, even with schedule entries left", async () => {
    // A slow hook, not slow delays, is what blows the budget in the
    // field: the Windows re-kill can spend tens of seconds per pass. The
    // 60ms hook against a 20ms ceiling means the second failure lands
    // over budget while two schedule entries remain unused.
    mocks.failureCodes = ["EBUSY", "EBUSY", "EBUSY", "EBUSY"];
    const onRetry = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    await expect(
      renameWithRetryPlan("/from", "/to", {
        delaysMs: [1, 1, 1],
        onRetry,
        maxTotalMs: 20,
      }),
    ).rejects.toMatchObject({ code: "EBUSY" });

    expect(mocks.renameCalls).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lockHolderLivenessGivenPublisher,
  readLockHolder,
} from "@traycer-clients/shared/host-lock/cross-process-lock";
import { DOCTOR_ISSUE_CODES } from "../issues";
import { probeUpdateAttemptLock } from "../update-attempt-lock";

// A single failed read says nothing about the lock, and the issue's remedy is
// deleting the file. The real read cannot be made to fail once on demand, so
// this replaces only `readLockHolder` and keeps the probe and the lock's rule.

vi.mock(
  "@traycer-clients/shared/host-lock/cross-process-lock",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@traycer-clients/shared/host-lock/cross-process-lock")
    >()),
    readLockHolder: vi.fn(),
  }),
);

const read = vi.mocked(readLockHolder);

function probe() {
  return probeUpdateAttemptLock({
    lockPath: "/lock",
    verifyPublisher: async () => "dead",
    livenessGivenPublisher: lockHolderLivenessGivenPublisher,
  });
}

beforeEach(() => {
  read.mockReset();
});

describe("probeUpdateAttemptLock on a failed read", () => {
  it("says nothing when the second read succeeds", async () => {
    read
      .mockResolvedValueOnce({ kind: "read-error" })
      .mockResolvedValueOnce({ kind: "absent" });
    expect(await probe()).toBeNull();
  });

  it("reports the lock when the second read fails too", async () => {
    read.mockResolvedValue({ kind: "read-error" });
    const issue = await probe();
    expect(issue?.code).toBe(
      DOCTOR_ISSUE_CODES.HOST_UPDATE_ATTEMPT_LOCK_UNREADABLE,
    );
  });
});

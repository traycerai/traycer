/**
 * `supervisedProcessGroupId` of `1` must parse as `null`. `kill(-1, 0)` is not a liveness probe for this lock's actuator.
 */
import { describe, expect, it } from "vitest";
import { parseAttemptLockHolder } from "../host-update-attempt-liveness";

function lockBytes(supervisedProcessGroupId: number): string {
  return JSON.stringify({
    pid: 4242,
    reason: "test",
    startedAt: new Date().toISOString(),
    supervisedProcessGroupId,
  });
}

describe("parseAttemptLockHolder — supervisedProcessGroupId > 1 threshold", () => {
  it("drops a recorded supervisedProcessGroupId of 1 — group 1 (init's) is not a live supervised actuator", () => {
    const holder = parseAttemptLockHolder(lockBytes(1));
    expect(holder).not.toBeNull();
    expect(holder?.supervisedProcessGroupId).toBeNull();
  });

  it("preserves a recorded supervisedProcessGroupId of 2 — the first value actually above the threshold", () => {
    const holder = parseAttemptLockHolder(lockBytes(2));
    expect(holder).not.toBeNull();
    expect(holder?.supervisedProcessGroupId).toBe(2);
  });

  it("preserves an ordinary, larger supervisedProcessGroupId verbatim", () => {
    const holder = parseAttemptLockHolder(lockBytes(4242));
    expect(holder).not.toBeNull();
    expect(holder?.supervisedProcessGroupId).toBe(4242);
  });

  it("treats an omitted supervisedProcessGroupId the same as a recorded 1 — both project to null", () => {
    const bytes = JSON.stringify({
      pid: 4242,
      reason: "test",
      startedAt: new Date().toISOString(),
    });
    const holder = parseAttemptLockHolder(bytes);
    expect(holder).not.toBeNull();
    expect(holder?.supervisedProcessGroupId).toBeNull();
  });
});

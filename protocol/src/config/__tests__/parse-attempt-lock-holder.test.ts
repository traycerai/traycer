/**
 * `parseAttemptLockHolder`'s `supervisedProcessGroupId` tolerance.
 *
 * Production change: the threshold moved from `> 0` to `> 1`, to match the
 * canonical writer-side parser in
 * `@traycer-clients/shared/host-lock/cross-process-lock.ts`. Probing group 1
 * asks `kill(-1, 0)` - "is there ANY signalable process on this machine" -
 * which is true on every live system and therefore proves nothing about the
 * SPECIFIC supervised actuator this lock recorded. A record carrying `1`
 * must read as carrying no group at all (`null`), exactly like a record that
 * omits the field, or this reader and the shared lock module's own reader
 * would disagree about the same lock file's liveness - the drift the module
 * doc comment calls out as already having caused one misdiagnosis.
 *
 * `holder-conformance.test.ts` in `clients/shared/host-update/__tests__/`
 * drives this same parser through the real writer end to end, but every
 * supervised-group id it exercises is `process.pid` - never exactly `1` -
 * so it does not pin this threshold. This file is the direct unit coverage
 * for the parser itself.
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

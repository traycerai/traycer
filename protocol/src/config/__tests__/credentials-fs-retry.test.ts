/**
 * `credentials-fs.ts`'s `windowsRenameRetryDelayMs`: the one policy every
 * retrying rename (the credentials-file writer's own `renameWithWindowsRetry`,
 * and the cross-process lock's `rewriteLockLivenessIfToken` loop covered in
 * `clients/shared/host-lock/__tests__/cross-process-lock-win32-rename.test.ts`)
 * shares to decide whether, and how long, to wait before the next attempt.
 */
import { afterEach, describe, expect, it } from "vitest";
import { windowsRenameRetryDelayMs } from "../credentials-fs";

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

// `process.platform` has an own, configurable property descriptor in every
// Node runtime this suite targets; captured once so the win32 simulation
// below restores the exact original rather than guessing a value.
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);
if (ORIGINAL_PLATFORM_DESCRIPTOR === undefined) {
  throw new Error("process.platform has no own property descriptor");
}

function stubWin32Platform(): void {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
}

// Unconditional: a test that never stubbed the platform leaves it already
// equal to the original descriptor, so redefining it here is a no-op for
// that test and a genuine restore for one that did.
afterEach(() => {
  Object.defineProperty(process, "platform", ORIGINAL_PLATFORM_DESCRIPTOR);
  expect(process.platform).toBe(ORIGINAL_PLATFORM_DESCRIPTOR.value);
});

describe("windowsRenameRetryDelayMs", () => {
  const transientCodes = ["EPERM", "EACCES", "EBUSY"] as const;
  const schedule = [10, 25, 50, 100, 200] as const;

  for (const code of transientCodes) {
    it(`returns the scheduled delay for ${code} at every retry index on win32`, () => {
      stubWin32Platform();
      schedule.forEach((delay, retryIndex) => {
        expect(windowsRenameRetryDelayMs(errnoError(code), retryIndex)).toBe(
          delay,
        );
      });
    });
  }

  it("returns null once the schedule is spent (index 5)", () => {
    stubWin32Platform();
    expect(windowsRenameRetryDelayMs(errnoError("EPERM"), 5)).toBeNull();
  });

  it("returns null for a non-transient code (ENOENT) on win32", () => {
    stubWin32Platform();
    expect(windowsRenameRetryDelayMs(errnoError("ENOENT"), 0)).toBeNull();
  });

  it("returns null for an error with no code on win32", () => {
    stubWin32Platform();
    expect(windowsRenameRetryDelayMs(new Error("no code"), 0)).toBeNull();
  });

  it("returns null off win32, even for a transient code at retry index 0", () => {
    expect(process.platform).not.toBe("win32");
    expect(windowsRenameRetryDelayMs(errnoError("EPERM"), 0)).toBeNull();
  });
});

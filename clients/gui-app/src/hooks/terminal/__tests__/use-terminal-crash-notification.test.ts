import { describe, expect, it } from "vitest";
import { isTerminalCrashExit } from "@/hooks/terminal/use-terminal-crash-notification";

describe("isTerminalCrashExit", () => {
  it("accepts abnormal process exits and rejects clean or lifecycle exits", () => {
    expect(
      isTerminalCrashExit({
        status: "exited",
        exitCode: 1,
        exitReason: "process-exit",
        isExitSuppressed: () => false,
      }),
    ).toBe(true);
    expect(
      isTerminalCrashExit({
        status: "exited",
        exitCode: 0,
        exitReason: "process-exit",
        isExitSuppressed: () => false,
      }),
    ).toBe(false);
    expect(
      isTerminalCrashExit({
        status: "exited",
        exitCode: -1,
        exitReason: "killed",
        isExitSuppressed: () => false,
      }),
    ).toBe(false);
    expect(
      isTerminalCrashExit({
        status: "exited",
        exitCode: -1,
        exitReason: "reaped",
        isExitSuppressed: () => false,
      }),
    ).toBe(false);
  });
});

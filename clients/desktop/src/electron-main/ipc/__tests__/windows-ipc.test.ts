import { describe, expect, it } from "vitest";
import { shouldPreserveClosedWindowSnapshot } from "../windows-ipc";

describe("shouldPreserveClosedWindowSnapshot", () => {
  it("prunes a deliberate mid-session close (not quitting, other windows remain)", () => {
    expect(
      shouldPreserveClosedWindowSnapshot({
        quitting: false,
        remainingWindowCount: 2,
      }),
    ).toBe(false);
  });

  it("preserves the last-window close (Win/Linux window-all-closed race, macOS red-light close)", () => {
    expect(
      shouldPreserveClosedWindowSnapshot({
        quitting: false,
        remainingWindowCount: 0,
      }),
    ).toBe(true);
  });

  it("preserves every closing window while quitting, even when others remain", () => {
    expect(
      shouldPreserveClosedWindowSnapshot({
        quitting: true,
        remainingWindowCount: 2,
      }),
    ).toBe(true);
  });

  it("preserves a quit that also happens to close the last window", () => {
    expect(
      shouldPreserveClosedWindowSnapshot({
        quitting: true,
        remainingWindowCount: 0,
      }),
    ).toBe(true);
  });
});

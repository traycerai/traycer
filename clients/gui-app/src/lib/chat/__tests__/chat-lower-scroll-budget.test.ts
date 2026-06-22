import { describe, expect, it } from "vitest";
import { lowerScrollRegionMaxHeightClass } from "@/lib/chat/chat-lower-scroll-budget";

describe("lowerScrollRegionMaxHeightClass", () => {
  it("uses the largest budget for a single scroll region", () => {
    expect(
      lowerScrollRegionMaxHeightClass({
        pinnedStackVisible: false,
        queueVisible: true,
        approvalVisible: false,
      }),
    ).toBe("max-h-[min(40dvh,24rem)]");
  });

  it("reduces the budget when pinned stack and queue are both visible", () => {
    expect(
      lowerScrollRegionMaxHeightClass({
        pinnedStackVisible: true,
        queueVisible: true,
        approvalVisible: false,
      }),
    ).toBe("max-h-[min(24dvh,14rem)]");
  });

  it("uses the tightest budget when approvals add pressure", () => {
    expect(
      lowerScrollRegionMaxHeightClass({
        pinnedStackVisible: true,
        queueVisible: true,
        approvalVisible: true,
      }),
    ).toBe("max-h-[min(18dvh,11rem)]");
  });
});

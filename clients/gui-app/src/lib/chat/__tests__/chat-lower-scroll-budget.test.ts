import { describe, expect, it } from "vitest";
import { lowerScrollRegionMaxHeightClass } from "@/lib/chat/chat-lower-scroll-budget";

describe("lowerScrollRegionMaxHeightClass", () => {
  it("uses the largest budget for a single scroll region", () => {
    expect(
      lowerScrollRegionMaxHeightClass({
        pinnedStackVisible: false,
        queueVisible: true,
        backgroundVisible: false,
        activeAgentsVisible: false,
        approvalVisible: false,
      }),
    ).toBe("max-h-[min(40dvh,24rem)]");
  });

  it("reduces the budget when pinned stack and queue are both visible", () => {
    expect(
      lowerScrollRegionMaxHeightClass({
        pinnedStackVisible: true,
        queueVisible: true,
        backgroundVisible: false,
        activeAgentsVisible: false,
        approvalVisible: false,
      }),
    ).toBe("max-h-[min(24dvh,14rem)]");
  });

  it("uses the tightest budget when approvals add pressure", () => {
    expect(
      lowerScrollRegionMaxHeightClass({
        pinnedStackVisible: true,
        queueVisible: true,
        backgroundVisible: false,
        activeAgentsVisible: false,
        approvalVisible: true,
      }),
    ).toBe("max-h-[min(18dvh,11rem)]");
  });

  it("counts the background section as another scroll region", () => {
    expect(
      lowerScrollRegionMaxHeightClass({
        pinnedStackVisible: true,
        queueVisible: true,
        backgroundVisible: true,
        activeAgentsVisible: false,
        approvalVisible: false,
      }),
    ).toBe("max-h-[min(18dvh,11rem)]");
  });

  it("counts active agents with background as multiple scroll regions", () => {
    expect(
      lowerScrollRegionMaxHeightClass({
        pinnedStackVisible: false,
        queueVisible: false,
        backgroundVisible: true,
        activeAgentsVisible: true,
        approvalVisible: false,
      }),
    ).toBe("max-h-[min(24dvh,14rem)]");
  });

  it("counts queue, background, and active agents as three regions", () => {
    expect(
      lowerScrollRegionMaxHeightClass({
        pinnedStackVisible: false,
        queueVisible: true,
        backgroundVisible: true,
        activeAgentsVisible: true,
        approvalVisible: false,
      }),
    ).toBe("max-h-[min(18dvh,11rem)]");
  });
});

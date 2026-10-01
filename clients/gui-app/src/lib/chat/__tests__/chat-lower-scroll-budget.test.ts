import { describe, expect, it } from "vitest";
import {
  chatBackgroundSectionVisible,
  lowerScrollRegionMaxHeightClass,
  lowerSurfaceFrame,
  type LowerSurfaceFrameInput,
} from "@/lib/chat/chat-lower-scroll-budget";
import type { ChatDockSection } from "@/lib/chat/chat-dock-sections";

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

describe("chatBackgroundSectionVisible", () => {
  it("is hidden when every count is zero", () => {
    expect(
      chatBackgroundSectionVisible({
        backgroundItemCount: 0,
        runningManagedCommandCount: 0,
        heldManagedCommandCount: 0,
        portForwardCount: 0,
      }),
    ).toBe(false);
  });

  it("stays visible on the pre-existing counts, unchanged by the new input", () => {
    expect(
      chatBackgroundSectionVisible({
        backgroundItemCount: 1,
        runningManagedCommandCount: 0,
        heldManagedCommandCount: 0,
        portForwardCount: 0,
      }),
    ).toBe(true);
    expect(
      chatBackgroundSectionVisible({
        backgroundItemCount: 0,
        runningManagedCommandCount: 1,
        heldManagedCommandCount: 0,
        portForwardCount: 0,
      }),
    ).toBe(true);
    expect(
      chatBackgroundSectionVisible({
        backgroundItemCount: 0,
        runningManagedCommandCount: 0,
        heldManagedCommandCount: 1,
        portForwardCount: 0,
      }),
    ).toBe(true);
  });

  // A forward outlives the turn that made it, so it alone must be able to
  // keep the section visible - an `interrupted` forward with nothing else
  // running is exactly the row a person most needs to reach.
  it("is visible when only the port-forward count is above zero", () => {
    expect(
      chatBackgroundSectionVisible({
        backgroundItemCount: 0,
        runningManagedCommandCount: 0,
        heldManagedCommandCount: 0,
        portForwardCount: 1,
      }),
    ).toBe(true);
  });
});

/**
 * The decision the composer's top edge hangs on: whether anything is drawn in
 * the dock's joined frame (the composer then tucks into it, with no top
 * padding of its own) or the dock is empty or pills-only (the composer keeps
 * its own `pt-4`). `browser-tests/composer-queue-dock.spec.ts` measures the
 * real edge that this decides, through the same function.
 */

const NOTHING: LowerSurfaceFrameInput = {
  folded: new Set<ChatDockSection>(),
  openSection: null,
  todoHasContent: false,
  filesChangedHasContent: false,
  activeAgentsHasContent: false,
  backgroundHasContent: false,
  queueItemCount: 0,
};

const EVERY_MEMBER_WITH_CONTENT: LowerSurfaceFrameInput = {
  ...NOTHING,
  todoHasContent: true,
  filesChangedHasContent: true,
  activeAgentsHasContent: true,
  backgroundHasContent: true,
};

const EVERY_SECTION: ReadonlySet<ChatDockSection> = new Set<ChatDockSection>([
  "todo",
  "filesChanged",
  "activeAgents",
  "background",
]);

function frameWith(overrides: Partial<LowerSurfaceFrameInput>) {
  return lowerSurfaceFrame({ ...NOTHING, ...overrides });
}

describe("lowerSurfaceFrame", () => {
  it("leaves the composer its own top padding when the dock is empty", () => {
    expect(lowerSurfaceFrame(NOTHING).topSpacing).toBe("normal");
  });

  it("connects the composer to a queue that holds anything, whatever else is a pill", () => {
    const frame = lowerSurfaceFrame({
      ...EVERY_MEMBER_WITH_CONTENT,
      folded: EVERY_SECTION,
      queueItemCount: 1,
    });

    expect(frame.queueVisible).toBe(true);
    expect(frame.topSpacing).toBe("connected");
  });

  it("gives the top padding back when the queue empties beside nothing but pills", () => {
    const withQueue = lowerSurfaceFrame({
      ...EVERY_MEMBER_WITH_CONTENT,
      folded: EVERY_SECTION,
      queueItemCount: 2,
    });
    const emptied = lowerSurfaceFrame({
      ...EVERY_MEMBER_WITH_CONTENT,
      folded: EVERY_SECTION,
      queueItemCount: 0,
    });

    expect(withQueue.topSpacing).toBe("connected");
    expect(emptied.queueVisible).toBe(false);
    expect(emptied.topSpacing).toBe("normal");
  });

  it("draws nothing in the frame for members that are only pills", () => {
    const frame = lowerSurfaceFrame({
      ...EVERY_MEMBER_WITH_CONTENT,
      folded: EVERY_SECTION,
    });

    expect(frame).toEqual({
      pinnedStackVisible: false,
      queueVisible: false,
      dockAgentsVisible: false,
      dockBackgroundVisible: false,
      topSpacing: "normal",
    });
  });

  it("draws nothing for a member with nothing to show, folded or not", () => {
    expect(frameWith({ folded: new Set<ChatDockSection>() })).toEqual({
      pinnedStackVisible: false,
      queueVisible: false,
      dockAgentsVisible: false,
      dockBackgroundVisible: false,
      topSpacing: "normal",
    });
  });

  it.each<{
    readonly member: string;
    readonly input: Partial<LowerSurfaceFrameInput>;
    readonly drawn:
      | "pinnedStackVisible"
      | "dockAgentsVisible"
      | "dockBackgroundVisible";
  }>([
    {
      member: "Todo",
      input: { todoHasContent: true },
      drawn: "pinnedStackVisible",
    },
    {
      member: "Files changed",
      input: { filesChangedHasContent: true },
      drawn: "pinnedStackVisible",
    },
    {
      member: "Active agents",
      input: { activeAgentsHasContent: true },
      drawn: "dockAgentsVisible",
    },
    {
      member: "Background",
      input: { backgroundHasContent: true },
      drawn: "dockBackgroundVisible",
    },
  ])(
    "connects the composer to $member drawn as a full row",
    ({ input, drawn }) => {
      const frame = frameWith(input);

      expect(frame[drawn]).toBe(true);
      expect(frame.topSpacing).toBe("connected");
    },
  );

  it("connects the composer to an open pill's attached panel, though its member is folded", () => {
    const frame = frameWith({
      filesChangedHasContent: true,
      folded: new Set<ChatDockSection>(["filesChanged"]),
      openSection: "filesChanged",
    });

    expect(frame.pinnedStackVisible).toBe(true);
    expect(frame.topSpacing).toBe("connected");
  });
});

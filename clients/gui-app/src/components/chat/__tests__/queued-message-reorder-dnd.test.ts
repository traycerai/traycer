import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type {
  Active,
  ClientRect,
  DragEndEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import type {
  ChatQueuedItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  buildQueuedMessageOrderKey,
  resolveQueuedMessageDropPreview,
  useQueuedMessageReorderDnd,
} from "@/components/chat/queued-message-reorder-dnd";

describe("queued message reorder DnD", () => {
  it("moves an item before the first queued message", () => {
    const order = ["queue-1", "queue-2", "queue-3"];
    const orderKey = buildQueuedMessageOrderKey(order);

    expect(
      resolveQueuedMessageDropPreview({
        sourceQueueItemId: "queue-3",
        targetQueueItemId: "queue-1",
        targetIndex: 0,
        targetTop: 100,
        targetHeight: 40,
        pointerY: 101,
        orderedQueueItemIds: order,
        activeOrderKey: orderKey,
        currentOrderKey: orderKey,
      }),
    ).toEqual({
      queueItemId: "queue-3",
      beforeQueueItemId: "queue-1",
      index: 0,
    });
  });

  it("moves an item after the last queued message", () => {
    const order = ["queue-1", "queue-2", "queue-3"];
    const orderKey = buildQueuedMessageOrderKey(order);

    expect(
      resolveQueuedMessageDropPreview({
        sourceQueueItemId: "queue-1",
        targetQueueItemId: "queue-3",
        targetIndex: 2,
        targetTop: 100,
        targetHeight: 40,
        pointerY: 139,
        orderedQueueItemIds: order,
        activeOrderKey: orderKey,
        currentOrderKey: orderKey,
      }),
    ).toEqual({
      queueItemId: "queue-1",
      beforeQueueItemId: null,
      index: 3,
    });
  });

  it("returns no preview for the same effective position", () => {
    const order = ["queue-1", "queue-2", "queue-3"];
    const orderKey = buildQueuedMessageOrderKey(order);

    expect(
      resolveQueuedMessageDropPreview({
        sourceQueueItemId: "queue-2",
        targetQueueItemId: "queue-2",
        targetIndex: 1,
        targetTop: 100,
        targetHeight: 40,
        pointerY: 101,
        orderedQueueItemIds: order,
        activeOrderKey: orderKey,
        currentOrderKey: orderKey,
      }),
    ).toBeNull();
    expect(
      resolveQueuedMessageDropPreview({
        sourceQueueItemId: "queue-2",
        targetQueueItemId: "queue-2",
        targetIndex: 1,
        targetTop: 100,
        targetHeight: 40,
        pointerY: 139,
        orderedQueueItemIds: order,
        activeOrderKey: orderKey,
        currentOrderKey: orderKey,
      }),
    ).toBeNull();
  });

  it("returns no preview when the queue order changed during drag", () => {
    const dragOrder = ["queue-1", "queue-2", "queue-3"];
    const currentOrder = ["queue-2", "queue-1", "queue-3"];

    expect(
      resolveQueuedMessageDropPreview({
        sourceQueueItemId: "queue-3",
        targetQueueItemId: "queue-1",
        targetIndex: 0,
        targetTop: 100,
        targetHeight: 40,
        pointerY: 101,
        orderedQueueItemIds: currentOrder,
        activeOrderKey: buildQueuedMessageOrderKey(dragOrder),
        currentOrderKey: buildQueuedMessageOrderKey(currentOrder),
      }),
    ).toBeNull();
  });
});

describe("useQueuedMessageReorderDnd pointer source", () => {
  it("resolves drops from the collision pass pointer, not activator + scroll-adjusted delta", () => {
    const items = [
      makeQueuedItem("queue-1"),
      makeQueuedItem("queue-2"),
      makeQueuedItem("queue-3"),
    ];
    const onReorder = vi.fn();
    const hook = renderHook(() =>
      useQueuedMessageReorderDnd({ items, onReorder }),
    );
    const orderKey = hook.result.current.orderKey;
    const sourceData = queuedDndData("queue-3", 2, orderKey);

    act(() => {
      hook.result.current.handleDragStart(
        makeDragStartEvent(makeActive("queue-3", sourceData)),
      );
    });
    // Simulate an auto-scrolled list: the collision pass - the same point
    // that picked `over` - sees the pointer above queue-1's midline (120),
    // while reconstructing it as activatorEvent.clientY + delta.y (120 + 25
    // = 145, delta being scroll-adjusted) would land below it and insert
    // before queue-2 instead.
    act(() => {
      hook.result.current.collisionDetection(
        makeCollisionArgs(makeActive("queue-3", sourceData), {
          x: 0,
          y: 101,
        }),
      );
    });
    act(() => {
      hook.result.current.handleDragEnd(
        makeDragEndEvent({
          active: makeActive("queue-3", sourceData),
          overData: queuedDndData("queue-1", 0, orderKey),
          overRect: makeClientRect(100, 40),
          activatorClientY: 120,
          deltaY: 25,
        }),
      );
    });

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(items[2], "queue-1");
  });

  it("resolves no drop when the collision pass carries no pointer (keyboard drag)", () => {
    const items = [makeQueuedItem("queue-1"), makeQueuedItem("queue-2")];
    const onReorder = vi.fn();
    const hook = renderHook(() =>
      useQueuedMessageReorderDnd({ items, onReorder }),
    );
    const orderKey = hook.result.current.orderKey;
    const sourceData = queuedDndData("queue-2", 1, orderKey);

    act(() => {
      hook.result.current.handleDragStart(
        makeDragStartEvent(makeActive("queue-2", sourceData)),
      );
      hook.result.current.collisionDetection(
        makeCollisionArgs(makeActive("queue-2", sourceData), null),
      );
      hook.result.current.handleDragEnd(
        makeDragEndEvent({
          active: makeActive("queue-2", sourceData),
          overData: queuedDndData("queue-1", 0, orderKey),
          overRect: makeClientRect(100, 40),
          activatorClientY: 101,
          deltaY: 0,
        }),
      );
    });

    expect(onReorder).not.toHaveBeenCalled();
  });
});

const TEST_SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

function makeQueuedItem(queueItemId: string): ChatQueuedItem {
  return {
    queueItemId,
    messageId: `${queueItemId}-message`,
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: queueItemId }],
          },
        ],
      },
    },
    sender: { type: "user", userId: "owner-1" },
    settings: TEST_SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function queuedDndData(
  queueItemId: string,
  index: number,
  orderKey: string,
): Record<string, unknown> {
  return { kind: "queued-message", queueItemId, index, orderKey };
}

function makeActive(id: string, data: Record<string, unknown>): Active {
  return {
    id,
    data: { current: data },
    rect: { current: { initial: null, translated: null } },
  };
}

function makeClientRect(top: number, height: number): ClientRect {
  return {
    width: 320,
    height,
    top,
    left: 0,
    right: 320,
    bottom: top + height,
  };
}

function makeDragStartEvent(active: Active): DragStartEvent {
  return { active, activatorEvent: new Event("pointerdown") };
}

function makeCollisionArgs(
  active: Active,
  pointerCoordinates: { readonly x: number; readonly y: number } | null,
) {
  return {
    active,
    collisionRect: makeClientRect(0, 24),
    droppableRects: new Map<string | number, ClientRect>(),
    droppableContainers: [],
    pointerCoordinates,
  };
}

function makeDragEndEvent(input: {
  readonly active: Active;
  readonly overData: Record<string, unknown>;
  readonly overRect: ClientRect;
  readonly activatorClientY: number;
  readonly deltaY: number;
}): DragEndEvent {
  return {
    active: input.active,
    activatorEvent: new MouseEvent("pointerdown", {
      clientY: input.activatorClientY,
    }),
    collisions: null,
    delta: { x: 0, y: input.deltaY },
    over: {
      id: String(input.overData.queueItemId),
      rect: input.overRect,
      disabled: false,
      data: { current: input.overData },
    },
  };
}

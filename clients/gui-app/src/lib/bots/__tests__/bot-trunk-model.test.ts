import { describe, expect, it } from "vitest";
import type {
  ChatQueuedTaskCheckinItem,
  ChatQueuedTaskOverdueItem,
  OpenChatQueuedItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  pendingTaskCheckins,
  pendingTaskOverdue,
} from "@/lib/bots/bot-trunk-model";

function checkinItem(queueItemId: string): ChatQueuedTaskCheckinItem {
  return {
    kind: "task-checkin",
    queueItemId,
    description: "Check-in on 2 tasks",
    delivery: "next_turn",
    targetTurnId: null,
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
  };
}

function overdueItem(queueItemId: string): ChatQueuedTaskOverdueItem {
  return {
    kind: "task-overdue",
    queueItemId,
    description: "Task overdue notice",
    delivery: "next_turn",
    targetTurnId: null,
    status: "pending",
    createdAt: 2,
    updatedAt: 2,
  };
}

describe("pendingTaskOverdue", () => {
  it("is null when the trunk's queue holds no overdue notice", () => {
    expect(pendingTaskOverdue([])).toBeNull();
    expect(pendingTaskOverdue([checkinItem("queue-checkin")])).toBeNull();
  });

  it("returns the overdue item waiting on the queue, whatever else is queued around it", () => {
    const overdue = overdueItem("queue-overdue");
    const items: ReadonlyArray<OpenChatQueuedItem> = [
      checkinItem("queue-checkin"),
      overdue,
    ];

    expect(pendingTaskOverdue(items)).toBe(overdue);
  });

  it("returns the first one if a queue ever held two", () => {
    const first = overdueItem("queue-overdue-1");
    const second = overdueItem("queue-overdue-2");

    expect(pendingTaskOverdue([first, second])).toBe(first);
  });

  it("is independent of pendingTaskCheckins: an overdue item is never listed as a check-in", () => {
    const items: ReadonlyArray<OpenChatQueuedItem> = [
      overdueItem("queue-overdue"),
      checkinItem("queue-checkin"),
    ];

    expect(pendingTaskCheckins(items).map((item) => item.queueItemId)).toEqual([
      "queue-checkin",
    ]);
    expect(pendingTaskOverdue(items)?.queueItemId).toBe("queue-overdue");
  });
});

import { describe, expect, it } from "vitest";
import { createManagedDataByteBudget } from "../managed-data-byte-budget";

function microtaskQueue(): {
  readonly schedule: (callback: () => void) => void;
  readonly flushOne: () => void;
  readonly size: () => number;
} {
  const callbacks: (() => void)[] = [];
  return {
    schedule: (callback) => callbacks.push(callback),
    flushOne(): void {
      const callback = callbacks.shift();
      if (callback === undefined) throw new Error("no microtask was queued");
      callback();
    },
    size: () => callbacks.length,
  };
}

describe("managed-data byte budget", () => {
  it("coalesces settlements into one prune and tries chat before task", () => {
    const queue = microtaskQueue();
    let bytes = 120;
    const calls: string[] = [];
    const budget = createManagedDataByteBudget({
      readAccountedBytes: () => bytes,
      readLimitBytes: () => 100,
      evictOldestChat: () => {
        calls.push("chat");
        bytes = 80;
        return true;
      },
      evictOldestTask: () => {
        calls.push("task");
        return true;
      },
      scheduleMicrotask: queue.schedule,
    });

    budget.noteSettlement();
    budget.noteSettlement();
    budget.noteSettlement();
    expect(queue.size()).toBe(1);
    expect(calls).toEqual([]);

    queue.flushOne();
    expect(calls).toEqual(["chat"]);
    expect(budget.snapshot()).toEqual({ prunes: 1, overProtected: false });
  });

  it("does not retry an unchanged protected plateau until eligibility changes", () => {
    const queue = microtaskQueue();
    let bytes = 150;
    let chatEligible = false;
    let chatAttempts = 0;
    let taskAttempts = 0;
    const budget = createManagedDataByteBudget({
      readAccountedBytes: () => bytes,
      readLimitBytes: () => 100,
      evictOldestChat: () => {
        chatAttempts += 1;
        if (!chatEligible) return false;
        bytes = 90;
        return true;
      },
      evictOldestTask: () => {
        taskAttempts += 1;
        return false;
      },
      scheduleMicrotask: queue.schedule,
    });

    budget.noteSettlement();
    queue.flushOne();
    expect(budget.snapshot()).toEqual({ prunes: 0, overProtected: true });
    expect(chatAttempts).toBe(1);
    expect(taskAttempts).toBe(1);
    expect(queue.size()).toBe(0);

    budget.noteSettlement();
    queue.flushOne();
    expect(chatAttempts).toBe(1);
    expect(taskAttempts).toBe(1);
    expect(queue.size()).toBe(0);

    chatEligible = true;
    budget.noteEligibilityChange();
    expect(queue.size()).toBe(1);
    queue.flushOne();
    expect(chatAttempts).toBe(2);
    expect(taskAttempts).toBe(1);
    expect(budget.snapshot()).toEqual({ prunes: 1, overProtected: false });
  });
});

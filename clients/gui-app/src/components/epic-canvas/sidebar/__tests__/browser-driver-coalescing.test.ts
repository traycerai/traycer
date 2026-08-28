import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserTabDriverChatSignature,
  cancelCoalesceTimer,
  restartCoalesceTimer,
} from "@/components/epic-canvas/sidebar/browser-driver-coalescing";

afterEach(() => {
  vi.useRealTimers();
});

describe("browserTabDriverChatSignature", () => {
  it("ignores driver order and duplicate chats", () => {
    expect(
      browserTabDriverChatSignature([{ chatId: "b" }, { chatId: "a" }]),
    ).toBe(browserTabDriverChatSignature([{ chatId: "a" }, { chatId: "b" }]));
    expect(
      browserTabDriverChatSignature([{ chatId: "a" }, { chatId: "a" }]),
    ).toBe(browserTabDriverChatSignature([{ chatId: "a" }]));
    expect(browserTabDriverChatSignature([])).toBe("");
  });
});

describe("restartCoalesceTimer", () => {
  it("keeps one wait running while the chat set is unchanged", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const first = restartCoalesceTimer(null, "a", 400, run);
    const second = restartCoalesceTimer(first, "a", 400, run);
    expect(second).toBe(first);

    vi.advanceTimersByTime(399);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("restarts the wait when the chat set changes", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const pending = restartCoalesceTimer(null, "a", 400, first);
    vi.advanceTimersByTime(300);
    restartCoalesceTimer(pending, "b", 400, second);

    vi.advanceTimersByTime(300);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending wait", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    expect(cancelCoalesceTimer(restartCoalesceTimer(null, "a", 400, run))).toBe(
      null,
    );
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import type { QuoteChatTarget } from "@/components/epic-canvas/renderers/chat-target-menu/quote-chat-targets";
import { canvasAnnotationTarget } from "../canvas-annotation-target";

function target(
  chatId: string,
  overrides: Partial<QuoteChatTarget>,
): QuoteChatTarget {
  return {
    chatId,
    title: chatId,
    isOpen: false,
    isLastFocused: false,
    isOnOtherHost: false,
    ...overrides,
  };
}

describe("canvasAnnotationTarget", () => {
  it("returns null when there are no chats", () => {
    expect(canvasAnnotationTarget([])).toBeNull();
  });

  it("prefers the last focused eligible chat over other eligible chats", () => {
    const focused = target("b", { isLastFocused: true });
    expect(
      canvasAnnotationTarget([target("a", {}), focused, target("c", {})]),
    ).toBe(focused);
  });

  it("falls back to the sole eligible chat when none is focused", () => {
    const sole = target("a", {});
    expect(canvasAnnotationTarget([sole])).toBe(sole);
  });

  it("does not guess among several eligible chats, even an open one", () => {
    expect(
      canvasAnnotationTarget([target("a", { isOpen: true }), target("b", {})]),
    ).toBeNull();
  });

  it("ignores a focused chat on another host", () => {
    const local = target("a", {});
    expect(
      canvasAnnotationTarget([
        target("b", { isLastFocused: true, isOnOtherHost: true }),
        local,
      ]),
    ).toBe(local);
  });

  it("returns null when every chat is on another host", () => {
    expect(
      canvasAnnotationTarget([
        target("a", { isLastFocused: true, isOnOtherHost: true }),
      ]),
    ).toBeNull();
  });

  it("returns null when a sole chat is on another host and nothing else is eligible", () => {
    expect(
      canvasAnnotationTarget([target("a", { isOnOtherHost: true })]),
    ).toBeNull();
  });
});

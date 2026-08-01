import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/stores/composer/chat-store";
import {
  computeStableChatTimelineRows,
  EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
  type StableChatTimelineRowsState,
} from "@/components/chat/chat-stable-rows";
import { makeMessage } from "./chat-message-fixtures";

function cloneMessage(message: ChatMessage): ChatMessage {
  return { ...message };
}

function rebuildArray(
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<ChatMessage> {
  return messages.map(cloneMessage);
}

describe("computeStableChatTimelineRows", () => {
  it("reuses previous message object references when tracked fields are unchanged, even if the array is rebuilt", () => {
    const first = makeMessage(0, "user");
    const second = makeMessage(1, "assistant");
    const initial = [first, second];

    const afterFirst = computeStableChatTimelineRows(
      initial,
      EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
    );
    expect(afterFirst.result[0]).toBe(first);
    expect(afterFirst.result[1]).toBe(second);

    // Store rebuilds the array wholesale with fresh object identities.
    const rebuilt = rebuildArray(initial);
    expect(rebuilt[0]).not.toBe(first);
    expect(rebuilt[1]).not.toBe(second);

    const afterRebuild = computeStableChatTimelineRows(rebuilt, afterFirst);
    expect(afterRebuild.result[0]).toBe(first);
    expect(afterRebuild.result[1]).toBe(second);
    expect(afterRebuild.result[0]).not.toBe(rebuilt[0]);
    expect(afterRebuild.result[1]).not.toBe(rebuilt[1]);
  });

  it("produces a new object for a message whose tracked fields changed", () => {
    const original = makeMessage(0, "assistant");
    const state = computeStableChatTimelineRows(
      [original],
      EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
    );

    const contentChanged: ChatMessage = {
      ...cloneMessage(original),
      content: "token",
    };
    const afterContent = computeStableChatTimelineRows([contentChanged], state);
    expect(afterContent.result[0]).toBe(contentChanged);
    expect(afterContent.result[0]).not.toBe(original);

    const completedChanged: ChatMessage = {
      ...cloneMessage(contentChanged),
      completedAt: 100,
    };
    const afterCompleted = computeStableChatTimelineRows(
      [completedChanged],
      afterContent,
    );
    expect(afterCompleted.result[0]).toBe(completedChanged);

    const stoppedChanged: ChatMessage = {
      ...cloneMessage(completedChanged),
      stopped: {
        stoppedAt: 200,
        reason: "user",
        turnHadOutput: true,
        turnReplyText: "token",
      },
    };
    const afterStopped = computeStableChatTimelineRows(
      [stoppedChanged],
      afterCompleted,
    );
    expect(afterStopped.result[0]).toBe(stoppedChanged);

    const newSegment = {
      id: "seg-1",
      kind: "text" as const,
      markdown: "hello",
      isStreaming: true,
    };
    const segmentsChanged: ChatMessage = {
      ...cloneMessage(stoppedChanged),
      segments: [newSegment],
    };
    const afterSegments = computeStableChatTimelineRows(
      [segmentsChanged],
      afterStopped,
    );
    expect(afterSegments.result[0]).toBe(segmentsChanged);
  });

  it("returns the exact same top-level state object when nothing changed (referential no-op)", () => {
    const messages = [makeMessage(0, "user"), makeMessage(1, "assistant")];
    const state = computeStableChatTimelineRows(
      messages,
      EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
    );

    const rebuiltUnchanged = rebuildArray(messages);
    const next = computeStableChatTimelineRows(rebuiltUnchanged, state);
    expect(next).toBe(state);
    expect(next.result).toBe(state.result);
    expect(next.byId).toBe(state.byId);
  });

  it("handles insertions while keeping unaffected earlier row references", () => {
    const user = makeMessage(0, "user");
    const state = computeStableChatTimelineRows(
      [user],
      EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
    );

    // Streaming append: new assistant message at the end.
    const assistant = makeMessage(1, "assistant");
    const afterAppend = computeStableChatTimelineRows(
      [cloneMessage(user), assistant],
      state,
    );
    expect(afterAppend.result).toHaveLength(2);
    expect(afterAppend.result[0]).toBe(user);
    expect(afterAppend.result[1]).toBe(assistant);
    expect(afterAppend).not.toBe(state);
  });

  it("handles deletions (branch-edit truncates the tail) while keeping kept-row references", () => {
    const m0 = makeMessage(0, "user");
    const m1 = makeMessage(1, "assistant");
    const m2 = makeMessage(2, "user");
    const state = computeStableChatTimelineRows(
      [m0, m1, m2],
      EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
    );

    const afterTruncate = computeStableChatTimelineRows(
      [cloneMessage(m0), cloneMessage(m1)],
      state,
    );
    expect(afterTruncate.result).toHaveLength(2);
    expect(afterTruncate.result[0]).toBe(m0);
    expect(afterTruncate.result[1]).toBe(m1);
    expect(afterTruncate.byId.has(m2.id)).toBe(false);
  });

  it("handles reordering while keeping unchanged message object references", () => {
    const a = makeMessage(0, "user");
    const b = makeMessage(1, "assistant");
    const state = computeStableChatTimelineRows(
      [a, b],
      EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
    );

    const reordered = [cloneMessage(b), cloneMessage(a)];
    const afterReorder = computeStableChatTimelineRows(reordered, state);
    expect(afterReorder.result).toHaveLength(2);
    expect(afterReorder.result[0]).toBe(b);
    expect(afterReorder.result[1]).toBe(a);
  });

  it("uses id as the dedup key and does not reuse across different ids even if other fields match", () => {
    const base = makeMessage(0, "user");
    const sameFieldsDifferentId: ChatMessage = {
      ...cloneMessage(base),
      id: "message-other",
    };
    const state = computeStableChatTimelineRows(
      [base],
      EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
    );

    const next = computeStableChatTimelineRows([sameFieldsDifferentId], state);
    expect(next.result[0]).toBe(sameFieldsDifferentId);
    expect(next.result[0]).not.toBe(base);
    expect(next.byId.get("message-other")).toBe(sameFieldsDifferentId);
    expect(next.byId.has(base.id)).toBe(false);
  });

  it("starts from the empty state constant", () => {
    const empty: StableChatTimelineRowsState =
      EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE;
    expect(empty.result).toEqual([]);
    expect(empty.byId.size).toBe(0);

    const next = computeStableChatTimelineRows([], empty);
    expect(next).toBe(empty);
  });
});

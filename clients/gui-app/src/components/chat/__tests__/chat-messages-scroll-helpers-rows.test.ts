import { describe, expect, it } from "vitest";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";
import {
  buildRowKeyToIndex,
  viewportActiveUserMessageId,
  viewportAnchorRowKey,
} from "@/components/chat/chat-messages-scroll-helpers";

function model(
  id: string,
  role: ChatMessageModel["role"],
  content: string,
): ChatMessageModel {
  return {
    id,
    role,
    content,
    segments: [],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1000,
    completedAt: null,
    stopped: null,
    persistentMessageId: id,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function hydrated(
  key: string,
  ordinal: number,
  message: ChatMessageModel,
): TranscriptListRow {
  return { kind: "hydrated", key, ordinal, model: message };
}

function placeholder(key: string, ordinal: number): TranscriptListRow {
  return { kind: "placeholder", key, ordinal, entry: null };
}

function state(rowTops: readonly number[], scroll: number) {
  return {
    positionAtIndex: (index: number): number | undefined => rowTops[index],
    scroll,
    topOffsetAdjustment: 0,
  };
}

describe("row-based chat scroll helpers", () => {
  it("maps both placeholder and hydrated keys to list indexes", () => {
    const rows: readonly TranscriptListRow[] = [
      placeholder("placeholder-0", 0),
      hydrated("message-1", 1, model("message-1", "user", "question")),
      placeholder("placeholder-2", 2),
    ];
    const indexes = buildRowKeyToIndex(rows);

    expect(indexes.get("placeholder-0")).toBe(0);
    expect(indexes.get("message-1")).toBe(1);
    expect(indexes.get("placeholder-2")).toBe(2);
  });

  it("returns a placeholder key when the reading line sits on it", () => {
    const rows: readonly TranscriptListRow[] = [
      hydrated("u0", 0, model("u0", "user", "question")),
      placeholder("unhydrated-1", 1),
      hydrated("a2", 2, model("a2", "assistant", "answer")),
    ];

    expect(viewportAnchorRowKey(state([0, 100, 200], 60), rows)).toBe(
      "unhydrated-1",
    );
  });

  it("collapses a middle placeholder to the nearest hydrated row and its owner", () => {
    const rows: readonly TranscriptListRow[] = [
      hydrated("u0", 0, model("u0", "user", "question")),
      placeholder("unhydrated-1", 1),
      placeholder("unhydrated-2", 2),
      hydrated("a3", 3, model("a3", "assistant", "answer")),
    ];
    const messages = [
      model("u0", "user", "question"),
      model("a3", "assistant", "answer"),
    ];

    expect(
      viewportActiveUserMessageId(
        state([0, 100, 200, 300], 160),
        rows,
        messages,
      ),
    ).toBe("u0");
  });

  it("falls forward from placeholders above all hydrated rows", () => {
    const rows: readonly TranscriptListRow[] = [
      placeholder("unhydrated-0", 0),
      placeholder("unhydrated-1", 1),
      hydrated("a2", 2, model("a2", "assistant", "answer")),
    ];
    const messages = [
      model("u0", "user", "question"),
      model("a2", "assistant", "answer"),
    ];

    expect(
      viewportActiveUserMessageId(state([0, 100, 200], 0), rows, messages),
    ).toBe("u0");
  });

  it("returns the anchor row key when no hydrated row exists", () => {
    const rows: readonly TranscriptListRow[] = [
      placeholder("unhydrated-0", 0),
      placeholder("unhydrated-1", 1),
    ];

    expect(viewportActiveUserMessageId(state([0, 100], 0), rows, [])).toBe(
      "unhydrated-0",
    );
  });
});

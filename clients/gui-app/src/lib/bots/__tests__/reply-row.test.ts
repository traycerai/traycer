import { describe, expect, it } from "vitest";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import { replyFollowsPost, replyRowIdFor } from "@/lib/bots/reply-row";
import type { ChatMessage } from "@/stores/composer/chat-store";

function assistantRow(input: {
  readonly id: string;
  readonly persistentMessageId: string | null;
  readonly turnMessageIds: ReadonlyArray<string> | null;
}): ChatMessage {
  const base: ChatMessage = {
    ...makeMessage(0, "assistant"),
    id: input.id,
    persistentMessageId: input.persistentMessageId,
  };
  return input.turnMessageIds === null
    ? base
    : { ...base, turnMessageIds: input.turnMessageIds };
}

describe("replyRowIdFor", () => {
  it("resolves a message id to the row whose persistentMessageId is it", () => {
    const rows = [
      makeMessage(0, "user"),
      assistantRow({
        id: "assistant:ts:2000",
        persistentMessageId: "reply-uuid",
        turnMessageIds: null,
      }),
    ];
    expect(replyRowIdFor(rows, "reply-uuid")).toBe("assistant:ts:2000");
  });

  it("resolves a message id folded into a multi-record turn to that turn's row", () => {
    const rows = [
      assistantRow({
        id: "assistant:turn-1",
        persistentMessageId: "record-last",
        turnMessageIds: ["record-first", "record-middle", "record-last"],
      }),
      assistantRow({
        id: "assistant:turn-2",
        persistentMessageId: "other",
        turnMessageIds: null,
      }),
    ];
    expect(replyRowIdFor(rows, "record-first")).toBe("assistant:turn-1");
    expect(replyRowIdFor(rows, "record-middle")).toBe("assistant:turn-1");
    expect(replyRowIdFor(rows, "other")).toBe("assistant:turn-2");
  });

  it("is null when no rendered row carries the message", () => {
    const rows = [
      makeMessage(0, "user"),
      assistantRow({
        id: "assistant:turn-1",
        persistentMessageId: "record-last",
        turnMessageIds: ["record-first", "record-last"],
      }),
    ];
    expect(replyRowIdFor(rows, "absent-reply")).toBeNull();
    expect(replyRowIdFor([], "absent-reply")).toBeNull();
  });
});

describe("replyFollowsPost", () => {
  function post(id: string): ChatMessage {
    return { ...makeMessage(0, "user"), persistentMessageId: id };
  }

  it("is true when the row right after the post is the reply, or a turn that folds it in", () => {
    const direct = [
      post("post-1"),
      assistantRow({
        id: "assistant:a",
        persistentMessageId: "reply-1",
        turnMessageIds: null,
      }),
    ];
    expect(replyFollowsPost(direct, "post-1", "reply-1")).toBe(true);

    const folded = [
      post("post-1"),
      assistantRow({
        id: "assistant:turn",
        persistentMessageId: "record-last",
        turnMessageIds: ["record-first", "record-last"],
      }),
    ];
    expect(replyFollowsPost(folded, "post-1", "record-first")).toBe(true);
  });

  it("is false when another row sits between the post and its reply, or the reply comes before it", () => {
    const reply = assistantRow({
      id: "assistant:a",
      persistentMessageId: "reply-1",
      turnMessageIds: null,
    });
    expect(
      replyFollowsPost(
        [post("post-1"), post("post-2"), reply],
        "post-1",
        "reply-1",
      ),
    ).toBe(false);
    expect(replyFollowsPost([reply, post("post-1")], "post-1", "reply-1")).toBe(
      false,
    );
  });

  it("is false when the post is the last row, or is not in the rendered rows", () => {
    expect(replyFollowsPost([post("post-1")], "post-1", "reply-1")).toBe(false);
    expect(replyFollowsPost([], "post-1", "reply-1")).toBe(false);
  });
});

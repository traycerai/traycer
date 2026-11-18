import { describe, expect, it } from "vitest";
import { cloudDraftIdentityKey } from "@/lib/drafts/cloud-draft-identity";

interface KeyParts {
  readonly ownerHostId: string;
  readonly taskId: string;
  readonly ownerUserId: string;
  readonly chatId: string;
}

function keyFor(parts: KeyParts): string {
  return cloudDraftIdentityKey({
    ownerHostId: parts.ownerHostId,
    identity: {
      taskId: parts.taskId,
      ownerUserId: parts.ownerUserId,
      chatId: parts.chatId,
    },
  });
}

describe("cloudDraftIdentityKey", () => {
  it("keys a row by owner host and the full identity triple", () => {
    const identity = { taskId: "task-1", chatId: "chat-1", ownerUserId: "u1" };
    expect(cloudDraftIdentityKey({ ownerHostId: "host-a", identity })).toBe(
      '["host-a","task-1","u1","chat-1"]',
    );
    // Two hosts can mint the same chat id under one task; the owner keeps
    // their rows apart, and a claim (new owner, same head) reads as new.
    expect(cloudDraftIdentityKey({ ownerHostId: "host-b", identity })).not.toBe(
      cloudDraftIdentityKey({ ownerHostId: "host-a", identity }),
    );
  });

  it("does not let a delimiter inside one part alias another row", () => {
    // A colon moved between two adjacent parts.
    expect(
      keyFor({
        ownerHostId: "a",
        taskId: "b",
        ownerUserId: "c:d",
        chatId: "e",
      }),
    ).not.toBe(
      keyFor({
        ownerHostId: "a",
        taskId: "b",
        ownerUserId: "c",
        chatId: "d:e",
      }),
    );

    // The same shape with a NUL, the delimiter a hand-rolled join would
    // reach for next.
    expect(
      keyFor({
        ownerHostId: "a",
        taskId: "b",
        ownerUserId: "c\u0000d",
        chatId: "e",
      }),
    ).not.toBe(
      keyFor({
        ownerHostId: "a",
        taskId: "b",
        ownerUserId: "c",
        chatId: "d\u0000e",
      }),
    );

    // A quote and a bracket moved between parts: the characters the
    // encoding itself uses must not forge a part boundary.
    expect(
      keyFor({
        ownerHostId: "a",
        taskId: 'b","c',
        ownerUserId: "d",
        chatId: "e",
      }),
    ).not.toBe(
      keyFor({
        ownerHostId: "a",
        taskId: "b",
        ownerUserId: 'c","d',
        chatId: "e",
      }),
    );
    expect(
      keyFor({
        ownerHostId: "a",
        taskId: "b]",
        ownerUserId: "c",
        chatId: "d",
      }),
    ).not.toBe(
      keyFor({
        ownerHostId: "a",
        taskId: "b",
        ownerUserId: "]c",
        chatId: "d",
      }),
    );
  });

  it("is stable for equal inputs", () => {
    const first = keyFor({
      ownerHostId: "host-a",
      taskId: "task-1",
      ownerUserId: "u1",
      chatId: "chat-1",
    });
    const second = keyFor({
      ownerHostId: "host-a",
      taskId: "task-1",
      ownerUserId: "u1",
      chatId: "chat-1",
    });
    expect(first).toBe(second);
  });
});

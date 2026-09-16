import { describe, expect, it } from "vitest";
import { cloudDraftIdentityKey } from "@/lib/drafts/cloud-draft-identity";

describe("cloudDraftIdentityKey", () => {
  it("keys a row by owner host and the full identity triple", () => {
    const identity = { taskId: "task-1", chatId: "chat-1", ownerUserId: "u1" };
    expect(cloudDraftIdentityKey({ ownerHostId: "host-a", identity })).toBe(
      "host-a:task-1:u1:chat-1",
    );
    // Two hosts can mint the same chat id under one task; the owner keeps
    // their rows apart, and a claim (new owner, same head) reads as new.
    expect(cloudDraftIdentityKey({ ownerHostId: "host-b", identity })).not.toBe(
      cloudDraftIdentityKey({ ownerHostId: "host-a", identity }),
    );
  });
});

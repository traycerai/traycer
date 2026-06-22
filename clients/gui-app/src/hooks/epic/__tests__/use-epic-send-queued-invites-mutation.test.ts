import { describe, expect, it } from "vitest";
import { buildQueuedInviteBatches } from "@/hooks/epic/use-epic-send-queued-invites-mutation";
import type { QueuedInvite } from "@/lib/epic-invites";

describe("buildQueuedInviteBatches", () => {
  it("deduplicates existing collaborator re-invites by user id", () => {
    const emailInvite: QueuedInvite = {
      identifier: "anurag@example.com",
      identifierType: "email",
      role: "editor",
    };
    const handleInvite: QueuedInvite = {
      identifier: "anurag",
      identifierType: "github_handle",
      role: "editor",
    };
    const newInvite: QueuedInvite = {
      identifier: "new-user",
      identifierType: "github_handle",
      role: "viewer",
    };

    const batches = buildQueuedInviteBatches({
      queuedInvites: [emailInvite, handleInvite, newInvite],
      existingByInviteKey: new Map([
        ["email:anurag@example.com", "user-1"],
        ["github_handle:anurag", "user-1"],
      ]),
    });

    expect(batches.reInvites).toEqual([
      {
        userId: "user-1",
        invite: emailInvite,
        matchingInvites: [emailInvite, handleInvite],
      },
    ]);
    expect(batches.newInvites).toEqual([newInvite]);
  });
});

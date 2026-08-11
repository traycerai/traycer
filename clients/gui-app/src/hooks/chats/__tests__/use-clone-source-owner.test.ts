import { describe, expect, it } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { resolveCloneSourceOwnerUserId } from "@/hooks/chats/use-clone-source-owner";

/**
 * The owner a clone surface sends with `forkSource` (chat-sync-v2 ticket 37).
 *
 * The case the ticket exists for is the third one: no local record, but a
 * cloud row the surface already rendered from. Everything else here pins the
 * ordering and the two ways this must answer `null` rather than guess - the
 * host TRUSTS a value it is given when it holds no facts of its own, so a
 * fabricated owner is worse than an absent one.
 */

function cloudRow(chatId: string, ownerUserId: string): CloudChatSummary {
  return {
    identity: { taskId: "epic-1", chatId, ownerUserId },
    ownerHostId: "owner-host",
    createdAt: 1,
    visibility: "task",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer: false,
  };
}

describe("resolveCloneSourceOwnerUserId", () => {
  it("takes the cloud row's owner when there is no local record - the case the clone used to lose its history on", () => {
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: null,
        cloudChats: [
          cloudRow("chat-other", "owner-other"),
          cloudRow("chat-1", "owner-9"),
        ],
      }),
    ).toBe("owner-9");
  });

  it("prefers the local record over the listing - this device's own projection outranks a list it rendered beside", () => {
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: "owner-local",
        cloudChats: [cloudRow("chat-1", "owner-9")],
      }),
    ).toBe("owner-local");
  });

  it('treats an empty local owner as no answer and falls through - `""` would fail the wire\'s min(1) and break the clone outright', () => {
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: "",
        cloudChats: [cloudRow("chat-1", "owner-9")],
      }),
    ).toBe("owner-9");
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: "",
        cloudChats: null,
      }),
    ).toBeNull();
  });

  it("never borrows another chat's owner: a listing without this chat answers null", () => {
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: null,
        cloudChats: [cloudRow("chat-other", "owner-other")],
      }),
    ).toBeNull();
  });

  it("answers null while the list is still unresolved, and for no chat at all", () => {
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: null,
        cloudChats: null,
      }),
    ).toBeNull();
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: null,
        localRecordOwnerUserId: "owner-local",
        cloudChats: [cloudRow("chat-1", "owner-9")],
      }),
    ).toBeNull();
  });
});

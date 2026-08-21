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

function cloudRow(
  chatId: string,
  ownerUserId: string,
  ownerHostId: string,
): CloudChatSummary {
  return {
    identity: { taskId: "epic-1", chatId, ownerUserId },
    ownerHostId,
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
          cloudRow("chat-other", "owner-other", "owner-host"),
          cloudRow("chat-1", "owner-9", "owner-host"),
        ],
        sourceOwnerHostId: null,
      }),
    ).toBe("owner-9");
  });

  it("prefers the local record over the listing - this device's own projection outranks a list it rendered beside", () => {
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: "owner-local",
        cloudChats: [cloudRow("chat-1", "owner-9", "owner-host")],
        sourceOwnerHostId: null,
      }),
    ).toBe("owner-local");
  });

  it('treats an empty local owner as no answer and falls through - `""` would fail the wire\'s min(1) and break the clone outright', () => {
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: "",
        cloudChats: [cloudRow("chat-1", "owner-9", "owner-host")],
        sourceOwnerHostId: null,
      }),
    ).toBe("owner-9");
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: "",
        cloudChats: null,
        sourceOwnerHostId: null,
      }),
    ).toBeNull();
  });

  it("never borrows another chat's owner: a listing without this chat answers null", () => {
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: null,
        cloudChats: [cloudRow("chat-other", "owner-other", "owner-host")],
        sourceOwnerHostId: null,
      }),
    ).toBeNull();
  });

  it("answers null while the list is still unresolved, and for no chat at all", () => {
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: null,
        cloudChats: null,
        sourceOwnerHostId: null,
      }),
    ).toBeNull();
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: null,
        localRecordOwnerUserId: "owner-local",
        cloudChats: [cloudRow("chat-1", "owner-9", "owner-host")],
        sourceOwnerHostId: null,
      }),
    ).toBeNull();
  });

  // `chatId` is host-minted and NOT unique under a task (`cloud-chat.ts`:
  // identity is the triple), so a listing can carry two rows for one id. The
  // owner drives the host's anti-squat expectation AND, since the shared-chat
  // banner, whether the UI calls a chat the viewer's own - both are wrong to
  // guess at.
  it("disambiguates a colliding chat id by the source's bound host", () => {
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: null,
        cloudChats: [
          cloudRow("chat-1", "owner-a", "host-a"),
          cloudRow("chat-1", "owner-b", "host-b"),
        ],
        sourceOwnerHostId: "host-b",
      }),
    ).toBe("owner-b");
  });

  it("answers null for a colliding chat id it cannot disambiguate, rather than taking the first row", () => {
    const colliding = [
      cloudRow("chat-1", "owner-a", "host-a"),
      cloudRow("chat-1", "owner-b", "host-b"),
    ];
    // No host in hand.
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: null,
        cloudChats: colliding,
        sourceOwnerHostId: null,
      }),
    ).toBeNull();
    // A host that names neither row.
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: null,
        cloudChats: colliding,
        sourceOwnerHostId: "host-c",
      }),
    ).toBeNull();
  });

  // The trap the fork dialog fell into: a published copy is read through the
  // host SERVING it, generally the viewer's own machine. Handed that host as
  // the tie-breaker, a colliding id resolves to the viewer's own unrelated row
  // - a wrong owner, which the host TRUSTS, rather than an absent one. Callers
  // that cannot name the OWNING host must pass `null` and take the degrade.
  it("resolves a collision to the viewer's own row when handed a serving host - why callers must pass the owning host or null", () => {
    const colliding = [
      cloudRow("chat-1", "viewer-user", "viewer-own-host"),
      cloudRow("chat-1", "collaborator-user", "collaborator-host"),
    ];
    // The serving host IS the viewer's own, so this picks the wrong owner...
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: null,
        cloudChats: colliding,
        sourceOwnerHostId: "viewer-own-host",
      }),
    ).toBe("viewer-user");
    // ...whereas declining to name a host degrades honestly.
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: null,
        cloudChats: colliding,
        sourceOwnerHostId: null,
      }),
    ).toBeNull();
  });

  // The tie-breaker must not become a filter: one row is already unambiguous,
  // and a caller whose bound host disagrees for a reason this function cannot
  // see must not lose the owner it used to resolve.
  it("keeps the single matching row even when the caller's host disagrees", () => {
    expect(
      resolveCloneSourceOwnerUserId({
        chatId: "chat-1",
        localRecordOwnerUserId: null,
        cloudChats: [cloudRow("chat-1", "owner-9", "owner-host")],
        sourceOwnerHostId: "some-other-host",
      }),
    ).toBe("owner-9");
  });
});

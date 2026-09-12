import { describe, expect, it } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import type { DraftKind } from "@traycer/protocol/host";
import type {
  CloudChatIdentity,
  CloudChatSummary,
} from "@traycer/protocol/host/epic/cloud-chat";
import { cloudDraftIdentityKey } from "@/lib/drafts/cloud-draft-kinds";
import {
  cloudDraftsDirectoryIsVisible,
  openableCloudDrafts,
} from "@/lib/drafts/cloud-drafts-visibility";

function error(code: RpcErrorCode): HostRpcError {
  return new HostRpcError({
    code,
    message: code,
    requestId: "req-1",
    method: "epic.listCloudChats",
    fatalDetails: null,
  });
}

describe("cloudDraftsDirectoryIsVisible", () => {
  it("hides when the host omitted a scope id", () => {
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: null,
        error: null,
        isPending: false,
        isSuccess: true,
      }),
    ).toBe(false);
  });

  it("hides on old-host errors even while the query is still pending", () => {
    // `isPending` on its own keeps the section visible, so this case can only
    // pass if the unsupported classification actually fires - with the
    // settled flags it would read `false` for any error at all, including
    // `null`.
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: error("E_HOST_UNSUPPORTED"),
        isPending: true,
        isSuccess: false,
      }),
    ).toBe(false);
  });

  it("hides free-tier FORBIDDEN by SETTLING, not by classifying it", () => {
    // Free-tier arrives as FORBIDDEN and is deliberately not classified: what
    // hides the section is the query having settled without success. Both
    // halves are asserted so the pair states the mechanism rather than
    // restating a `false` that any error value would produce.
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: error("FORBIDDEN"),
        isPending: false,
        isSuccess: false,
      }),
    ).toBe(false);
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: error("FORBIDDEN"),
        isPending: true,
        isSuccess: false,
      }),
    ).toBe(true);
  });

  it("shows while a capable host is listing or has listed", () => {
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: null,
        isPending: true,
        isSuccess: false,
      }),
    ).toBe(true);
    expect(
      cloudDraftsDirectoryIsVisible({
        scopeId: "scp_1",
        error: null,
        isPending: false,
        isSuccess: true,
      }),
    ).toBe(true);
  });
});

describe("openableCloudDrafts", () => {
  const identityA: CloudChatIdentity = {
    taskId: "task-1",
    chatId: "chat-a",
    ownerUserId: "user-1",
  };
  const identityB: CloudChatIdentity = {
    taskId: "task-1",
    chatId: "chat-b",
    ownerUserId: "user-1",
  };

  function chat(input: {
    readonly identity: CloudChatIdentity;
    readonly ownerHostId: string;
  }): CloudChatSummary {
    return {
      identity: input.identity,
      ownerHostId: input.ownerHostId,
      createdAt: 0,
      visibility: "private",
      title: null,
      isTitleEditedByUser: false,
      parentChatId: null,
      isArchived: false,
      runSettingsSummary: null,
      metadataUpdatedAt: 0,
      headSha256: null,
      publishedAt: null,
      throughRecordSeq: null,
      isOwnedByViewer: true,
    };
  }

  it("excludes a row owned by the calling hostId", () => {
    const row = chat({ identity: identityA, ownerHostId: "host-b" });
    const kinds = new Map<string, DraftKind>([
      [cloudDraftIdentityKey(identityA), "landing"],
    ]);

    expect(
      openableCloudDrafts({ chats: [row], hostId: "host-b", kinds }),
    ).toEqual([]);
  });

  it("excludes a chat-composer row and an interview row", () => {
    const composerRow = chat({ identity: identityA, ownerHostId: "host-a" });
    const interviewRow = chat({ identity: identityB, ownerHostId: "host-a" });
    const kinds = new Map<string, DraftKind>([
      [cloudDraftIdentityKey(identityA), "chat-composer"],
      [cloudDraftIdentityKey(identityB), "interview"],
    ]);

    expect(
      openableCloudDrafts({
        chats: [composerRow, interviewRow],
        hostId: "host-b",
        kinds,
      }),
    ).toEqual([]);
  });

  it("includes a landing row and a new-chat row", () => {
    const landingRow = chat({ identity: identityA, ownerHostId: "host-a" });
    const newChatRow = chat({ identity: identityB, ownerHostId: "host-a" });
    const kinds = new Map<string, DraftKind>([
      [cloudDraftIdentityKey(identityA), "landing"],
      [cloudDraftIdentityKey(identityB), "new-chat"],
    ]);

    expect(
      openableCloudDrafts({
        chats: [landingRow, newChatRow],
        hostId: "host-b",
        kinds,
      }),
    ).toEqual([landingRow, newChatRow]);
  });

  it("excludes a row whose kind has not been recorded yet (head not read)", () => {
    const row = chat({ identity: identityA, ownerHostId: "host-a" });

    expect(
      openableCloudDrafts({
        chats: [row],
        hostId: "host-b",
        kinds: new Map(),
      }),
    ).toEqual([]);
  });

  it("returns an empty list when hostId is null", () => {
    const row = chat({ identity: identityA, ownerHostId: "host-a" });
    const kinds = new Map<string, DraftKind>([
      [cloudDraftIdentityKey(identityA), "landing"],
    ]);

    expect(openableCloudDrafts({ chats: [row], hostId: null, kinds })).toEqual(
      [],
    );
  });
});

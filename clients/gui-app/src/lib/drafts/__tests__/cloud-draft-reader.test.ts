import { describe, expect, it } from "vitest";
import {
  utf8Bytes,
  webCryptoSha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import type { CloudChatReadPort } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import { serializeDraftHeadDocument } from "@traycer/protocol/persistence/draft/document";
import type { DraftHeadRecord } from "@traycer/protocol/persistence/draft/schemas";
import { DRAFT_HEAD_SCHEMA_VERSION } from "@traycer/protocol/persistence/draft/version";
import { readCloudDraft } from "@/lib/drafts/cloud-draft-reader";

const IDENTITY: CloudChatIdentity = {
  taskId: "scp_TESTDRAFTSSCOPEID000001",
  chatId: "draft-1",
  ownerUserId: "user-1",
};

const HEAD: DraftHeadRecord = {
  dialect: "draft/v1",
  schemaVersion: DRAFT_HEAD_SCHEMA_VERSION,
  kind: "stash-entry",
  lastTouchedAt: 1,
  target: { epicId: null, chatId: null, blockId: null },
  hostLocal: { hostId: "host-a", workspace: null },
  portable: {
    content: { type: "doc", content: [{ type: "paragraph" }] },
    blobHashes: [],
    createdAt: 1,
  },
};

function portWithHead(head: string, sha256: string): CloudChatReadPort {
  return {
    resolveHead: () =>
      Promise.resolve({
        chat: {
          identity: IDENTITY,
          ownerHostId: "host-a",
          createdAt: 1,
          visibility: "private",
          title: null,
          isTitleEditedByUser: false,
          parentChatId: null,
          isArchived: false,
          runSettingsSummary: null,
          metadataUpdatedAt: 1,
          headSha256: sha256,
          publishedAt: 1,
          throughRecordSeq: 1,
          isOwnedByViewer: true,
        },
        outcome: { status: "ok", head, headSha256: sha256 },
      }),
    readPart: () => {
      throw new Error("draft/v1 must not fetch parts");
    },
  };
}

describe("readCloudDraft", () => {
  it("verifies the head digest and decodes a stash-entry", async () => {
    const head = serializeDraftHeadDocument(HEAD);
    const sha256 = await webCryptoSha256Hex(utf8Bytes(head));
    const outcome = await readCloudDraft({
      identity: IDENTITY,
      port: portWithHead(head, sha256),
      sha256Hex: webCryptoSha256Hex,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.record.kind).toBe("stash-entry");
  });

  it("refuses a digest mismatch before parse", async () => {
    const head = serializeDraftHeadDocument(HEAD);
    const outcome = await readCloudDraft({
      identity: IDENTITY,
      port: portWithHead(head, "ab".repeat(32)),
      sha256Hex: webCryptoSha256Hex,
    });
    expect(outcome).toMatchObject({
      kind: "corrupt",
      reason: "head-digest-mismatch",
    });
  });
});

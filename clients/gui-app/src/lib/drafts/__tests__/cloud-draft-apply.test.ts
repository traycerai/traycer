import { describe, expect, it } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";
import { DRAFT_HEAD_SCHEMA_VERSION } from "@traycer/protocol/persistence/draft/version";
import { draftDocumentFromCloudHead } from "@/lib/drafts/cloud-draft-apply";

const SUMMARY: CloudChatSummary = {
  identity: {
    taskId: "scp_TESTDRAFTSSCOPEID000001",
    chatId: "draft-1",
    ownerUserId: "user-1",
  },
  ownerHostId: "host-a",
  createdAt: 1,
  visibility: "private",
  title: "From laptop",
  isTitleEditedByUser: false,
  parentChatId: null,
  isArchived: false,
  runSettingsSummary: null,
  metadataUpdatedAt: 1,
  headSha256: "ab".repeat(32),
  publishedAt: 9,
  throughRecordSeq: 1,
  isOwnedByViewer: true,
};

describe("draftDocumentFromCloudHead", () => {
  it("projects a published landing draft as a replica with no foreign workspace", () => {
    const record: DraftHeadReaderRecord = {
      dialect: "draft/v1",
      schemaVersion: DRAFT_HEAD_SCHEMA_VERSION,
      kind: "draft",
      surfaceKind: "landing",
      lastTouchedAt: 4,
      target: { epicId: null, chatId: null, blockId: null },
      hostLocal: {
        hostId: "host-a",
        workspace: {
          folders: ["/tmp"],
          folderInfoByPath: {},
          primaryPath: "/tmp",
        },
      },
      portable: {
        content: { type: "doc", content: [{ type: "paragraph" }] },
        selection: null,
        runSettings: null,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };
    const document = draftDocumentFromCloudHead(SUMMARY, record);
    expect(document.kind).toBe("landing");
    expect(document.origin).toBe("replica");
    expect(document.ownerHostId).toBe("host-a");
    expect(document.workspace).toBeNull();
    expect(document.publication.lastPublishedAt).toBe(9);
  });
});

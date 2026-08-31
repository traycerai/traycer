import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";
import { DRAFT_HEAD_DIALECT } from "@traycer/protocol/persistence/draft/version";

const directoryMock = vi.hoisted(() => ({
  chats: [] as ReadonlyArray<CloudChatSummary>,
}));
const readMock = vi.hoisted(() => ({
  read: vi.fn<() => Promise<{ kind: string; record: unknown }>>(),
}));
const ingestMock = vi.hoisted(() => ({
  ingest: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/hooks/drafts/use-cloud-drafts-directory", () => ({
  useCloudDraftsDirectory: () => ({
    visible: true,
    scopeId: "scp_1",
    chats: directoryMock.chats,
  }),
}));
vi.mock("@/lib/chats/cloud-chat-read-port", () => ({
  createHostCloudChatReadPort: () => ({}),
}));
vi.mock("@/lib/drafts/cloud-draft-reader", () => ({
  readCloudDraft: (): Promise<{ kind: string; record: unknown }> =>
    readMock.read(),
}));
vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  ingestCloudDraftSummary: (): Promise<void> => ingestMock.ingest(),
}));

const { useCloudDraftsIngest } =
  await import("@/hooks/drafts/use-cloud-drafts-ingest");

const HOST_ID = "host-a";
const OWNER_HOST_ID = "host-b";
const DIGEST_ONE = "a".repeat(64);
const DIGEST_TWO = "b".repeat(64);

function summary(headSha256: string): CloudChatSummary {
  return {
    identity: {
      taskId: "scp_1",
      chatId: "draft-1",
      ownerUserId: "user-1",
    },
    ownerHostId: OWNER_HOST_ID,
    createdAt: 1,
    visibility: "private",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256,
    publishedAt: 1,
    throughRecordSeq: 1,
    isOwnedByViewer: true,
  };
}

const HEAD: DraftHeadReaderRecord = {
  dialect: DRAFT_HEAD_DIALECT,
  schemaVersion: { major: 1, minor: 0 },
  kind: "draft",
  surfaceKind: "landing",
  lastTouchedAt: 1,
  target: { epicId: null, chatId: null, blockId: null },
  hostLocal: { hostId: OWNER_HOST_ID, workspace: null },
  portable: {
    content: { type: "doc", content: [{ type: "paragraph" }] },
    selection: null,
    runSettings: null,
    composerMode: "chat",
    blobHashes: [],
    closed: false,
  },
};

// The hook only needs the client to be non-null; every call it would make
// goes through the mocked reader and coordinator.
const CLIENT = { request: () => Promise.reject(new Error("unused")) };

afterEach(() => {
  directoryMock.chats = [];
  readMock.read.mockReset();
  ingestMock.ingest.mockReset();
});

describe("useCloudDraftsIngest", () => {
  it("re-reads the same draft when its published head changes", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });

    // Same identity, same scope, newer head. Keyed on the identity alone this
    // second publish was skipped and the replica stayed on the old bytes.
    directoryMock.chats = [summary(DIGEST_TWO)];
    view.rerender();
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
  });

  it("drops a read that resolves after the effect was torn down", async () => {
    const pending: Array<() => void> = [];
    readMock.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => {
            resolve({ kind: "ok", record: HEAD });
          });
        }),
    );
    directoryMock.chats = [summary(DIGEST_ONE)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(1);
    });
    view.unmount();
    for (const resolve of pending) resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });
});

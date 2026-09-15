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
// Mirrors the retry constants in use-cloud-drafts-ingest.ts. They are not
// exported, so these tests restate them - keep them in sync if the
// production values change.
const MAX_HEAD_READ_ATTEMPTS = 3;
const HEAD_READ_RETRY_BASE_MS = 2_000;

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
  vi.useRealTimers();
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

  it("retries a head read that throws once, then ingests once it succeeds", async () => {
    vi.useFakeTimers();
    readMock.read
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValueOnce({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // The first read rejects. Let that promise settle so attemptRead's catch
    // block actually runs and arms the retry timer before the clock moves -
    // advancing first would jump straight past a timer that does not exist
    // yet.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);

    // Backoff for attempt 0: HEAD_READ_RETRY_BASE_MS * 2 ** 0 = 2s.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_HEAD_READ_ATTEMPTS reads and makes no further attempt", async () => {
    vi.useFakeTimers();
    readMock.read.mockRejectedValue(new Error("persistent read failure"));
    directoryMock.chats = [summary(DIGEST_ONE)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // Attempt 0 fails and arms the first retry (2s backoff).
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    // Attempt 1 fails and arms the second retry (4s backoff).
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);

    // Attempt 2 is the last one (MAX_HEAD_READ_ATTEMPTS = 3): it fails and
    // gives up rather than arming a third timer.
    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    });
    expect(vi.getTimerCount()).toBe(0);

    // Advancing well past every backoff makes no further read.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("clears a pending retry timer on unmount, so it never fires a read", async () => {
    vi.useFakeTimers();
    readMock.read.mockRejectedValue(new Error("transient read failure"));
    directoryMock.chats = [summary(DIGEST_ONE)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );

    // Prove the trigger fired - the first attempt failed and armed a retry -
    // before asserting that unmounting stops it.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);

    // The cleanup cleared the timer: letting it lapse reads no further.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });
});

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";
import { DRAFT_HEAD_DIALECT } from "@traycer/protocol/persistence/draft/version";
import type { ReactNode } from "react";
import { appLogger } from "@/lib/logger";
import type { CloudDraftHeadAbandonCause } from "@/lib/drafts/draft-mirror-coordinator";
import {
  SurfaceDemandContext,
  type ActiveSurfaceDemand,
} from "@/stores/tabs/surface-demand";

const directoryMock = vi.hoisted(() => ({
  chats: [] as ReadonlyArray<CloudChatSummary>,
  settled: true,
  snapshotSeq: 0,
}));
const readMock = vi.hoisted(() => ({
  read: vi.fn<() => Promise<{ kind: string; record: unknown }>>(),
}));
// The INGEST fence: reserved only when a head read starts, and it is also the
// coordinator's apply supersession check.
const reserveMock = vi.hoisted(() => ({
  reserve: vi.fn<(draftId: string) => void>(),
}));
// The SWEEP fence: reserved for every listed head (whichever host owns it) on
// each walk, read or skipped, at the directory snapshot's dispatch position,
// and never supersedes an apply.
const sweepFenceMock = vi.hoisted(() => ({
  reserve:
    vi.fn<
      (draftId: string, ownerHostId: string, listedAtSeq: number) => void
    >(),
}));
const ingestMock = vi.hoisted(() => ({
  ingest:
    vi.fn<
      (args: {
        hostId: string;
        summary: CloudChatSummary;
        document: unknown;
      }) => Promise<void>
    >(),
}));
const sweepMock = vi.hoisted(() => ({
  sweep:
    vi.fn<
      (
        hostId: string,
        listed: ReadonlyMap<string, ReadonlySet<string>>,
        fenceSeq: number,
      ) => readonly string[]
    >(),
}));
// No mirrors dropped unless a test overrides this.
sweepMock.sweep.mockReturnValue([]);
const flushMock = vi.hoisted(() => ({
  flush:
    vi.fn<
      (
        listed: ReadonlyMap<string, ReadonlySet<string>>,
        fenceSeq: number,
        alreadyFlushed: ReadonlySet<string>,
      ) => readonly string[]
    >(),
}));
flushMock.flush.mockReturnValue([]);
// The coordinator's process-wide "settled" record. Nothing settled unless a
// test says so; keyed exactly as production keys it.
const settledMock = vi.hoisted(() => ({
  settled: vi.fn<(summary: CloudChatSummary) => boolean>(),
}));
settledMock.settled.mockReturnValue(false);
// Whether the coordinator's record for a head is still `reading` this very
// digest: what a retry checks before it reserves the ingest fence. The claim
// stands unless a test says a newer head's read displaced it.
const readingMock = vi.hoisted(() => ({
  reading: vi.fn<(summary: CloudChatSummary) => boolean>(),
}));
readingMock.reading.mockReturnValue(true);
// The coordinator's claim on a head: begun before a read; released silently
// on an ambiguous identity (the mount's own key goes with it); abandoned with
// a cause when the read ends without a decision - out of attempts
// (`exhausted`), or torn down with the read undecided (`released`) - and
// settled when it answers a terminal refusal.
const claimMock = vi.hoisted(() => ({
  begin: vi.fn<(summary: CloudChatSummary) => void>(),
  release: vi.fn<(summary: CloudChatSummary) => void>(),
  abandon:
    vi.fn<
      (summary: CloudChatSummary, cause: CloudDraftHeadAbandonCause) => void
    >(),
  settleWithoutApply: vi.fn<(summary: CloudChatSummary) => void>(),
}));
// A skipped head's host is registered as an image source for it.
const noteHostMock = vi.hoisted(() => ({
  note: vi.fn<(summary: CloudChatSummary, hostId: string) => void>(),
}));
// The abandon subscription: the hook's listener is captured so a test can
// deliver an abandon to it, and every subscribe hands back one shared
// unsubscribe spy.
const abandonSubscriptionMock = vi.hoisted(() => ({
  subscribe:
    vi.fn<
      (
        listener: (
          summary: CloudChatSummary,
          cause: CloudDraftHeadAbandonCause,
        ) => void,
      ) => () => void
    >(),
  unsubscribe: vi.fn<() => void>(),
  listener: null as
    | ((summary: CloudChatSummary, cause: CloudDraftHeadAbandonCause) => void)
    | null,
}));
function installAbandonSubscription(): void {
  abandonSubscriptionMock.listener = null;
  abandonSubscriptionMock.subscribe.mockImplementation((listener) => {
    abandonSubscriptionMock.listener = listener;
    return abandonSubscriptionMock.unsubscribe;
  });
}
installAbandonSubscription();

vi.mock("@/hooks/drafts/use-cloud-drafts-directory", () => ({
  useCloudDraftsDirectory: () => ({
    visible: true,
    settled: directoryMock.settled,
    scopeId: "scp_1",
    chats: directoryMock.chats,
    snapshotIngestSeq: (): number => directoryMock.snapshotSeq,
  }),
}));
vi.mock("@/lib/chats/cloud-chat-read-port", () => ({
  createHostCloudChatReadPort: () => ({}),
}));
vi.mock("@/lib/drafts/cloud-draft-reader", () => ({
  readCloudDraft: (): Promise<{ kind: string; record: unknown }> =>
    readMock.read(),
}));
vi.mock("@/lib/drafts/draft-mirror-coordinator", () => {
  return {
    cloudDraftHeadKey: (summary: CloudChatSummary): string =>
      `${summary.ownerHostId}:${summary.identity.taskId}:${summary.identity.ownerUserId}:${summary.identity.chatId}:${summary.headSha256}`,
    cloudDraftHeadSettled: (summary: CloudChatSummary): boolean =>
      settledMock.settled(summary),
    cloudDraftHeadReading: (summary: CloudChatSummary): boolean =>
      readingMock.reading(summary),
    beginCloudDraftHeadRead: (summary: CloudChatSummary): void =>
      claimMock.begin(summary),
    releaseCloudDraftHeadRead: (summary: CloudChatSummary): void =>
      claimMock.release(summary),
    abandonCloudDraftHeadRead: (
      summary: CloudChatSummary,
      cause: CloudDraftHeadAbandonCause,
    ): void => claimMock.abandon(summary, cause),
    noteCloudDraftHeadHost: (summary: CloudChatSummary, hostId: string): void =>
      noteHostMock.note(summary, hostId),
    subscribeCloudDraftHeadAbandoned: (
      listener: (
        summary: CloudChatSummary,
        cause: CloudDraftHeadAbandonCause,
      ) => void,
    ): (() => void) => abandonSubscriptionMock.subscribe(listener),
    settleCloudDraftHeadWithoutApply: (summary: CloudChatSummary): void =>
      claimMock.settleWithoutApply(summary),
    reserveCloudDraftIngestFence: (draftId: string): void =>
      reserveMock.reserve(draftId),
    reserveCloudDraftSweepFence: (
      draftId: string,
      ownerHostId: string,
      listedAtSeq: number,
    ): void => sweepFenceMock.reserve(draftId, ownerHostId, listedAtSeq),
    ingestCloudDraftSummary: (args: {
      hostId: string;
      summary: CloudChatSummary;
      document: unknown;
    }): Promise<void> => ingestMock.ingest(args),
    sweepAbsentCloudDraftMirrors: (
      hostId: string,
      listed: ReadonlyMap<string, ReadonlySet<string>>,
      fenceSeq: number,
    ): readonly string[] => sweepMock.sweep(hostId, listed, fenceSeq),
    flushAbsentOwnCloudDrafts: (
      listed: ReadonlyMap<string, ReadonlySet<string>>,
      fenceSeq: number,
      alreadyFlushed: ReadonlySet<string>,
      // Snapshotted: the hook mutates the set after the call, and the tests
      // read what was excluded AT the call.
    ): readonly string[] =>
      flushMock.flush(listed, fenceSeq, new Set(alreadyFlushed)),
  };
});

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

function summary(
  headSha256: string | null,
  overrides: Partial<CloudChatSummary> | null,
): CloudChatSummary {
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
    ...overrides,
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

/** Delivers an abandon to the listener the mounted hook registered. */
function deliverAbandon(
  abandoned: CloudChatSummary,
  cause: CloudDraftHeadAbandonCause,
): void {
  const listener = abandonSubscriptionMock.listener;
  if (listener === null) throw new Error("the hook never subscribed");
  listener(abandoned, cause);
}

afterEach(() => {
  // Unmount first, so a teardown's calls land before the mocks are reset
  // rather than leaking into the next test's counts.
  cleanup();
  directoryMock.chats = [];
  directoryMock.settled = true;
  directoryMock.snapshotSeq = 0;
  readMock.read.mockReset();
  reserveMock.reserve.mockReset();
  sweepFenceMock.reserve.mockReset();
  ingestMock.ingest.mockReset();
  sweepMock.sweep.mockReset();
  // No mirrors dropped unless a test says otherwise.
  sweepMock.sweep.mockReturnValue([]);
  flushMock.flush.mockReset();
  flushMock.flush.mockReturnValue([]);
  settledMock.settled.mockReset();
  settledMock.settled.mockReturnValue(false);
  readingMock.reading.mockReset();
  readingMock.reading.mockReturnValue(true);
  claimMock.begin.mockReset();
  claimMock.release.mockReset();
  claimMock.abandon.mockReset();
  claimMock.settleWithoutApply.mockReset();
  noteHostMock.note.mockReset();
  abandonSubscriptionMock.subscribe.mockReset();
  abandonSubscriptionMock.unsubscribe.mockReset();
  installAbandonSubscription();
  vi.useRealTimers();
});

describe("useCloudDraftsIngest", () => {
  it("reads nothing from a surface a held tab cycle is only previewing, and reads once it settles", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    let demand: ActiveSurfaceDemand = "preview";
    const wrapper = ({ children }: { readonly children: ReactNode }) => (
      <SurfaceDemandContext value={demand}>{children}</SurfaceDemandContext>
    );

    const view = renderHook(
      () => useCloudDraftsIngest(CLIENT as never, HOST_ID),
      { wrapper },
    );
    // A previewed tab may be left again before the cycle ends: no head is
    // claimed, fenced, read or swept for it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readMock.read).not.toHaveBeenCalled();
    expect(sweepFenceMock.reserve).not.toHaveBeenCalled();
    expect(reserveMock.reserve).not.toHaveBeenCalled();

    demand = "settled";
    view.rerender();
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
  });

  it("re-reads the same draft when its published head changes", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });

    // Same identity, same scope, newer head. Keyed on the identity alone this
    // second publish was skipped and the replica stayed on the old bytes.
    directoryMock.chats = [summary(DIGEST_TWO, null)];
    view.rerender();
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
  });

  it("reserves the ingest fence before the head read resolves, then ingests once the read settles", async () => {
    const pending: Array<() => void> = [];
    readMock.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => {
            resolve({ kind: "ok", record: HEAD });
          });
        }),
    );
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.snapshotSeq = 5;
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // The ingest fence is reserved BEFORE the head read resolves - while the
    // read is still pending, the reserve has already happened but nothing
    // has ingested yet. It is reserved once, inside `attemptRead`, before its
    // own read; the pre-sweep walk reservation is the separate SWEEP fence.
    await vi.waitFor(() => {
      expect(reserveMock.reserve).toHaveBeenCalledTimes(1);
    });
    expect(reserveMock.reserve).toHaveBeenNthCalledWith(1, "draft-1");
    expect(sweepFenceMock.reserve).toHaveBeenCalledTimes(1);
    // At the directory snapshot's dispatch position, not at the walk.
    expect(sweepFenceMock.reserve).toHaveBeenCalledWith(
      "draft-1",
      OWNER_HOST_ID,
      5,
    );
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).not.toHaveBeenCalled();

    for (const resolve of pending) resolve();
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
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
    directoryMock.chats = [summary(DIGEST_ONE, null)];

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
    directoryMock.chats = [summary(DIGEST_ONE, null)];

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
    // The ingest fence is reserved once per attempt: the failed first read
    // and the successful retry each reserve it again before their own read.
    // The sweep fence is the walk's and is taken once, not per attempt.
    expect(reserveMock.reserve).toHaveBeenCalledTimes(2);
    expect(sweepFenceMock.reserve).toHaveBeenCalledTimes(1);
  });

  it("gives up after MAX_HEAD_READ_ATTEMPTS reads and makes no further attempt", async () => {
    vi.useFakeTimers();
    readMock.read.mockRejectedValue(new Error("persistent read failure"));
    directoryMock.chats = [summary(DIGEST_ONE, null)];

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

  it("a retry whose claim a newer head displaced stops before the ingest fence: no reserve, no read, no release, and the key is given back", async () => {
    vi.useFakeTimers();
    readMock.read.mockRejectedValueOnce(new Error("transient read failure"));
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );

    // The first attempt fails and arms the retry. The claim is not asked about
    // on the first attempt: it holds the claim it just made.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(reserveMock.reserve).toHaveBeenCalledTimes(1);
    expect(readingMock.reading).not.toHaveBeenCalled();

    // A newer head's read displaced the claim while the timer ran: the claim
    // is gone and the record names a newer head, so the guard answers settled.
    readingMock.reading.mockReturnValue(false);
    settledMock.settled.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    expect(readingMock.reading).toHaveBeenCalledTimes(1);
    expect(readingMock.reading).toHaveBeenCalledWith(row);
    expect(reserveMock.reserve).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // The key was given back: with nothing holding the head, the same listing
    // delivered again is read, claimed again, instead of skipped as handled.
    readingMock.reading.mockReturnValue(true);
    settledMock.settled.mockReturnValue(false);
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    await vi.waitFor(() => {
      expect(claimMock.begin).toHaveBeenCalledTimes(2);
    });
    expect(claimMock.begin).toHaveBeenNthCalledWith(2, row);
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
    expect(claimMock.abandon).not.toHaveBeenCalled();
  });

  it("a retry of a failed apply whose claim was displaced stops the same way", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockRejectedValueOnce(
      new Error("transient apply failure"),
    );
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(reserveMock.reserve).toHaveBeenCalledTimes(1);
    expect(readingMock.reading).not.toHaveBeenCalled();

    // Displaced by a newer head: no claim, and the guard answers settled.
    readingMock.reading.mockReturnValue(false);
    settledMock.settled.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    expect(readingMock.reading).toHaveBeenCalledTimes(1);
    expect(reserveMock.reserve).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("a retry whose claim still stands reserves the fence and reads again", async () => {
    vi.useFakeTimers();
    readMock.read
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValueOnce({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(reserveMock.reserve).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readingMock.reading).toHaveBeenCalledTimes(1);
    expect(readingMock.reading).toHaveBeenCalledWith(row);
    expect(reserveMock.reserve).toHaveBeenCalledTimes(2);
    expect(readMock.read).toHaveBeenCalledTimes(2);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(claimMock.abandon).not.toHaveBeenCalled();
  });

  it("a retry whose claim was dropped with nobody holding the head claims it again and reads", async () => {
    vi.useFakeTimers();
    readMock.read
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValueOnce({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(reserveMock.reserve).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(1);

    // The claim was dropped under this mount (a torn-down mount's apply
    // released the row by digest) and nothing replaced it: not reading, and
    // not settled either, since no newer record displaced it.
    readingMock.reading.mockReturnValue(false);
    settledMock.settled.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readingMock.reading).toHaveBeenCalledTimes(1);
    expect(readingMock.reading).toHaveBeenCalledWith(row);
    expect(claimMock.begin).toHaveBeenCalledTimes(2);
    expect(claimMock.begin).toHaveBeenNthCalledWith(1, row);
    expect(claimMock.begin).toHaveBeenNthCalledWith(2, row);
    expect(reserveMock.reserve).toHaveBeenCalledTimes(2);
    expect(readMock.read).toHaveBeenCalledTimes(2);
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a retry of a failed apply whose claim was dropped claims the head again", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest
      .mockRejectedValueOnce(new Error("transient apply failure"))
      .mockResolvedValueOnce(undefined);
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).toHaveBeenCalledTimes(1);

    // Dropped with nobody holding the head: not reading, not settled.
    readingMock.reading.mockReturnValue(false);
    settledMock.settled.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
    expect(claimMock.begin).toHaveBeenCalledTimes(2);
    expect(claimMock.begin).toHaveBeenNthCalledWith(2, row);
    expect(reserveMock.reserve).toHaveBeenCalledTimes(2);
    expect(readMock.read).toHaveBeenCalledTimes(2);
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("calls sweepAbsentCloudDraftMirrors once with every directory row's ids - foreign and own-host - and the directory's snapshot seq, when the directory is settled, and only head-ingests the foreign row", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.settled = true;
    directoryMock.snapshotSeq = 7;
    const ownHostSummary = summary(DIGEST_TWO, {
      identity: {
        taskId: "scp_1",
        chatId: "draft-2",
        ownerUserId: "user-1",
      },
      ownerHostId: HOST_ID,
    });
    directoryMock.chats = [summary(DIGEST_ONE, null), ownHostSummary];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(sweepMock.sweep).toHaveBeenCalledTimes(1);
    });
    expect(sweepMock.sweep).toHaveBeenCalledWith(
      HOST_ID,
      new Map([
        ["draft-1", new Set([OWNER_HOST_ID])],
        ["draft-2", new Set([HOST_ID])],
      ]),
      7,
    );
    // Only the foreign row (owned by another host) is head-ingested; the
    // own-host row is already live via `drafts.subscribe`.
    expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
  });

  it("nudges absent own rows with a flush once per settled snapshot, excluding ids already nudged for it", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.settled = true;
    directoryMock.snapshotSeq = 7;
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    flushMock.flush.mockReturnValueOnce(["own-absent"]);

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(flushMock.flush).toHaveBeenCalledTimes(1);
    });
    const [listed, fenceSeq, excluded] = flushMock.flush.mock.calls[0];
    expect([...listed.keys()]).toEqual(["draft-1"]);
    expect(fenceSeq).toBe(7);
    expect(excluded.size).toBe(0);

    // The same snapshot read again (a new array reference, same fence):
    // the id already nudged is excluded rather than flushed twice.
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();
    await vi.waitFor(() => {
      expect(flushMock.flush).toHaveBeenCalledTimes(2);
    });
    expect([...flushMock.flush.mock.calls[1][2]]).toEqual(["own-absent"]);

    // A new snapshot starts over.
    directoryMock.snapshotSeq = 8;
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();
    await vi.waitFor(() => {
      expect(flushMock.flush).toHaveBeenCalledTimes(3);
    });
    expect(flushMock.flush.mock.calls[2][1]).toBe(8);
    expect(flushMock.flush.mock.calls[2][2].size).toBe(0);
  });

  it("does not nudge own rows while the directory is unsettled", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.settled = false;
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(flushMock.flush).not.toHaveBeenCalled();
  });

  it("does not call sweepAbsentCloudDraftMirrors while the directory is unsettled", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.settled = false;
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(sweepMock.sweep).not.toHaveBeenCalled();
  });

  it("re-attempts ingest for the same head after a rejected ingest, on the next effect run", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockRejectedValueOnce(new Error("ingest failed"));
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });

    ingestMock.ingest.mockResolvedValueOnce(undefined);
    // Same head, new array reference (an equal-by-value array with a
    // different identity) so the effect re-runs.
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
  });

  it("ingests the happy path exactly once per head across rerenders, with the host id, summary and document", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    const [ingestArgs] = ingestMock.ingest.mock.calls[0];
    expect(ingestArgs.hostId).toBe(HOST_ID);
    expect(ingestArgs.summary.headSha256).toBe(DIGEST_ONE);
    expect(ingestArgs.document).toBeDefined();

    // From here the coordinator answers as it does in production: the head
    // is settled, and that settled record is what stops the re-read. Same
    // head, new array reference each time, so no further ingest calls
    // should happen.
    settledMock.settled.mockReturnValue(true);
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
  });

  it("retries a rejected ingest via the same backoff, then succeeds without warning on the first failure", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest
      .mockRejectedValueOnce(new Error("transient apply failure"))
      .mockResolvedValueOnce(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    // The first ingest rejects. Let that promise settle so the catch block
    // arms the retry timer before the clock moves.
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();

    // Backoff for attempt 0: HEAD_READ_RETRY_BASE_MS * 2 ** 0 = 2s. The
    // retry re-reads the head before calling ingest again.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("releases the key when teardown interrupts a failing apply, so the next setup asks again", async () => {
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    const pending: Array<() => void> = [];
    ingestMock.ingest
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            pending.push(() => {
              reject(new Error("apply failed after teardown"));
            });
          }),
      )
      .mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(
      ({ client }) => useCloudDraftsIngest(client, HOST_ID),
      { initialProps: { client: CLIENT as never } },
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });

    // A new client instance re-runs the effect: the old scope is torn down
    // while its apply is still in flight, and that apply then rejects.
    view.rerender({ client: { ...CLIENT } as never });
    for (const reject of pending) reject();

    // The torn-down chain must have released the key, so the fresh setup
    // ingests the same head again instead of skipping it.
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("clears a pending retry timer on unmount, so it never fires a read", async () => {
    vi.useFakeTimers();
    readMock.read.mockRejectedValue(new Error("transient read failure"));
    directoryMock.chats = [summary(DIGEST_ONE, null)];

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

  it("reserves the sweep fence for a foreign row with a head before the settled sweep runs, and the ingest fence only once its read starts", async () => {
    const order: string[] = [];
    sweepFenceMock.reserve.mockImplementation(() => {
      order.push("sweep-fence");
    });
    reserveMock.reserve.mockImplementation(() => {
      order.push("ingest-fence");
    });
    sweepMock.sweep.mockImplementation(() => {
      order.push("sweep");
      return [];
    });
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(sweepMock.sweep).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(reserveMock.reserve).toHaveBeenCalledTimes(1);
    });
    // The pre-sweep reserve (over every foreign row with a head) is the SWEEP
    // fence and happens before the settled sweep runs, on the first effect
    // run. The ingest fence follows, when the head read starts.
    const firstSweepFence = order.indexOf("sweep-fence");
    const firstSweep = order.indexOf("sweep");
    const firstIngestFence = order.indexOf("ingest-fence");
    expect(firstSweepFence).toBeGreaterThanOrEqual(0);
    expect(firstSweep).toBeGreaterThanOrEqual(0);
    expect(firstSweepFence).toBeLessThan(firstSweep);
    expect(firstIngestFence).toBeGreaterThan(firstSweep);
    expect(sweepFenceMock.reserve).toHaveBeenCalledTimes(1);
  });

  it("reserves the sweep fence for an own-host row with a head too, without reading, claiming or ingesting it", async () => {
    const order: string[] = [];
    sweepFenceMock.reserve.mockImplementation(() => {
      order.push("sweep-fence");
    });
    sweepMock.sweep.mockImplementation(() => {
      order.push("sweep");
      return [];
    });
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    // The row this mount's own host owns: never read through this mount's
    // pipe, but listed here, so another host's older absence sweep must find
    // it fenced.
    directoryMock.snapshotSeq = 6;
    directoryMock.chats = [summary(DIGEST_ONE, { ownerHostId: HOST_ID })];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(sweepMock.sweep).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sweepFenceMock.reserve).toHaveBeenCalledTimes(1);
    expect(sweepFenceMock.reserve).toHaveBeenCalledWith("draft-1", HOST_ID, 6);
    // Fenced before the settled sweep, as a foreign row is.
    expect(order).toEqual(["sweep-fence", "sweep"]);
    // Fenced, not read: no ingest fence, no claim, no read, no ingest.
    expect(reserveMock.reserve).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(readMock.read).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("a fresh mount reads nothing for a head the coordinator has settled: no read, no claim, no ingest, but the head is still sweep-fenced and never ingest-fenced", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    settledMock.settled.mockReturnValue(true);
    directoryMock.snapshotSeq = 4;
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    // A second mount of the hook (a new tab) holds no memory of its own; the
    // coordinator's record is the only memory, and it is what stops the
    // fan-out.
    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settledMock.settled).toHaveBeenCalled();
    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
    // One pre-sweep SWEEP-fence reserve per mount: the fence is taken for a
    // listed head whether or not this mount reads it. The ingest fence is
    // the apply's supersession check, so a head this mount does not read
    // never takes it - that would abandon another mount's apply of the row.
    expect(sweepFenceMock.reserve).toHaveBeenCalledTimes(2);
    expect(sweepFenceMock.reserve).toHaveBeenCalledWith(
      "draft-1",
      OWNER_HOST_ID,
      4,
    );
    expect(reserveMock.reserve).not.toHaveBeenCalled();
  });

  it("fences a skipped head without reading or claiming it, so the reader's apply never meets a replica this mount's sweep dropped", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    // A head under read by another mount is settled as far as the guard is
    // concerned (the coordinator answers true for both).
    settledMock.settled.mockReturnValue(true);
    directoryMock.snapshotSeq = 3;
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await new Promise((resolve) => setTimeout(resolve, 0));
    // Sweep-fenced once, pre-sweep. Nothing else is done with the row; in
    // particular a skipped head never reserves the INGEST fence, which is
    // also the apply's supersession check.
    expect(sweepFenceMock.reserve).toHaveBeenCalledTimes(1);
    expect(sweepFenceMock.reserve).toHaveBeenCalledWith(
      "draft-1",
      OWNER_HOST_ID,
      3,
    );
    expect(reserveMock.reserve).not.toHaveBeenCalled();
    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("registers this host as a row host for a skipped head and, at read start, for a head it reads, each with the hook's host id", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    const skipped = summary(DIGEST_ONE, null);
    const read = summary(DIGEST_TWO, {
      identity: {
        taskId: "scp_1",
        chatId: "draft-2",
        ownerUserId: "user-1",
      },
    });
    settledMock.settled.mockImplementation(
      (candidate) => candidate === skipped,
    );
    directoryMock.chats = [skipped, read];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(ingestMock.ingest.mock.calls[0][0].summary).toBe(read);
    // The skipped head is noted by the skip path; the head it reads is noted
    // once, by the read's own start (see the read-start test below).
    expect(noteHostMock.note).toHaveBeenCalledTimes(2);
    expect(noteHostMock.note).toHaveBeenCalledWith(skipped, HOST_ID);
    expect(noteHostMock.note).toHaveBeenCalledWith(read, HOST_ID);
    expect(
      noteHostMock.note.mock.calls.filter((call) => call[0] === skipped),
    ).toHaveLength(1);
    expect(
      noteHostMock.note.mock.calls.filter((call) => call[0] === read),
    ).toHaveLength(1);
  });

  it("notes the reading host as a row host when its read starts, before the read decides", async () => {
    const order: string[] = [];
    claimMock.begin.mockImplementation(() => {
      order.push("begin");
    });
    noteHostMock.note.mockImplementation(() => {
      order.push("note");
    });
    readMock.read.mockImplementation(() => {
      order.push("read");
      // Never resolves: the host must already be noted while the read is pending.
      return new Promise(() => {});
    });
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(1);
    });
    // Noted right after the claim begins and before the read starts, and the
    // read has decided nothing: no settle, no release, no ingest.
    expect(order).toEqual(["begin", "note", "read"]);
    expect(noteHostMock.note).toHaveBeenCalledTimes(1);
    expect(noteHostMock.note).toHaveBeenCalledWith(row, HOST_ID);
    expect(noteHostMock.note.mock.calls[0][0]).toBe(row);
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("a settled head is still swept and nudged like any listed row; only the read is skipped", async () => {
    settledMock.settled.mockReturnValue(true);
    directoryMock.settled = true;
    directoryMock.snapshotSeq = 7;
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sweepMock.sweep).toHaveBeenCalledTimes(1);
    const [, listed, fenceSeq] = sweepMock.sweep.mock.calls[0];
    expect(fenceSeq).toBe(7);
    expect(listed.get("draft-1")).toEqual(new Set([OWNER_HOST_ID]));
    expect(flushMock.flush).toHaveBeenCalledTimes(1);
    expect(readMock.read).not.toHaveBeenCalled();
  });

  it("reads a head again once the coordinator no longer reports it settled (its mirror left the store)", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    settledMock.settled.mockReturnValue(true);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readMock.read).not.toHaveBeenCalled();

    settledMock.settled.mockReturnValue(false);
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
  });

  it("releases the guard for a chat the sweep drops, so a later listing re-ingests its head", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    sweepMock.sweep.mockReturnValue([]);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);

    // The sweep reports draft-1's mirror dropped on this run - the
    // directory listing is unchanged (same head), only the sweep verdict
    // differs.
    sweepMock.sweep.mockReturnValue(["draft-1"]);
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    // A further rerender with the same summary: the guard entry for
    // draft-1 was released by the drop above, so this head - previously
    // skipped by the guard - is read and ingested again rather than
    // silently staying stuck on the old apply. (The drop-triggered read on
    // the prior rerender never resolves before this one tears it down, so
    // it counts as a `readMock.read` call but never reaches ingest - it is
    // the fresh attempt started on THIS rerender that ingests.)
    sweepMock.sweep.mockReturnValue([]);
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
    expect(readMock.read).toHaveBeenCalledTimes(3);
  });

  it("neither reads, fences nor claims a row that has no head yet, while still reading the rows beside it", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    const headless = summary(null, null);
    const published = summary(DIGEST_ONE, {
      identity: {
        taskId: "scp_1",
        chatId: "draft-2",
        ownerUserId: "user-1",
      },
    });
    directoryMock.chats = [headless, published];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    // Only the published row was read, claimed and fenced (both fences).
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(claimMock.begin).toHaveBeenCalledWith(published);
    expect(claimMock.begin).not.toHaveBeenCalledWith(headless);
    expect(reserveMock.reserve).not.toHaveBeenCalledWith("draft-1");
    expect(reserveMock.reserve).toHaveBeenCalledWith("draft-2");
    expect(sweepFenceMock.reserve).not.toHaveBeenCalledWith(
      "draft-1",
      OWNER_HOST_ID,
      expect.any(Number),
    );
    expect(sweepFenceMock.reserve).toHaveBeenCalledWith(
      "draft-2",
      OWNER_HOST_ID,
      0,
    );
    expect(ingestMock.ingest.mock.calls[0][0].summary).toBe(published);
  });

  it("does nothing at all for a lone row that has no head yet", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    directoryMock.chats = [summary(null, null)];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readMock.read).not.toHaveBeenCalled();
    expect(reserveMock.reserve).not.toHaveBeenCalled();
    expect(sweepFenceMock.reserve).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("claims the head with the coordinator before its read starts", async () => {
    const order: string[] = [];
    claimMock.begin.mockImplementation(() => {
      order.push("begin");
    });
    readMock.read.mockImplementation(() => {
      order.push("read");
      // Never resolves: the claim must already stand while the read is pending.
      return new Promise(() => {});
    });
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(1);
    });
    expect(order).toEqual(["begin", "read"]);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(claimMock.begin).toHaveBeenCalledWith(row);
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
  });

  it("settles a head whose read answers a terminal refusal, without a retry or an ingest", async () => {
    vi.useFakeTimers();
    readMock.read.mockResolvedValue({ kind: "unpublished", record: null });
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));

    await vi.waitFor(() => {
      expect(claimMock.settleWithoutApply).toHaveBeenCalledTimes(1);
    });
    expect(claimMock.settleWithoutApply).toHaveBeenCalledWith(row);
    expect(vi.getTimerCount()).toBe(0);
    // The reading host is a row host although the head settled without an
    // install: it was noted when the read started, once.
    expect(noteHostMock.note).toHaveBeenCalledTimes(1);
    expect(noteHostMock.note).toHaveBeenCalledWith(row, HOST_ID);

    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).not.toHaveBeenCalled();
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(noteHostMock.note).toHaveBeenCalledTimes(1);
  });

  it("releases silently, and does not settle or abandon, a head whose read answers an ambiguous identity, then asks again at the next delivery", async () => {
    vi.useFakeTimers();
    readMock.read.mockResolvedValue({
      kind: "ambiguous-identity",
      record: null,
    });
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );

    await vi.waitFor(() => {
      expect(claimMock.release).toHaveBeenCalledTimes(1);
    });
    // Released silently: no abandon (so no wake of the mounts that skipped
    // the head), no settle, no retry, no ingest.
    expect(claimMock.release).toHaveBeenCalledWith(row);
    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // The release does not take the host back: it was noted when the read
    // started, and stays a row host of the head.
    expect(noteHostMock.note).toHaveBeenCalledTimes(1);
    expect(noteHostMock.note).toHaveBeenCalledWith(row, HOST_ID);

    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(ingestMock.ingest).not.toHaveBeenCalled();
    expect(claimMock.release).toHaveBeenCalledTimes(1);
    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();

    // The mount's own key went with the claim: the next delivery of the
    // directory re-runs the effect, and this mount reads the head AGAIN
    // (the guard no longer holds it).
    directoryMock.snapshotSeq = 1;
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();
    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(2);
    });
    expect(claimMock.begin).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(claimMock.release).toHaveBeenCalledTimes(2);
    });
    // Each read noted its host as it started.
    expect(noteHostMock.note).toHaveBeenCalledTimes(2);
    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("abandons, rather than releases, the coordinator's claim when the effect is torn down with a read still pending, after unsubscribing", async () => {
    readMock.read.mockImplementation(() => new Promise(() => {}));
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(readMock.read).toHaveBeenCalledTimes(1);
    });
    expect(claimMock.begin).toHaveBeenCalledWith(row);
    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(abandonSubscriptionMock.unsubscribe).not.toHaveBeenCalled();

    view.unmount();

    expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    expect(claimMock.abandon).toHaveBeenCalledWith(row, "released");
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
    // Unsubscribed FIRST: the abandon this teardown issues must not reach the
    // listener of the very mount that is going away.
    expect(abandonSubscriptionMock.unsubscribe).toHaveBeenCalledTimes(1);
    expect(
      abandonSubscriptionMock.unsubscribe.mock.invocationCallOrder[0],
    ).toBeLessThan(claimMock.abandon.mock.invocationCallOrder[0]);
  });

  it("does not abandon a head whose read already decided before the teardown", async () => {
    readMock.read.mockResolvedValue({ kind: "unpublished", record: null });
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(claimMock.settleWithoutApply).toHaveBeenCalledTimes(1);
    });

    view.unmount();

    expect(claimMock.abandon).not.toHaveBeenCalled();
    expect(claimMock.release).not.toHaveBeenCalled();
  });

  it("subscribes to abandoned heads once per effect run and unsubscribes on every teardown", async () => {
    settledMock.settled.mockReturnValue(true);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(1);
    });
    expect(abandonSubscriptionMock.unsubscribe).not.toHaveBeenCalled();

    // A new directory delivery re-runs the effect: the old subscription ends
    // with the old run, and one new one replaces it.
    directoryMock.chats = [summary(DIGEST_ONE, null)];
    view.rerender();
    expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(2);
    expect(abandonSubscriptionMock.unsubscribe).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(abandonSubscriptionMock.unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("starts exactly one read for an abandoned head this mount skipped and the guard no longer holds", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    // Another mount holds the head, so this mount skips it at setup.
    settledMock.settled.mockReturnValue(true);
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
    await vi.waitFor(() => {
      expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();

    // The holder is torn down: the claim is gone, and the coordinator names
    // the head. An equal-by-value copy, as the coordinator's own summary is a
    // different object from this mount's directory row.
    settledMock.settled.mockReturnValue(false);
    deliverAbandon({ ...row }, "released");

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    // The row it reads is this mount's own listing, not the abandoned copy.
    expect(claimMock.begin.mock.calls[0][0]).toBe(row);
    expect(ingestMock.ingest.mock.calls[0][0].summary).toBe(row);

    // The same abandon delivered again: the coordinator holds this mount's
    // own claim and settlement now, and answers as it does in production.
    settledMock.settled.mockReturnValue(true);
    deliverAbandon({ ...row }, "released");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readMock.read).toHaveBeenCalledTimes(1);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
  });

  it("starts no read for an abandoned head the directory does not list under the same key", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    settledMock.settled.mockReturnValue(true);
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
    await vi.waitFor(() => {
      expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(1);
    });
    settledMock.settled.mockReturnValue(false);

    // Another row, another head of the same row, another owner of the same id.
    deliverAbandon(
      summary(DIGEST_ONE, {
        identity: { taskId: "scp_1", chatId: "draft-9", ownerUserId: "user-1" },
      }),
      "released",
    );
    deliverAbandon(summary(DIGEST_TWO, null), "released");
    deliverAbandon(summary(DIGEST_ONE, { ownerHostId: "host-c" }), "released");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("starts no read for an abandoned head the guard still skips because something else holds it", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    settledMock.settled.mockReturnValue(true);
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
    await vi.waitFor(() => {
      expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(1);
    });

    // A third mount claimed the head first: the guard is asked again at the
    // abandon, and still answers settled.
    deliverAbandon({ ...row }, "released");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("starts no read for an abandoned head once the mount is gone, even if the old listener is still invoked", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    settledMock.settled.mockReturnValue(true);
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(abandonSubscriptionMock.subscribe).toHaveBeenCalledTimes(1);
    });
    // The reference a coordinator that notified from a snapshot taken before
    // the unsubscribe would still hold.
    const staleListener = abandonSubscriptionMock.listener;
    if (staleListener === null) throw new Error("the hook never subscribed");

    view.unmount();
    expect(abandonSubscriptionMock.unsubscribe).toHaveBeenCalledTimes(1);

    settledMock.settled.mockReturnValue(false);
    staleListener({ ...row }, "released");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readMock.read).not.toHaveBeenCalled();
    expect(claimMock.begin).not.toHaveBeenCalled();
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });

  it("abandons the coordinator's claim once, at the end, when every attempt of a head read throws, and starts no read of its own when the abandon wakes it", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockRejectedValue(new Error("persistent read failure"));
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];
    // The real coordinator tells every subscriber, this mount's included, and
    // answers "not held" once the claim is gone (the default of the settled
    // mock): without the hook's own exhausted-key check this wake would start
    // a fourth read.
    claimMock.abandon.mockImplementation((abandoned, cause) => {
      deliverAbandon({ ...abandoned }, cause);
    });

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );

    // Attempt 0 fails and arms the first retry; the claim stands through it.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(claimMock.abandon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);

    // Attempt 1 fails and arms the second retry (doubled); still claimed.
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(2);
    expect(claimMock.abandon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);

    // Attempt 2 is the last: it gives up and abandons.
    await vi.waitFor(() => {
      expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(claimMock.abandon).toHaveBeenCalledWith(row, "exhausted");
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(claimMock.settleWithoutApply).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // The wake the abandon delivered to this very mount started nothing: no
    // new claim, no fourth read, no timer, however long it waits.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);
    expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    expect(claimMock.release).not.toHaveBeenCalled();

    // The exhausted head is no longer this mount's to abandon when it goes.
    view.unmount();
    expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("abandons the coordinator's claim once, at the end, when every attempt of an apply throws, and starts no read of its own when the abandon wakes it", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockRejectedValue(new Error("persistent apply failure"));
    const row = summary(DIGEST_ONE, null);
    directoryMock.chats = [row];
    claimMock.abandon.mockImplementation((abandoned, cause) => {
      deliverAbandon({ ...abandoned }, cause);
    });

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );

    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(claimMock.abandon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(claimMock.abandon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);

    await vi.waitFor(() => {
      expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    });
    expect(ingestMock.ingest).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(claimMock.abandon).toHaveBeenCalledWith(row, "exhausted");
    expect(claimMock.release).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // No fourth read or apply from the wake the abandon delivered here.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(ingestMock.ingest).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);

    view.unmount();
    expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    expect(claimMock.release).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("ignores the abandon wake only for the head it exhausted this run: another head's abandon still starts a read", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockRejectedValue(new Error("persistent read failure"));
    const exhausted = summary(DIGEST_ONE, null);
    const skipped = summary(DIGEST_TWO, {
      identity: {
        taskId: "scp_1",
        chatId: "draft-2",
        ownerUserId: "user-1",
      },
    });
    // The second row is held by another mount at setup, and free afterwards.
    settledMock.settled.mockImplementation(
      (candidate) => candidate === skipped,
    );
    directoryMock.chats = [exhausted, skipped];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);
    await vi.waitFor(() => {
      expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);

    // The exhausted head's wake is ignored; the skipped head's is not.
    settledMock.settled.mockReturnValue(false);
    deliverAbandon({ ...exhausted }, "exhausted");
    await vi.advanceTimersByTimeAsync(0);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);

    deliverAbandon({ ...skipped }, "exhausted");
    await vi.advanceTimersByTimeAsync(0);
    expect(claimMock.begin).toHaveBeenCalledTimes(2);
    expect(claimMock.begin.mock.calls[1][0]).toBe(skipped);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS + 1);
    warnSpy.mockRestore();
  });

  it("ignores an exhausted wake for a later publication while it lists the earlier one it exhausted, takes it once a delivery lists the later one, and still ignores its own", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockRejectedValue(new Error("persistent read failure"));
    const exhausted = summary(DIGEST_ONE, { publishedAt: 5 });
    directoryMock.chats = [exhausted];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);
    await vi.waitFor(() => {
      expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);

    // The coordinator answers: not held, not being read. The wake for the
    // publication this run exhausted is ignored.
    settledMock.settled.mockReturnValue(false);
    deliverAbandon({ ...exhausted }, "exhausted");
    await vi.advanceTimersByTimeAsync(0);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);

    // (1) Another mount abandons the same digest at a LATER publication, but
    // this run still lists the earlier one (5) and has exhausted it: the wake
    // is looked up by THIS run's listing, so it is ignored. Two mounts that
    // list different publications of one digest must not trade the head.
    deliverAbandon({ ...exhausted, publishedAt: 9 }, "exhausted");
    await vi.advanceTimersByTimeAsync(0);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);

    // (2) A delivery now lists the later publication. The effect re-runs
    // with a fresh `exhaustedKeys`; another mount holds the head, so this
    // run skips it.
    settledMock.settled.mockReturnValue(true);
    const later = summary(DIGEST_ONE, { publishedAt: 9 });
    directoryMock.snapshotSeq = 1;
    directoryMock.chats = [later];
    view.rerender();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);

    // That mount then gives the head up as exhausted: the wake is taken, and
    // exactly one read starts, on this run's own listing of the later
    // publication.
    settledMock.settled.mockReturnValue(false);
    deliverAbandon({ ...later }, "exhausted");
    await vi.advanceTimersByTimeAsync(0);
    expect(claimMock.begin).toHaveBeenCalledTimes(2);
    expect(claimMock.begin.mock.calls[1][0]).toBe(later);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS + 1);
    warnSpy.mockRestore();
  });

  it("takes a released wake for a publication it exhausted, and still ignores an exhausted one", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    readMock.read.mockRejectedValue(new Error("persistent read failure"));
    const exhausted = summary(DIGEST_ONE, { publishedAt: 5 });
    directoryMock.chats = [exhausted];

    renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);
    await vi.waitFor(() => {
      expect(vi.getTimerCount()).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);
    await vi.waitFor(() => {
      expect(claimMock.abandon).toHaveBeenCalledTimes(1);
    });
    expect(claimMock.abandon).toHaveBeenCalledWith(exhausted, "exhausted");
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // The coordinator answers: not held, not being read. An exhaustion wake
    // for the very publication this run gave up on (a sibling that ran out of
    // attempts on it too) starts nothing, so two failing mounts do not trade
    // the head at the ladder's pace.
    settledMock.settled.mockReturnValue(false);
    deliverAbandon({ ...exhausted }, "exhausted");
    await vi.advanceTimersByTimeAsync(0);
    expect(claimMock.begin).toHaveBeenCalledTimes(1);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS);

    // A RELEASE wake for the same publication is taken: the sibling that took
    // the head over was torn down with it undecided. Exactly one read starts,
    // on this mount's own listing, and the same wake again finds it held.
    deliverAbandon({ ...exhausted }, "released");
    await vi.advanceTimersByTimeAsync(0);
    expect(claimMock.begin).toHaveBeenCalledTimes(2);
    expect(claimMock.begin.mock.calls[1][0]).toBe(exhausted);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS + 1);

    settledMock.settled.mockReturnValue(true);
    deliverAbandon({ ...exhausted }, "released");
    await vi.advanceTimersByTimeAsync(0);
    expect(claimMock.begin).toHaveBeenCalledTimes(2);
    expect(readMock.read).toHaveBeenCalledTimes(MAX_HEAD_READ_ATTEMPTS + 1);
    warnSpy.mockRestore();
  });

  it("asks the coordinator about a head this mount already ingested when the same digest is listed at a later publication time, and reads it again when the coordinator no longer holds it", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    const first = summary(DIGEST_ONE, null);
    directoryMock.chats = [first];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    expect(settledMock.settled).toHaveBeenCalledWith(first);
    settledMock.settled.mockClear();
    noteHostMock.note.mockClear();

    // The same identity and digest listed again at a later publication time:
    // the coordinator is asked, and it answers false (it forgot the head), so
    // the head is read again; this mount keeps no vote of its own.
    const republished = summary(DIGEST_ONE, { publishedAt: 9 });
    directoryMock.chats = [republished];
    view.rerender();

    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(2);
    });
    expect(settledMock.settled).toHaveBeenCalledTimes(1);
    expect(settledMock.settled).toHaveBeenCalledWith(republished);
    expect(settledMock.settled.mock.calls[0][0]).toBe(republished);
    expect(readMock.read).toHaveBeenCalledTimes(2);
    expect(claimMock.begin).toHaveBeenCalledTimes(2);
    expect(claimMock.begin.mock.calls[1][0]).toBe(republished);
    // Read, not skipped: the only note is the republished head's read start,
    // not a skip-path note.
    expect(noteHostMock.note).toHaveBeenCalledTimes(1);
    expect(noteHostMock.note).toHaveBeenCalledWith(republished, HOST_ID);
    expect(noteHostMock.note.mock.calls[0][0]).toBe(republished);
  });

  it("reads a head this mount already ingested again whenever the coordinator no longer holds it, at the same, an earlier or a null publication time", async () => {
    readMock.read.mockResolvedValue({ kind: "ok", record: HEAD });
    ingestMock.ingest.mockResolvedValue(undefined);
    directoryMock.chats = [summary(DIGEST_ONE, null)];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(ingestMock.ingest).toHaveBeenCalledTimes(1);
    });
    settledMock.settled.mockClear();
    noteHostMock.note.mockClear();

    const listings = [
      summary(DIGEST_ONE, { publishedAt: 1 }),
      summary(DIGEST_ONE, { publishedAt: 0 }),
      summary(DIGEST_ONE, { publishedAt: null }),
    ];
    // The coordinator is the only memory: this mount ingested the head once,
    // but the coordinator no longer holds it (settled answers false), so
    // every listing is read again, whatever its publication time.
    let expectedReads = 1;
    for (const listing of listings) {
      noteHostMock.note.mockClear();
      directoryMock.chats = [listing];
      view.rerender();
      expectedReads += 1;

      await vi.waitFor(() => {
        expect(ingestMock.ingest).toHaveBeenCalledTimes(expectedReads);
      });
      // The only note is this listing's read start.
      expect(noteHostMock.note).toHaveBeenCalledTimes(1);
      expect(noteHostMock.note).toHaveBeenCalledWith(listing, HOST_ID);
      expect(readMock.read).toHaveBeenCalledTimes(expectedReads);
      expect(claimMock.begin).toHaveBeenCalledTimes(expectedReads);
    }
  });

  it("a sole mount that was refused a head reads the same digest again when it is republished later, and the coordinator is asked first", async () => {
    readMock.read.mockResolvedValue({ kind: "unpublished", record: null });
    const first = summary(DIGEST_ONE, { publishedAt: 5 });
    directoryMock.chats = [first];

    const view = renderHook(() =>
      useCloudDraftsIngest(CLIENT as never, HOST_ID),
    );
    await vi.waitFor(() => {
      expect(claimMock.settleWithoutApply).toHaveBeenCalledTimes(1);
    });
    expect(readMock.read).toHaveBeenCalledTimes(1);
    settledMock.settled.mockClear();

    const republished = summary(DIGEST_ONE, { publishedAt: 9 });
    directoryMock.chats = [republished];
    view.rerender();

    await vi.waitFor(() => {
      expect(claimMock.settleWithoutApply).toHaveBeenCalledTimes(2);
    });
    expect(settledMock.settled).toHaveBeenCalledWith(republished);
    expect(readMock.read).toHaveBeenCalledTimes(2);
    expect(claimMock.begin).toHaveBeenCalledTimes(2);
    expect(claimMock.begin.mock.calls[1][0]).toBe(republished);
    expect(claimMock.settleWithoutApply.mock.calls[1][0]).toBe(republished);
    expect(ingestMock.ingest).not.toHaveBeenCalled();
  });
});

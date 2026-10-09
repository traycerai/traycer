import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { DraftHeadReaderRecord } from "@traycer/protocol/persistence/draft/schemas";
import { DRAFT_HEAD_DIALECT } from "@traycer/protocol/persistence/draft/version";
import type { CloudDraftReadOutcome } from "@/lib/drafts/cloud-draft-reader";
import {
  cloudDraftHeadReading,
  cloudDraftHeadSettled,
  resetDraftMirrorCoordinatorForTests,
  sweepAbsentCloudDraftMirrors,
} from "@/lib/drafts/draft-mirror-coordinator";
import { resetLandingDraftRetirementsForTests } from "@/lib/drafts/landing-draft-retirement";
import { appLogger } from "@/lib/logger";
import {
  emptyLandingDraftWorkspaceSnapshot,
  freshLandingMirrorState,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";

// The real coordinator, the real hook, the real landing store. Only the read
// side is faked: the directory the hook walks, the host read port, and the
// head read itself, whose promise each test settles by hand.
const directoryMock = vi.hoisted(() => ({
  chats: [] as ReadonlyArray<CloudChatSummary>,
  // The directory snapshot's dispatch position the hook stamps its sweep
  // fences at.
  fenceSeq: 0,
}));
const readMock = vi.hoisted(() => ({
  pending: [] as Array<{
    chatId: string;
    // The host client the read went out on: each mount's port wraps its own,
    // so a test can say WHICH mount issued a read.
    client: object;
    resolve: (outcome: CloudDraftReadOutcome) => void;
    reject: (error: Error) => void;
  }>,
}));

vi.mock("@/hooks/drafts/use-cloud-drafts-directory", () => ({
  useCloudDraftsDirectory: () => ({
    visible: true,
    settled: true,
    scopeId: "scp_1",
    chats: directoryMock.chats,
    snapshotIngestSeq: (): number => directoryMock.fenceSeq,
  }),
}));
vi.mock("@/lib/chats/cloud-chat-read-port", () => ({
  createHostCloudChatReadPort: (client: object): { client: object } => ({
    client,
  }),
}));
vi.mock("@/lib/drafts/cloud-draft-reader", () => ({
  readCloudDraft: (options: {
    identity: { chatId: string };
    port: { client: object };
  }): Promise<CloudDraftReadOutcome> =>
    new Promise((resolve, reject) => {
      readMock.pending.push({
        chatId: options.identity.chatId,
        client: options.port.client,
        resolve,
        reject,
      });
    }),
}));

const { useCloudDraftsIngest } =
  await import("@/hooks/drafts/use-cloud-drafts-ingest");

const HOST_ID = "host-a";
const SECOND_HOST_ID = "host-c";
const OWNER_HOST_ID = "host-b";
const HEAD_SHA = "a".repeat(64);
// Mirrors the retry constants in use-cloud-drafts-ingest.ts, which are not
// exported: keep in sync if the production values change.
const HEAD_READ_RETRY_BASE_MS = 2_000;

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

// The hook only needs a non-null client: the read port and the reader are
// mocked above.
const CLIENT = { request: () => Promise.reject(new Error("unused")) };
// A second mount bound to another host reads through its own client.
const SECOND_CLIENT = { request: () => Promise.reject(new Error("unused")) };

function row(chatId: string): CloudChatSummary {
  return {
    identity: { taskId: "scp_1", chatId, ownerUserId: "user-1" },
    ownerHostId: OWNER_HOST_ID,
    createdAt: 1,
    visibility: "private",
    title: null,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 1,
    headSha256: HEAD_SHA,
    publishedAt: 1,
    throughRecordSeq: 1,
    isOwnedByViewer: true,
  };
}

interface MountedHook {
  readonly unmount: () => void;
  /** One more directory delivery to this mount: the effect runs again. */
  readonly rerender: () => void;
}

function mount(): MountedHook {
  return renderHook(() => useCloudDraftsIngest(CLIENT as never, HOST_ID));
}

/** A mount bound to another host than `mount()`'s, with its own client. */
function mountOnSecondHost(): MountedHook {
  return renderHook(() =>
    useCloudDraftsIngest(SECOND_CLIENT as never, SECOND_HOST_ID),
  );
}

/** A clean replica of a cloud row the directory lists under `OWNER_HOST_ID`. */
function replicaMirror(id: string): LandingDraftTab {
  return {
    id,
    content: EMPTY_LANDING_DRAFT_CONTENT,
    selection: null,
    lastTouchedAt: 1,
    settings: null,
    composerMode: "chat",
    workspace: emptyLandingDraftWorkspaceSnapshot(),
    ...freshLandingMirrorState(),
    adoption: { state: "adopted", hostId: OWNER_HOST_ID },
    ownerHostId: OWNER_HOST_ID,
    origin: "replica",
    hostRevision: 1,
    publication: {
      status: "current",
      lastPublishedAt: 1,
      publishedRevision: 1,
      halted: null,
    },
  };
}

function landingIds(): readonly string[] {
  return useLandingDraftStore
    .getState()
    .drafts.map((draft) => draft.id)
    .toSorted();
}

function resolveAll(outcome: CloudDraftReadOutcome): void {
  for (const pending of readMock.pending) pending.resolve(outcome);
}

/** The reads issued for one draft so far, in the order they were issued. */
function readsFor(
  chatId: string,
): readonly (typeof readMock.pending)[number][] {
  return readMock.pending.filter((read) => read.chatId === chatId);
}

/** The reads one mount's client issued for one draft so far. */
function readsOn(
  client: object,
  chatId: string,
): readonly (typeof readMock.pending)[number][] {
  return readMock.pending.filter(
    (read) => read.client === client && read.chatId === chatId,
  );
}

/**
 * How many head-read give-ups the logger recorded. Counted by message: the
 * landing image GC logs its own startup warning through the same logger, at a
 * time no test here controls.
 */
function headReadFailures(warnSpy: {
  readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
}): number {
  return warnSpy.mock.calls.filter(
    ([message]) => message === "[cloud-drafts] head read failed",
  ).length;
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Lets the microtasks an abandon queued run: a surviving mount's wake is
 * deferred one microtask past the commit that abandoned the head.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  // Unmount first: teardown releases the claims it still holds.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  readMock.pending.length = 0;
  directoryMock.chats = [];
  directoryMock.fenceSeq = 0;
  resetDraftMirrorCoordinatorForTests();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  resetLandingDraftRetirementsForTests();
});

describe("useCloudDraftsIngest across mounts, on the real coordinator", () => {
  it("reads each head once for two simultaneous mounts, installs the mirrors, and reads nothing for a mount rendered afterwards", async () => {
    directoryMock.chats = [row("draft-1"), row("draft-2"), row("draft-3")];

    mount();
    mount();

    await vi.waitFor(() => {
      expect(readMock.pending).toHaveLength(3);
    });
    // The second mount found every head claimed and read none of them.
    await nextTick();
    expect(readMock.pending.map((read) => read.chatId).toSorted()).toEqual([
      "draft-1",
      "draft-2",
      "draft-3",
    ]);
    for (const chat of directoryMock.chats) {
      expect(cloudDraftHeadReading(chat)).toBe(true);
    }

    resolveAll({ kind: "ok", record: HEAD });
    await vi.waitFor(() => {
      expect(landingIds()).toEqual(["draft-1", "draft-2", "draft-3"]);
    });
    for (const chat of directoryMock.chats) {
      expect(cloudDraftHeadSettled(chat)).toBe(true);
      expect(cloudDraftHeadReading(chat)).toBe(false);
    }

    // A third mount, after the mirrors are installed: the coordinator's
    // settled record answers, and that record is the only memory there is.
    mount();
    await nextTick();
    expect(readMock.pending).toHaveLength(3);
  });

  it("settles heads that answer a terminal refusal, so a later mount reads nothing", async () => {
    directoryMock.chats = [row("draft-1"), row("draft-2"), row("draft-3")];

    mount();
    mount();
    await vi.waitFor(() => {
      expect(readMock.pending).toHaveLength(3);
    });

    resolveAll({ kind: "unpublished" });
    await vi.waitFor(() => {
      for (const chat of directoryMock.chats) {
        expect(cloudDraftHeadReading(chat)).toBe(false);
        expect(cloudDraftHeadSettled(chat)).toBe(true);
      }
    });
    expect(landingIds()).toEqual([]);

    mount();
    await nextTick();
    expect(readMock.pending).toHaveLength(3);
  });

  it("fences a head another mount is reading, and abandons the claim when the reading mount unmounts with nobody left to wake", async () => {
    const pendingRow = row("draft-4");
    directoryMock.chats = [pendingRow];

    const reader = mount();
    await vi.waitFor(() => {
      expect(readMock.pending).toHaveLength(1);
    });
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);

    // A second mount skips the claimed head but still reserves its SWEEP
    // fence, at ITS directory's dispatch position (9, past the reader's 5):
    // no second read is issued, and a replica mirror of the row survives a
    // sweep of a snapshot dispatched before that position and is dropped by
    // one dispatched at it.
    directoryMock.fenceSeq = 5;
    const reserved = mount();
    await nextTick();
    reserved.unmount();
    directoryMock.fenceSeq = 9;
    const bystander = mount();
    await nextTick();
    expect(readMock.pending).toHaveLength(1);
    useLandingDraftStore.setState({
      drafts: [replicaMirror("draft-4")],
      activeDraftId: null,
    });
    expect(sweepAbsentCloudDraftMirrors(HOST_ID, new Map(), 8)).toEqual([]);
    expect(landingIds()).toEqual(["draft-4"]);
    expect(sweepAbsentCloudDraftMirrors(HOST_ID, new Map(), 9)).toEqual([
      "draft-4",
    ]);
    expect(landingIds()).toEqual([]);

    // The bystander never owned the claim, so it does not release it.
    bystander.unmount();
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);

    reader.unmount();
    expect(cloudDraftHeadReading(pendingRow)).toBe(false);
    expect(cloudDraftHeadSettled(pendingRow)).toBe(false);
    // Nobody was listening, so nothing read it in the meantime.
    expect(readMock.pending).toHaveLength(1);

    // A read that lands after its mount went away installs nothing.
    resolveAll({ kind: "ok", record: HEAD });
    await nextTick();
    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadSettled(pendingRow)).toBe(false);

    // The released head is read again by the next mount.
    mount();
    await vi.waitFor(() => {
      expect(readMock.pending).toHaveLength(2);
    });
  });

  it("hands a head to the surviving mount when the mount reading it unmounts: one read from it, its claim standing, and the abandoned read installing nothing", async () => {
    const pendingRow = row("draft-5");
    directoryMock.chats = [pendingRow];

    const reader = mount();
    await vi.waitFor(() => {
      expect(readsFor("draft-5")).toHaveLength(1);
    });
    const abandonedRead = readsFor("draft-5")[0];
    mount();
    await nextTick();
    // The second mount skipped the head the first one holds.
    expect(readsFor("draft-5")).toHaveLength(1);
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);

    reader.unmount();
    await flushMicrotasks();

    // The survivor read it at once, not at its next directory delivery: two
    // reads over the head's lifetime, and the claim is the survivor's.
    expect(readsFor("draft-5")).toHaveLength(2);
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);
    await nextTick();
    expect(readsFor("draft-5")).toHaveLength(2);

    // The abandoned continuation resolves with a good head: it installs
    // nothing and does not disturb the survivor's claim.
    abandonedRead.resolve({ kind: "ok", record: HEAD });
    await nextTick();
    expect(landingIds()).toEqual([]);
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);
    expect(cloudDraftHeadSettled(pendingRow)).toBe(true);

    // The survivor's own read decides the head.
    readsFor("draft-5")[1].resolve({ kind: "ok", record: HEAD });
    await vi.waitFor(() => {
      expect(landingIds()).toEqual(["draft-5"]);
    });
    expect(cloudDraftHeadReading(pendingRow)).toBe(false);
    expect(cloudDraftHeadSettled(pendingRow)).toBe(true);
    expect(readsFor("draft-5")).toHaveLength(2);
  });

  it("wakes every surviving mount that skipped the head but only one of them reads it", async () => {
    const pendingRow = row("draft-6");
    directoryMock.chats = [pendingRow];

    const reader = mount();
    await vi.waitFor(() => {
      expect(readsFor("draft-6")).toHaveLength(1);
    });
    mount();
    mount();
    await nextTick();
    expect(readsFor("draft-6")).toHaveLength(1);

    reader.unmount();
    await flushMicrotasks();

    // The first survivor claims the head; the second asks the guard again and
    // finds it held.
    expect(readsFor("draft-6")).toHaveLength(2);
    await nextTick();
    expect(readsFor("draft-6")).toHaveLength(2);
    expect(cloudDraftHeadReading(pendingRow)).toBe(true);
  });

  it("does not wake a surviving mount for a head the reading mount decided before it unmounted", async () => {
    const decidedRow = row("draft-7");
    directoryMock.chats = [decidedRow];

    const reader = mount();
    await vi.waitFor(() => {
      expect(readsFor("draft-7")).toHaveLength(1);
    });
    mount();
    await nextTick();
    readsFor("draft-7")[0].resolve({ kind: "unpublished" });
    await vi.waitFor(() => {
      expect(cloudDraftHeadSettled(decidedRow)).toBe(true);
    });

    reader.unmount();
    await nextTick();

    expect(readsFor("draft-7")).toHaveLength(1);
    expect(cloudDraftHeadSettled(decidedRow)).toBe(true);
  });

  it("hands a head to the surviving mount, bound to another host, when the reading mount gives up after every attempt: one read from the survivor through its own client, none more from the exhausted mount", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    const failingRow = row("draft-8");
    directoryMock.chats = [failingRow];

    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(readsOn(CLIENT, "draft-8")).toHaveLength(1);
    mountOnSecondHost();
    await vi.advanceTimersByTimeAsync(0);
    // The second mount skipped the head, and is still mounted throughout.
    expect(readsFor("draft-8")).toHaveLength(1);
    expect(readsOn(SECOND_CLIENT, "draft-8")).toHaveLength(0);

    // Attempt 0 fails; the retry is the reading mount's, at 2 s.
    readsFor("draft-8")[0].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);
    expect(readsOn(CLIENT, "draft-8")).toHaveLength(2);
    expect(readsOn(SECOND_CLIENT, "draft-8")).toHaveLength(0);
    expect(cloudDraftHeadReading(failingRow)).toBe(true);

    // Attempt 1 fails; the retry is at 4 s.
    readsFor("draft-8")[1].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);
    expect(readsOn(CLIENT, "draft-8")).toHaveLength(3);
    expect(readsOn(SECOND_CLIENT, "draft-8")).toHaveLength(0);

    // Attempt 2 is the last: the mount gives up and abandons the claim, which
    // wakes the second mount. It reads the head now, through its own pipe; the
    // exhausted mount ignores its own wake and starts no fourth read.
    readsOn(CLIENT, "draft-8")[2].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(headReadFailures(warnSpy)).toBe(1);
    expect(readsOn(SECOND_CLIENT, "draft-8")).toHaveLength(1);
    expect(readsOn(CLIENT, "draft-8")).toHaveLength(3);
    expect(cloudDraftHeadReading(failingRow)).toBe(true);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readsOn(SECOND_CLIENT, "draft-8")).toHaveLength(1);
    expect(readsOn(CLIENT, "draft-8")).toHaveLength(3);

    // The survivor's read decides the head.
    readsOn(SECOND_CLIENT, "draft-8")[0].resolve({ kind: "ok", record: HEAD });
    await vi.advanceTimersByTimeAsync(0);
    expect(landingIds()).toEqual(["draft-8"]);
    expect(cloudDraftHeadReading(failingRow)).toBe(false);
    expect(cloudDraftHeadSettled(failingRow)).toBe(true);
    expect(readsFor("draft-8")).toHaveLength(4);
  });

  it("gives the head back to nobody when the only mount gives up after every attempt: released, not settled, and a later mount asks again", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    const failingRow = row("draft-9");
    directoryMock.chats = [failingRow];

    mount();
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      readsFor("draft-9")[attempt].reject(new Error("read failed"));
      await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2 ** attempt);
    }
    expect(readsFor("draft-9")).toHaveLength(3);

    readsFor("draft-9")[2].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(cloudDraftHeadReading(failingRow)).toBe(false);
    expect(cloudDraftHeadSettled(failingRow)).toBe(false);
    expect(headReadFailures(warnSpy)).toBe(1);
    // Nobody else was listening, and the exhausted mount ignored its own wake.
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readsFor("draft-9")).toHaveLength(3);

    // Released, not settled: a later mount asks again.
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(readsFor("draft-9")).toHaveLength(4);
  });

  it("an ambiguous identity on mount A wakes nobody: B reads nothing now, and both mounts ask again at their next delivery", async () => {
    const ambiguousRow = row("draft-13");
    directoryMock.chats = [ambiguousRow];

    const a = mount();
    await vi.waitFor(() => {
      expect(readsOn(CLIENT, "draft-13")).toHaveLength(1);
    });
    const b = mountOnSecondHost();
    await nextTick();
    // B skipped the head A holds.
    expect(readsOn(SECOND_CLIENT, "draft-13")).toHaveLength(0);
    expect(cloudDraftHeadReading(ambiguousRow)).toBe(true);

    // A meets an ambiguous identity: the claim is given back silently, not
    // settled and not abandoned, so B is not woken into a read of the same
    // answer.
    readsOn(CLIENT, "draft-13")[0].resolve({
      kind: "ambiguous-identity",
      resolvedOwnerUserId: null,
    });
    await vi.waitFor(() => {
      expect(cloudDraftHeadReading(ambiguousRow)).toBe(false);
    });
    await flushMicrotasks();
    await nextTick();
    expect(cloudDraftHeadSettled(ambiguousRow)).toBe(false);
    expect(readsOn(SECOND_CLIENT, "draft-13")).toHaveLength(0);
    expect(readsOn(CLIENT, "draft-13")).toHaveLength(1);
    expect(readsFor("draft-13")).toHaveLength(1);
    expect(landingIds()).toEqual([]);

    // The next directory delivery re-runs both mounts. A's key went with the
    // claim, and B never held one, so each asks: the coordinator admits the
    // first to walk (A) and the other (B) finds the head claimed and skips.
    a.rerender();
    await vi.waitFor(() => {
      expect(readsOn(CLIENT, "draft-13")).toHaveLength(2);
    });
    b.rerender();
    await nextTick();
    expect(readsOn(SECOND_CLIENT, "draft-13")).toHaveLength(0);
    expect(cloudDraftHeadReading(ambiguousRow)).toBe(true);

    // The same answer again, and the following delivery reaches B first: B
    // reads and A, which reads the head again only when it is free, skips.
    readsOn(CLIENT, "draft-13")[1].resolve({
      kind: "ambiguous-identity",
      resolvedOwnerUserId: null,
    });
    await vi.waitFor(() => {
      expect(cloudDraftHeadReading(ambiguousRow)).toBe(false);
    });
    await flushMicrotasks();
    expect(readsFor("draft-13")).toHaveLength(2);
    b.rerender();
    await vi.waitFor(() => {
      expect(readsOn(SECOND_CLIENT, "draft-13")).toHaveLength(1);
    });
    a.rerender();
    await nextTick();
    expect(readsOn(CLIENT, "draft-13")).toHaveLength(2);
    expect(readsFor("draft-13")).toHaveLength(3);
    // B's read is the one in flight; given back like A's, never settled.
    expect(cloudDraftHeadReading(ambiguousRow)).toBe(true);
    readsOn(SECOND_CLIENT, "draft-13")[0].resolve({
      kind: "ambiguous-identity",
      resolvedOwnerUserId: null,
    });
    await vi.waitFor(() => {
      expect(cloudDraftHeadReading(ambiguousRow)).toBe(false);
    });
    await flushMicrotasks();
    await nextTick();
    expect(readsFor("draft-13")).toHaveLength(3);
    expect(cloudDraftHeadSettled(ambiguousRow)).toBe(false);
    expect(landingIds()).toEqual([]);
  });

  it("a mount that exhausted a head takes it back when the mount that took it over is torn down", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
    const contestedRow = row("draft-15");
    directoryMock.chats = [contestedRow];

    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(readsOn(CLIENT, "draft-15")).toHaveLength(1);
    const takeover = mountOnSecondHost();
    await vi.advanceTimersByTimeAsync(0);
    expect(readsOn(SECOND_CLIENT, "draft-15")).toHaveLength(0);

    // A's three attempts all fail.
    readsOn(CLIENT, "draft-15")[0].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);
    readsOn(CLIENT, "draft-15")[1].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);
    expect(readsOn(CLIENT, "draft-15")).toHaveLength(3);
    readsOn(CLIENT, "draft-15")[2].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(0);

    // A abandoned with `exhausted`: B takes the head over, its read held
    // pending, and A ignores its own wake.
    expect(headReadFailures(warnSpy)).toBe(1);
    expect(readsOn(SECOND_CLIENT, "draft-15")).toHaveLength(1);
    expect(readsOn(CLIENT, "draft-15")).toHaveLength(3);
    expect(cloudDraftHeadReading(contestedRow)).toBe(true);

    // B is torn down with its read undecided: its teardown abandons with
    // `released`, which A takes. Exactly one new read, on A's own client.
    takeover.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(readsOn(CLIENT, "draft-15")).toHaveLength(4);
    expect(readsOn(SECOND_CLIENT, "draft-15")).toHaveLength(1);
    expect(cloudDraftHeadReading(contestedRow)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(readsOn(CLIENT, "draft-15")).toHaveLength(4);

    // A's reads fail again: it exhausts again, and nobody is left to wake into
    // a read (B is gone; A ignores its own exhaustion).
    readsOn(CLIENT, "draft-15")[3].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS);
    readsOn(CLIENT, "draft-15")[4].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 2);
    expect(readsOn(CLIENT, "draft-15")).toHaveLength(6);
    readsOn(CLIENT, "draft-15")[5].reject(new Error("read failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(headReadFailures(warnSpy)).toBe(2);
    expect(cloudDraftHeadReading(contestedRow)).toBe(false);
    expect(cloudDraftHeadSettled(contestedRow)).toBe(false);
    await vi.advanceTimersByTimeAsync(HEAD_READ_RETRY_BASE_MS * 100);
    expect(readsOn(CLIENT, "draft-15")).toHaveLength(6);
    expect(readsOn(SECOND_CLIENT, "draft-15")).toHaveLength(1);
    expect(landingIds()).toEqual([]);
  });

  it("two mounts re-run by one delivery with reads in flight resolve each head once, not once per mount", async () => {
    const heads = [row("draft-10"), row("draft-11"), row("draft-12")];
    directoryMock.chats = heads;

    // Two mounts of one host in ONE component, so one directory delivery
    // re-runs both in a single React commit: every cleanup runs before any
    // setup, which is the order a refetch that moves the fence sequence gives
    // every mounted tab.
    const view = renderHook(() => {
      useCloudDraftsIngest(CLIENT as never, HOST_ID);
      useCloudDraftsIngest(CLIENT as never, HOST_ID);
    });
    await vi.waitFor(() => {
      expect(readMock.pending).toHaveLength(heads.length);
    });
    await nextTick();
    // The first mount read every head; the second found each one claimed. None
    // of the reads has been answered.
    expect(readMock.pending).toHaveLength(heads.length);
    for (const head of heads) {
      expect(readsFor(head.identity.chatId)).toHaveLength(1);
      expect(cloudDraftHeadReading(head)).toBe(true);
    }

    // One delivery: a new array with the same rows, both mounts re-run in one
    // commit.
    directoryMock.chats = [...heads];
    act(() => {
      view.rerender();
    });
    await flushMicrotasks();
    await nextTick();

    // The reads in flight were abandoned by the torn-down runs and read once
    // more by the new runs: each head was resolved twice over its lifetime (the
    // abandoned read plus one fresh read), never once more per mount.
    expect(readMock.pending).toHaveLength(heads.length * 2);
    for (const head of heads) {
      expect(readsFor(head.identity.chatId)).toHaveLength(2);
      expect(cloudDraftHeadReading(head)).toBe(true);
    }

    // The fresh reads decide the heads; the abandoned ones install nothing
    // and add no read.
    for (const head of heads) {
      readsFor(head.identity.chatId)[0].resolve({ kind: "ok", record: HEAD });
    }
    await nextTick();
    expect(landingIds()).toEqual([]);
    for (const head of heads) {
      readsFor(head.identity.chatId)[1].resolve({ kind: "ok", record: HEAD });
    }
    await vi.waitFor(() => {
      expect(landingIds()).toEqual(["draft-10", "draft-11", "draft-12"]);
    });
    expect(readMock.pending).toHaveLength(heads.length * 2);
  });

  it("the mount that ingested a head reads it again when its mirror leaves the store outside the sweep, and restores the mirror", async () => {
    const listed = row("draft-20");
    directoryMock.chats = [listed];

    // ONE long-lived mount: it reads the head itself, so it is the mount
    // that once held the head, not one that skipped a head another mount
    // settled.
    const view = mount();
    await vi.waitFor(() => {
      expect(readsFor("draft-20")).toHaveLength(1);
    });
    readsFor("draft-20")[0].resolve({ kind: "ok", record: HEAD });
    await vi.waitFor(() => {
      expect(landingIds()).toEqual(["draft-20"]);
    });
    expect(cloudDraftHeadSettled(listed)).toBe(true);

    // The mirror leaves the store outside the absence sweep, as a delete
    // route removes it. The coordinator notices the absence and forgets the
    // head.
    useLandingDraftStore.setState({
      drafts: useLandingDraftStore
        .getState()
        .drafts.filter((draft) => draft.id !== "draft-20"),
    });
    expect(landingIds()).toEqual([]);

    // A new delivery of the SAME row at the same publication time.
    directoryMock.chats = [row("draft-20")];
    view.rerender();

    // The mount reads the head again: its own earlier read is no vote.
    await vi.waitFor(() => {
      expect(readsFor("draft-20")).toHaveLength(2);
    });
    expect(landingIds()).toEqual([]);
    readsFor("draft-20")[1].resolve({ kind: "ok", record: HEAD });
    await vi.waitFor(() => {
      expect(landingIds()).toEqual(["draft-20"]);
    });
    expect(cloudDraftHeadSettled(directoryMock.chats[0])).toBe(true);
  });
});

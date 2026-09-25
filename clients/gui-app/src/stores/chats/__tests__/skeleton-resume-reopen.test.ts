import { beforeEach, describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  SKELETON_RESUME_BLOCK_SIZE,
  SKELETON_RESUME_DERIVATION,
  skeletonResumeBlockDigest,
} from "@traycer/protocol/persistence/chat-transcript/skeleton-resume";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  disposingForIdentityTeardown,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { forgetAllSkeletonsForResume } from "@/stores/chats/skeleton-resume-cache";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

/**
 * # Re-opening a chat the client already holds (`chat.subscribe@1.18`)
 *
 * A reconnect used to restream the whole skeleton - about a megabyte for a
 * 6-7k row chat - into a window that already held all but its last few rows.
 * The chat now describes its skeleton on the subscribe, and the host starts
 * the stream past what the description matched, with `retainedRows` on the
 * first chunk. These pin the client's half end to end through the store: what
 * it claims, that a resumed stream lands a window indistinguishable from a
 * full one, and that an answer it cannot honour recovers the way a lost chunk
 * already does.
 */

const EPIC_ID = "epic-resume";
const CHAT_ID = "chat-resume";
const OWNER_ID = "owner-1";
const BLOCK = SKELETON_RESUME_BLOCK_SIZE;

function entry(ordinal: number): RowSkeletonEntry {
  return {
    rowId: `row-${ordinal}`,
    createdAt: 1_000 + ordinal,
    role: ordinal % 2 === 0 ? "user" : "assistant",
    byteLength: 64,
    bodyDigest: `d-${ordinal}`,
  };
}

function entries(from: number, to: number): RowSkeletonEntry[] {
  return Array.from({ length: to - from }, (_, index) => entry(from + index));
}

type WindowedSnapshotFrame = Parameters<
  ChatStreamCallbacks["onWindowedSnapshot"]
>[0];
type SkeletonChunkFrame = Parameters<ChatStreamCallbacks["onSkeletonChunk"]>[0];

/** A bootstrap snapshot: a fresh subscriber, so no revision, and no tail rows. */
function bootstrapSnapshot(
  epoch: number,
  rowCount: number,
): WindowedSnapshotFrame {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    snapshot: {
      chat: {
        id: CHAT_ID,
        parentId: null,
        userId: OWNER_ID,
        hostId: "host-a",
        title: "Chat",
        createdAt: 1,
        updatedAt: 1,
        isTitleEditedByUser: false,
        settings: null,
        archivedAt: null,
        lastDeliveredRolesDigest: null,
        activeSessionChain: null,
        claudePendingWakes: [],
        pinnedUserProviderHandle: null,
      },
      access: { role: "owner", ownerUserId: OWNER_ID, canAct: true },
      queue: { status: "idle", items: [] },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      transcriptEpoch: epoch,
      rowCount,
      indexRevision: null,
      tail: {
        fromOrdinal: rowCount,
        rowIds: [],
        messages: [],
        events: [],
      },
      derived: {
        latestAssistantUsage: null,
        pinnedTodo: null,
        pinnedTaskTodoItems: [],
        latestForkableAssistantMessageId: null,
        restorableSetupInterruption: null,
        interviewAnswerability: [],
        latestAssistantAuthFailureTurnKey: null,
        setupCardWindows: [],
      },
    },
  };
}

function chunkFrame(input: {
  readonly epoch: number;
  readonly fromOrdinal: number;
  readonly entries: readonly RowSkeletonEntry[];
  readonly retainedRows: number | undefined;
}): SkeletonChunkFrame {
  const frame: SkeletonChunkFrame = {
    kind: "skeletonChunk",
    hasBinaryPayload: false,
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    chunk: {
      epoch: input.epoch,
      fromOrdinal: input.fromOrdinal,
      entries: [...input.entries],
      isFinal: true,
    },
  };
  return input.retainedRows === undefined
    ? frame
    : { ...frame, retainedRows: input.retainedRows };
}

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly resnapshotCount: () => number;
  callbacks(): ChatStreamCallbacks;
}

function createHarness(): Harness {
  let resnapshots = 0;
  let callbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: () => {},
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => {
          resnapshots += 1;
        },
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    resnapshotCount: () => resnapshots,
    callbacks: () => {
      if (callbacks === null) throw new Error("Expected callbacks");
      return callbacks;
    },
  };
}

/** Open the chat and stream its whole skeleton, as a first subscribe does. */
function openFully(harness: Harness, epoch: number, rowCount: number): void {
  const cb = harness.callbacks();
  cb.onWindowedSnapshot(bootstrapSnapshot(epoch, rowCount));
  cb.onSkeletonChunk(
    chunkFrame({
      epoch,
      fromOrdinal: 0,
      entries: entries(0, rowCount),
      retainedRows: undefined,
    }),
  );
}

function windowOf(harness: Harness) {
  return harness.handle.store.getState().transcriptWindow;
}

beforeEach(() => {
  forgetAllSkeletonsForResume();
});

describe("skeleton resume: what a chat claims", () => {
  it("claims nothing before it holds a skeleton", () => {
    const harness = createHarness();
    expect(harness.callbacks().readSkeletonResume()).toBe(null);
    harness.handle.dispose();
  });

  it("describes the whole blocks of a complete skeleton", () => {
    const harness = createHarness();
    openFully(harness, 0, 2 * BLOCK + 40);
    expect(windowOf(harness).skeletonComplete).toBe(true);
    expect(harness.callbacks().readSkeletonResume()).toEqual({
      derivation: SKELETON_RESUME_DERIVATION,
      blockSize: BLOCK,
      blockDigests: [
        skeletonResumeBlockDigest(entries(0, BLOCK)),
        skeletonResumeBlockDigest(entries(BLOCK, 2 * BLOCK)),
      ],
    });
    harness.handle.dispose();
  });

  it("claims nothing for a skeleton it does not trust", () => {
    const harness = createHarness();
    const cb = harness.callbacks();
    cb.onWindowedSnapshot(bootstrapSnapshot(0, 2 * BLOCK));
    // Half the stream: the window knows it is short.
    cb.onSkeletonChunk({
      ...chunkFrame({
        epoch: 0,
        fromOrdinal: 0,
        entries: entries(0, BLOCK),
        retainedRows: undefined,
      }),
      chunk: {
        epoch: 0,
        fromOrdinal: 0,
        entries: entries(0, BLOCK),
        isFinal: false,
      },
    });
    expect(windowOf(harness).skeletonComplete).toBe(false);
    expect(cb.readSkeletonResume()).toBe(null);
    harness.handle.dispose();
  });
});

describe("skeleton resume: a resumed stream lands a whole window", () => {
  it("keeps the described rows across a same-epoch reconnect and applies only the new ones", () => {
    const harness = createHarness();
    openFully(harness, 0, 2 * BLOCK + 40);
    const cb = harness.callbacks();

    // The reconnect: the subscribe reads the claim, the host re-bootstraps at
    // the grown row count, and streams only past the two matching blocks.
    expect(cb.readSkeletonResume()?.blockDigests).toHaveLength(2);
    cb.onWindowedSnapshot(bootstrapSnapshot(0, 2 * BLOCK + 55));
    cb.onSkeletonChunk(
      chunkFrame({
        epoch: 0,
        fromOrdinal: 2 * BLOCK,
        entries: entries(2 * BLOCK, 2 * BLOCK + 55),
        retainedRows: 2 * BLOCK,
      }),
    );

    const window = windowOf(harness);
    expect(window.invalidated).toBe(false);
    expect(window.skeletonComplete).toBe(true);
    expect(window.skeletonStreamCoveredThrough).toBe(2 * BLOCK + 55);
    expect(window.skeleton.map((value) => value?.rowId)).toEqual(
      entries(0, 2 * BLOCK + 55).map((value) => value.rowId),
    );
    expect(harness.resnapshotCount()).toBe(0);
    harness.handle.dispose();
  });

  it("re-seats the described rows after a host restart moved the epoch", () => {
    // A fresh publication on the host restarts its epoch, so the bootstrap
    // snapshot rebases the window and clears its skeleton before the resumed
    // chunk arrives. The rows the host verified are still the ones described.
    const harness = createHarness();
    const cb = harness.callbacks();
    openFully(harness, 3, 2 * BLOCK);
    expect(cb.readSkeletonResume()?.blockDigests).toHaveLength(2);

    cb.onWindowedSnapshot(bootstrapSnapshot(0, 2 * BLOCK + 3));
    expect(windowOf(harness).skeleton).toHaveLength(0);
    cb.onSkeletonChunk(
      chunkFrame({
        epoch: 0,
        fromOrdinal: 2 * BLOCK,
        entries: entries(2 * BLOCK, 2 * BLOCK + 3),
        retainedRows: 2 * BLOCK,
      }),
    );

    const window = windowOf(harness);
    expect(window.epoch).toBe(0);
    expect(window.invalidated).toBe(false);
    expect(window.skeletonComplete).toBe(true);
    expect(window.skeleton.map((value) => value?.rowId)).toEqual(
      entries(0, 2 * BLOCK + 3).map((value) => value.rowId),
    );
    harness.handle.dispose();
  });
});

describe("skeleton resume: an answer the client cannot honour", () => {
  it("voids the index when the host keeps rows the client never offered", () => {
    const harness = createHarness();
    const cb = harness.callbacks();
    // Nothing held, nothing offered - and a chunk that says otherwise.
    expect(cb.readSkeletonResume()).toBe(null);
    cb.onWindowedSnapshot(bootstrapSnapshot(0, BLOCK + 10));
    cb.onSkeletonChunk(
      chunkFrame({
        epoch: 0,
        fromOrdinal: BLOCK,
        entries: entries(BLOCK, BLOCK + 10),
        retainedRows: BLOCK,
      }),
    );
    const window = windowOf(harness);
    // The recovery a lost chunk already takes: the stream never covered its
    // first rows, so the window declares its index void and re-requests it.
    expect(window.skeletonComplete).toBe(false);
    expect(window.invalidated).toBe(true);
    harness.handle.dispose();
  });

  it("spends the offer on the first chunk, so a later stream cannot reuse it", () => {
    const harness = createHarness();
    const cb = harness.callbacks();
    openFully(harness, 0, 2 * BLOCK);
    expect(cb.readSkeletonResume()).not.toBe(null);

    // The host did not resume: a full stream answers the claim.
    cb.onWindowedSnapshot(bootstrapSnapshot(0, 2 * BLOCK));
    cb.onSkeletonChunk(
      chunkFrame({
        epoch: 0,
        fromOrdinal: 0,
        entries: entries(0, 2 * BLOCK),
        retainedRows: undefined,
      }),
    );
    expect(windowOf(harness).skeletonComplete).toBe(true);

    // A resnapshot's stream on the SAME connection offered nothing, so a
    // `retainedRows` on it is refused rather than read against the old offer.
    cb.onWindowedSnapshot(bootstrapSnapshot(0, 2 * BLOCK));
    cb.onSkeletonChunk(
      chunkFrame({
        epoch: 0,
        fromOrdinal: BLOCK,
        entries: entries(BLOCK, 2 * BLOCK),
        retainedRows: BLOCK,
      }),
    );
    expect(windowOf(harness).invalidated).toBe(true);
    harness.handle.dispose();
  });
});

describe("skeleton resume: re-opening a chat whose session was closed", () => {
  it("claims the skeleton the closed session left behind, and resumes into an empty window", () => {
    const closed = createHarness();
    openFully(closed, 0, 2 * BLOCK + 40);
    // The warm pool evicts it: the session, its window and its socket go.
    closed.handle.dispose();

    const reopened = createHarness();
    const cb = reopened.callbacks();
    expect(windowOf(reopened).skeleton).toHaveLength(0);
    expect(cb.readSkeletonResume()).toEqual({
      derivation: SKELETON_RESUME_DERIVATION,
      blockSize: BLOCK,
      blockDigests: [
        skeletonResumeBlockDigest(entries(0, BLOCK)),
        skeletonResumeBlockDigest(entries(BLOCK, 2 * BLOCK)),
      ],
    });
    cb.onWindowedSnapshot(bootstrapSnapshot(0, 2 * BLOCK + 44));
    cb.onSkeletonChunk(
      chunkFrame({
        epoch: 0,
        fromOrdinal: 2 * BLOCK,
        entries: entries(2 * BLOCK, 2 * BLOCK + 44),
        retainedRows: 2 * BLOCK,
      }),
    );
    const window = windowOf(reopened);
    expect(window.invalidated).toBe(false);
    expect(window.skeletonComplete).toBe(true);
    expect(window.skeleton.map((value) => value?.rowId)).toEqual(
      entries(0, 2 * BLOCK + 44).map((value) => value.rowId),
    );
    reopened.handle.dispose();
  });

  it("leaves nothing behind across an identity change", () => {
    const closed = createHarness();
    openFully(closed, 0, 2 * BLOCK);
    disposingForIdentityTeardown(() => {
      closed.handle.dispose();
    });
    const reopened = createHarness();
    expect(reopened.callbacks().readSkeletonResume()).toBe(null);
    reopened.handle.dispose();
  });

  it("drops skeletons closed BEFORE the identity change too", () => {
    const closed = createHarness();
    openFully(closed, 0, 2 * BLOCK);
    closed.handle.dispose();
    disposingForIdentityTeardown(() => undefined);
    const reopened = createHarness();
    expect(reopened.callbacks().readSkeletonResume()).toBe(null);
    reopened.handle.dispose();
  });
});

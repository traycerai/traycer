import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnvironment } from "@traycer-clients/shared/replica-runtime";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import { createProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import {
  chatHolderId,
  chatWholeSetSliceBytes,
  createChatWindowBudgetBook,
  evictChatWindowForAccountant,
  legacyTranscriptResidencyBytes,
  type ChatWindowBudgetSession,
} from "@/stores/replica-memory/chat-window-budget";
import {
  appendLiveRecords,
  applyRangeResponse,
  applySkeletonChunk,
  applyWindowedSnapshot,
  emptyTranscriptWindow,
  TRANSCRIPT_WINDOW_MAX_BYTES,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatRangeResponse } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import {
  CHAT_WINDOWS_SOFT_LIMIT_BYTES,
  HOT_DOCS_SOFT_LIMIT_BYTES,
  EPIC_REPLICAS_SOFT_LIMIT_BYTES,
} from "@/stores/replica-memory/budget-limits";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function userMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function event(eventId: string, timestamp: number): ChatEvent {
  return {
    eventId,
    type: "turn.completed",
    timestamp,
    clientActionId: null,
    actor: null,
    message: null,
    turnId: "turn-1",
    messageId: null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: null,
  };
}

function skeletonEntry(rowId: string, ordinal: number): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000 + ordinal,
    role: "user",
    byteLength: 128,
    bodyDigest: `d-${rowId}`,
  };
}

function rangeOf(
  fromOrdinal: number,
  rowIds: readonly string[],
  messages: readonly Message[],
): ChatRangeResponse {
  return {
    requestId: `req-${fromOrdinal}`,
    epoch: 1,
    fromOrdinal,
    rowIds: [...rowIds],
    messages: [...messages],
    events: [],
    rowContext: {},
    reachedStart: fromOrdinal === 0,
    reachedEnd: false,
  };
}

function windowWithSkeleton(rowCount: number): TranscriptWindow {
  const seeded = applyWindowedSnapshot(emptyTranscriptWindow(), {
    epoch: 1,
    rowCount,
    indexRevision: null,
    tail: { fromOrdinal: rowCount, messages: [], events: [] },
  });
  return applySkeletonChunk(seeded, {
    epoch: 1,
    fromOrdinal: 0,
    entries: Array.from({ length: rowCount }, (_unused, index) =>
      skeletonEntry(`row-${index}`, index),
    ),
    isFinal: true,
  });
}

function fakeEnvironment(): RuntimeEnvironment {
  return {
    clock: { now: () => 0 },
    scheduler: {
      schedule() {
        return { cancel(): void {} };
      },
      scheduleMicrotask(): void {},
    },
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("chatWholeSetSliceBytes", () => {
  it("charges empty slices as zero, not the encoding of []/{}", () => {
    expect(
      chatWholeSetSliceBytes({
        queue: {},
        pendingApprovals: [],
        pendingFileEditApprovals: [],
        pendingInterviews: [],
        backgroundItems: [],
        managedCommands: [],
      }),
    ).toBe(0);
  });

  it("charges a non-empty slice by its JSON bytes", () => {
    const empty = chatWholeSetSliceBytes({
      queue: { items: [{ id: "q1" }] },
      pendingApprovals: [],
      pendingFileEditApprovals: [],
      pendingInterviews: [],
      backgroundItems: [],
      managedCommands: [],
    });
    expect(empty).toBeGreaterThan(0);
  });
});

describe("legacyTranscriptResidencyBytes", () => {
  it("is the sum of recordByteLength over the whole transcript", () => {
    const messages = [userMessage("m-0", 0), userMessage("m-1", 1)];
    const events = [event("e-0", 0)];
    expect(legacyTranscriptResidencyBytes(messages, events)).toBe(
      recordByteLength(messages[0]) +
        recordByteLength(messages[1]) +
        recordByteLength(events[0]),
    );
  });
});

describe("evictChatWindowForAccountant", () => {
  it("reclaims unprotected spans and reports remaining live records as tail", () => {
    let window = windowWithSkeleton(4);
    window = applyRangeResponse(
      window,
      rangeOf(0, ["row-0"], [userMessage("m-0", 0)]),
    );
    window = applyRangeResponse(
      window,
      rangeOf(1, ["row-1"], [userMessage("m-1", 1)]),
    );
    window = appendLiveRecords(window, {
      messages: [userMessage("m-live", 9)],
      events: [],
    });
    const before = window.hydratedBytes;
    expect(before).toBeGreaterThan(0);

    const { window: next, outcome } = evictChatWindowForAccountant(
      window,
      0,
      null,
      [],
    );
    expect(outcome.reclaimedBytes).toBeGreaterThan(0);
    expect(next.hydratedBytes).toBeLessThan(before);
    expect(next.liveMessages).toHaveLength(1);
    expect(
      outcome.protectedBytesByKind.some((entry) => entry.kind === "tail"),
    ).toBe(true);
  });
});

describe("createChatWindowBudgetBook", () => {
  it("evicts the coldest session first", () => {
    const book = createChatWindowBudgetBook();
    const coldEvict = vi.fn(
      (): ReturnType<ChatWindowBudgetSession["evict"]> => ({
        reclaimedBytes: 50,
        protectedBytesByKind: [],
      }),
    );
    const hotEvict = vi.fn(
      (): ReturnType<ChatWindowBudgetSession["evict"]> => ({
        reclaimedBytes: 0,
        protectedBytesByKind: [{ kind: "visible", bytes: 80 }],
      }),
    );
    book.attach({
      holderId: "cold",
      touchedAt: () => 1,
      measure: () => 50,
      evict: coldEvict,
    });
    book.attach({
      holderId: "hot",
      touchedAt: () => 9,
      measure: () => 80,
      evict: hotEvict,
    });
    const outcome = book.evict(40);
    expect(coldEvict).toHaveBeenCalledTimes(1);
    expect(hotEvict).not.toHaveBeenCalled();
    expect(outcome.reclaimedBytes).toBe(50);
  });

  it("chatHolderId discriminates host, not only epic+chat", () => {
    expect(chatHolderId("h1", "e", "c")).not.toBe(chatHolderId("h2", "e", "c"));
  });
});

describe("createProcessMemoryRuntime", () => {
  it("registers the three known planes under their named ids", () => {
    const runtime = createProcessMemoryRuntime(fakeEnvironment());
    const ids = runtime.accountant
      .snapshot()
      .planes.map((plane) => plane.planeId);
    expect(ids).toEqual([
      BUDGET_PLANE_IDS.chatWindows,
      BUDGET_PLANE_IDS.hotDocs,
      BUDGET_PLANE_IDS.epicReplicas,
    ]);
    const limits = runtime.accountant
      .snapshot()
      .planes.map((plane) => plane.softLimitBytes);
    expect(limits).toEqual([
      CHAT_WINDOWS_SOFT_LIMIT_BYTES,
      HOT_DOCS_SOFT_LIMIT_BYTES,
      EPIC_REPLICAS_SOFT_LIMIT_BYTES,
    ]);
  });
});

describe("TRANSCRIPT_WINDOW_MAX_BYTES remains the per-window unit", () => {
  it("is still 8 MiB, and the process pool is a multiple of it", () => {
    expect(TRANSCRIPT_WINDOW_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(CHAT_WINDOWS_SOFT_LIMIT_BYTES).toBe(4 * TRANSCRIPT_WINDOW_MAX_BYTES);
  });
});

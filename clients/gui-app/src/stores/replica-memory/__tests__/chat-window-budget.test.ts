import { describe, expect, it, vi } from "vitest";
import type {
  EvictionOutcome,
  RuntimeEnvironment,
} from "@traycer-clients/shared/replica-runtime";
import {
  BUDGET_PLANE_IDS,
  createMemoryAccountant,
} from "@traycer-clients/shared/replica-runtime";
import { createProcessMemoryRuntime } from "@/stores/replica-memory/process-memory-accountant";
import {
  chatHolderId,
  chatWholeSetSliceBytes,
  createChatWindowBudgetBook,
  evictChatWindowForAccountant,
  legacyTranscriptResidencyBytes,
} from "@/stores/replica-memory/chat-window-budget";
import {
  appendLiveRecords,
  applyRangeResponse,
  applySkeletonChunk,
  applyWindowedSnapshot,
  emptyTranscriptWindow,
  streamWindowMessage,
  TRANSCRIPT_WINDOW_MAX_BYTES,
  transcriptWindowChargedBytes,
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
  EPIC_REPLICAS_SOFT_LIMIT_BYTES,
  HOT_DOCS_SOFT_LIMIT_BYTES,
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

function grownUserMessage(message: Message, index: number): Message {
  if (message.role !== "user") return message;
  return {
    ...message,
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: `chunk ${index} `.repeat(600) }],
          },
        ],
      },
      browserAnnotations: [],
    },
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
  const seeded = applyWindowedSnapshot(
    emptyTranscriptWindow(),
    {
      epoch: 1,
      rowCount,
      indexRevision: null,
      tail: { fromOrdinal: rowCount, messages: [], events: [] },
    },
    null,
    null,
  );
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
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeOf(1, ["row-1"], [userMessage("m-1", 1)]),
      null,
      null,
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

  it("reports surviving visible and required spans, not only live records", () => {
    let window = windowWithSkeleton(6);
    window = applyRangeResponse(
      window,
      rangeOf(0, ["row-0"], [userMessage("m-0", 0)]),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeOf(2, ["row-2"], [userMessage("m-2", 2)]),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeOf(4, ["row-4"], [userMessage("m-4", 4)]),
      null,
      null,
    );
    const { outcome } = evictChatWindowForAccountant(
      window,
      0,
      { fromOrdinal: 0, toOrdinal: 1 },
      [2],
    );
    expect(
      outcome.protectedBytesByKind.some((entry) => entry.kind === "visible"),
    ).toBe(true);
    expect(
      outcome.protectedBytesByKind.some((entry) => entry.kind === "required"),
    ).toBe(true);
    expect(outcome.reclaimedBytes).toBeGreaterThan(0);
  });
});

/**
 * The feature's own motivating case, end to end: a huge IN-FLIGHT turn has to
 * evict the cold scrollback it is competing with.
 *
 * The chain has three links and each one is load-bearing. The turn's deltas
 * are `deferred`, so they deliberately leave `hydratedBytes` unmoved. The mark
 * they leave in `unsettledByteMessageIds` is what carries the growth forward.
 * `evictTranscriptWindowToBudget` settles FIRST and only then reads its gate,
 * which is the moment the growth becomes a figure at all. Break any link and
 * the window reads as under budget while holding a turn's worth of bytes.
 */
describe("an in-flight turn's growth reaches the eviction gate", () => {
  it("evicts cold spans once a STREAMING row grows past the budget", () => {
    let window = windowWithSkeleton(4);
    window = applyRangeResponse(
      window,
      rangeOf(0, ["row-0"], [userMessage("m-0", 0)]),
      null,
      null,
    );
    window = applyRangeResponse(
      window,
      rangeOf(1, ["row-1"], [userMessage("m-1", 1)]),
      null,
      null,
    );
    window = appendLiveRecords(window, {
      messages: [userMessage("m-live", 9)],
      events: [],
    });
    const spansBefore = window.spans.length;
    expect(spansBefore).toBeGreaterThan(0);

    // The budget is the charge BEFORE the turn grows, so nothing but the
    // growth itself can push this window over it.
    const budget = transcriptWindowChargedBytes(window);
    const figureBeforeGrowth = window.hydratedBytes;

    for (let index = 0; index < 8; index += 1) {
      window = streamWindowMessage(
        window,
        "m-live",
        (message) => grownUserMessage(message, index),
        null,
      ).window;
    }

    // Deferred: the stored figure has NOT moved, which is what keeps
    // `settleWindowBytes` off the per-token path.
    expect(window.hydratedBytes).toBe(figureBeforeGrowth);
    // ...but the true charge has, and by more than the budget allows.
    expect(transcriptWindowChargedBytes(window)).toBeGreaterThan(budget);

    const { window: next, outcome } = evictChatWindowForAccountant(
      window,
      budget,
      null,
      [],
    );

    expect(outcome.reclaimedBytes).toBeGreaterThan(0);
    expect(next.spans.length).toBeLessThan(spansBefore);
    // The live row itself survives - it has no ordinal, so evicting it would
    // not be recoverable by range hydration.
    expect(next.liveMessages.map((message) => message.messageId)).toEqual([
      "m-live",
    ]);
  });
});

describe("createChatWindowBudgetBook", () => {
  it("evicts the coldest session first", () => {
    const book = createChatWindowBudgetBook();
    const coldEvict = vi.fn((): EvictionOutcome => ({
      reclaimedBytes: 50,
      protectedBytesByKind: [],
    }));
    const hotEvict = vi.fn((): EvictionOutcome => ({
      reclaimedBytes: 0,
      protectedBytesByKind: [{ kind: "visible", bytes: 80 }],
    }));
    book.attach({
      holderId: "cold",
      touchedAt: () => 1,
      evict: coldEvict,
    });
    book.attach({
      holderId: "hot",
      touchedAt: () => 9,
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

  it("orders eviction by process-wide recency, not per-session publish count", () => {
    const runtime = createProcessMemoryRuntime(fakeEnvironment());
    const aEvict = vi.fn((): EvictionOutcome => ({
      reclaimedBytes: 10,
      protectedBytesByKind: [],
    }));
    const bEvict = vi.fn((): EvictionOutcome => ({
      reclaimedBytes: 10,
      protectedBytesByKind: [],
    }));
    let aStamp = 0;
    let bStamp = 0;
    runtime.chatWindows.attach({
      holderId: "busy-abandoned",
      touchedAt: () => aStamp,
      evict: aEvict,
    });
    runtime.chatWindows.attach({
      holderId: "just-opened",
      touchedAt: () => bStamp,
      evict: bEvict,
    });
    for (let index = 0; index < 5; index += 1) {
      aStamp = runtime.stampChatRecency();
    }
    bStamp = runtime.stampChatRecency();
    runtime.chatWindows.evict(10);
    expect(aEvict).toHaveBeenCalledTimes(1);
    expect(bEvict).not.toHaveBeenCalled();
  });

  it("one plane walk when a cold session publishes and re-enters reconcile", () => {
    const accountant = createMemoryAccountant({
      environment: fakeEnvironment(),
      observedCeilingBytes: 10_000,
    });
    const book = createChatWindowBudgetBook();
    const planeEvict = vi.fn((overBytes: number): EvictionOutcome => {
      return book.evict(overBytes);
    });
    accountant.register({
      planeId: BUDGET_PLANE_IDS.chatWindows,
      softLimitBytes: 100,
      nearThresholdRatio: 0.8,
      evict: planeEvict,
    });
    const coldEvict = vi.fn((): EvictionOutcome => {
      accountant.settle(BUDGET_PLANE_IDS.chatWindows, "cold", 40);
      accountant.reconcile(BUDGET_PLANE_IDS.chatWindows);
      return { reclaimedBytes: 40, protectedBytesByKind: [] };
    });
    const hotEvict = vi.fn((): EvictionOutcome => ({
      reclaimedBytes: 0,
      protectedBytesByKind: [{ kind: "visible", bytes: 80 }],
    }));
    book.attach({
      holderId: "cold",
      touchedAt: () => 1,
      evict: coldEvict,
    });
    book.attach({
      holderId: "hot",
      touchedAt: () => 9,
      evict: hotEvict,
    });
    accountant.settle(BUDGET_PLANE_IDS.chatWindows, "cold", 80);
    accountant.settle(BUDGET_PLANE_IDS.chatWindows, "hot", 80);
    accountant.reconcile(BUDGET_PLANE_IDS.chatWindows);
    expect(planeEvict).toHaveBeenCalledTimes(1);
    expect(coldEvict).toHaveBeenCalledTimes(1);
    expect(hotEvict).toHaveBeenCalledTimes(1);
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

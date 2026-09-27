/**
 * Opt-in, after-GC V8 calibration for an unmounted chat store. Run each
 * fixture alone from clients/gui-app, for example:
 *
 *   NODE_OPTIONS=--expose-gc MEM_FIXTURE=small bunx vitest run src/stores/replica-memory/__tests__/chat-store-calibration.test.ts
 *
 * Repeat with many-row and large-body. The first store warms module/shape
 * costs; each reported delta includes construction of the remaining stores.
 * This measures managed JS data, not DOM or full renderer memory.
 */
import { expect, it } from "vitest";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import {
  getProcessMemoryRuntime,
  resetProcessMemoryRuntimeForTests,
} from "@/stores/replica-memory/process-memory-accountant";

type Fixture = {
  name: string;
  stores: number;
  rows: number;
  bodyBytes: number;
};

function usedAfterGc(): number {
  if (global.gc === undefined) throw new Error("run with node --expose-gc");
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
}

function body(length: number, seed: number): string {
  const bytes = Buffer.allocUnsafe(length);
  let value = seed + 1;
  for (let index = 0; index < length; index += 1) {
    value = (value * 1664525 + 1013904223) >>> 0;
    bytes[index] = 97 + (value % 26);
  }
  return bytes.toString("latin1");
}

function userMessage(
  storeIndex: number,
  rowIndex: number,
  bodyBytes: number,
): Message {
  return {
    role: "user" as const,
    messageId: `message-${storeIndex}-${rowIndex}`,
    sender: { type: "user" as const, userId: "owner-calibration" },
    message: {
      kind: "user" as const,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: body(bodyBytes, storeIndex * 10000 + rowIndex),
              },
            ],
          },
        ],
      },
      browserAnnotations: [],
    },
    timestamp: rowIndex + 1,
    sessionAnchor: null,
  };
}

function snapshot(
  storeIndex: number,
  fixture: Fixture,
): Parameters<ChatStreamCallbacks["onWindowedSnapshot"]>[0] {
  const chatId = `chat-calibration-${storeIndex}`;
  const messages = Array.from({ length: fixture.rows }, (_, index) =>
    userMessage(storeIndex, index, fixture.bodyBytes),
  );
  return {
    kind: "snapshot" as const,
    hasBinaryPayload: false,
    epicId: "epic-calibration",
    chatId,
    snapshot: {
      chat: {
        id: chatId,
        parentId: null,
        userId: "owner-calibration",
        hostId: "host-calibration",
        title: "Calibration chat",
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
      access: {
        role: "owner" as const,
        ownerUserId: "owner-calibration",
        canAct: true,
      },
      queue: { status: "idle" as const, items: [] },
      runStatus: "idle" as const,
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
      transcriptEpoch: 1,
      rowCount: messages.length,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages, events: [] },
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

function chargedBytes(): number {
  const plane = getProcessMemoryRuntime()
    .accountant.snapshot()
    .planes.find((entry) => entry.planeId === "chat-windows");
  if (plane === undefined) throw new Error("chat-windows plane absent");
  return plane.settledBytes + plane.provisionalBytes;
}

function openStore(index: number) {
  const callbackBox: { current: ChatStreamCallbacks | null } = {
    current: null,
  };
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-calibration",
    epicId: "epic-calibration",
    chatId: `chat-calibration-${index}`,
    userId: "owner-calibration",
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      callbackBox.current = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        draftBlobBridgeSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  if (callbackBox.current === null) throw new Error("missing callbacks");
  return { handle, callbacks: callbackBox.current };
}

export function measure(fixture: Fixture) {
  resetProcessMemoryRuntimeForTests();
  const warmup = openStore(-1);
  warmup.callbacks.onWindowedSnapshot(
    snapshot(-1, {
      name: "warmup",
      stores: 1,
      rows: 1,
      bodyBytes: 8,
    }),
  );
  const before = usedAfterGc();
  const accountedBefore = chargedBytes();
  const held = Array.from({ length: fixture.stores }, (_, index) =>
    openStore(index),
  );
  (globalThis as { calibrationHeld?: unknown }).calibrationHeld = {
    warmup,
    held,
  };
  held.forEach((item, index) =>
    item.callbacks.onWindowedSnapshot(snapshot(index, fixture)),
  );
  const after = usedAfterGc();
  const accountedAfter = chargedBytes();
  const deltaBytes = after - before;
  const accountedBytes = accountedAfter - accountedBefore;
  return {
    fixture: fixture.name,
    stores: fixture.stores,
    rowsPerStore: fixture.rows,
    rawBodyBytes: fixture.stores * fixture.rows * fixture.bodyBytes,
    accountedBytes,
    deltaBytes,
    relativeError: Math.abs(accountedBytes - deltaBytes) / deltaBytes,
  };
}

it("reports unmounted chat store calibration when requested", () => {
  const selected = process.env.MEM_FIXTURE;
  if (selected === undefined) return;
  const fixtures = new Map<string, Fixture>([
    ["small", { name: "small", stores: 50, rows: 1, bodyBytes: 24 }],
    ["many-row", { name: "many-row", stores: 3, rows: 300, bodyBytes: 24 }],
    [
      "large-body",
      { name: "large-body", stores: 5, rows: 1, bodyBytes: 200_000 },
    ],
  ]);
  const fixture = fixtures.get(selected);
  if (fixture === undefined) throw new Error(`Unknown fixture: ${selected}`);
  const result = measure(fixture);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  expect(result.relativeError).toBeLessThanOrEqual(0.3);
});

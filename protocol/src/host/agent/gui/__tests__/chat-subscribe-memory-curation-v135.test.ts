import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSubscribeV134,
  chatSubscribeV135,
  chatSubscribeV136,
  chatSubscribeV137,
  openChatSubscribeWindowedServerFrameSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.35` adds the `memory-curation` queue item: the ask that the
 * environment's main bot curate its shared memory. `1.32` through `1.34` bind a
 * frozen six-arm queue, so a frame carrying the item parses on `1.35` and is
 * refused on `1.34` (the host omits the item for those peers). `1.36` carries
 * the same frames unchanged, so the item parses there too.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];

const envelope = {
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
};

const memoryCurationItem = {
  kind: "memory-curation",
  queueItemId: "queue-item-1",
  description: "Curate the environment memory",
  createdAt: 1000,
  updatedAt: 1000,
};

const taskOverdueItem = {
  kind: "task-overdue",
  queueItemId: "queue-item-2",
  description: "A task is overdue",
  createdAt: 1000,
  updatedAt: 1000,
};

function queueChangedFrame(items: readonly object[]): Record<string, unknown> {
  return {
    kind: "queueChanged",
    ...envelope,
    queue: { status: "idle", items },
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected object for ${label}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function windowedSnapshotFrame(
  items: readonly object[],
): Record<string, unknown> {
  return {
    kind: "snapshot",
    ...envelope,
    snapshot: {
      chat: {
        parentId: null,
        id: "chat-1",
        userId: "user-1",
        hostId: "host-1",
        title: "Chat",
        createdAt: 1000,
        updatedAt: 1000,
        isTitleEditedByUser: false,
      },
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items },
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      transcriptEpoch: 0,
      rowCount: 0,
      indexRevision: null,
      tail: { fromOrdinal: 0, messages: [], events: [] },
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

const SURFACES = [
  { name: "queueChanged", frame: queueChangedFrame },
  { name: "windowed snapshot", frame: windowedSnapshotFrame },
] as const;

describe("chat.subscribe@1.35 registration", () => {
  it("binds chatSubscribeV135 above the frozen 1.34, under the 1.37 head", () => {
    expect(line.latestMinor).toBe(37);
    expect(line.versions[37].contract).toBe(chatSubscribeV137);
    expect(line.versions[36].contract).toBe(chatSubscribeV136);
    expect(line.versions[35].contract).toBe(chatSubscribeV135);
    expect(line.versions[34].contract).toBe(chatSubscribeV134);
    expect(chatSubscribeV135.schemaVersion).toEqual({ major: 1, minor: 35 });
    // Frozen since 1.37 added the steer restart reasons to `actionAck`.
    expect(chatSubscribeV135.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV134.serverFrameSchema).not.toBe(
      chatSubscribeV135.serverFrameSchema,
    );
  });

  it("carries 1.35's request, client and server schemas unchanged on 1.36", () => {
    expect(chatSubscribeV136.schemaVersion).toEqual({ major: 1, minor: 36 });
    expect(chatSubscribeV136.openRequestSchema).toBe(
      chatSubscribeV135.openRequestSchema,
    );
    expect(chatSubscribeV136.clientFrameSchema).toBe(
      chatSubscribeV135.clientFrameSchema,
    );
    expect(chatSubscribeV136.serverFrameSchema).toBe(
      chatSubscribeV135.serverFrameSchema,
    );
  });
});

describe.each(SURFACES)("memory-curation item on a $name frame", (surface) => {
  it("parses on 1.35 and defaults delivery, targetTurnId and status", () => {
    const parsed = chatSubscribeV135.serverFrameSchema.parse(
      surface.frame([memoryCurationItem]),
    );
    const queue =
      parsed.kind === "snapshot"
        ? asRecord(parsed.snapshot, "snapshot").queue
        : asRecord(parsed, "frame").queue;
    const items = asRecord(queue, "queue").items;
    if (!Array.isArray(items)) throw new Error("expected queue items");
    expect(items).toEqual([
      {
        ...memoryCurationItem,
        delivery: "next_turn",
        targetTurnId: null,
        status: "pending",
      },
    ]);
  });

  it("parses on 1.36 exactly as on 1.35", () => {
    const frame = surface.frame([memoryCurationItem]);
    expect(chatSubscribeV136.serverFrameSchema.parse(frame)).toEqual(
      chatSubscribeV135.serverFrameSchema.parse(frame),
    );
  });

  it("is refused on 1.34, whose queue is frozen at the six older arms", () => {
    expect(
      chatSubscribeV134.serverFrameSchema.safeParse(
        surface.frame([memoryCurationItem]),
      ).success,
    ).toBe(false);
  });

  it("parses a queue of only the older arms on both 1.34 and 1.35", () => {
    const frame = surface.frame([taskOverdueItem]);
    expect(chatSubscribeV134.serverFrameSchema.safeParse(frame).success).toBe(
      true,
    );
    expect(chatSubscribeV135.serverFrameSchema.safeParse(frame).success).toBe(
      true,
    );
  });
});

describe("a memory-curation item is host-authored", () => {
  it("is refused with a status outside the host-authored set", () => {
    expect(
      chatSubscribeV135.serverFrameSchema.safeParse(
        queueChangedFrame([{ ...memoryCurationItem, status: "failed" }]),
      ).success,
    ).toBe(false);
  });
});

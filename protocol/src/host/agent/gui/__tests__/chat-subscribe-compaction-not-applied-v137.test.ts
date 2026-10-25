import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSubscribeV134,
  chatSubscribeV135,
  chatSubscribeV136,
  chatSubscribeV137,
  chatSubscribeV138,
  chatSubscribeV139,
  openChatSubscribeWindowedServerFrameSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.37` lets an errored compaction say it was `notApplied`:
 * the attempt was refused without anything failing. Every earlier line binds
 * the hand-frozen compaction event and block, so a peer below `1.37` drops the
 * key as unknown and reads the same row as a plain failure, on all three
 * carriers: a `blockDelta` event, the snapshot tail and a `range` row.
 *
 * The frozen snapshot and range are whole-envelope copies, so the cases below
 * also pin that nothing but the flag differs between the flagged and the
 * unflagged frame, and that the settings, queue and tail around the block
 * survive on each line.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];
const MINORS = Object.keys(line.versions).map(Number);
const NOT_APPLIED_MINOR = 37;
const FIRST_WINDOWED_MINOR = 8;
const FIRST_TASK_OVERDUE_MINOR = 27;
const SEND_WOULD_QUEUE_MINOR = 34;
const MEMORY_CURATION_MINOR = 35;
const FROZEN_MINORS = MINORS.filter((minor) => minor < NOT_APPLIED_MINOR);
const FROZEN_WINDOWED_MINORS = FROZEN_MINORS.filter(
  (minor) => minor >= FIRST_WINDOWED_MINOR,
);

const envelope = {
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
};

const access = { role: "owner", ownerUserId: "user-1", canAct: true };

const settings = {
  harnessId: "codex",
  model: "gpt-5.4",
  permissionMode: "supervised",
  reasoningEffort: "high",
  agentMode: "epic",
};

/** The tuple a frame returns: the input plus the schema's defaulted nulls. */
const canonicalSettings = { ...settings, profileId: null, serviceTier: null };

const taskOverdueItem = {
  kind: "task-overdue",
  queueItemId: "queue-item-2",
  description: "A task is overdue",
  createdAt: 1000,
  updatedAt: 1000,
};

const memoryCurationItem = {
  kind: "memory-curation",
  queueItemId: "queue-item-1",
  description: "Curate the environment memory",
  createdAt: 1000,
  updatedAt: 1000,
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected object for ${label}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function asArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`expected array for ${label}`);
  return value;
}

function compactionErroredBlock(
  notApplied: boolean | undefined,
): Record<string, unknown> {
  return {
    blockId: "compaction-1",
    status: "errored",
    timestamp: 1,
    type: "compaction",
    trigger: "auto",
    preTokens: 900,
    postTokens: null,
    durationMs: null,
    summary: null,
    error: "Copilot did not apply this compaction.",
    ...(notApplied === undefined ? {} : { notApplied }),
  };
}

function compactionErroredEvent(
  notApplied: boolean | undefined,
): Record<string, unknown> {
  return {
    type: "compaction.errored",
    blockId: "compaction-1",
    timestamp: 1,
    trigger: "auto",
    preTokens: 900,
    error: "Copilot did not apply this compaction.",
    ...(notApplied === undefined ? {} : { notApplied }),
  };
}

function assistantRow(block: Record<string, unknown>): Record<string, unknown> {
  return {
    role: "assistant",
    messageId: "assistant-1",
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: "Coder",
    },
    blocks: [block],
    timestamp: 2,
    turnId: "turn-1",
    usage: null,
  };
}

function chatRecord(messages: readonly unknown[]): Record<string, unknown> {
  return {
    parentId: null,
    id: "chat-1",
    userId: "user-1",
    hostId: "host-1",
    title: "Chat",
    createdAt: 1000,
    updatedAt: 1000,
    isTitleEditedByUser: false,
    settings,
    ...(messages.length > 0 ? { messages } : {}),
  };
}

/** Queue arms every minor from the one that introduced them accepts. */
function queueItemsFor(minor: number): readonly Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (minor >= FIRST_TASK_OVERDUE_MINOR) items.push(taskOverdueItem);
  if (minor >= MEMORY_CURATION_MINOR) items.push(memoryCurationItem);
  return items;
}

function queueFor(minor: number): Record<string, unknown> {
  return { status: "idle", items: queueItemsFor(minor) };
}

function itemKinds(items: readonly unknown[]): readonly unknown[] {
  return items.map((item) => asRecord(item, "queue item").kind);
}

function blockDeltaFrame(
  notApplied: boolean | undefined,
): Record<string, unknown> {
  return {
    kind: "blockDelta",
    ...envelope,
    event: compactionErroredEvent(notApplied),
  };
}

/** The full (non-windowed) snapshot the `1.0`-`1.7` lines send. */
function fullSnapshotFrame(
  notApplied: boolean | undefined,
): Record<string, unknown> {
  return {
    kind: "snapshot",
    ...envelope,
    snapshot: {
      chat: chatRecord([assistantRow(compactionErroredBlock(notApplied))]),
      access,
      queue: { status: "idle", items: [] },
      activeTurn: null,
      runStatus: "idle",
      pendingApprovals: [],
      pendingInterviews: [],
      pendingFileEditApprovals: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      accumulatedFileChanges: [],
      managedCommands: [],
    },
  };
}

function windowedSnapshotFrame(
  minor: number,
  notApplied: boolean | undefined,
): Record<string, unknown> {
  return {
    kind: "snapshot",
    ...envelope,
    snapshot: {
      chat: chatRecord([]),
      access,
      queue: queueFor(minor),
      runStatus: "idle",
      activeTurn: null,
      pendingApprovals: [],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      transcriptEpoch: 0,
      rowCount: 1,
      indexRevision: null,
      ...(minor >= SEND_WOULD_QUEUE_MINOR ? { sendWouldQueue: true } : {}),
      tail: {
        fromOrdinal: 0,
        messages: [assistantRow(compactionErroredBlock(notApplied))],
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

function rangeFrame(notApplied: boolean | undefined): Record<string, unknown> {
  return {
    kind: "range",
    ...envelope,
    range: {
      requestId: "range-1",
      epoch: 0,
      fromOrdinal: 0,
      rowIds: ["assistant-1"],
      messages: [assistantRow(compactionErroredBlock(notApplied))],
      events: [],
      reachedStart: true,
      reachedEnd: true,
    },
  };
}

type Surface = {
  readonly name: string;
  readonly frame: (
    minor: number,
    notApplied: boolean | undefined,
  ) => Record<string, unknown>;
  /** The decoded compaction block or event on whichever carrier. */
  readonly compaction: (
    parsed: Record<string, unknown>,
    minor: number,
  ) => Record<string, unknown>;
};

const SURFACES: readonly Surface[] = [
  {
    name: "blockDelta event",
    frame: (_minor, notApplied) => blockDeltaFrame(notApplied),
    compaction: (parsed) => asRecord(parsed.event, "event"),
  },
  {
    name: "snapshot tail",
    frame: (minor, notApplied) =>
      minor < FIRST_WINDOWED_MINOR
        ? fullSnapshotFrame(notApplied)
        : windowedSnapshotFrame(minor, notApplied),
    compaction: (parsed, minor) => {
      const snapshot = asRecord(parsed.snapshot, "snapshot");
      const messages =
        minor < FIRST_WINDOWED_MINOR
          ? asRecord(snapshot.chat, "chat").messages
          : asRecord(snapshot.tail, "tail").messages;
      const row = asRecord(asArray(messages, "messages")[0], "row");
      return asRecord(asArray(row.blocks, "blocks")[0], "block");
    },
  },
  {
    name: "range row",
    frame: (_minor, notApplied) => rangeFrame(notApplied),
    compaction: (parsed) => {
      const range = asRecord(parsed.range, "range");
      const row = asRecord(asArray(range.messages, "messages")[0], "row");
      return asRecord(asArray(row.blocks, "blocks")[0], "block");
    },
  },
];

/** Surfaces the line carries: a range exists only on the windowed lines. */
function surfacesFor(minor: number): readonly Surface[] {
  return SURFACES.filter(
    (surface) => surface.name !== "range row" || minor >= FIRST_WINDOWED_MINOR,
  );
}

function parseFrame(
  minor: number,
  frame: Record<string, unknown>,
): Record<string, unknown> {
  const result =
    line.versions[minor].contract.serverFrameSchema.safeParse(frame);
  expect(result.success, `1.${minor} must parse the frame`).toBe(true);
  if (!result.success) throw new Error(`1.${minor} refused the frame`);
  return asRecord(result.data, "frame");
}

describe("chat.subscribe@1.37 registration", () => {
  it("binds chatSubscribeV137 above 1.36, frozen under the 1.39 head", () => {
    expect(line.latestMinor).toBe(39);
    expect(line.versions[39].contract).toBe(chatSubscribeV139);
    expect(line.versions[38].contract).toBe(chatSubscribeV138);
    expect(line.versions[37].contract).toBe(chatSubscribeV137);
    expect(line.versions[36].contract).toBe(chatSubscribeV136);
    expect(line.versions[35].contract).toBe(chatSubscribeV135);
    expect(chatSubscribeV137.schemaVersion).toEqual({ major: 1, minor: 37 });
    expect(chatSubscribeV137.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV138.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV139.serverFrameSchema).toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV136.serverFrameSchema).not.toBe(
      chatSubscribeV137.serverFrameSchema,
    );
  });

  it("registers every minor from 1.0 through 1.39", () => {
    expect([...MINORS].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, minor) => minor),
    );
  });
});

describe.each(SURFACES)(
  "a compaction.errored outcome on a $name",
  (surface) => {
    const { serverFrameSchema } = chatSubscribeV137;

    it("keeps notApplied: true exactly as sent on 1.37", () => {
      const parsed = asRecord(
        serverFrameSchema.parse(surface.frame(NOT_APPLIED_MINOR, true)),
        "frame",
      );
      expect(surface.compaction(parsed, NOT_APPLIED_MINOR).notApplied).toBe(
        true,
      );
    });

    it("keeps an explicit false on 1.37", () => {
      const parsed = asRecord(
        serverFrameSchema.parse(surface.frame(NOT_APPLIED_MINOR, false)),
        "frame",
      );
      expect(surface.compaction(parsed, NOT_APPLIED_MINOR).notApplied).toBe(
        false,
      );
    });

    it("reads an absent flag as a plain failure on 1.37", () => {
      const parsed = asRecord(
        serverFrameSchema.parse(surface.frame(NOT_APPLIED_MINOR, undefined)),
        "frame",
      );
      const decoded = surface.compaction(parsed, NOT_APPLIED_MINOR);
      if (surface.name === "blockDelta event") {
        // The event keeps the key optional; only the stored block defaults it.
        expect(decoded.notApplied).toBeUndefined();
      } else {
        expect(decoded.notApplied).toBe(false);
      }
    });

    it("refuses a non-boolean flag on 1.37", () => {
      const frame = surface.frame(NOT_APPLIED_MINOR, undefined);
      const carrier = JSON.stringify(frame).replace(
        /"error":"Copilot did not apply this compaction\."/,
        '"error":"Copilot did not apply this compaction.","notApplied":"yes"',
      );
      expect(serverFrameSchema.safeParse(JSON.parse(carrier)).success).toBe(
        false,
      );
    });
  },
);

describe("every frozen chat.subscribe line strips the compaction notApplied flag", () => {
  it("covers 1.0 through 1.36", () => {
    expect([...FROZEN_MINORS].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 37 }, (_, minor) => minor),
    );
  });

  for (const surface of SURFACES) {
    describe(surface.name, () => {
      it.each(
        FROZEN_MINORS.filter(
          (minor) =>
            surface.name !== "range row" || minor >= FIRST_WINDOWED_MINOR,
        ),
      )("1.%i drops the flag and keeps the rest of the frame", (minor) => {
        const flagged = parseFrame(minor, surface.frame(minor, true));
        const unflagged = parseFrame(minor, surface.frame(minor, undefined));
        expect(surface.compaction(flagged, minor)).not.toHaveProperty(
          "notApplied",
        );
        expect(flagged).toEqual(unflagged);
      });
    });
  }
});

describe("the frozen windowed snapshot keeps its settings, queue and tail", () => {
  it.each(FROZEN_WINDOWED_MINORS)(
    "1.%i keeps the run settings, queue items, tail row and derived block",
    (minor) => {
      const parsed = parseFrame(minor, windowedSnapshotFrame(minor, true));
      const snapshot = asRecord(parsed.snapshot, "snapshot");
      expect(asRecord(snapshot.chat, "chat").settings).toEqual(
        canonicalSettings,
      );
      expect(
        itemKinds(
          asArray(asRecord(snapshot.queue, "queue").items, "queue items"),
        ),
      ).toEqual(itemKinds(queueItemsFor(minor)));
      expect(
        asArray(asRecord(snapshot.tail, "tail").messages, "tail"),
      ).toHaveLength(1);
      expect(snapshot.derived).toBeDefined();
      expect(snapshot.sendWouldQueue).toBe(
        minor >= SEND_WOULD_QUEUE_MINOR ? true : undefined,
      );
    },
  );
});

describe("the 1.37 snapshot keeps the retained boundaries", () => {
  it("carries both queue arms, sendWouldQueue and the flag together", () => {
    const parsed = parseFrame(
      NOT_APPLIED_MINOR,
      windowedSnapshotFrame(NOT_APPLIED_MINOR, true),
    );
    const snapshot = asRecord(parsed.snapshot, "snapshot");
    const kinds = itemKinds(
      asArray(asRecord(snapshot.queue, "queue").items, "items"),
    );
    expect(kinds).toEqual(["task-overdue", "memory-curation"]);
    expect(snapshot.sendWouldQueue).toBe(true);
    expect(asRecord(snapshot.chat, "chat").settings).toEqual(canonicalSettings);
    expect(SURFACES[1].compaction(parsed, NOT_APPLIED_MINOR).notApplied).toBe(
      true,
    );
  });

  it("1.35 keeps the memory-curation item and strips the flag from the same frame", () => {
    const frame = windowedSnapshotFrame(NOT_APPLIED_MINOR, true);
    const parsed = parseFrame(35, frame);
    const snapshot = asRecord(parsed.snapshot, "snapshot");
    const kinds = itemKinds(
      asArray(asRecord(snapshot.queue, "queue").items, "items"),
    );
    expect(kinds).toEqual(["task-overdue", "memory-curation"]);
    expect(SURFACES[1].compaction(parsed, 35)).not.toHaveProperty("notApplied");
  });

  it("1.34 refuses the memory-curation item that 1.35, 1.36 and 1.37 accept", () => {
    const frame = windowedSnapshotFrame(NOT_APPLIED_MINOR, undefined);
    expect(chatSubscribeV134.serverFrameSchema.safeParse(frame).success).toBe(
      false,
    );
    expect(chatSubscribeV135.serverFrameSchema.safeParse(frame).success).toBe(
      true,
    );
    expect(chatSubscribeV136.serverFrameSchema.safeParse(frame).success).toBe(
      true,
    );
    expect(chatSubscribeV137.serverFrameSchema.safeParse(frame).success).toBe(
      true,
    );
  });
});

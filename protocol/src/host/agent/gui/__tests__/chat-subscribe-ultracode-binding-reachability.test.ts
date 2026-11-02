import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";

/**
 * Every frozen `chat.subscribe` line binds a whole snapshot, so the per-chat
 * Ultracode request has to be absent on each of them by that line's own
 * schema, not by a projection that could be skipped. The same snapshot carries
 * the `1.37` compaction flag, which gives the cliff its two edges: lines
 * `0`-`36` drop both new keys, lines `37`-`40` keep the compaction flag and
 * still drop the request, and `41` keeps both.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];
const MINORS = Object.keys(line.versions)
  .map(Number)
  .sort((a, b) => a - b);

const FIRST_WINDOWED_MINOR = 8;
const FIRST_TASK_OVERDUE_MINOR = 27;
const SEND_WOULD_QUEUE_MINOR = 34;
const MEMORY_CURATION_MINOR = 35;
const NOT_APPLIED_MINOR = 37;
const ULTRACODE_MINOR = 41;

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
const canonicalSettings = { ...settings, profileId: null, serviceTier: null };

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

const compactionBlock = {
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
  notApplied: true,
};

const assistantRow = {
  role: "assistant",
  messageId: "assistant-1",
  sender: {
    type: "agent",
    harnessId: "claude",
    agentId: "agent-1",
    displayName: "Coder",
  },
  blocks: [compactionBlock],
  timestamp: 2,
  turnId: "turn-1",
  usage: null,
};

function chatRecord(withMessages: boolean): Record<string, unknown> {
  return {
    parentId: null,
    id: "chat-1",
    userId: "user-1",
    hostId: "host-1",
    title: "Chat",
    createdAt: 1000,
    updatedAt: 1000,
    isTitleEditedByUser: false,
    settings: { ...settings, ultracode: true },
    ...(withMessages ? { messages: [assistantRow] } : {}),
  };
}

function queueItemsFor(minor: number): readonly Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (minor >= FIRST_TASK_OVERDUE_MINOR) {
    items.push({
      kind: "task-overdue",
      queueItemId: "queue-item-2",
      description: "A task is overdue",
      createdAt: 1000,
      updatedAt: 1000,
    });
  }
  if (minor >= MEMORY_CURATION_MINOR) {
    items.push({
      kind: "memory-curation",
      queueItemId: "queue-item-1",
      description: "Curate the environment memory",
      createdAt: 1000,
      updatedAt: 1000,
    });
  }
  return items;
}

function snapshotFrame(minor: number): Record<string, unknown> {
  if (minor < FIRST_WINDOWED_MINOR) {
    return {
      kind: "snapshot",
      ...envelope,
      snapshot: {
        chat: chatRecord(true),
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
  return {
    kind: "snapshot",
    ...envelope,
    snapshot: {
      chat: chatRecord(false),
      access,
      queue: { status: "idle", items: queueItemsFor(minor) },
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
      tail: { fromOrdinal: 0, messages: [assistantRow], events: [] },
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

function parsed(minor: number): {
  chatSettings: unknown;
  compaction: Record<string, unknown>;
} {
  const result = line.versions[minor].contract.serverFrameSchema.safeParse(
    snapshotFrame(minor),
  );
  expect(result.success, `1.${minor} must parse the snapshot`).toBe(true);
  if (!result.success) throw new Error(`1.${minor} refused the snapshot`);
  const snapshot = asRecord(
    asRecord(result.data, "frame").snapshot,
    "snapshot",
  );
  const chat = asRecord(snapshot.chat, "chat");
  const messages =
    minor < FIRST_WINDOWED_MINOR
      ? chat.messages
      : asRecord(snapshot.tail, "tail").messages;
  const row = asRecord(asArray(messages, "messages")[0], "row");
  return {
    chatSettings: chat.settings,
    compaction: asRecord(asArray(row.blocks, "blocks")[0], "block"),
  };
}

describe("chat.subscribe binding reachability for the Ultracode request", () => {
  it("registers every minor from 1.0 through the 1.41 head", () => {
    expect(MINORS).toEqual(
      Array.from({ length: ULTRACODE_MINOR + 1 }, (_, minor) => minor),
    );
    expect(line.latestMinor).toBe(ULTRACODE_MINOR);
  });

  it.each(MINORS.filter((minor) => minor < ULTRACODE_MINOR))(
    "1.%i drops the request from the chat settings and keeps the rest of the tuple",
    (minor) => {
      const { chatSettings } = parsed(minor);
      expect(chatSettings).toEqual(canonicalSettings);
    },
  );

  it.each(MINORS.filter((minor) => minor < NOT_APPLIED_MINOR))(
    "1.%i drops the compaction flag as well: the cliff's lower edge",
    (minor) => {
      expect(parsed(minor).compaction).not.toHaveProperty("notApplied");
    },
  );

  it.each(
    MINORS.filter(
      (minor) => minor >= NOT_APPLIED_MINOR && minor < ULTRACODE_MINOR,
    ),
  )(
    "1.%i keeps the compaction flag while still dropping the request: the cliff's upper edge",
    (minor) => {
      const { chatSettings, compaction } = parsed(minor);
      expect(compaction.notApplied).toBe(true);
      expect(chatSettings).toEqual(canonicalSettings);
    },
  );

  it("1.41 keeps both", () => {
    const { chatSettings, compaction } = parsed(ULTRACODE_MINOR);
    expect(compaction.notApplied).toBe(true);
    expect(chatSettings).toEqual({ ...canonicalSettings, ultracode: true });
  });
});

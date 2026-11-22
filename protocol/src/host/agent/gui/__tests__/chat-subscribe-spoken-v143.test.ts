import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { snapshotUserMessageSchema } from "@traycer/protocol/persistence/chat-sync/open-harness";
import { messageSchema } from "@traycer/protocol/persistence/epic/messages";

/**
 * `chat.subscribe@1.43` lets a member's user row say `spoken`: its words were
 * spoken on a call. Every earlier line binds a hand-frozen user row, so a peer
 * below `1.43` drops the key as unknown and reads the same row as the plain
 * message it is, on all three ways a row reaches a client: the windowed
 * snapshot's tail, a `range` frame and the `messageAccepted` frame. The row
 * is stored with it too: in the epic record and in a chat-sync shard.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];

const LIVE_MINOR = 43;
/** The frozen lines that bind the open user row without `spoken`, one per family of common frames. */
const FROZEN_MINORS = [42, 41, 40, 37];

const envelope = {
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
};

const settings = {
  harnessId: "codex",
  model: "gpt-5.4",
  permissionMode: "supervised",
  reasoningEffort: "high",
  agentMode: "epic",
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected object for ${label}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function firstOf(value: unknown, label: string): Record<string, unknown> {
  if (!Array.isArray(value)) throw new Error(`expected array for ${label}`);
  return asRecord(value[0], label);
}

function userRow(spoken: boolean): Record<string, unknown> {
  return {
    role: "user",
    messageId: "user-1",
    sender: { type: "user", userId: "user-1" },
    message: {
      kind: "user",
      content: { type: "doc", content: [] },
      browserAnnotations: [],
    },
    timestamp: 2,
    sessionAnchor: null,
    ...(spoken ? { spoken: true } : {}),
  };
}

function windowedSnapshotFrame(spoken: boolean): Record<string, unknown> {
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
        settings,
      },
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items: [] },
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
      tail: { fromOrdinal: 0, messages: [userRow(spoken)], events: [] },
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

function rangeFrame(spoken: boolean): Record<string, unknown> {
  return {
    kind: "range",
    ...envelope,
    range: {
      requestId: "range-1",
      epoch: 0,
      fromOrdinal: 0,
      rowIds: ["user-1"],
      messages: [userRow(spoken)],
      events: [],
      reachedStart: true,
      reachedEnd: true,
    },
  };
}

function messageAcceptedFrame(spoken: boolean): Record<string, unknown> {
  return { kind: "messageAccepted", ...envelope, message: userRow(spoken) };
}

type Channel = {
  readonly name: string;
  readonly frame: (spoken: boolean) => Record<string, unknown>;
  /** The decoded user row on this channel. */
  readonly rowOf: (parsed: Record<string, unknown>) => Record<string, unknown>;
};

const CHANNELS: readonly Channel[] = [
  {
    name: "windowed snapshot tail",
    frame: windowedSnapshotFrame,
    rowOf: (parsed) => {
      const snapshot = asRecord(parsed.snapshot, "snapshot");
      return firstOf(asRecord(snapshot.tail, "tail").messages, "tail row");
    },
  },
  {
    name: "range frame",
    frame: rangeFrame,
    rowOf: (parsed) =>
      firstOf(asRecord(parsed.range, "range").messages, "range row"),
  },
  {
    name: "messageAccepted frame",
    frame: messageAcceptedFrame,
    rowOf: (parsed) => asRecord(parsed.message, "message"),
  },
];

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

describe.each(CHANNELS)("a spoken user row on the $name", (channel) => {
  it("keeps spoken: true on 1.43", () => {
    const row = channel.rowOf(parseFrame(LIVE_MINOR, channel.frame(true)));

    expect(row.spoken).toBe(true);
  });

  it.each(FROZEN_MINORS)(
    "1.%i drops the flag and reads the rest of the row as sent",
    (minor) => {
      const stripped = channel.rowOf(parseFrame(minor, channel.frame(true)));
      const typed = channel.rowOf(parseFrame(minor, channel.frame(false)));

      expect(stripped).toEqual(typed);
    },
  );
});

describe("a spoken user row at rest", () => {
  it("round-trips through the epic message and the chat-sync shard row", () => {
    const row = userRow(true);
    // A shard row keeps `sessionAnchor` in the chat's host-private section.
    const { sessionAnchor: _sessionAnchor, ...shardRow } = row;

    expect(messageSchema.parse(row)).toMatchObject({ spoken: true });
    expect(snapshotUserMessageSchema.parse(shardRow)).toMatchObject({
      spoken: true,
    });
  });
});

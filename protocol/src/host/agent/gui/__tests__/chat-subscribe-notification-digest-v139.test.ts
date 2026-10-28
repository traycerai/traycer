import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSubscribeV135,
  chatSubscribeV136,
  chatSubscribeV137,
  chatSubscribeV138,
  chatSubscribeV139,
  openChatSubscribeWindowedServerFrameSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { CHAT_SUBSCRIBE_NOTIFICATION_DIGEST_MINOR } from "@traycer/protocol/host/agent/gui/chat-frame-compat";

/**
 * `chat.subscribe@1.39` adds the `notification-digest` queue item: a digest of
 * the person's notification feed, composed by the bot's host and waiting on the
 * queue of the personal bot chat that subscribed to it. `1.35` through `1.38`
 * bind a frozen seven-arm queue, so a frame carrying the item parses on `1.39`
 * and is refused on every older line (the host omits the item for those peers,
 * from the queue and from the queue events alike).
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];

const envelope = {
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
};

const attentionRow = {
  notificationId: "notif-1",
  entity: { kind: "task", id: "task-1", title: "Ship the release" },
  severity: "error",
  operation: "failed",
  title: "The release run failed",
  at: 1500,
  read: false,
};

const recentRow = {
  notificationId: "notif-2",
  entity: null,
  severity: "info",
  operation: "completed",
  title: "A chat finished",
  at: 1600,
  read: true,
};

const digestItem = {
  kind: "notification-digest",
  queueItemId: "queue-item-1",
  description: "Notification digest",
  createdAt: 2000,
  updatedAt: 2000,
  window: { fromVersion: 3, throughVersion: 9, from: 1000, through: 2000 },
  attention: [attentionRow],
  recent: [recentRow],
  truncated: false,
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

function queueItems(frame: unknown): unknown[] {
  const record = asRecord(frame, "frame");
  const holder =
    record.kind === "snapshot" ? asRecord(record.snapshot, "snapshot") : record;
  const items = asRecord(holder.queue, "queue").items;
  if (!Array.isArray(items)) throw new Error("expected queue items");
  return items;
}

const SURFACES = [
  { name: "queueChanged", frame: queueChangedFrame },
  { name: "windowed snapshot", frame: windowedSnapshotFrame },
] as const;

describe("chat.subscribe@1.39 registration", () => {
  it("binds chatSubscribeV139 as the registry head and the live frame schema", () => {
    expect(line.latestMinor).toBe(39);
    expect(line.versions[39].contract).toBe(chatSubscribeV139);
    expect(chatSubscribeV139.schemaVersion).toEqual({ major: 1, minor: 39 });
    expect(chatSubscribeV139.serverFrameSchema).toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(CHAT_SUBSCRIBE_NOTIFICATION_DIGEST_MINOR).toBe(39);
  });

  it("freezes 1.38 on its own frame schema, with the request and client frames unchanged", () => {
    expect(chatSubscribeV138.serverFrameSchema).not.toBe(
      chatSubscribeV139.serverFrameSchema,
    );
    expect(chatSubscribeV139.openRequestSchema).toBe(
      chatSubscribeV138.openRequestSchema,
    );
    expect(chatSubscribeV139.clientFrameSchema).toBe(
      chatSubscribeV138.clientFrameSchema,
    );
  });
});

describe.each(SURFACES)(
  "notification-digest item on a $name frame",
  (surface) => {
    it("parses on 1.39 with its window, rows and defaults", () => {
      const parsed = chatSubscribeV139.serverFrameSchema.parse(
        surface.frame([digestItem]),
      );
      expect(queueItems(parsed)).toEqual([
        {
          ...digestItem,
          delivery: "next_turn",
          targetTurnId: null,
          status: "pending",
        },
      ]);
    });

    it("parses an attention-only digest whose recent rows are null, over a restarted window", () => {
      const attentionOnly = {
        ...digestItem,
        window: { ...digestItem.window, from: null },
        recent: null,
        truncated: true,
      };
      const parsed = chatSubscribeV139.serverFrameSchema.parse(
        surface.frame([attentionOnly]),
      );
      expect(queueItems(parsed)).toEqual([
        {
          ...attentionOnly,
          delivery: "next_turn",
          targetTurnId: null,
          status: "pending",
        },
      ]);
    });

    it("decodes a feed severity and operation it has never heard of", () => {
      const unknownStrings = {
        ...digestItem,
        attention: [
          { ...attentionRow, severity: "critical", operation: "paged" },
        ],
      };
      expect(
        chatSubscribeV139.serverFrameSchema.safeParse(
          surface.frame([unknownStrings]),
        ).success,
      ).toBe(true);
    });

    it.each([
      ["1.38", chatSubscribeV138],
      ["1.37", chatSubscribeV137],
      ["1.36", chatSubscribeV136],
      ["1.35", chatSubscribeV135],
    ])(
      "is refused on %s, whose queue is frozen at the seven older arms",
      (_label, contract) => {
        expect(
          contract.serverFrameSchema.safeParse(surface.frame([digestItem]))
            .success,
        ).toBe(false);
      },
    );

    it("parses a queue of only the older arms on both 1.38 and 1.39", () => {
      const frame = surface.frame([taskOverdueItem]);
      expect(chatSubscribeV138.serverFrameSchema.safeParse(frame).success).toBe(
        true,
      );
      expect(chatSubscribeV139.serverFrameSchema.safeParse(frame).success).toBe(
        true,
      );
    });
  },
);

describe("a notification-digest item is host-authored and shaped", () => {
  it("is refused with a status outside the host-authored set", () => {
    expect(
      chatSubscribeV139.serverFrameSchema.safeParse(
        queueChangedFrame([{ ...digestItem, status: "failed" }]),
      ).success,
    ).toBe(false);
  });

  it.each([
    ["no window", { window: undefined }],
    [
      "a fractional window version",
      { window: { ...digestItem.window, fromVersion: 1.5 } },
    ],
    [
      "a negative window version",
      { window: { ...digestItem.window, throughVersion: -1 } },
    ],
    ["no truncated flag", { truncated: undefined }],
    [
      "an entity kind outside task, chat and bot",
      {
        attention: [
          { ...attentionRow, entity: { kind: "epic", id: "e", title: null } },
        ],
      },
    ],
    [
      "a row without a read state",
      { attention: [{ ...attentionRow, read: undefined }] },
    ],
  ])("is refused with %s", (_label, override) => {
    expect(
      chatSubscribeV139.serverFrameSchema.safeParse(
        queueChangedFrame([{ ...digestItem, ...override }]),
      ).success,
    ).toBe(false);
  });
});

describe("bot.subscribe@1.2 notificationSubscriptions", () => {
  const subscribeLine = hostStreamRpcRegistry["bot.subscribe"][1];
  const v11 = subscribeLine.versions[1].contract;
  const v12 = subscribeLine.versions[2].contract;

  const BOT = {
    botId: "bot_01HZX5Y8K3M2N4P6Q7R8S9T0V1",
    environmentId: "env-1",
    createdByUserId: "owner-1",
    title: "Tracy",
    harness: "claude",
    model: "claude-opus-5-5",
    effort: null,
    profile: null,
    trunkChatId: "trunk-1",
    boundHostId: "host-1",
    hostEpoch: 0,
    createdAt: 1_760_000_000_000,
    archivedAt: null,
    directive: null,
    appConversationChatId: null,
    replyMode: "thread",
  };

  const subscriptions = [
    { target: { kind: "trunk" }, attentionOnly: true, everySeconds: null },
    {
      target: { kind: "thread", threadId: "thread-1" },
      attentionOnly: false,
      everySeconds: 600,
    },
  ];

  function snapshot(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      kind: "snapshot",
      bot: BOT,
      tasks: [],
      openRequestCount: 0,
      conversationsRevision: 0,
      boundHost: { hostId: "host-1", epoch: 0, isThisHost: true },
      activity: null,
      hasBinaryPayload: false,
      ...extra,
    };
  }

  // The line's head is asserted with the minor that heads it (1.3, in
  // `bot-task-entry-schema.test.ts`).
  it("registers 1.2, with 1.1 frozen on its own frame schema", () => {
    expect(v12.schemaVersion).toEqual({ major: 1, minor: 2 });
    expect(v11.serverFrameSchema).not.toBe(v12.serverFrameSchema);
  });

  it("carries the subscriptions on a 1.2 snapshot", () => {
    const parsed = asRecord(
      v12.serverFrameSchema.parse(
        snapshot({ notificationSubscriptions: subscriptions }),
      ),
      "frame",
    );
    expect(parsed.notificationSubscriptions).toEqual(subscriptions);
  });

  it("reads a snapshot without the key, as a host that predates it sends, as null", () => {
    const parsed = asRecord(v12.serverFrameSchema.parse(snapshot({})), "frame");
    expect(parsed.notificationSubscriptions).toBeNull();
  });

  it.each([
    ["a zero interval", { everySeconds: 0 }],
    ["a fractional interval", { everySeconds: 1.5 }],
    ["a thread target with no thread id", { target: { kind: "thread" } }],
  ])("refuses %s", (_label, override) => {
    expect(
      v12.serverFrameSchema.safeParse(
        snapshot({
          notificationSubscriptions: [{ ...subscriptions[0], ...override }],
        }),
      ).success,
    ).toBe(false);
  });

  it("strips the key from a 1.1 subscriber's snapshot", () => {
    const parsed = asRecord(
      v11.serverFrameSchema.parse(
        snapshot({ notificationSubscriptions: subscriptions }),
      ),
      "frame",
    );
    expect(parsed).not.toHaveProperty("notificationSubscriptions");
    expect(parsed.bot).toEqual(BOT);
  });

  it("parses the frames that did not change at 1.2 identically on both lines", () => {
    for (const frame of [
      {
        kind: "activity",
        target: { kind: "trunk" },
        entry: null,
        hasBinaryPayload: false,
      },
      { kind: "deleted", hasBinaryPayload: false },
      { kind: "pong", hasBinaryPayload: false },
    ]) {
      expect(v11.serverFrameSchema.parse(frame)).toEqual(
        v12.serverFrameSchema.parse(frame),
      );
    }
  });
});

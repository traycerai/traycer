import { describe, expect, it } from "vitest";
import {
  chatQueuedItemSchema,
  chatQueuedPortForwardItemSchema,
  chatSubscribeV113,
  chatSubscribeV114,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { chatPortForwardSchema } from "@traycer/protocol/host/port-forward";

/**
 * `chat.subscribe@1.14` - the port-forward line. Covers the three places the
 * surface rides (`chatQueuedItemSchema`'s new arm, `chatPortForwardSchema`'s
 * own shape, and the `portForwardsChanged` / `queueChanged` frames on the
 * `1.13` vs `1.14` server-frame unions), following the pattern
 * `chat-subscribe-held-updates.test.ts` used for the previous whole-set
 * "changed" frame.
 */

const MANAGED_COMMAND_ITEM = {
  kind: "managed-command" as const,
  queueItemId: "queue-managed-1",
  commandId: "command-1",
  description: "bun test --watch",
  status: "pending" as const,
  createdAt: 3000,
  updatedAt: 3000,
};

// The exact shape a released pre-`1.6` host persisted into `queue.added`
// metadata and put on the wire: no `kind` key at all.
const LEGACY_KINDLESS_ITEM = {
  queueItemId: "queue-legacy-1",
  messageId: "message-2",
  message: { kind: "user", content: { type: "doc", content: [] } },
  sender: { type: "user", userId: "user-1" },
  settings: {
    harnessId: "codex",
    model: "gpt-5-codex",
    permissionMode: "supervised",
    reasoningEffort: null,
    agentMode: "epic",
  },
  createdAt: 2001,
  updatedAt: 2002,
};

const PORT_FORWARD_ITEM = {
  kind: "port-forward" as const,
  queueItemId: "queue-pf-1",
  forwardId: "forward-1",
  description: "8080 → laptop:8080",
  createdAt: 5000,
  updatedAt: 5000,
};

const CHAT_PORT_FORWARD = {
  forwardId: "forward-1",
  description: "8080 → laptop:8080",
  target: { hostId: "host-b", port: 8080 },
  listen: { hostId: "host-a", requestedPort: 8080, boundPort: 8080 },
  state: "active" as const,
  stateReason: null,
  createdAtMs: 10,
  recentEvents: [],
};

describe("chatQueuedItemSchema's port-forward arm (chat.subscribe@1.14)", () => {
  // Catches: `chatQueuedPortForwardItemSchema` losing the `kind: z.literal(
  // "port-forward")` discriminant, or the union no longer routing it there.
  it("parses a port-forward item to kind: 'port-forward' with defaults filled", () => {
    const parsed = chatQueuedItemSchema.parse(PORT_FORWARD_ITEM);

    expect(parsed.kind).toBe("port-forward");
    if (parsed.kind !== "port-forward") {
      throw new Error("expected port-forward item");
    }
    expect(parsed.forwardId).toBe("forward-1");
    // Catches: `delivery`/`targetTurnId`/`status` losing their `.default(...)`.
    expect(parsed.delivery).toBe("next_turn");
    expect(parsed.targetTurnId).toBeNull();
    expect(parsed.status).toBe("pending");
    // Content-free like the managed-command arm: nothing to fabricate.
    expect(parsed).not.toHaveProperty("message");
    expect(parsed).not.toHaveProperty("sender");
  });

  // Catches: the port-forward arm being listed before managed-command (or
  // otherwise shadowing it) in the `z.union`.
  it("still parses a managed-command item as its own variant", () => {
    const parsed = chatQueuedItemSchema.parse(MANAGED_COMMAND_ITEM);

    expect(parsed.kind).toBe("managed-command");
    if (parsed.kind !== "managed-command") {
      throw new Error("expected managed-command item");
    }
    expect(parsed.commandId).toBe("command-1");
  });

  // Catches: the prompt arm losing its `.default("prompt")`, or being moved
  // off the LAST union position - either would break every persisted
  // pre-1.6 queue-item payload, which carries no `kind` at all.
  it("still lands a legacy kind-less payload on the prompt arm", () => {
    const parsed = chatQueuedItemSchema.parse(LEGACY_KINDLESS_ITEM);

    expect(parsed.kind).toBe("prompt");
    if (parsed.kind !== "prompt") throw new Error("expected prompt item");
    expect(parsed.messageId).toBe("message-2");
  });

  // The port-forward item's status is deliberately narrower than the prompt
  // lifecycle enum (`chatQueueItemStatusSchema`): "injected" is a real status
  // for a prompt item (a row rendered in the transcript) but is not
  // representable on the content-free port-forward arm. Catches: the
  // port-forward arm's `status` widening to the full prompt enum.
  it("rejects a port-forward item carrying a status only the prompt arm knows", () => {
    const malformed = { ...PORT_FORWARD_ITEM, status: "injected" };

    expect(chatQueuedPortForwardItemSchema.safeParse(malformed).success).toBe(
      false,
    );
    // The whole union rejects it too: the explicit `kind: "port-forward"`
    // cannot fall through to the prompt arm, whose discriminant is a literal
    // "prompt" - `.default()` only fires on an undefined field, not on a
    // conflicting explicit value.
    expect(chatQueuedItemSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("chatPortForwardSchema (chat.subscribe@1.14 row shape)", () => {
  // Catches: `counters` (or any other `ownedPortForwardSchema`-only field)
  // being added to the chat-facing row, and catches a field silently being
  // dropped from it. The doc comment on `chatPortForwardSchema` is explicit
  // that this row carries NO counters - unlike `ownedPortForwardSchema`.
  it("exposes exactly the field list the chat row ships, with no counters key", () => {
    const keys = Object.keys(chatPortForwardSchema.shape).sort();

    expect(keys).toEqual(
      [
        "forwardId",
        "description",
        "target",
        "listen",
        "state",
        "stateReason",
        "createdAtMs",
        "recentEvents",
      ].sort(),
    );
    expect(keys).not.toContain("counters");
  });

  it("parses a well-formed row", () => {
    expect(chatPortForwardSchema.parse(CHAT_PORT_FORWARD)).toEqual(
      CHAT_PORT_FORWARD,
    );
  });
});

describe("chat.subscribe@1.13 vs @1.14: the portForwardsChanged frame", () => {
  const portForwardsChangedFrame = {
    kind: "portForwardsChanged",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    portForwards: [CHAT_PORT_FORWARD],
  };

  // Catches: `chatSubscribeWindowedServerFrameSchema` (bound live by
  // `chatSubscribeV114`) losing its `portForwardsChanged` arm.
  it("1.14 accepts a portForwardsChanged frame", () => {
    const parsed = chatSubscribeV114.serverFrameSchema.parse(
      portForwardsChangedFrame,
    );

    if (parsed.kind !== "portForwardsChanged") {
      throw new Error("expected portForwardsChanged");
    }
    expect(parsed.portForwards).toEqual([CHAT_PORT_FORWARD]);
  });

  // Catches: `portForwards` losing its `.default([])` on the frame.
  it("1.14 defaults an omitted portForwardsChanged set to []", () => {
    const parsed = chatSubscribeV114.serverFrameSchema.parse({
      kind: "portForwardsChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
    });

    if (parsed.kind !== "portForwardsChanged") {
      throw new Error("expected portForwardsChanged");
    }
    expect(parsed.portForwards).toEqual([]);
  });

  // THE regression guard, aimed at `1.13` - the line immediately below this
  // one, exactly as `chat-subscribe-held-updates.test.ts` aims its own guard
  // at the newest line with peers in the field. Catches:
  // `chatSubscribeServerFrameSchemaV113` gaining a `portForwardsChanged`
  // variant (it must have none - `1.14` is the first line that knows this
  // frame kind at all).
  it("1.13 has no variant for portForwardsChanged and rejects it", () => {
    expect(
      chatSubscribeV113.serverFrameSchema.safeParse(portForwardsChangedFrame)
        .success,
    ).toBe(false);
  });
});

describe("chat.subscribe@1.13 vs @1.14: the queueChanged frame's port-forward item", () => {
  function queueChangedFrame(
    items: ReadonlyArray<unknown>,
  ): Record<string, unknown> {
    return {
      kind: "queueChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      queue: { status: "idle", items },
    };
  }

  // Catches: the live `chatQueueStateSchema` (bound by `chatSubscribeV114`'s
  // common frames) losing the port-forward arm on the `queueChanged` frame
  // specifically (as opposed to on `chatQueuedItemSchema` alone).
  it("1.14 accepts a queueChanged frame carrying a port-forward item", () => {
    const parsed = chatSubscribeV114.serverFrameSchema.parse(
      queueChangedFrame([PORT_FORWARD_ITEM]),
    );

    if (parsed.kind !== "queueChanged")
      throw new Error("expected queueChanged");
    expect(parsed.queue.items[0]).toMatchObject({
      kind: "port-forward",
      forwardId: "forward-1",
    });
  });

  // THE regression guard for the queue axis: `chatQueueStateSchemaPrePortForward`
  // (bound by `chatSubscribeV113`'s common frames) must still be the two-arm
  // union it was frozen at. Catches that frozen union silently widening to
  // admit the port-forward arm - which would let an old app parse (and thus
  // partially render) a queue item it has no chip for.
  it("1.13 rejects a queueChanged frame carrying a port-forward item", () => {
    expect(
      chatSubscribeV113.serverFrameSchema.safeParse(
        queueChangedFrame([PORT_FORWARD_ITEM]),
      ).success,
    ).toBe(false);
  });

  // Catches: the `1.13` freeze accidentally dropping the managed-command arm
  // too, rather than narrowly excluding only port-forward - the two-arm
  // union must still admit its OTHER arm.
  it("a managed-command-only queueChanged frame is accepted by both 1.13 and 1.14", () => {
    expect(
      chatSubscribeV113.serverFrameSchema.safeParse(
        queueChangedFrame([MANAGED_COMMAND_ITEM]),
      ).success,
    ).toBe(true);
    expect(
      chatSubscribeV114.serverFrameSchema.safeParse(
        queueChangedFrame([MANAGED_COMMAND_ITEM]),
      ).success,
    ).toBe(true);
  });
});

describe("the chat row's state is two-valued", () => {
  // Catches: `chatPortForwardSchema.state` reusing the four-value
  // `portForwardStateSchema` instead of its own two-value
  // `chatPortForwardStateSchema` - a `binding` or `stopped` row would then pass
  // a schema whose whole job is to admit only the two states a chat row can
  // ever be in.
  it("rejects a row in state 'binding' or 'stopped'", () => {
    expect(
      chatPortForwardSchema.safeParse({
        ...CHAT_PORT_FORWARD,
        state: "binding",
      }).success,
    ).toBe(false);
    expect(
      chatPortForwardSchema.safeParse({
        ...CHAT_PORT_FORWARD,
        state: "stopped",
      }).success,
    ).toBe(false);
  });

  it("parses a row in state 'active' or 'interrupted'", () => {
    expect(
      chatPortForwardSchema.safeParse({ ...CHAT_PORT_FORWARD, state: "active" })
        .success,
    ).toBe(true);
    expect(
      chatPortForwardSchema.safeParse({
        ...CHAT_PORT_FORWARD,
        state: "interrupted",
      }).success,
    ).toBe(true);
  });

  // Same guard one layer up: a `portForwardsChanged` frame carrying a
  // four-value-shaped row must be rejected by the live server-frame union, not
  // merely by the row schema in isolation.
  it("rejects a portForwardsChanged frame whose row is 'binding', accepts 'active'", () => {
    const bindingFrame = {
      kind: "portForwardsChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      portForwards: [{ ...CHAT_PORT_FORWARD, state: "binding" }],
    };
    const activeFrame = {
      ...bindingFrame,
      portForwards: [{ ...CHAT_PORT_FORWARD, state: "active" }],
    };

    expect(
      chatSubscribeV114.serverFrameSchema.safeParse(bindingFrame).success,
    ).toBe(false);
    expect(
      chatSubscribeV114.serverFrameSchema.safeParse(activeFrame).success,
    ).toBe(true);
  });

  // The 1.14 windowed snapshot's own `portForwards` array carries the same
  // row schema. Fixture shape follows `subscribe-windowed-line.test.ts`'s
  // `baseWindowedSnapshot()` / `windowedSnapshotFrame()` helpers - the minimal
  // valid windowed snapshot that file already proves parses on this line.
  function baseChatRecord(): Record<string, unknown> {
    return {
      parentId: null,
      id: "chat-1",
      userId: "user-1",
      hostId: "host-1",
      title: "Chat",
      createdAt: 1000,
      updatedAt: 1000,
      isTitleEditedByUser: false,
    };
  }

  function windowedSnapshotWithPortForwards(
    portForwards: ReadonlyArray<unknown>,
  ): Record<string, unknown> {
    return {
      chat: baseChatRecord(),
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
      portForwards,
    };
  }

  function windowedSnapshotFrame(
    snapshot: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot,
    };
  }

  it("rejects a 1.14 windowed snapshot whose portForwards[0].state is 'stopped', accepts 'interrupted'", () => {
    const stoppedFrame = windowedSnapshotFrame(
      windowedSnapshotWithPortForwards([
        { ...CHAT_PORT_FORWARD, state: "stopped" },
      ]),
    );
    const interruptedFrame = windowedSnapshotFrame(
      windowedSnapshotWithPortForwards([
        { ...CHAT_PORT_FORWARD, state: "interrupted" },
      ]),
    );

    expect(
      chatSubscribeV114.serverFrameSchema.safeParse(stoppedFrame).success,
    ).toBe(false);
    expect(
      chatSubscribeV114.serverFrameSchema.safeParse(interruptedFrame).success,
    ).toBe(true);
  });
});

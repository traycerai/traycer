/**
 * `chat.subscribe@1.15`'s message-delivery slice: the one client
 * acknowledgement (`messageDeliveryRestored`), the `messageDeliveryChanged`
 * server push carrying the four-phase delivery state
 * (`pending | preparing | started | withdrawn`), and the `<=1.14` freeze that
 * must not have moved under them.
 *
 * The opening is sent or withdrawn by the host alone. `messageDeliveryEdit`,
 * `messageDeliveryRetry` and `messageDeliveryCancel` - and the `paused` /
 * `cancelled` phases they drove - are gone. A client only acknowledges that it
 * has restored a withdrawn prompt into its composer, naming the revision it
 * restored from.
 *
 * Frozen-line coverage here is by KIND LIST, on the model
 * `chat-subscribe-auto-mode-lines.test.ts` uses for the same boundary: the
 * union's own `.options` are the ground truth for what a line accepts, so a
 * kind silently added to (or dropped from) a "frozen" line's schema shows up
 * here without needing a parsed example of every frame shape.
 */
import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSubscribeV113,
  chatSubscribeV114,
  chatSubscribeV115,
  chatSubscribeV116,
  chatSubscribeV117,
  chatSubscribeV118,
  type ChatSubscribeClientFrame,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { projectChatClientFrameForVersion } from "@traycer/protocol/host/agent/gui/chat-frame-compat";
import {
  chatMessageDeliveryRestoreSchema,
  chatMessageDeliverySchema,
  chatMessageDeliveryStateSchema,
} from "@traycer/protocol/host/agent/gui/message-delivery";
import {
  userMessageSchema,
  userMessageSchemaV18,
} from "@traycer/protocol/persistence/epic/messages";

function userMessagePayload(): Record<string, unknown> {
  return {
    role: "user",
    messageId: "message-1",
    sender: { type: "user", userId: "owner-1" },
    message: {
      kind: "user",
      content: { type: "doc", content: [] },
      browserAnnotations: [],
    },
    timestamp: 1_000,
    sessionAnchor: null,
    // The marker under test - present on the WIRE payload regardless of which
    // line is asked to parse it.
    providerHistory: "excluded",
  };
}

const NEW_CLIENT_ACTION_KIND = "messageDeliveryRestored" as const;

type ChatSubscribeContract =
  | typeof chatSubscribeV113
  | typeof chatSubscribeV114
  | typeof chatSubscribeV115
  | typeof chatSubscribeV116
  | typeof chatSubscribeV117
  | typeof chatSubscribeV118;

function clientFrameKinds(contract: ChatSubscribeContract): readonly string[] {
  return contract.clientFrameSchema.options.map(
    (option) => option.shape.kind.value,
  );
}

function serverFrameKinds(contract: ChatSubscribeContract): readonly string[] {
  return contract.serverFrameSchema.options.map(
    (option) => option.shape.kind.value,
  );
}

describe("chat.subscribe registry carries the new line at 1.15", () => {
  it("keeps 1.15 installed and bound to chatSubscribeV115 - the head has since moved to 1.18", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.versions[15]?.contract).toBe(chatSubscribeV115);
    expect(line.latestMinor).toBe(18);
  });

  it("keeps 1.14 bound to its own contract, not silently re-pointed at 1.15", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.versions[14]?.contract).toBe(chatSubscribeV114);
  });

  it("carries the message-delivery frame kinds forward onto the head (1.18)", () => {
    // The head still speaks the message-delivery slice this line minted:
    // `1.16` only adds the approval-tier key and `1.17` only the sender-host
    // key and `1.18` only the receipt / pausedReason keys; none drops anything.
    for (const contract of [
      chatSubscribeV116,
      chatSubscribeV117,
      chatSubscribeV118,
    ]) {
      expect(clientFrameKinds(contract)).toContain(NEW_CLIENT_ACTION_KIND);
      expect(serverFrameKinds(contract)).toContain("messageDeliveryChanged");
    }
  });
});

describe("chat.subscribe@1.15 client frame: the one new acknowledgement", () => {
  it("adds exactly messageDeliveryRestored onto 1.14's set - position unconstrained", () => {
    // A SET difference, not a positional slice: the live line adds new kinds
    // before shared transport kinds it re-lists (`loadRange`/`resnapshot`),
    // so 1.15's list is not simply 1.14's list with this kind appended at the
    // end. What is actually pinned here is membership, both ways - every
    // 1.14 kind is still present, and the only kind 1.15 adds is this one -
    // not the relative order the union happens to declare them in.
    const v115Kinds = new Set(clientFrameKinds(chatSubscribeV115));
    const v114Kinds = new Set(clientFrameKinds(chatSubscribeV114));

    for (const kind of v114Kinds) {
      expect(v115Kinds.has(kind)).toBe(true);
    }
    const added = [...v115Kinds].filter((kind) => !v114Kinds.has(kind));
    expect(added).toEqual([NEW_CLIENT_ACTION_KIND]);
  });

  it("parses a well-formed messageDeliveryRestored frame", () => {
    const result = chatSubscribeV115.clientFrameSchema.safeParse({
      kind: "messageDeliveryRestored",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "action-1",
      messageId: "message-1",
      expectedRevision: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects expectedRevision <= 0 - the CAS token is 1-based", () => {
    const result = chatSubscribeV115.clientFrameSchema.safeParse({
      kind: "messageDeliveryRestored",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "action-1",
      messageId: "message-1",
      expectedRevision: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects the removed messageDeliveryEdit/Retry/Cancel kinds - the host owns retry and cancel now", () => {
    const removedKinds = [
      "messageDeliveryEdit",
      "messageDeliveryRetry",
      "messageDeliveryCancel",
    ] as const;
    for (const kind of removedKinds) {
      const result = chatSubscribeV115.clientFrameSchema.safeParse({
        kind,
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        messageId: "message-1",
        expectedRevision: 1,
        content: { type: "doc", content: [] },
        settings: {
          harnessId: "claude",
          model: "test-model",
          permissionMode: "supervised",
          reasoningEffort: null,
          agentMode: "epic",
        },
        accountContext: { type: "PERSONAL" },
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("chat.subscribe@1.15 client frame: messageDeliveryRestored requires the 1.15 handshake", () => {
  const RESTORED_FRAME: ChatSubscribeClientFrame = {
    kind: "messageDeliveryRestored",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    clientActionId: "action-1",
    messageId: "message-1",
    expectedRevision: 1,
  };

  const PRE_1_15_VERSIONS: ReadonlyArray<SchemaVersion | null> = [
    { major: 1, minor: 14 },
    { major: 1, minor: 0 },
    null,
  ];

  it("parses on the live 1.15 line", () => {
    expect(chatSubscribeV115.clientFrameSchema.parse(RESTORED_FRAME)).toEqual(
      RESTORED_FRAME,
    );
  });

  it("passes through projectChatClientFrameForVersion unchanged once negotiated at 1.15", () => {
    expect(
      projectChatClientFrameForVersion(RESTORED_FRAME, {
        major: 1,
        minor: 15,
      }),
    ).toBe(RESTORED_FRAME);
  });

  it("is refused below 1.15 with the exact message", () => {
    // A refusal test that can actually fail: if the throw in
    // `projectChatClientFrameForVersion` were ever removed, this frame would
    // come back unchanged instead of throwing, and every assertion below
    // would fail.
    for (const version of PRE_1_15_VERSIONS) {
      expect(() =>
        projectChatClientFrameForVersion(RESTORED_FRAME, version),
      ).toThrow(
        "Message delivery acknowledgements require chat.subscribe@1.15 or newer",
      );
    }
  });
});

describe("chat.subscribe@1.15 server frame: messageDeliveryChanged", () => {
  it("adds messageDeliveryChanged to the server frame's kind vocabulary", () => {
    expect(serverFrameKinds(chatSubscribeV115)).toContain(
      "messageDeliveryChanged",
    );
  });

  it("parses a well-formed messageDeliveryChanged push carrying a delivery state", () => {
    const result = chatSubscribeV115.serverFrameSchema.safeParse({
      kind: "messageDeliveryChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      delivery: {
        messageId: "message-1",
        revision: 2,
        state: { phase: "preparing" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses delivery: null (the cleared slot)", () => {
    const result = chatSubscribeV115.serverFrameSchema.safeParse({
      kind: "messageDeliveryChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      delivery: null,
    });
    expect(result.success).toBe(true);
  });

  it("parses a withdrawn delivery carrying a restorable prompt, unclaimed", () => {
    const result = chatSubscribeV115.serverFrameSchema.safeParse({
      kind: "messageDeliveryChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      delivery: {
        messageId: "message-1",
        revision: 3,
        state: {
          phase: "withdrawn",
          code: "MESSAGE_START_FAILED",
          reason: "The turn could not start.",
          missingHashes: [],
          restore: { content: { type: "doc", content: [] } },
          restoreClaimed: false,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("parses a withdrawn delivery with no restorable prompt (an agent-authored opening)", () => {
    const result = chatSubscribeV115.serverFrameSchema.safeParse({
      kind: "messageDeliveryChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      delivery: {
        messageId: "message-1",
        revision: 4,
        state: {
          phase: "withdrawn",
          code: "MESSAGE_PREPARATION_STOPPED",
          reason: "Stopped by the user.",
          missingHashes: [],
          restore: null,
          restoreClaimed: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("chat.subscribe@1.15 snapshot: the messageDelivery field", () => {
  function baseSnapshot(): Record<string, unknown> {
    return {
      chat: {
        parentId: null,
        userId: "owner-1",
        id: "chat-1",
        hostId: "host-1",
        title: "Chat",
        createdAt: 1_000,
        updatedAt: 1_000,
        isTitleEditedByUser: false,
      },
      access: { role: "owner", ownerUserId: "owner-1", canAct: true },
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
      transcriptEpoch: 0,
      rowCount: 1,
      indexRevision: null,
      tail: {
        fromOrdinal: 0,
        rowIds: ["message-1"],
        messages: [userMessagePayload()],
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
    };
  }

  function snapshotFrame(
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

  const DELIVERY = {
    messageId: "message-1",
    revision: 1,
    state: { phase: "pending" },
  };

  it("parses a snapshot carrying messageDelivery on the live 1.15 line", () => {
    const result = chatSubscribeV115.serverFrameSchema.safeParse(
      snapshotFrame({ ...baseSnapshot(), messageDelivery: DELIVERY }),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    if (result.data.kind !== "snapshot") throw new Error("expected snapshot");
    expect(result.data.snapshot.messageDelivery).toEqual(DELIVERY);
  });

  it("parses a snapshot with messageDelivery omitted (no opening in flight)", () => {
    const result = chatSubscribeV115.serverFrameSchema.safeParse(
      snapshotFrame(baseSnapshot()),
    );
    expect(result.success).toBe(true);
  });

  it("1.14's frozen snapshot has no messageDelivery field - a 1.14 peer never sees a stale opening", () => {
    const result = chatSubscribeV114.serverFrameSchema.safeParse(
      snapshotFrame({ ...baseSnapshot(), messageDelivery: DELIVERY }),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    if (result.data.kind !== "snapshot") throw new Error("expected snapshot");
    expect(result.data.snapshot).not.toHaveProperty("messageDelivery");
  });
});

describe("chatMessageDeliveryStateSchema: the four execution phases", () => {
  it("parses pending", () => {
    expect(
      chatMessageDeliveryStateSchema.safeParse({ phase: "pending" }).success,
    ).toBe(true);
  });

  it("parses preparing", () => {
    expect(
      chatMessageDeliveryStateSchema.safeParse({ phase: "preparing" }).success,
    ).toBe(true);
  });

  it("parses started, requiring turnId and assistantMessageId", () => {
    expect(
      chatMessageDeliveryStateSchema.safeParse({
        phase: "started",
        turnId: "turn-1",
        assistantMessageId: "assistant-1",
      }).success,
    ).toBe(true);

    expect(
      chatMessageDeliveryStateSchema.safeParse({ phase: "started" }).success,
    ).toBe(false);
  });

  it("parses withdrawn with a restorable prompt", () => {
    expect(
      chatMessageDeliveryStateSchema.safeParse({
        phase: "withdrawn",
        code: "MESSAGE_START_FAILED",
        reason: "The turn could not start.",
        missingHashes: [],
        restore: { content: { type: "doc", content: [] } },
        restoreClaimed: false,
      }).success,
    ).toBe(true);
  });

  it("parses withdrawn with restore: null", () => {
    expect(
      chatMessageDeliveryStateSchema.safeParse({
        phase: "withdrawn",
        code: "MESSAGE_PREPARATION_STOPPED",
        reason: "Stopped by the user.",
        missingHashes: [],
        restore: null,
        restoreClaimed: false,
      }).success,
    ).toBe(true);
  });

  it("requires restoreClaimed on withdrawn - it is neither optional nor defaulted", () => {
    const result = chatMessageDeliveryStateSchema.safeParse({
      phase: "withdrawn",
      code: "MESSAGE_START_FAILED",
      reason: "The turn could not start.",
      missingHashes: [],
      restore: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a restore object with no content", () => {
    const result = chatMessageDeliveryStateSchema.safeParse({
      phase: "withdrawn",
      code: "MESSAGE_START_FAILED",
      reason: "The turn could not start.",
      missingHashes: [],
      restore: {},
      restoreClaimed: false,
    });
    expect(result.success).toBe(false);
  });

  it("no longer parses the removed paused phase", () => {
    // Regression guard: if `paused` were ever re-added to the discriminated
    // union this would start succeeding.
    const result = chatMessageDeliveryStateSchema.safeParse({
      phase: "paused",
      code: "MISSING_ATTACHMENT_BYTES",
      reason: "Attachment bytes were missing.",
      missingHashes: ["hash-1"],
    });
    expect(result.success).toBe(false);
  });

  it("no longer parses the removed cancelled phase", () => {
    expect(
      chatMessageDeliveryStateSchema.safeParse({ phase: "cancelled" }).success,
    ).toBe(false);
  });
});

describe("chatMessageDeliveryRestoreSchema", () => {
  it("parses a restore payload carrying prompt content", () => {
    expect(
      chatMessageDeliveryRestoreSchema.safeParse({
        content: { type: "doc", content: [] },
      }).success,
    ).toBe(true);
  });

  it("rejects a restore payload with no content", () => {
    expect(chatMessageDeliveryRestoreSchema.safeParse({}).success).toBe(false);
  });
});

describe("chatMessageDeliverySchema", () => {
  it("parses a full delivery record", () => {
    expect(
      chatMessageDeliverySchema.safeParse({
        messageId: "message-1",
        revision: 1,
        state: { phase: "pending" },
      }).success,
    ).toBe(true);
  });

  it("rejects revision <= 0 - the CAS token is 1-based", () => {
    expect(
      chatMessageDeliverySchema.safeParse({
        messageId: "message-1",
        revision: 0,
        state: { phase: "pending" },
      }).success,
    ).toBe(false);
  });
});

describe("chat.subscribe@<=1.14 is frozen against the message-delivery additions", () => {
  it.each([
    ["1.13", chatSubscribeV113],
    ["1.14", chatSubscribeV114],
  ] as const)(
    "%s's client frame admits none of the message-delivery kinds",
    (_label, contract) => {
      const kinds = clientFrameKinds(contract);
      expect(kinds).not.toContain(NEW_CLIENT_ACTION_KIND);
      expect(kinds).not.toContain("messageDeliveryEdit");
      expect(kinds).not.toContain("messageDeliveryRetry");
      expect(kinds).not.toContain("messageDeliveryCancel");
    },
  );

  it.each([
    ["1.13", chatSubscribeV113],
    ["1.14", chatSubscribeV114],
  ] as const)(
    "%s's server frame admits no messageDeliveryChanged push",
    (_label, contract) => {
      expect(serverFrameKinds(contract)).not.toContain(
        "messageDeliveryChanged",
      );
    },
  );

  it.each([
    ["1.13", chatSubscribeV113],
    ["1.14", chatSubscribeV114],
  ] as const)(
    "%s refuses a messageDeliveryRestored client frame outright",
    (_label, contract) => {
      const result = contract.clientFrameSchema.safeParse({
        kind: "messageDeliveryRestored",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        messageId: "message-1",
        expectedRevision: 1,
      });
      expect(result.success).toBe(false);
    },
  );

  it("1.14's client frame kind list is byte-for-byte 1.13's - the message-delivery widen touched neither", () => {
    expect(clientFrameKinds(chatSubscribeV114)).toEqual(
      clientFrameKinds(chatSubscribeV113),
    );
  });
});

describe("the providerHistory marker: shape freeze at the schema level", () => {
  it("userMessageSchemaV18 (the <=1.14 wire shape) is well-formed WITHOUT the marker", () => {
    const { providerHistory: _dropped, ...withoutMarker } =
      userMessagePayload();
    expect(userMessageSchemaV18.safeParse(withoutMarker).success).toBe(true);
  });

  it("userMessageSchemaV18 STRIPS an unknown providerHistory key rather than rejecting it", () => {
    // Non-strict zod object: an additive key a NEWER build wrote is not an
    // error for a build that predates it, it is simply not carried forward.
    // A `<=1.14` peer parsing a `1.15` payload must not blow up on the marker.
    const result = userMessageSchemaV18.safeParse(userMessagePayload());
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    expect(result.data).not.toHaveProperty("providerHistory");
  });

  it("the live userMessageSchema (1.15) RETAINS providerHistory", () => {
    const result = userMessageSchema.safeParse(userMessagePayload());
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    expect(result.data.providerHistory).toBe("excluded");
  });

  it("the live userMessageSchema rejects any providerHistory value other than the one literal", () => {
    const result = userMessageSchema.safeParse({
      ...userMessagePayload(),
      providerHistory: "sent",
    });
    expect(result.success).toBe(false);
  });
});

describe("the providerHistory marker on the wire: <=1.14 strips, 1.15 retains", () => {
  function messageAcceptedFrame(): Record<string, unknown> {
    return {
      kind: "messageAccepted",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      message: userMessagePayload(),
    };
  }

  it.each([
    ["1.13", chatSubscribeV113],
    ["1.14", chatSubscribeV114],
  ] as const)(
    "%s's messageAccepted frame parses but strips the marker",
    (_label, contract) => {
      const result = contract.serverFrameSchema.safeParse(
        messageAcceptedFrame(),
      );
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("expected the frame to parse");
      if (result.data.kind !== "messageAccepted") {
        throw new Error("expected messageAccepted");
      }
      expect(result.data.message).not.toHaveProperty("providerHistory");
    },
  );

  it("1.15's messageAccepted frame retains the marker", () => {
    const result = chatSubscribeV115.serverFrameSchema.safeParse(
      messageAcceptedFrame(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    if (result.data.kind !== "messageAccepted") {
      throw new Error("expected messageAccepted");
    }
    const message = result.data.message;
    if (message.role !== "user") throw new Error("expected a user message");
    expect(message.providerHistory).toBe("excluded");
  });

  function windowedSnapshotFrame(): Record<string, unknown> {
    return {
      // The wire discriminator is "snapshot" for both the legacy and the
      // windowed shape - "windowedSnapshot" never appears on the wire. The
      // client tells them apart by which callback/schema line it is parsing
      // through (`onSnapshot` vs `onWindowedSnapshot`), never by a distinct
      // `kind` value; see `ChatStreamCallbacks.onWindowedSnapshot`'s doc
      // comment in `chat-stream-client.ts`.
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat: {
          parentId: null,
          userId: "owner-1",
          id: "chat-1",
          hostId: "host-1",
          title: "Chat",
          createdAt: 1_000,
          updatedAt: 1_000,
          isTitleEditedByUser: false,
        },
        access: { role: "owner", ownerUserId: "owner-1", canAct: true },
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
        transcriptEpoch: 0,
        rowCount: 1,
        indexRevision: null,
        tail: {
          fromOrdinal: 0,
          rowIds: ["message-1"],
          messages: [userMessagePayload()],
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

  it("1.14's windowed snapshot tail parses but strips the marker from its messages", () => {
    const result = chatSubscribeV114.serverFrameSchema.safeParse(
      windowedSnapshotFrame(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    if (result.data.kind !== "snapshot") {
      throw new Error("expected snapshot");
    }
    const [message] = result.data.snapshot.tail.messages;
    expect(message).toBeDefined();
    expect(message).not.toHaveProperty("providerHistory");
  });

  it("1.15's windowed snapshot tail retains the marker on its messages", () => {
    const result = chatSubscribeV115.serverFrameSchema.safeParse(
      windowedSnapshotFrame(),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    if (result.data.kind !== "snapshot") {
      throw new Error("expected snapshot");
    }
    const [message] = result.data.snapshot.tail.messages;
    if (message === undefined || message.role !== "user") {
      throw new Error("expected a user message");
    }
    expect(message.providerHistory).toBe("excluded");
  });

  function rangeFrame(): Record<string, unknown> {
    return {
      kind: "range",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      range: {
        requestId: "range-1",
        epoch: 1,
        fromOrdinal: 0,
        rowIds: ["message-1"],
        messages: [userMessagePayload()],
        events: [],
        reachedStart: true,
        reachedEnd: true,
      },
    };
  }

  it("1.14's range response parses but strips the marker from its messages", () => {
    const result = chatSubscribeV114.serverFrameSchema.safeParse(rangeFrame());
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    if (result.data.kind !== "range") throw new Error("expected range");
    const [message] = result.data.range.messages;
    expect(message).toBeDefined();
    expect(message).not.toHaveProperty("providerHistory");
  });

  it("1.15's range response retains the marker on its messages", () => {
    const result = chatSubscribeV115.serverFrameSchema.safeParse(rangeFrame());
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    if (result.data.kind !== "range") throw new Error("expected range");
    const [message] = result.data.range.messages;
    if (message === undefined || message.role !== "user") {
      throw new Error("expected a user message");
    }
    expect(message.providerHistory).toBe("excluded");
  });
});

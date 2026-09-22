/**
 * `chat.subscribe@1.15`'s message-delivery slice: the three new client
 * actions, the new `messageDeliveryChanged` server push, and the `<=1.14`
 * freeze that must not have moved under them.
 *
 * Frozen-line coverage here is by KIND LIST, on the model
 * `chat-subscribe-auto-mode-lines.test.ts` uses for the same boundary: the
 * union's own `.options` are the ground truth for what a line accepts, so a
 * kind silently added to (or dropped from) a "frozen" line's schema shows up
 * here without needing a parsed example of every frame shape.
 */
import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSubscribeV113,
  chatSubscribeV114,
  chatSubscribeV115,
} from "@traycer/protocol/host/agent/gui/subscribe";
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

const NEW_CLIENT_ACTION_KINDS = [
  "messageDeliveryEdit",
  "messageDeliveryRetry",
  "messageDeliveryCancel",
] as const;

type ChatSubscribeContract =
  | typeof chatSubscribeV113
  | typeof chatSubscribeV114
  | typeof chatSubscribeV115;

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
  it("advances latestMinor to 15 and binds it to chatSubscribeV115", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.latestMinor).toBe(15);
    expect(line.versions[15]?.contract).toBe(chatSubscribeV115);
  });

  it("keeps 1.14 bound to its own contract, not silently re-pointed at 1.15", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.versions[14]?.contract).toBe(chatSubscribeV114);
  });
});

describe("chat.subscribe@1.15 client frame: the three new actions", () => {
  it("adds exactly the three message-delivery kinds onto 1.14's set - position unconstrained", () => {
    // A SET difference, not a positional slice: the live line adds new kinds
    // before shared transport kinds it re-lists (`loadRange`/`resnapshot`),
    // so 1.15's list is not simply 1.14's list with these three appended at
    // the end. What is actually pinned here is membership, both ways - every
    // 1.14 kind is still present, and the only kinds 1.15 adds are these
    // three - not the relative order the union happens to declare them in.
    const v115Kinds = new Set(clientFrameKinds(chatSubscribeV115));
    const v114Kinds = new Set(clientFrameKinds(chatSubscribeV114));

    for (const kind of v114Kinds) {
      expect(v115Kinds.has(kind)).toBe(true);
    }
    const added = [...v115Kinds].filter((kind) => !v114Kinds.has(kind));
    expect(added.sort()).toEqual([...NEW_CLIENT_ACTION_KINDS].sort());
  });

  it("parses a well-formed messageDeliveryEdit frame", () => {
    const result = chatSubscribeV115.clientFrameSchema.safeParse({
      kind: "messageDeliveryEdit",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "action-1",
      messageId: "message-1",
      expectedRevision: 1,
      content: { type: "doc", content: [] },
    });
    expect(result.success).toBe(true);
  });

  it("defaults browserAnnotations to [] on messageDeliveryEdit when omitted", () => {
    const result = chatSubscribeV115.clientFrameSchema.safeParse({
      kind: "messageDeliveryEdit",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "action-1",
      messageId: "message-1",
      expectedRevision: 1,
      content: { type: "doc", content: [] },
    });
    if (!result.success) throw new Error("expected the frame to parse");
    expect(
      (result.data as { browserAnnotations: unknown }).browserAnnotations,
    ).toEqual([]);
  });

  it("parses a well-formed messageDeliveryRetry frame", () => {
    const result = chatSubscribeV115.clientFrameSchema.safeParse({
      kind: "messageDeliveryRetry",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "action-1",
      messageId: "message-1",
      expectedRevision: 2,
      settings: {
        harnessId: "claude",
        model: "test-model",
        permissionMode: "supervised",
        reasoningEffort: null,
        agentMode: "epic",
      },
      accountContext: { type: "PERSONAL" },
    });
    expect(result.success).toBe(true);
  });

  it("parses a well-formed messageDeliveryCancel frame with no content payload", () => {
    const result = chatSubscribeV115.clientFrameSchema.safeParse({
      kind: "messageDeliveryCancel",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      clientActionId: "action-1",
      messageId: "message-1",
      expectedRevision: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects expectedRevision <= 0 on every new action (the CAS token is 1-based)", () => {
    for (const kind of NEW_CLIENT_ACTION_KINDS) {
      const result = chatSubscribeV115.clientFrameSchema.safeParse({
        kind,
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        messageId: "message-1",
        expectedRevision: 0,
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
});

describe("chat.subscribe@<=1.14 is frozen against the message-delivery additions", () => {
  it.each([
    ["1.13", chatSubscribeV113],
    ["1.14", chatSubscribeV114],
  ] as const)(
    "%s's client frame admits none of the three new action kinds",
    (_label, contract) => {
      const kinds = clientFrameKinds(contract);
      for (const kind of NEW_CLIENT_ACTION_KINDS) {
        expect(kinds).not.toContain(kind);
      }
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
    "%s refuses a messageDeliveryEdit client frame outright",
    (_label, contract) => {
      const result = contract.clientFrameSchema.safeParse({
        kind: "messageDeliveryEdit",
        hasBinaryPayload: false,
        epicId: "epic-1",
        chatId: "chat-1",
        clientActionId: "action-1",
        messageId: "message-1",
        expectedRevision: 1,
        content: { type: "doc", content: [] },
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

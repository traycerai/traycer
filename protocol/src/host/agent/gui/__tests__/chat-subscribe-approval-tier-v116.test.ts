import { describe, expect, it } from "vitest";
import { validateVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { AUTO_JUDGE_TIER_VALUES } from "@traycer/protocol/host/auto-mode/contracts";
import {
  chatApprovalReasonSchema,
  chatApprovalReasonSchemaPreTier,
  chatSubscribeV113,
  chatSubscribeV114,
  chatSubscribeV115,
  chatSubscribeV116,
  chatSubscribeV117,
  chatSubscribeV118,
  chatSubscribeV119,
  chatSubscribeV120,
  chatSubscribeV121,
  chatSubscribeV122,
  chatSubscribeV123,
  chatSubscribeV124,
  chatSubscribeV125,
  chatSubscribeV126,
  chatSubscribeV127,
  chatSubscribeV128,
  chatSubscribeV129,
  chatSubscribeV130,
  chatSubscribeV131,
  chatSubscribeV132,
  chatSubscribeV133,
  chatSubscribeV134,
  chatSubscribeV135,
  chatSubscribeV136,
  chatSubscribeV137,
  chatSubscribeV138,
  chatSubscribeWindowedServerFrameSchema,
  openChatSubscribeWindowedServerFrameSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.16`: the approval card's judge reason gains `tier`. See
 * `subscribe.ts`'s docblocks on `chatSubscribeV116` and
 * `chatApprovalReasonSchema` for the TOLERANCE (not projection) contract - the key is
 * `.nullable().default(null)` inside a non-strict object, so it is written at
 * every minor and simply dropped by an older peer's decoder.
 */

function approvalRequestedFrame(
  reason: Record<string, unknown>,
): Record<string, unknown> {
  return {
    kind: "approvalRequested",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    approval: {
      approvalId: "approval-1",
      toolName: "bash",
      description: "Run a command",
      input: null,
      requestedAt: 1_000,
      reason,
    },
  };
}

describe("chat.subscribe registry: 1.16 installed below the 1.17 through 1.22 lines, 1.15 still installed", () => {
  it("binds 1.16 and 1.15 to their own contracts - the head has since moved to 1.38", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.latestMinor).toBe(38);
    expect(line.versions[38].contract).toBe(chatSubscribeV138);
    expect(line.versions[37].contract).toBe(chatSubscribeV137);
    expect(line.versions[36].contract).toBe(chatSubscribeV136);
    expect(line.versions[35].contract).toBe(chatSubscribeV135);
    expect(line.versions[34].contract).toBe(chatSubscribeV134);
    expect(line.versions[23].contract).toBe(chatSubscribeV123);
    expect(line.versions[22].contract).toBe(chatSubscribeV122);
    expect(line.versions[21].contract).toBe(chatSubscribeV121);
    expect(line.versions[20].contract).toBe(chatSubscribeV120);
    expect(line.versions[19].contract).toBe(chatSubscribeV119);
    expect(line.versions[18].contract).toBe(chatSubscribeV118);
    expect(line.versions[17].contract).toBe(chatSubscribeV117);
    expect(line.versions[16].contract).toBe(chatSubscribeV116);
    expect(line.versions[15].contract).toBe(chatSubscribeV115);
  });

  it("1.38's server frame is the open windowed schema; older lines are frozen", () => {
    expect(chatSubscribeV124.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV125.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV126.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV127.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    // 1.28 froze when 1.29 added the tool-call `agentMessageDelivery` stamp
    // above it.
    expect(chatSubscribeV128.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    // 1.29 froze when 1.30 opened the html, canvas and file artifact kinds
    // above it.
    expect(chatSubscribeV129.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    // 1.30 froze when 1.31 added the tool-call `artifact` stamp above it.
    expect(chatSubscribeV130.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    // 1.31 froze when 1.32 grew the browser annotation record above it.
    expect(chatSubscribeV131.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    // 1.32 froze when 1.33 widened the accumulated-change `artifact` tag's
    // kind above it; 1.33 binds the live windowed schema.
    expect(chatSubscribeV132.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    // 1.33 froze when 1.34 added `sendWouldQueue` above it; 1.34 froze when
    // 1.35 added the memory-curation queue item above it; 1.35 froze when
    // 1.37 added the compaction `notApplied` flag above it; 1.36 aliases
    // 1.35's frozen frames; 1.37 binds the live windowed schema.
    expect(chatSubscribeV133.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV134.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV135.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV136.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    // 1.37 froze when 1.38 added the steer restart reasons to `actionAck`.
    expect(chatSubscribeV137.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV138.serverFrameSchema).toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    // 1.36 carries 1.35's frames unchanged.
    expect(chatSubscribeV136.serverFrameSchema).toBe(
      chatSubscribeV135.serverFrameSchema,
    );
    expect(chatSubscribeV123.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV122.serverFrameSchema).not.toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV121.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV122.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV123.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV120.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV119.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV118.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV117.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV116.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV115.serverFrameSchema).not.toBe(
      chatSubscribeV116.serverFrameSchema,
    );
  });

  it("1.15 and 1.16 share the same client frame schema - the tier is host-authored", () => {
    expect(chatSubscribeV115.clientFrameSchema).toBe(
      chatSubscribeV116.clientFrameSchema,
    );
  });

  it("validates the stream registry as constructed", () => {
    expect(() =>
      validateVersionedStreamRpcRegistry(hostStreamRpcRegistry),
    ).not.toThrow();
  });
});

describe("chatApprovalReasonSchema: the tier field", () => {
  it("keeps an explicit tier, fills null when absent, and rejects an unknown tier", () => {
    expect(
      chatApprovalReasonSchema.parse({
        rule: "Force Push",
        text: "This rewrites remote history.",
        tier: "soft",
      }).tier,
    ).toBe("soft");
    expect(
      chatApprovalReasonSchema.parse({
        rule: "Force Push",
        text: "This rewrites remote history.",
      }).tier,
    ).toBeNull();
    expect(
      chatApprovalReasonSchema.safeParse({
        rule: "Force Push",
        text: "This rewrites remote history.",
        tier: "fuzzy",
      }).success,
    ).toBe(false);
  });

  it("accepts every AUTO_JUDGE_TIER_VALUES member", () => {
    for (const tier of AUTO_JUDGE_TIER_VALUES) {
      expect(
        chatApprovalReasonSchema.safeParse({
          rule: "Force Push",
          text: "This rewrites remote history.",
          tier,
        }).success,
      ).toBe(true);
    }
  });

  it("chatApprovalReasonSchemaPreTier strips the tier key", () => {
    const parsed = chatApprovalReasonSchemaPreTier.parse({
      rule: "Force Push",
      text: "This rewrites remote history.",
      tier: "soft",
    });
    expect(Object.hasOwn(parsed, "tier")).toBe(false);
    expect(parsed).toEqual({
      rule: "Force Push",
      text: "This rewrites remote history.",
    });
  });
});

describe("chat.subscribe@1.16 approvalRequested frame: tier decode across the skew", () => {
  const TIERED_REASON = {
    rule: "Force Push",
    text: "This rewrites remote history.",
    tier: "soft",
  } as const;

  it("decodes tier: soft on the live 1.16 line", () => {
    const result = chatSubscribeV116.serverFrameSchema.safeParse(
      approvalRequestedFrame(TIERED_REASON),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    if (result.data.kind !== "approvalRequested") {
      throw new Error("expected approvalRequested");
    }
    expect(result.data.approval.reason?.tier).toBe("soft");
  });

  it.each([
    ["1.15", chatSubscribeV115],
    ["1.14", chatSubscribeV114],
    ["1.13", chatSubscribeV113],
  ] as const)(
    "%s decodes the same tiered frame, keeps rule/text, and strips tier",
    (_label, contract) => {
      const result = contract.serverFrameSchema.safeParse(
        approvalRequestedFrame(TIERED_REASON),
      );
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("expected the frame to parse");
      if (result.data.kind !== "approvalRequested") {
        throw new Error("expected approvalRequested");
      }
      expect(result.data.approval.reason).not.toBeNull();
      const reason = result.data.approval.reason;
      if (reason === null) throw new Error("expected a reason");
      expect(reason.rule).toBe("Force Push");
      expect(reason.text).toBe("This rewrites remote history.");
      expect(Object.hasOwn(reason, "tier")).toBe(false);
    },
  );

  it("reverse skew: a 1.15-shaped frame without tier decodes on 1.16 with tier: null", () => {
    const untieredReason = {
      rule: "Force Push",
      text: "This rewrites remote history.",
    };
    const result = chatSubscribeV116.serverFrameSchema.safeParse(
      approvalRequestedFrame(untieredReason),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    if (result.data.kind !== "approvalRequested") {
      throw new Error("expected approvalRequested");
    }
    expect(result.data.approval.reason?.tier).toBeNull();
  });
});

describe("chat.subscribe@1.16 windowed snapshot: tier decode on pendingApprovals[0].reason", () => {
  function baseSnapshot(
    reason: Record<string, unknown>,
  ): Record<string, unknown> {
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
      pendingApprovals: [
        {
          approvalId: "approval-1",
          toolName: "bash",
          description: "Run a command",
          input: null,
          requestedAt: 1_000,
          reason,
        },
      ],
      pendingInterviews: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      pendingFileEditApprovals: [],
      accumulatedFileChangeCount: 0,
      managedCommands: [],
      heldUpdates: [],
      portForwards: [],
      transcriptEpoch: 0,
      rowCount: 0,
      indexRevision: null,
      tail: {
        fromOrdinal: 0,
        rowIds: [],
        messages: [],
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

  const TIERED_REASON = {
    rule: "Force Push",
    text: "This rewrites remote history.",
    tier: "soft",
  } as const;

  it("keeps tier on the live 1.16 snapshot's pendingApprovals[0].reason", () => {
    const result = chatSubscribeV116.serverFrameSchema.safeParse(
      snapshotFrame(baseSnapshot(TIERED_REASON)),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected the frame to parse");
    if (result.data.kind !== "snapshot") throw new Error("expected snapshot");
    const [approval] = result.data.snapshot.pendingApprovals;
    expect(approval?.reason?.tier).toBe("soft");
  });

  it.each([
    ["1.15", chatSubscribeV115],
    ["1.14", chatSubscribeV114],
    ["1.13", chatSubscribeV113],
  ] as const)(
    "strips tier on the %s snapshot's pendingApprovals[0].reason",
    (_label, contract) => {
      const result = contract.serverFrameSchema.safeParse(
        snapshotFrame(baseSnapshot(TIERED_REASON)),
      );
      expect(result.success).toBe(true);
      if (!result.success) throw new Error("expected the frame to parse");
      if (result.data.kind !== "snapshot") throw new Error("expected snapshot");
      const [approval] = result.data.snapshot.pendingApprovals;
      expect(approval?.reason).not.toBeNull();
      const reason = approval?.reason;
      if (reason === null || reason === undefined) {
        throw new Error("expected a reason");
      }
      expect(reason.rule).toBe("Force Push");
      expect(reason.text).toBe("This rewrites remote history.");
      expect(Object.hasOwn(reason, "tier")).toBe(false);
    },
  );
});

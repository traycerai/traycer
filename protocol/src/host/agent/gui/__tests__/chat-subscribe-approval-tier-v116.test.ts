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
  chatSubscribeV118,
  chatSubscribeWindowedServerFrameSchema,
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

describe("chat.subscribe registry: 1.16 installed, 1.18 the head", () => {
  it("keeps 1.16 bound to chatSubscribeV116 - the head has since moved to 1.18", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.latestMinor).toBe(18);
    expect(line.versions[18].contract).toBe(chatSubscribeV118);
    expect(line.versions[16].contract).toBe(chatSubscribeV116);
    expect(line.versions[15].contract).toBe(chatSubscribeV115);
  });

  it("1.16's server frame is a distinct, frozen schema, no longer the live windowed one", () => {
    expect(chatSubscribeV116.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV118.serverFrameSchema).toBe(
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

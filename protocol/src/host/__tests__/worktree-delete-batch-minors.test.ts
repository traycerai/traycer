import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  worktreeDeleteBatchByPathOpenRequestSchema,
  worktreeDeleteBatchByPathOpenRequestSchemaV11,
  worktreeDeleteBatchByPathServerFrameSchema,
  worktreeDeleteBatchByPathServerFrameSchemaV11,
  worktreeDeleteBatchByPathServerFrameSchemaV12,
  worktreeDeleteBatchByPathServerFrameSchemaV13,
  worktreeDeleteBatchByPathServerFrameSchemaV14,
  WORKTREE_DELETE_ERROR_TAIL_MAX_BYTES,
  WORKTREE_DELETE_ERROR_TAIL_MAX_LINES,
} from "@traycer/protocol/host/worktree-delete-batch-stream";

const commandId = "2f1d0a2c-0000-4000-8000-000000000000";

const holder = {
  ownerRef: {
    epicId: "epic-1",
    ownerKind: "chat" as const,
    ownerId: "chat-1",
  },
  holdKind: "chat-turn" as const,
  activity: "working" as const,
  label: "Chat is mid-turn",
};

const holderWithChatTier = {
  ...holder,
  chatTier: "turn" as const,
};

describe("worktree.deleteBatchByPath@1.1", () => {
  it("is registered alongside the frozen 1.0 contract", () => {
    const registry = hostStreamRpcRegistry["worktree.deleteBatchByPath"];
    expect(registry[1].latestMinor).toBe(4);
    expect(registry[1].versions[4].contract.serverFrameSchema).toBe(
      worktreeDeleteBatchByPathServerFrameSchemaV14,
    );
    expect(registry[1].versions[0].contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(registry[1].versions[1].contract.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
  });

  it("1.0 strips per-target stopOwners", () => {
    const parsed = worktreeDeleteBatchByPathOpenRequestSchema.parse({
      mode: "start",
      commandId,
      source: "settings",
      targets: [{ worktreePath: "/wt", scripts: null, stopOwners: true }],
    });
    expect(parsed.mode).toBe("start");
    if (parsed.mode === "start") {
      expect(parsed.targets[0]).not.toHaveProperty("stopOwners");
    }
  });

  it("1.1 defaults stopOwners to false and round-trips the parsed request", () => {
    const parsed = worktreeDeleteBatchByPathOpenRequestSchemaV11.parse({
      mode: "start",
      commandId,
      source: "task_sweep",
      epicId: "epic-1",
      targets: [{ worktreePath: "/wt", scripts: null }],
    });
    expect(parsed.mode).toBe("start");
    if (parsed.mode === "start") {
      expect(parsed.targets[0]?.stopOwners).toBe(false);
    }
    expect(worktreeDeleteBatchByPathOpenRequestSchemaV11.parse(parsed)).toEqual(
      parsed,
    );
  });

  it("1.1 round-trips explicit per-target stopOwners", () => {
    const parsed = worktreeDeleteBatchByPathOpenRequestSchemaV11.parse({
      mode: "start",
      commandId,
      source: "settings",
      targets: [{ worktreePath: "/wt", scripts: null, stopOwners: true }],
    });
    expect(parsed.mode).toBe("start");
    if (parsed.mode === "start") {
      expect(parsed.targets[0]?.stopOwners).toBe(true);
    }
    expect(worktreeDeleteBatchByPathOpenRequestSchemaV11.parse(parsed)).toEqual(
      parsed,
    );
  });

  it("1.1 target.failed accepts optional holders and WORKTREE_BUSY code", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV11.parse({
      kind: "target.failed",
      worktreePath: "/wt",
      reason: "in use",
      holders: [holder],
      code: "WORKTREE_BUSY",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("target.failed");
    if (parsed.kind === "target.failed") {
      expect(parsed.holders).toEqual([holder]);
      expect(parsed.code).toBe("WORKTREE_BUSY");
    }
  });

  it("1.1 target.failed accepts the 1.0-shaped frame", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV11.parse({
      kind: "target.failed",
      worktreePath: "/wt",
      reason: "remove failed",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("target.failed");
    if (parsed.kind === "target.failed") {
      expect(parsed.holders).toBeUndefined();
      expect(parsed.code).toBeUndefined();
    }
  });

  it("1.1 sanitizes malformed holders and an unknown code to absent", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV11.parse({
      kind: "target.failed",
      worktreePath: "/wt",
      reason: "future busy refusal",
      holders: [{ not: "a holder" }],
      code: "WORKTREE_FUTURE_BUSY",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("target.failed");
    if (parsed.kind === "target.failed") {
      expect(parsed.reason).toBe("future busy refusal");
      expect(parsed.holders).toBeUndefined();
      expect(parsed.code).toBeUndefined();
    }
  });

  it("1.0 target.failed strips 1.1 busy details", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchema.parse({
      kind: "target.failed",
      worktreePath: "/wt",
      reason: "in use",
      holders: [holder],
      code: "WORKTREE_BUSY",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("target.failed");
    if (parsed.kind === "target.failed") {
      expect(parsed).not.toHaveProperty("holders");
      expect(parsed).not.toHaveProperty("code");
    }
  });

  it("frozen 1.1 target.failed strips chatTier (old-client degrade)", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV11.parse({
      kind: "target.failed",
      worktreePath: "/wt",
      reason: "in use",
      holders: [holderWithChatTier],
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("target.failed");
    if (parsed.kind === "target.failed") {
      expect(parsed.holders).toHaveLength(1);
      expect(parsed.holders?.[0]).not.toHaveProperty("chatTier");
    }
  });
});

describe("worktree.deleteBatchByPath@1.2 chatTier", () => {
  it("1.2 target.failed keeps chatTier on chat-turn holders", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV12.parse({
      kind: "target.failed",
      worktreePath: "/wt",
      reason: "in use",
      holders: [holderWithChatTier],
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("target.failed");
    if (parsed.kind === "target.failed") {
      expect(parsed.holders).toEqual([holderWithChatTier]);
      expect(parsed.holders?.[0]?.chatTier).toBe("turn");
    }
  });

  it("1.2 target.failed sanitizes an unknown chatTier by dropping holders, keeping reason", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV12.safeParse({
      kind: "target.failed",
      worktreePath: "/wt",
      reason: "in use",
      holders: [{ ...holder, chatTier: "bogus" }],
      hasBinaryPayload: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe("target.failed");
      if (parsed.data.kind === "target.failed") {
        expect(parsed.data.reason).toBe("in use");
        expect(parsed.data.holders).toBeUndefined();
      }
    }
  });
});

describe("worktree.deleteBatchByPath@1.3 declined", () => {
  it("1.3 target.complete carries the decline kind of a non-deletion", () => {
    for (const declined of [
      "not_managed",
      "teardown_failed",
      "removal_failed",
    ] as const) {
      const parsed = worktreeDeleteBatchByPathServerFrameSchemaV13.parse({
        kind: "target.complete",
        worktreePath: "/wt",
        deleted: false,
        declined,
        hasBinaryPayload: false,
      });
      expect(parsed.kind).toBe("target.complete");
      if (parsed.kind === "target.complete") {
        expect(parsed.deleted).toBe(false);
        expect(parsed.declined).toBe(declined);
      }
    }
  });

  it("1.3 target.complete accepts the 1.2-shaped frame without declined", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV13.parse({
      kind: "target.complete",
      worktreePath: "/wt",
      deleted: true,
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("target.complete");
    if (parsed.kind === "target.complete") {
      expect(parsed.declined).toBeUndefined();
    }
  });

  it("1.3 sanitizes an unknown future decline kind to absent, keeping the outcome", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV13.parse({
      kind: "target.complete",
      worktreePath: "/wt",
      deleted: false,
      declined: "disk_full",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("target.complete");
    if (parsed.kind === "target.complete") {
      expect(parsed.deleted).toBe(false);
      expect(parsed.declined).toBeUndefined();
    }
  });

  it("1.3 target.failed keeps the 1.2 busy details", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV13.parse({
      kind: "target.failed",
      worktreePath: "/wt",
      reason: "in use",
      holders: [holderWithChatTier],
      code: "WORKTREE_BUSY",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("target.failed");
    if (parsed.kind === "target.failed") {
      expect(parsed.holders).toEqual([holderWithChatTier]);
      expect(parsed.code).toBe("WORKTREE_BUSY");
    }
  });

  it("frozen 1.0, 1.1 and 1.2 target.complete strip declined (old-client degrade)", () => {
    const frame = {
      kind: "target.complete",
      worktreePath: "/wt",
      deleted: false,
      declined: "not_managed",
      hasBinaryPayload: false,
    };
    for (const schema of [
      worktreeDeleteBatchByPathServerFrameSchema,
      worktreeDeleteBatchByPathServerFrameSchemaV11,
      worktreeDeleteBatchByPathServerFrameSchemaV12,
    ]) {
      const parsed = schema.parse(frame);
      expect(parsed.kind).toBe("target.complete");
      expect(parsed).not.toHaveProperty("declined");
      if (parsed.kind === "target.complete") {
        expect(parsed.deleted).toBe(false);
      }
    }
  });
});

describe("worktree.deleteBatchByPath@1.4 error tail", () => {
  it("1.4 target.complete carries the error tail of a failed deletion", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV14.parse({
      kind: "target.complete",
      worktreePath: "/wt",
      deleted: false,
      declined: "removal_failed",
      errorTail: "fatal: cannot remove '/wt': Device or resource busy",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("target.complete");
    if (parsed.kind === "target.complete") {
      expect(parsed.declined).toBe("removal_failed");
      expect(parsed.errorTail).toBe(
        "fatal: cannot remove '/wt': Device or resource busy",
      );
    }
  });

  it("1.4 target.failed carries the error tail beside the busy details", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV14.parse({
      kind: "target.failed",
      worktreePath: "/wt",
      reason: "git worktree remove failed",
      errorTail: "error: unable to unlink",
      code: "WORKTREE_BUSY",
      holders: [holderWithChatTier],
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("target.failed");
    if (parsed.kind === "target.failed") {
      expect(parsed.errorTail).toBe("error: unable to unlink");
      expect(parsed.code).toBe("WORKTREE_BUSY");
      expect(parsed.holders).toEqual([holderWithChatTier]);
    }
  });

  it("1.4 accepts frames without an error tail", () => {
    for (const frame of [
      {
        kind: "target.complete",
        worktreePath: "/wt",
        deleted: true,
        hasBinaryPayload: false,
      },
      {
        kind: "target.failed",
        worktreePath: "/wt",
        reason: "boom",
        hasBinaryPayload: false,
      },
    ]) {
      const parsed = worktreeDeleteBatchByPathServerFrameSchemaV14.parse(frame);
      expect(parsed).not.toHaveProperty("errorTail");
    }
  });

  it("1.4 sanitizes a malformed error tail to absent without dropping the terminal frame", () => {
    for (const errorTail of [42, { text: "x" }, ["x"], null]) {
      const complete = worktreeDeleteBatchByPathServerFrameSchemaV14.safeParse({
        kind: "target.complete",
        worktreePath: "/wt",
        deleted: false,
        declined: "removal_failed",
        errorTail,
        hasBinaryPayload: false,
      });
      expect(complete.success).toBe(true);
      if (complete.success && complete.data.kind === "target.complete") {
        expect(complete.data.deleted).toBe(false);
        expect(complete.data.declined).toBe("removal_failed");
        expect(complete.data.errorTail).toBeUndefined();
      }
      const failed = worktreeDeleteBatchByPathServerFrameSchemaV14.safeParse({
        kind: "target.failed",
        worktreePath: "/wt",
        reason: "boom",
        errorTail,
        hasBinaryPayload: false,
      });
      expect(failed.success).toBe(true);
      if (failed.success && failed.data.kind === "target.failed") {
        expect(failed.data.reason).toBe("boom");
        expect(failed.data.errorTail).toBeUndefined();
      }
    }
  });

  it("1.4 keeps the 1.3 decline kind semantics", () => {
    const parsed = worktreeDeleteBatchByPathServerFrameSchemaV14.parse({
      kind: "target.complete",
      worktreePath: "/wt",
      deleted: false,
      declined: "disk_full",
      hasBinaryPayload: false,
    });
    if (parsed.kind === "target.complete") {
      expect(parsed.declined).toBeUndefined();
    }
  });

  it("1.4 accepts an error tail at exactly the byte and line limits", () => {
    const atByteLimit = "é".repeat(WORKTREE_DELETE_ERROR_TAIL_MAX_BYTES / 2);
    const atLineLimit = Array.from(
      { length: WORKTREE_DELETE_ERROR_TAIL_MAX_LINES },
      (_, index) => `line ${index}`,
    ).join("\n");
    for (const errorTail of [atByteLimit, atLineLimit]) {
      const parsed = worktreeDeleteBatchByPathServerFrameSchemaV14.parse({
        kind: "target.complete",
        worktreePath: "/wt",
        deleted: false,
        declined: "removal_failed",
        errorTail,
        hasBinaryPayload: false,
      });
      expect(parsed.kind === "target.complete" && parsed.errorTail).toBe(
        errorTail,
      );
    }
  });

  it("1.4 drops an error tail over the byte or line limit but keeps the terminal outcome", () => {
    // Multibyte: fewer characters than the byte limit, more bytes than it.
    const overBytes = "é".repeat(WORKTREE_DELETE_ERROR_TAIL_MAX_BYTES / 2 + 1);
    const overLines = Array.from(
      { length: WORKTREE_DELETE_ERROR_TAIL_MAX_LINES + 1 },
      (_, index) => `line ${index}`,
    ).join("\n");
    for (const errorTail of [overBytes, overLines]) {
      const complete = worktreeDeleteBatchByPathServerFrameSchemaV14.safeParse({
        kind: "target.complete",
        worktreePath: "/wt",
        deleted: false,
        declined: "removal_failed",
        errorTail,
        hasBinaryPayload: false,
      });
      expect(complete.success).toBe(true);
      if (complete.success && complete.data.kind === "target.complete") {
        expect(complete.data.deleted).toBe(false);
        expect(complete.data.declined).toBe("removal_failed");
        expect(complete.data.errorTail).toBeUndefined();
      }
      const failed = worktreeDeleteBatchByPathServerFrameSchemaV14.safeParse({
        kind: "target.failed",
        worktreePath: "/wt",
        reason: "boom",
        errorTail,
        hasBinaryPayload: false,
      });
      expect(failed.success).toBe(true);
      if (failed.success && failed.data.kind === "target.failed") {
        expect(failed.data.reason).toBe("boom");
        expect(failed.data.errorTail).toBeUndefined();
      }
    }
  });

  it("frozen 1.0-1.3 frames strip errorTail (old-client degrade)", () => {
    const frames = [
      {
        kind: "target.complete",
        worktreePath: "/wt",
        deleted: false,
        errorTail: "fatal: x",
        hasBinaryPayload: false,
      },
      {
        kind: "target.failed",
        worktreePath: "/wt",
        reason: "boom",
        errorTail: "fatal: x",
        hasBinaryPayload: false,
      },
    ];
    for (const schema of [
      worktreeDeleteBatchByPathServerFrameSchema,
      worktreeDeleteBatchByPathServerFrameSchemaV11,
      worktreeDeleteBatchByPathServerFrameSchemaV12,
      worktreeDeleteBatchByPathServerFrameSchemaV13,
    ]) {
      for (const frame of frames) {
        expect(schema.parse(frame)).not.toHaveProperty("errorTail");
      }
    }
  });
});

/**
 * Schema + version-negotiation tests for the lifecycle protocol minors:
 * `terminal.subscribe@1.6` viewer intent, `WORKTREE_BUSY` holders,
 * `worktree.delete@1.1` stopOwners, `worktree.deleteByPath@1.1`, and the
 * submit-time workspace intent on `agent.tui.promptSubmitted@1.1`.
 *
 * Chat send already carries `worktreeIntent` (same rebind-mutation shape);
 * that field is reused, not reminted.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  hostResponseErrorSchema,
  upgradeRequestToVersion,
  upgradeResponseToVersion,
  worktreeBusyErrorDetailsSchema,
  worktreeBusyHolderSchema,
} from "@traycer/protocol/framework/index";
import { unaryResponsePayloadSchema } from "@traycer/protocol/host-transport/mux";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  terminalSubscribeOpenRequestSchema,
  terminalSubscribeOpenRequestSchemaV16,
} from "@traycer/protocol/host/terminal/subscribe";
import {
  worktreeDeleteRequestSchema,
  worktreeDeleteRequestSchemaV11,
  worktreeDeleteRequestSchemaV12,
  worktreeHoldersChangedErrorDetailsSchema,
  worktreeListHoldersRequestSchema,
  worktreeListHoldersResponseSchema,
} from "@traycer/protocol/host/worktree-schemas";
import {
  worktreeDeleteByPathOpenRequestSchema,
  worktreeDeleteByPathOpenRequestSchemaV11,
  worktreeDeleteByPathOpenRequestSchemaV12,
  worktreeDeleteByPathServerFrameSchema,
  worktreeDeleteByPathServerFrameSchemaV11,
  worktreeDeleteByPathServerFrameSchemaV12,
} from "@traycer/protocol/host/worktree-delete-stream";

const V10 = { major: 1, minor: 0 } as const;
const V11 = { major: 1, minor: 1 } as const;
const V12 = { major: 1, minor: 2 } as const;

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

const HOLDERS_REVISION_DIGEST = "a".repeat(64);

describe("WORKTREE_BUSY typed holders", () => {
  it("parses a full holder and round-trips", () => {
    const parsed = worktreeBusyHolderSchema.parse(holder);
    expect(worktreeBusyHolderSchema.parse(parsed)).toEqual(parsed);
  });

  it("accepts an optional holderId and round-trips it", () => {
    const withId = { ...holder, holderId: "chat:chat-1" };
    const parsed = worktreeBusyHolderSchema.parse(withId);
    expect(parsed.holderId).toBe("chat:chat-1");
    expect(worktreeBusyHolderSchema.parse(holder).holderId).toBeUndefined();
  });

  it("accepts a WORKTREE_BUSY envelope without holders (old host)", () => {
    const parsed = worktreeBusyErrorDetailsSchema.parse({
      code: "WORKTREE_BUSY",
      message: "Worktree is in use by an active agent or terminal.",
    });
    expect(parsed.holders).toBeUndefined();
  });

  it("accepts a WORKTREE_BUSY envelope with holders (new host)", () => {
    const parsed = worktreeBusyErrorDetailsSchema.parse({
      code: "WORKTREE_BUSY",
      message: "Worktree is in use by an active agent or terminal.",
      holders: [holder],
    });
    expect(parsed.holders).toEqual([holder]);
    expect(parsed.holdersRevision).toBeUndefined();
  });

  it("accepts a digest holdersRevision on a WORKTREE_BUSY envelope", () => {
    const parsed = worktreeBusyErrorDetailsSchema.parse({
      code: "WORKTREE_BUSY",
      message: "Worktree is in use by an active agent or terminal.",
      holders: [holder],
      holdersRevision: HOLDERS_REVISION_DIGEST,
    });
    expect(parsed.holdersRevision).toBe(HOLDERS_REVISION_DIGEST);
  });

  it("sanitizes a non-digest holdersRevision on a WORKTREE_BUSY envelope to absent", () => {
    const parsed = worktreeBusyErrorDetailsSchema.parse({
      code: "WORKTREE_BUSY",
      message: "Worktree is in use by an active agent or terminal.",
      holders: [holder],
      holdersRevision: "rev-1",
    });
    expect(parsed.holdersRevision).toBeUndefined();
  });

  it("keeps holders on the current error envelope", () => {
    const parsed = hostResponseErrorSchema.parse({
      code: "WORKTREE_BUSY",
      message: "busy",
      holders: [holder],
      holdersRevision: HOLDERS_REVISION_DIGEST,
    });
    expect(parsed.holders).toEqual([holder]);
    expect(parsed.holdersRevision).toBe(HOLDERS_REVISION_DIGEST);
  });

  it("sanitizes malformed holders on the WS and mux error envelopes", () => {
    const malformed = [{ not: "a holder" }];
    const wsBusy = hostResponseErrorSchema.safeParse({
      code: "WORKTREE_BUSY",
      message: "in use",
      holders: malformed,
    });
    expect(wsBusy.success).toBe(true);
    if (wsBusy.success) {
      expect(wsBusy.data.code).toBe("WORKTREE_BUSY");
      expect(wsBusy.data.message).toBe("in use");
      expect(wsBusy.data.holders).toBeUndefined();
    }

    const wsOther = hostResponseErrorSchema.safeParse({
      code: "SOME_OTHER_ERROR",
      message: "resolver failed",
      holders: malformed,
    });
    expect(wsOther.success).toBe(true);
    if (wsOther.success) {
      expect(wsOther.data.code).toBe("SOME_OTHER_ERROR");
      expect(wsOther.data.message).toBe("resolver failed");
      expect(wsOther.data.holders).toBeUndefined();
    }

    const muxBusy = unaryResponsePayloadSchema.safeParse({
      requestId: "req-1",
      method: "worktree.delete",
      result: null,
      error: {
        code: "WORKTREE_BUSY",
        message: "in use",
        holders: malformed,
      },
    });
    expect(muxBusy.success).toBe(true);
    if (muxBusy.success) {
      expect(muxBusy.data.error?.code).toBe("WORKTREE_BUSY");
      expect(muxBusy.data.error?.message).toBe("in use");
      expect(muxBusy.data.error?.holders).toBeUndefined();
    }

    const muxOther = unaryResponsePayloadSchema.safeParse({
      requestId: "req-2",
      method: "host.status",
      result: null,
      error: {
        code: "SOME_OTHER_ERROR",
        message: "resolver failed",
        holders: malformed,
      },
    });
    expect(muxOther.success).toBe(true);
    if (muxOther.success) {
      expect(muxOther.data.error?.code).toBe("SOME_OTHER_ERROR");
      expect(muxOther.data.error?.message).toBe("resolver failed");
      expect(muxOther.data.error?.holders).toBeUndefined();
    }
  });

  it("legacy {code,message} parser strips holders (old-client degrade)", () => {
    const legacy = z.object({
      code: z.string(),
      message: z.string(),
    });
    const parsed = legacy.parse({
      code: "WORKTREE_BUSY",
      message: "busy",
      holders: [holder],
      holdersRevision: "rev-1",
    });
    expect(parsed).toEqual({ code: "WORKTREE_BUSY", message: "busy" });
    expect(parsed).not.toHaveProperty("holders");
    expect(parsed).not.toHaveProperty("holdersRevision");
  });
});

describe("terminal.subscribe@1.6 viewer intent", () => {
  it("is registered as latest minor 6", () => {
    expect(hostStreamRpcRegistry["terminal.subscribe"][1].latestMinor).toBe(6);
    expect(
      hostStreamRpcRegistry["terminal.subscribe"][1].versions[6].contract
        .schemaVersion,
    ).toEqual({ major: 1, minor: 6 });
  });

  it("defaults absent viewer to presentation", () => {
    const parsed = terminalSubscribeOpenRequestSchemaV16.parse({
      sessionId: "s1",
      cols: 80,
      rows: 24,
    });
    expect(parsed.viewer).toBe("presentation");
  });

  it("accepts cache", () => {
    const parsed = terminalSubscribeOpenRequestSchemaV16.parse({
      sessionId: "s1",
      cols: 80,
      rows: 24,
      viewer: "cache",
    });
    expect(parsed.viewer).toBe("cache");
  });

  it("1.5 open schema strips viewer (old-host degrade)", () => {
    const parsed = terminalSubscribeOpenRequestSchema.parse({
      sessionId: "s1",
      cols: 80,
      rows: 24,
      viewer: "cache",
    });
    expect(parsed).toEqual({ sessionId: "s1", cols: 80, rows: 24 });
    expect(parsed).not.toHaveProperty("viewer");
  });
});

describe("worktree.delete@1.1 stopOwners", () => {
  const deleteRegistry = hostRpcRegistry["worktree.delete"];

  it("is registered as latest minor 2", () => {
    expect(deleteRegistry[1].latestMinor).toBe(2);
  });

  it("defaults absent stopOwners to false", () => {
    const parsed = worktreeDeleteRequestSchemaV11.parse({
      epicId: "e1",
      workspacePath: "/repo",
      worktreePath: "/wt",
    });
    expect(parsed.stopOwners).toBe(false);
  });

  it("upgrades a 1.0 request to stopOwners: false", () => {
    const upgraded = upgradeRequestToVersion(deleteRegistry, V10, V11, {
      epicId: "e1",
      workspacePath: "/repo",
      worktreePath: "/wt",
    });
    expect(worktreeDeleteRequestSchemaV11.parse(upgraded)).toEqual(upgraded);
    expect(upgraded.stopOwners).toBe(false);
  });

  it("response upgrade is identity", () => {
    const response = { deleted: true };
    expect(
      upgradeResponseToVersion(deleteRegistry, V10, V11, response),
    ).toEqual(response);
  });

  it("1.0 request schema strips stopOwners (old-host degrade)", () => {
    const parsed = worktreeDeleteRequestSchema.parse({
      epicId: "e1",
      workspacePath: "/repo",
      worktreePath: "/wt",
      stopOwners: true,
    });
    expect(parsed).toEqual({
      epicId: "e1",
      workspacePath: "/repo",
      worktreePath: "/wt",
    });
    expect(parsed).not.toHaveProperty("stopOwners");
  });
});

describe("worktree.delete@1.2 expectedHoldersRevision", () => {
  const deleteRegistry = hostRpcRegistry["worktree.delete"];

  it("1.1 body parses as 1.2 with expectedHoldersRevision absent", () => {
    const parsed = worktreeDeleteRequestSchemaV12.parse({
      epicId: "e1",
      workspacePath: "/repo",
      worktreePath: "/wt",
      stopOwners: true,
    });
    expect(parsed.stopOwners).toBe(true);
    expect(parsed.expectedHoldersRevision).toBeUndefined();
  });

  it("accepts expectedHoldersRevision", () => {
    const parsed = worktreeDeleteRequestSchemaV12.parse({
      epicId: "e1",
      workspacePath: "/repo",
      worktreePath: "/wt",
      stopOwners: true,
      expectedHoldersRevision: HOLDERS_REVISION_DIGEST,
    });
    expect(parsed.expectedHoldersRevision).toBe(HOLDERS_REVISION_DIGEST);
  });

  it("rejects a present-empty expectedHoldersRevision", () => {
    const parsed = worktreeDeleteRequestSchemaV12.safeParse({
      epicId: "e1",
      workspacePath: "/repo",
      worktreePath: "/wt",
      stopOwners: true,
      expectedHoldersRevision: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-digest expectedHoldersRevision", () => {
    const parsed = worktreeDeleteRequestSchemaV12.safeParse({
      epicId: "e1",
      workspacePath: "/repo",
      worktreePath: "/wt",
      stopOwners: true,
      expectedHoldersRevision: "rev-abc",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects expectedHoldersRevision when stopOwners is false", () => {
    const parsed = worktreeDeleteRequestSchemaV12.safeParse({
      epicId: "e1",
      workspacePath: "/repo",
      worktreePath: "/wt",
      stopOwners: false,
      expectedHoldersRevision: HOLDERS_REVISION_DIGEST,
    });
    expect(parsed.success).toBe(false);
  });

  it("upgrades a 1.1 request with expectedHoldersRevision absent", () => {
    const upgraded = upgradeRequestToVersion(deleteRegistry, V11, V12, {
      epicId: "e1",
      workspacePath: "/repo",
      worktreePath: "/wt",
      stopOwners: true,
    });
    expect(worktreeDeleteRequestSchemaV12.parse(upgraded)).toEqual(upgraded);
    expect(upgraded.expectedHoldersRevision).toBeUndefined();
    expect(upgraded.stopOwners).toBe(true);
  });

  it("1.1 request schema strips expectedHoldersRevision (old-host degrade)", () => {
    const parsed = worktreeDeleteRequestSchemaV11.parse({
      epicId: "e1",
      workspacePath: "/repo",
      worktreePath: "/wt",
      stopOwners: true,
      expectedHoldersRevision: "rev-abc",
    });
    expect(parsed).not.toHaveProperty("expectedHoldersRevision");
  });

  it("parses a WORKTREE_HOLDERS_CHANGED envelope with holders and a digest revision", () => {
    const parsed = worktreeHoldersChangedErrorDetailsSchema.parse({
      code: "WORKTREE_HOLDERS_CHANGED",
      message: "holders changed",
      holders: [{ ...holder, holderId: "chat:chat-1" }],
      holdersRevision: HOLDERS_REVISION_DIGEST,
    });
    expect(parsed.code).toBe("WORKTREE_HOLDERS_CHANGED");
    expect(parsed.holders).toHaveLength(1);
    expect(parsed.holders?.[0]?.holderId).toBe("chat:chat-1");
    expect(parsed.holdersRevision).toBe(HOLDERS_REVISION_DIGEST);
  });

  it("sanitizes a non-digest holdersRevision on a WORKTREE_HOLDERS_CHANGED envelope to absent", () => {
    const parsed = worktreeHoldersChangedErrorDetailsSchema.parse({
      code: "WORKTREE_HOLDERS_CHANGED",
      message: "holders changed",
      holders: [holder],
      holdersRevision: "rev-1",
    });
    expect(parsed.code).toBe("WORKTREE_HOLDERS_CHANGED");
    expect(parsed.holders).toEqual([holder]);
    expect(parsed.holdersRevision).toBeUndefined();
  });
});

describe("worktree.deleteByPath@1.1 stopOwners + failed holders", () => {
  it("is registered as latest minor 2", () => {
    expect(hostStreamRpcRegistry["worktree.deleteByPath"][1].latestMinor).toBe(
      2,
    );
  });

  it("defaults absent stopOwners to false", () => {
    const parsed = worktreeDeleteByPathOpenRequestSchemaV11.parse({
      worktreePath: "/wt",
    });
    expect(parsed.stopOwners).toBe(false);
    expect(parsed.scripts).toBeNull();
  });

  it("1.0 open schema strips stopOwners", () => {
    const parsed = worktreeDeleteByPathOpenRequestSchema.parse({
      worktreePath: "/wt",
      stopOwners: true,
    });
    expect(parsed).not.toHaveProperty("stopOwners");
  });

  it("1.1 failed frame accepts holders", () => {
    const parsed = worktreeDeleteByPathServerFrameSchemaV11.parse({
      kind: "failed",
      reason: "in use",
      holders: [holder],
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("failed");
    if (parsed.kind === "failed") {
      expect(parsed.holders).toEqual([holder]);
    }
  });

  it("1.1 failed frame with malformed holders keeps kind and reason", () => {
    const parsed = worktreeDeleteByPathServerFrameSchemaV11.safeParse({
      kind: "failed",
      reason: "in use",
      holders: [{ not: "a holder" }],
      hasBinaryPayload: false,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe("failed");
      if (parsed.data.kind === "failed") {
        expect(parsed.data.reason).toBe("in use");
        expect(parsed.data.holders).toBeUndefined();
      }
    }
  });

  it("1.0 failed frame strips holders (old-client degrade)", () => {
    const parsed = worktreeDeleteByPathServerFrameSchema.parse({
      kind: "failed",
      reason: "in use",
      holders: [holder],
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("failed");
    if (parsed.kind === "failed") {
      expect(parsed).not.toHaveProperty("holders");
    }
  });
});

describe("worktree.deleteByPath@1.2 expectedHoldersRevision", () => {
  it("1.1 open body parses as 1.2 with expectedHoldersRevision absent", () => {
    const parsed = worktreeDeleteByPathOpenRequestSchemaV12.parse({
      worktreePath: "/wt",
      stopOwners: true,
    });
    expect(parsed.stopOwners).toBe(true);
    expect(parsed.expectedHoldersRevision).toBeUndefined();
  });

  it("accepts expectedHoldersRevision on the open request", () => {
    const parsed = worktreeDeleteByPathOpenRequestSchemaV12.parse({
      worktreePath: "/wt",
      stopOwners: true,
      expectedHoldersRevision: HOLDERS_REVISION_DIGEST,
    });
    expect(parsed.expectedHoldersRevision).toBe(HOLDERS_REVISION_DIGEST);
  });

  it("rejects a present-empty expectedHoldersRevision on the open request", () => {
    const parsed = worktreeDeleteByPathOpenRequestSchemaV12.safeParse({
      worktreePath: "/wt",
      stopOwners: true,
      expectedHoldersRevision: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-digest expectedHoldersRevision on the open request", () => {
    const parsed = worktreeDeleteByPathOpenRequestSchemaV12.safeParse({
      worktreePath: "/wt",
      stopOwners: true,
      expectedHoldersRevision: "rev-abc",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects expectedHoldersRevision when stopOwners is false on the open request", () => {
    const parsed = worktreeDeleteByPathOpenRequestSchemaV12.safeParse({
      worktreePath: "/wt",
      stopOwners: false,
      expectedHoldersRevision: HOLDERS_REVISION_DIGEST,
    });
    expect(parsed.success).toBe(false);
  });

  it("1.1 open schema strips expectedHoldersRevision", () => {
    const parsed = worktreeDeleteByPathOpenRequestSchemaV11.parse({
      worktreePath: "/wt",
      stopOwners: true,
      expectedHoldersRevision: "rev-abc",
    });
    expect(parsed).not.toHaveProperty("expectedHoldersRevision");
  });

  it("1.2 failed frame accepts HOLDERS_CHANGED code with holders and revision", () => {
    const parsed = worktreeDeleteByPathServerFrameSchemaV12.parse({
      kind: "failed",
      reason: "holders changed",
      code: "WORKTREE_HOLDERS_CHANGED",
      holders: [{ ...holder, holderId: "chat:chat-1" }],
      holdersRevision: HOLDERS_REVISION_DIGEST,
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("failed");
    if (parsed.kind === "failed") {
      expect(parsed.code).toBe("WORKTREE_HOLDERS_CHANGED");
      expect(parsed.holders?.[0]?.holderId).toBe("chat:chat-1");
      expect(parsed.holdersRevision).toBe(HOLDERS_REVISION_DIGEST);
    }
  });

  it("1.2 failed frame sanitizes a non-digest holdersRevision to absent", () => {
    const parsed = worktreeDeleteByPathServerFrameSchemaV12.parse({
      kind: "failed",
      reason: "holders changed",
      holdersRevision: "rev-abc",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("failed");
    if (parsed.kind === "failed") {
      expect(parsed.holdersRevision).toBeUndefined();
    }
  });

  it("1.2 failed frame sanitizes an unknown code to absent without dropping the terminal frame", () => {
    const parsed = worktreeDeleteByPathServerFrameSchemaV12.parse({
      kind: "failed",
      reason: "holders changed",
      code: "SOME_FUTURE_CODE",
      holders: [holder],
      holdersRevision: HOLDERS_REVISION_DIGEST,
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("failed");
    if (parsed.kind === "failed") {
      expect(parsed.code).toBeUndefined();
      expect(parsed.reason).toBe("holders changed");
      expect(parsed.holders).toEqual([holder]);
      expect(parsed.holdersRevision).toBe(HOLDERS_REVISION_DIGEST);
    }
  });

  it("1.2 failed frame keeps a known WORKTREE_BUSY code", () => {
    const parsed = worktreeDeleteByPathServerFrameSchemaV12.parse({
      kind: "failed",
      reason: "in use",
      code: "WORKTREE_BUSY",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("failed");
    if (parsed.kind === "failed") {
      expect(parsed.code).toBe("WORKTREE_BUSY");
    }
  });

  it("1.1 failed frame strips holdersRevision (old-client degrade)", () => {
    const parsed = worktreeDeleteByPathServerFrameSchemaV11.parse({
      kind: "failed",
      reason: "holders changed",
      holdersRevision: "rev-abc",
      holders: [holder],
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("failed");
    if (parsed.kind === "failed") {
      expect(parsed).not.toHaveProperty("holdersRevision");
    }
  });

  it("1.1 failed frame strips the 1.2 code (old-client degrade)", () => {
    const parsed = worktreeDeleteByPathServerFrameSchemaV11.parse({
      kind: "failed",
      reason: "holders changed",
      code: "WORKTREE_HOLDERS_CHANGED",
      holders: [holder],
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("failed");
    if (parsed.kind === "failed") {
      expect(parsed).not.toHaveProperty("code");
    }
  });
});

describe("worktree.listHolders@1.0", () => {
  const listHoldersRegistry = hostRpcRegistry["worktree.listHolders"];

  it("is registered as latest minor 0 with unsupported degrade", () => {
    expect(listHoldersRegistry.degrade).toEqual({ kind: "unsupported" });
    expect(listHoldersRegistry[1].latestMinor).toBe(0);
    expect(listHoldersRegistry[1].versions[0].contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("is absent from the released floor (old-client method-set unchanged)", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain("worktree.listHolders");
  });

  it("defaults absent owner to null (path mode)", () => {
    const parsed = worktreeListHoldersRequestSchema.parse({
      worktreePath: "/wt",
    });
    expect(parsed).toEqual({ worktreePath: "/wt", owner: null });
  });

  it("accepts an owner filter (owner mode)", () => {
    const parsed = worktreeListHoldersRequestSchema.parse({
      worktreePath: "/wt",
      owner: {
        epicId: "epic-1",
        ownerKind: "chat",
        ownerId: "chat-1",
      },
    });
    expect(parsed.owner).toEqual({
      epicId: "epic-1",
      ownerKind: "chat",
      ownerId: "chat-1",
    });
  });

  it("response accepts an empty holders list (unknown path/owner)", () => {
    const parsed = worktreeListHoldersResponseSchema.parse({ holders: [] });
    expect(parsed.holders).toEqual([]);
    expect(parsed.holdersRevision).toBeUndefined();
  });

  it("response accepts T2 holders", () => {
    const parsed = worktreeListHoldersResponseSchema.parse({
      holders: [holder],
    });
    expect(parsed.holders).toEqual([holder]);
  });

  it("response accepts a digest holdersRevision", () => {
    const parsed = worktreeListHoldersResponseSchema.parse({
      holders: [holder],
      holdersRevision: HOLDERS_REVISION_DIGEST,
    });
    expect(parsed.holdersRevision).toBe(HOLDERS_REVISION_DIGEST);
  });

  it("response rejects a non-digest holdersRevision", () => {
    const parsed = worktreeListHoldersResponseSchema.safeParse({
      holders: [holder],
      holdersRevision: "rev-abc",
    });
    expect(parsed.success).toBe(false);
  });
});

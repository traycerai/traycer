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
import { hostRpcRegistry, hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  terminalSubscribeOpenRequestSchema,
  terminalSubscribeOpenRequestSchemaV16,
} from "@traycer/protocol/host/terminal/subscribe";
import {
  worktreeDeleteRequestSchema,
  worktreeDeleteRequestSchemaV11,
} from "@traycer/protocol/host/worktree-schemas";
import {
  worktreeDeleteByPathOpenRequestSchema,
  worktreeDeleteByPathOpenRequestSchemaV11,
  worktreeDeleteByPathServerFrameSchema,
  worktreeDeleteByPathServerFrameSchemaV11,
} from "@traycer/protocol/host/worktree-delete-stream";

const V10 = { major: 1, minor: 0 } as const;
const V11 = { major: 1, minor: 1 } as const;

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

describe("WORKTREE_BUSY typed holders", () => {
  it("parses a full holder and round-trips", () => {
    const parsed = worktreeBusyHolderSchema.parse(holder);
    expect(worktreeBusyHolderSchema.parse(parsed)).toEqual(parsed);
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
  });

  it("keeps holders on the current error envelope", () => {
    const parsed = hostResponseErrorSchema.parse({
      code: "WORKTREE_BUSY",
      message: "busy",
      holders: [holder],
    });
    expect(parsed.holders).toEqual([holder]);
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
    });
    expect(parsed).toEqual({ code: "WORKTREE_BUSY", message: "busy" });
    expect(parsed).not.toHaveProperty("holders");
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

  it("is registered as latest minor 1", () => {
    expect(deleteRegistry[1].latestMinor).toBe(1);
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

describe("worktree.deleteByPath@1.1 stopOwners + failed holders", () => {
  it("is registered as latest minor 1", () => {
    expect(hostStreamRpcRegistry["worktree.deleteByPath"][1].latestMinor).toBe(
      1,
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

/**
 * Schema + version-negotiation tests for the `worktree.listAllForHost` staleness
 * signals added at v1.1. The critical invariant is that a v1.0 caller (the
 * current Settings tab, an older host) keeps negotiating against a v1.1 peer:
 * v1.1 rode a new minor of the EXISTING method, never a new method name, so the
 * frozen host-v1.0.0 method-name set (see released-surface-compat.test.ts) is
 * untouched and the per-method handshake bridges v1.0 <-> v1.1.
 */
import { describe, it, expect } from "vitest";
import {
  upgradeRequestToVersion,
  upgradeResponseToVersion,
} from "@traycer/protocol/framework/index";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  worktreeHostEntrySchema,
  worktreeHostEntrySchemaV11,
  worktreeListAllForHostRequestSchema,
  worktreeListAllForHostRequestSchemaV11,
  worktreeListAllForHostResponseSchemaV11,
} from "@traycer/protocol/host/worktree-schemas";

const V10 = { major: 1, minor: 0 } as const;
const V11 = { major: 1, minor: 1 } as const;

const listAllForHostRegistry = hostRpcRegistry["worktree.listAllForHost"];

// A v1.0 entry - every field the shipped listing already carries, none of the
// v1.1 staleness signals.
const v10Entry = {
  worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
  repoLabel: "acme/web",
  repoIdentifier: { owner: "acme", repo: "web" },
  branch: "feature-x",
  inUse: false,
  uncommittedCount: 0,
  gitRemovable: true,
  scripts: null,
};

describe("worktreeHostEntrySchemaV11", () => {
  it("parses an enriched entry and reparses unchanged", () => {
    const fixture = {
      ...v10Entry,
      lastActivityAt: 1_700_000_000_000,
      owners: [
        {
          epicId: "epic-1",
          ownerKind: "chat" as const,
          ownerId: "chat-1",
          updatedAt: 1_699_000_000_000,
        },
        {
          epicId: "epic-2",
          ownerKind: "terminal-agent" as const,
          ownerId: "agent-1",
          updatedAt: 1_699_500_000_000,
        },
      ],
      branchStatus: { ahead: 2, behind: 1, mergedIntoDefault: false },
      createdAt: 1_698_000_000_000,
    };
    const parsed1 = worktreeHostEntrySchemaV11.parse(fixture);
    const parsed2 = worktreeHostEntrySchemaV11.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
  });

  it("accepts the empty/unreferenced defaults (activity not probed)", () => {
    const parsed = worktreeHostEntrySchemaV11.parse({
      ...v10Entry,
      lastActivityAt: null,
      owners: [],
      branchStatus: null,
      createdAt: null,
    });
    expect(parsed.owners).toEqual([]);
    expect(parsed.branchStatus).toBeNull();
    expect(parsed.lastActivityAt).toBeNull();
  });

  it("still accepts a bare v1.0 entry as its own (v1.0) shape", () => {
    // The v1.0 entry schema is unchanged - a v1.0 host keeps producing it.
    expect(worktreeHostEntrySchema.parse(v10Entry)).toEqual(v10Entry);
  });
});

describe("worktreeListAllForHostRequestSchemaV11", () => {
  it("requires the includeActivity flag", () => {
    expect(worktreeListAllForHostRequestSchemaV11.parse({ includeActivity: true }))
      .toEqual({ includeActivity: true });
    expect(worktreeListAllForHostRequestSchema.parse({})).toEqual({});
  });
});

describe("worktree.listAllForHost v1.0 <-> v1.1 negotiation", () => {
  it("upgrades a v1.0 request to v1.1 with includeActivity defaulted false", () => {
    const upgraded = upgradeRequestToVersion(
      listAllForHostRegistry,
      V10,
      V11,
      {},
    );
    expect(upgraded).toEqual({ includeActivity: false });
    // And it validates against the v1.1 request schema.
    expect(worktreeListAllForHostRequestSchemaV11.parse(upgraded)).toEqual({
      includeActivity: false,
    });
  });

  it("upgrades a v1.0 response by defaulting the enriched entry fields", () => {
    const upgraded = upgradeResponseToVersion(
      listAllForHostRegistry,
      V10,
      V11,
      { worktrees: [v10Entry] },
    );
    expect(upgraded).toEqual({
      worktrees: [
        {
          ...v10Entry,
          lastActivityAt: null,
          owners: [],
          branchStatus: null,
          createdAt: null,
        },
      ],
    });
    // The upgraded payload is a valid v1.1 response.
    expect(worktreeListAllForHostResponseSchemaV11.parse(upgraded)).toEqual(
      upgraded,
    );
  });

  it("exposes v1.1 as the latest installed minor of major 1", () => {
    expect(listAllForHostRegistry[1].latestMinor).toBe(1);
    expect(Object.keys(listAllForHostRegistry[1].versions).sort()).toEqual([
      "0",
      "1",
    ]);
  });
});

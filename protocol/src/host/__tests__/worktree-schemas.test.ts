/**
 * Schema + version-negotiation tests for the `worktree.listAllForHost`
 * pagination and staleness signals added at v1.1. The critical invariant is
 * that a v1.0 caller (the
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
  worktreeBindingEntrySchema,
  worktreeBranchStatusSchema,
  worktreeHostEntrySchema,
  worktreeHostEntrySchemaV11,
  worktreeListAllForHostRequestSchema,
  worktreeListAllForHostResponseSchema,
  worktreeListAllForHostRequestSchemaV11,
  worktreeListAllForHostResponseSchemaV11,
  worktreeListBindingsForEpicResponseSchemaV11,
  worktreeSubmoduleMergeFactSchema,
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

// The merge-provenance fields in their absent shape - what an unprobed entry
// (and the v1.0 -> v1.1 upgrade) fills in: no PR bundle, no owned submodules,
// not at-base. `mergedHeadShaMatches` is `false` (not null) - it is a boolean.
const mergeProvenanceAbsent = {
  prState: null,
  prNumber: null,
  prUrl: null,
  mergedHeadShaMatches: false,
  submodules: [],
  atBaseCommit: false,
} as const;

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
      prState: "merged" as const,
      prNumber: 123,
      prUrl: "https://github.com/acme/web/pull/123",
      mergedHeadShaMatches: true,
      submodules: [
        {
          repoIdentifier: { owner: "acme", repo: "protocol" },
          branch: "feature-x",
          prState: "open" as const,
          prNumber: 45,
          prUrl: "https://github.com/acme/protocol/pull/45",
          mergedHeadShaMatches: false,
          mergedIntoDefault: false,
        },
      ],
      atBaseCommit: false,
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
      ...mergeProvenanceAbsent,
    });
    expect(parsed.owners).toEqual([]);
    expect(parsed.branchStatus).toBeNull();
    expect(parsed.lastActivityAt).toBeNull();
    expect(parsed.prState).toBeNull();
    expect(parsed.mergedHeadShaMatches).toBe(false);
    expect(parsed.submodules).toEqual([]);
  });

  it("parses a never-pushed-but-merged entry (null diff, proven merged)", () => {
    const parsed = worktreeHostEntrySchemaV11.parse({
      ...v10Entry,
      lastActivityAt: null,
      owners: [],
      branchStatus: { ahead: null, behind: null, mergedIntoDefault: true },
      createdAt: null,
      ...mergeProvenanceAbsent,
    });
    expect(parsed.branchStatus).toEqual({
      ahead: null,
      behind: null,
      mergedIntoDefault: true,
    });
  });

  it("parses an at-base entry (contained in default, no PR, atBaseCommit true)", () => {
    const parsed = worktreeHostEntrySchemaV11.parse({
      ...v10Entry,
      lastActivityAt: null,
      owners: [],
      branchStatus: { ahead: null, behind: null, mergedIntoDefault: true },
      createdAt: null,
      ...mergeProvenanceAbsent,
      atBaseCommit: true,
    });
    expect(parsed.prState).toBeNull();
    expect(parsed.submodules).toEqual([]);
    expect(parsed.atBaseCommit).toBe(true);
  });

  it("still accepts a bare v1.0 entry as its own (v1.0) shape", () => {
    // The v1.0 entry schema is unchanged - a v1.0 host keeps producing it.
    expect(worktreeHostEntrySchema.parse(v10Entry)).toEqual(v10Entry);
  });
});

describe("worktreeBranchStatusSchema (upstream-independent reshape)", () => {
  it("accepts null ahead/behind for a never-pushed branch proven merged", () => {
    // The win: a never-pushed branch whose HEAD is contained in the default
    // branch carries a real object with a proven `mergedIntoDefault` and null
    // upstream diff.
    const parsed = worktreeBranchStatusSchema.parse({
      ahead: null,
      behind: null,
      mergedIntoDefault: true,
    });
    expect(parsed).toEqual({
      ahead: null,
      behind: null,
      mergedIntoDefault: true,
    });
  });

  it("accepts a never-pushed but diverged branch (null diff, not merged)", () => {
    const parsed = worktreeBranchStatusSchema.parse({
      ahead: null,
      behind: null,
      mergedIntoDefault: false,
    });
    expect(parsed.ahead).toBeNull();
    expect(parsed.mergedIntoDefault).toBe(false);
  });

  it("still accepts a pushed branch with concrete ahead/behind counts", () => {
    const parsed = worktreeBranchStatusSchema.parse({
      ahead: 2,
      behind: 1,
      mergedIntoDefault: false,
    });
    expect(parsed).toEqual({ ahead: 2, behind: 1, mergedIntoDefault: false });
  });

  it("rejects negative counts", () => {
    expect(() =>
      worktreeBranchStatusSchema.parse({
        ahead: -1,
        behind: 0,
        mergedIntoDefault: false,
      }),
    ).toThrow();
  });
});

describe("worktreeListAllForHostRequestSchemaV11", () => {
  it("requires includeActivity, activityPaths, cursor, and limit", () => {
    expect(
      worktreeListAllForHostRequestSchemaV11.parse({
        includeActivity: true,
        activityPaths: null,
        cursor: null,
        limit: 50,
      }),
    ).toEqual({
      includeActivity: true,
      activityPaths: null,
      cursor: null,
      limit: 50,
    });
    // Nullable fields are never optional - every caller states the paging and
    // enrichment posture explicitly.
    expect(() =>
      worktreeListAllForHostRequestSchemaV11.parse({ includeActivity: true }),
    ).toThrow();
    expect(worktreeListAllForHostRequestSchema.parse({})).toEqual({});
  });

  it("rejects includeActivity=true with an unbounded paged listing", () => {
    expect(() =>
      worktreeListAllForHostRequestSchemaV11.parse({
        includeActivity: true,
        activityPaths: null,
        cursor: null,
        limit: null,
      }),
    ).toThrow();
  });

  it("allows the v1.0 bridge's unpaginated listing only without probes", () => {
    expect(
      worktreeListAllForHostRequestSchemaV11.parse({
        includeActivity: false,
        activityPaths: null,
        cursor: null,
        limit: null,
      }),
    ).toEqual({
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
    });
  });

  it("accepts selection mode with includeActivity=true and null paging fields", () => {
    const parsed = worktreeListAllForHostRequestSchemaV11.parse({
      includeActivity: true,
      activityPaths: ["/Users/dev/.traycer/worktrees/acme__web/feature-x"],
      cursor: null,
      limit: null,
    });
    expect(parsed).toEqual({
      includeActivity: true,
      activityPaths: ["/Users/dev/.traycer/worktrees/acme__web/feature-x"],
      cursor: null,
      limit: null,
    });
  });

  it("rejects selection mode with cursor or limit set", () => {
    expect(() =>
      worktreeListAllForHostRequestSchemaV11.parse({
        includeActivity: true,
        activityPaths: ["/Users/dev/.traycer/worktrees/acme__web/feature-x"],
        cursor: "/Users/dev/.traycer/worktrees/acme__api/feature-y",
        limit: null,
      }),
    ).toThrow();

    expect(() =>
      worktreeListAllForHostRequestSchemaV11.parse({
        includeActivity: true,
        activityPaths: ["/Users/dev/.traycer/worktrees/acme__web/feature-x"],
        cursor: null,
        limit: 25,
      }),
    ).toThrow();
  });
});

describe("worktreeListAllForHostResponseSchemaV11", () => {
  it("requires nextCursor and round-trips a paged response", () => {
    const response = {
      worktrees: [
        {
          ...v10Entry,
          lastActivityAt: null,
          owners: [],
          branchStatus: null,
          createdAt: null,
          ...mergeProvenanceAbsent,
        },
      ],
      nextCursor: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
    };

    const parsed1 = worktreeListAllForHostResponseSchemaV11.parse(response);
    const parsed2 = worktreeListAllForHostResponseSchemaV11.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(() =>
      worktreeListAllForHostResponseSchemaV11.parse({
        worktrees: response.worktrees,
      }),
    ).toThrow();
  });

  it("strips v1.1 pagination and enrichment fields when parsed as v1.0", () => {
    expect(
      worktreeListAllForHostResponseSchema.parse({
        worktrees: [
          {
            ...v10Entry,
            lastActivityAt: null,
            owners: [],
            branchStatus: null,
            createdAt: null,
            ...mergeProvenanceAbsent,
          },
        ],
        nextCursor: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
      }),
    ).toEqual({ worktrees: [v10Entry] });
  });
});

describe("worktree.listAllForHost v1.0 <-> v1.1 negotiation", () => {
  it("upgrades a v1.0 request to v1.1 with explicit unpaginated no-probe defaults", () => {
    const upgraded = upgradeRequestToVersion(
      listAllForHostRegistry,
      V10,
      V11,
      {},
    );
    expect(upgraded).toEqual({
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
    });
    // And it validates against the v1.1 request schema.
    expect(worktreeListAllForHostRequestSchemaV11.parse(upgraded)).toEqual({
      includeActivity: false,
      activityPaths: null,
      cursor: null,
      limit: null,
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
          ...mergeProvenanceAbsent,
        },
      ],
      nextCursor: null,
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

// A binding entry as an older (pre-migration) row would carry it, before the
// `ownedSubmodules` field existed. The host binding-v1->v2 migration backfills
// `ownedSubmodules: []`; here we assert the schema round-trips both the
// backfilled-empty and the fully-populated shapes.
const bindingEntryBase = {
  workspacePath: "/Users/dev/acme/web",
  mode: "worktree" as const,
  repoIdentifier: { owner: "acme", repo: "web" },
  worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
  branch: "feature-x",
  isPrimary: true,
  isImported: false,
  setupState: "succeeded" as const,
  setupTerminalSessionId: null,
  setupExitCode: 0,
  setupFailedAt: null,
  createdAt: 1_700_000_000_000,
};

describe("worktreeBindingEntrySchema (ownedSubmodules addition)", () => {
  it("round-trips a binding entry with owned submodules", () => {
    const entry = {
      ...bindingEntryBase,
      ownedSubmodules: [
        {
          repoIdentifier: { owner: "acme", repo: "protocol" },
          branch: "feature-x",
        },
      ],
    };
    const parsed1 = worktreeBindingEntrySchema.parse(entry);
    const parsed2 = worktreeBindingEntrySchema.parse(parsed1);
    expect(parsed2).toEqual(parsed1);
    expect(parsed1.ownedSubmodules).toHaveLength(1);
  });

  it("accepts the backfilled-empty shape (no owned submodules)", () => {
    const parsed = worktreeBindingEntrySchema.parse({
      ...bindingEntryBase,
      ownedSubmodules: [],
    });
    expect(parsed.ownedSubmodules).toEqual([]);
  });

  it("strips a stray legacy baseSha key (retired field, no v2->v3 bump)", () => {
    // A persisted v2 row written before baseSha was retired still carries the
    // key; zod strips the now-unknown field on read, so no migration is needed.
    const parsed = worktreeBindingEntrySchema.parse({
      ...bindingEntryBase,
      baseSha: "c".repeat(40),
      ownedSubmodules: [],
    });
    expect("baseSha" in parsed).toBe(false);
  });

  it("accepts an entry missing ownedSubmodules (wire compat with pre-existing released hosts)", () => {
    // This entry shape rides several already-released response/stream
    // payloads unversioned; a released host from before this field existed
    // omits the key entirely, and that must still parse.
    const parsed = worktreeBindingEntrySchema.parse(bindingEntryBase);
    expect(parsed.ownedSubmodules).toBeUndefined();
  });
});

describe("worktreeListBindingsForEpicResponseSchemaV11 (folderlessCwd)", () => {
  it("accepts a non-empty folderlessCwd", () => {
    const parsed = worktreeListBindingsForEpicResponseSchemaV11.parse({
      rows: [],
      folderlessCwd: "/Users/dev/.traycer/epics/epic-1",
    });
    expect(parsed.folderlessCwd).toBe("/Users/dev/.traycer/epics/epic-1");
  });

  it("accepts a null folderlessCwd (bridged up from a v1.0 host)", () => {
    const parsed = worktreeListBindingsForEpicResponseSchemaV11.parse({
      rows: [],
      folderlessCwd: null,
    });
    expect(parsed.folderlessCwd).toBeNull();
  });

  it("rejects a missing folderlessCwd - the v1.1 shape is not optional", () => {
    expect(() =>
      worktreeListBindingsForEpicResponseSchemaV11.parse({ rows: [] }),
    ).toThrow();
  });

  it("rejects an empty-string folderlessCwd", () => {
    expect(() =>
      worktreeListBindingsForEpicResponseSchemaV11.parse({
        rows: [],
        folderlessCwd: "",
      }),
    ).toThrow();
  });

  it("rejects an undefined folderlessCwd", () => {
    expect(() =>
      worktreeListBindingsForEpicResponseSchemaV11.parse({
        rows: [],
        folderlessCwd: undefined,
      }),
    ).toThrow();
  });
});

describe("worktreeSubmoduleMergeFactSchema", () => {
  it("round-trips a merged submodule fact", () => {
    const fact = {
      repoIdentifier: { owner: "acme", repo: "protocol" },
      branch: "feature-x",
      prState: "merged" as const,
      prNumber: 45,
      prUrl: "https://github.com/acme/protocol/pull/45",
      mergedHeadShaMatches: true,
      mergedIntoDefault: true,
    };
    expect(worktreeSubmoduleMergeFactSchema.parse(fact)).toEqual(fact);
  });

  it("accepts a submodule with no PR fact (null PR bundle)", () => {
    const parsed = worktreeSubmoduleMergeFactSchema.parse({
      repoIdentifier: { owner: "acme", repo: "protocol" },
      branch: "feature-x",
      prState: null,
      prNumber: null,
      prUrl: null,
      mergedHeadShaMatches: false,
      mergedIntoDefault: false,
    });
    expect(parsed.prState).toBeNull();
    expect(parsed.mergedHeadShaMatches).toBe(false);
  });
});

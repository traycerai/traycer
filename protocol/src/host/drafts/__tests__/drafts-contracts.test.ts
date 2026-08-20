import { describe, expect, it } from "vitest";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import { splitConnectionManifest } from "@traycer/protocol/framework/index";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import {
  draftDialectKindOf,
  draftDocumentSchema,
  draftsClaimResponseSchema,
  draftsClaimV10,
  draftsDeleteV10,
  draftsListRequestSchema,
  draftsListResponseSchema,
  draftsListV10,
  draftsSubscribeClientFrameSchemaV10,
  draftsSubscribeOpenRequestSchemaV10,
  draftsSubscribeServerFrameSchemaV10,
  draftsSubscribeV10,
  draftsUpsertRequestSchema,
  draftsUpsertV10,
  draftSubscribeFrameApplies,
  draftSurfaceKindOf,
  draftWriteSchema,
} from "@traycer/protocol/host/drafts/index";

const UNARY_METHODS = [
  "drafts.upsert",
  "drafts.delete",
  "drafts.list",
  "drafts.claim",
] as const;

const STREAM_METHOD = "drafts.subscribe";

const EMPTY_DOC = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

const RUN_SETTINGS = {
  harnessId: "claude",
  model: "claude-sonnet-4",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const WORKSPACE = {
  folders: ["/repo"],
  folderInfoByPath: {
    "/repo": {
      path: "/repo",
      name: "repo",
      repoIdentifier: { owner: "acme", repo: "widgets" },
      hostId: "host-1",
    },
  },
  primaryPath: "/repo",
};

const LANDING_WRITE = {
  draftId: "draft-1",
  kind: "landing" as const,
  target: { epicId: null, chatId: null, blockId: null },
  revision: 0,
  lastTouchedAt: 1_753_000_000_000,
  workspace: WORKSPACE,
  portable: {
    content: EMPTY_DOC,
    selection: { from: 1, to: 1 },
    runSettings: RUN_SETTINGS,
    composerMode: "chat" as const,
    blobHashes: [] as string[],
  },
};

const LANDING_DOCUMENT = {
  ...LANDING_WRITE,
  revision: 1,
  ownerHostId: "host-1",
  origin: "own" as const,
  adoption: { state: "adopted" as const, hostId: "host-1" },
  publication: {
    status: "unpublished" as const,
    lastPublishedAt: null,
    publishedRevision: null,
    halted: null,
  },
};

const INTERVIEW_DOCUMENT = {
  draftId: "draft-interview",
  kind: "interview" as const,
  target: { epicId: "epic-1", chatId: "chat-1", blockId: "block-1" },
  revision: 3,
  lastTouchedAt: 1_753_000_100_000,
  workspace: null,
  portable: {
    pageIndex: 1,
    answers: [
      { selected: ["yes"], otherText: "", otherSelected: false },
    ],
  },
  ownerHostId: "host-1",
  origin: "own" as const,
  adoption: { state: "adopted" as const, hostId: "host-1" },
  publication: {
    status: "current" as const,
    lastPublishedAt: 1_753_000_200_000,
    publishedRevision: 3,
    halted: null,
  },
};

const STASH_DOCUMENT = {
  draftId: "draft-stash",
  kind: "stash-entry" as const,
  target: { epicId: null, chatId: null, blockId: null },
  revision: 1,
  lastTouchedAt: 1_753_000_000_000,
  workspace: null,
  portable: {
    content: EMPTY_DOC,
    blobHashes: ["cd".repeat(32)],
    createdAt: 1_753_000_000_000,
  },
  ownerHostId: "host-1",
  origin: "own" as const,
  adoption: { state: "adopted" as const, hostId: "host-1" },
  publication: {
    status: "current" as const,
    lastPublishedAt: 1_753_000_000_000,
    publishedRevision: 1,
    halted: null,
  },
};

describe("drafts unary contracts", () => {
  it("registers each method at 1.0 with the exact contract instances", () => {
    expect(draftsUpsertV10.method).toBe("drafts.upsert");
    expect(draftsDeleteV10.method).toBe("drafts.delete");
    expect(draftsListV10.method).toBe("drafts.list");
    expect(draftsClaimV10.method).toBe("drafts.claim");
    expect(hostRpcRegistry["drafts.upsert"][1].versions[0].contract).toBe(
      draftsUpsertV10,
    );
    expect(hostRpcRegistry["drafts.delete"][1].versions[0].contract).toBe(
      draftsDeleteV10,
    );
    expect(hostRpcRegistry["drafts.list"][1].versions[0].contract).toBe(
      draftsListV10,
    );
    expect(hostRpcRegistry["drafts.claim"][1].versions[0].contract).toBe(
      draftsClaimV10,
    );
    for (const method of UNARY_METHODS) {
      expect(hostRpcRegistry[method][1].versions[0].contract.schemaVersion).toEqual(
        { major: 1, minor: 0 },
      );
    }
  });

  it("keeps every additive method optional and unsupported on older hosts", () => {
    const split = splitConnectionManifest(
      hostRpcRegistry,
      RELEASED_FLOOR_METHOD_NAMES,
    );
    for (const method of UNARY_METHODS) {
      expect(hostRpcRegistry[method].degrade).toEqual({ kind: "unsupported" });
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
      expect(split.manifest[method]).toBeUndefined();
      expect(split.optionalManifest[method]).toEqual({ major: 1, minor: 0 });
    }
  });
});

describe("drafts wire documents", () => {
  it("accepts landing, interview, and stash-entry documents", () => {
    expect(draftDocumentSchema.parse(LANDING_DOCUMENT)).toEqual(
      LANDING_DOCUMENT,
    );
    expect(draftDocumentSchema.parse(INTERVIEW_DOCUMENT)).toEqual(
      INTERVIEW_DOCUMENT,
    );
    expect(draftDocumentSchema.parse(STASH_DOCUMENT)).toEqual(STASH_DOCUMENT);
  });

  it("accepts an upsert write and a host-scoped empty list request", () => {
    expect(draftWriteSchema.parse(LANDING_WRITE)).toEqual(LANDING_WRITE);
    expect(draftsUpsertRequestSchema.parse({ draft: LANDING_WRITE })).toEqual({
      draft: LANDING_WRITE,
    });
    expect(draftsListRequestSchema.parse({})).toEqual({});
    expect(
      draftsListResponseSchema.parse({
        drafts: [LANDING_DOCUMENT],
        snapshotSeq: 10,
      }),
    ).toEqual({
      drafts: [LANDING_DOCUMENT],
      snapshotSeq: 10,
    });
    expect(
      draftsListResponseSchema.safeParse({ drafts: [LANDING_DOCUMENT] })
        .success,
    ).toBe(false);
  });

  it("rejects a write whose runSettings omit serviceTier or profileId", () => {
    const settings = LANDING_WRITE.portable.runSettings;
    const result = draftWriteSchema.safeParse({
      ...LANDING_WRITE,
      portable: {
        ...LANDING_WRITE.portable,
        runSettings: {
          harnessId: settings.harnessId,
          model: settings.model,
          permissionMode: settings.permissionMode,
          reasoningEffort: settings.reasoningEffort,
          agentMode: settings.agentMode,
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("maps the five UI kinds onto the three dialect kinds", () => {
    expect(draftDialectKindOf("landing")).toBe("draft");
    expect(draftDialectKindOf("new-chat")).toBe("draft");
    expect(draftDialectKindOf("chat-composer")).toBe("draft");
    expect(draftDialectKindOf("interview")).toBe("interview");
    expect(draftDialectKindOf("stash-entry")).toBe("stash-entry");
    expect(draftSurfaceKindOf("landing")).toBe("landing");
    expect(draftSurfaceKindOf("interview")).toBeNull();
    expect(draftSurfaceKindOf("stash-entry")).toBeNull();
  });

  it("accepts a typed claim unavailable arm for a host without publication", () => {
    expect(
      draftsClaimResponseSchema.parse({
        status: "unavailable",
        reason: "publication-not-ready",
      }),
    ).toEqual({
      status: "unavailable",
      reason: "publication-not-ready",
    });
  });

  it("accepts unsupported-version when a 1.0 host cannot decode a newer head", () => {
    expect(
      draftsClaimResponseSchema.parse({
        status: "unavailable",
        reason: "unsupported-version",
      }),
    ).toEqual({
      status: "unavailable",
      reason: "unsupported-version",
    });
  });

  it("carries stale-authority on a replica's publication halt", () => {
    const replica = {
      ...LANDING_DOCUMENT,
      origin: "replica" as const,
      publication: {
        status: "unknown" as const,
        lastPublishedAt: 1_753_000_000_000,
        publishedRevision: 1,
        halted: {
          cause: "stale-authority" as const,
          since: 1_753_000_300_000,
        },
      },
    };
    expect(draftDocumentSchema.parse(replica)).toEqual(replica);
  });
});

describe("drafts.subscribe@1.0 contract", () => {
  it("declares the method at 1.0 and registers it in the stream registry", () => {
    expect(draftsSubscribeV10.method).toBe(STREAM_METHOD);
    expect(draftsSubscribeV10.schemaVersion).toEqual({ major: 1, minor: 0 });
    expect(buildStreamManifest(hostStreamRpcRegistry)[STREAM_METHOD]).toEqual({
      major: 1,
      minor: 0,
    });
  });

  it("stays out of the unary released floor", () => {
    expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(STREAM_METHOD);
  });

  it("opens host-scoped, with no resume cursor at 1.0", () => {
    expect(draftsSubscribeOpenRequestSchemaV10.parse({})).toEqual({});
    expect(Object.keys(draftsSubscribeOpenRequestSchemaV10.shape)).toEqual([]);
  });

  it("is compatible with itself on the stream handshake", () => {
    const manifest = buildStreamManifest(hostStreamRpcRegistry);
    const result = checkStreamMethodCompatibility(
      hostStreamRpcRegistry,
      manifest,
      manifest,
      "host",
      STREAM_METHOD,
    );
    expect(result.ok).toBe(true);
  });
});

describe("drafts.subscribe@1.0 frames", () => {
  it("parses an upsert whose envelope revision matches its row", () => {
    const frame = {
      kind: "upsert" as const,
      hasBinaryPayload: false as const,
      storeSeq: 12,
      draftId: LANDING_DOCUMENT.draftId,
      revision: LANDING_DOCUMENT.revision,
      draft: LANDING_DOCUMENT,
    };
    expect(draftsSubscribeServerFrameSchemaV10.parse(frame)).toEqual(frame);
  });

  it("rejects an upsert whose envelope addresses a different draft", () => {
    const result = draftsSubscribeServerFrameSchemaV10.safeParse({
      kind: "upsert",
      hasBinaryPayload: false,
      storeSeq: 12,
      draftId: "some-other-draft",
      revision: LANDING_DOCUMENT.revision,
      draft: LANDING_DOCUMENT,
    });
    expect(result.success).toBe(false);
  });

  it("parses a delete that carries the host revision and storeSeq", () => {
    const frame = {
      kind: "delete" as const,
      hasBinaryPayload: false as const,
      storeSeq: 15,
      draftId: "draft-1",
      revision: 4,
    };
    expect(draftsSubscribeServerFrameSchemaV10.parse(frame)).toEqual(frame);
    expect(
      draftsSubscribeServerFrameSchemaV10.safeParse({
        kind: "delete",
        hasBinaryPayload: false,
        draftId: "draft-1",
        revision: 4,
      }).success,
    ).toBe(false);
  });

  it("does not let a buffered stale delete erase a newer list row", () => {
    // Bootstrap: list returned revision 3. A delayed delete at revision 2
    // must drop; applying it unconditionally would wipe the newer snapshot
    // and then reject a later rev-3 revival as "absorbing".
    const afterList = { kind: "row" as const, revision: 3 };
    const snapshotSeq = 10;
    expect(
      draftSubscribeFrameApplies(
        afterList,
        { revision: 2, storeSeq: 8 },
        snapshotSeq,
      ),
    ).toBe(false);
    expect(
      draftSubscribeFrameApplies(
        afterList,
        { revision: 3, storeSeq: 10 },
        snapshotSeq,
      ),
    ).toBe(false);
    expect(
      draftSubscribeFrameApplies(
        afterList,
        { revision: 4, storeSeq: 11 },
        snapshotSeq,
      ),
    ).toBe(true);

    const tombstone = {
      kind: "tombstone" as const,
      revision: 4,
      storeSeq: 11,
    };
    expect(
      draftSubscribeFrameApplies(
        tombstone,
        { revision: 3, storeSeq: 10 },
        snapshotSeq,
      ),
    ).toBe(false);
    expect(
      draftSubscribeFrameApplies(
        tombstone,
        { revision: 5, storeSeq: 12 },
        snapshotSeq,
      ),
    ).toBe(true);
  });

  it("applies present-state upsert and delete under the same strictly-greater revision rule", () => {
    const snapshotSeq = 10;
    expect(
      draftSubscribeFrameApplies(
        { kind: "row", revision: 1 },
        { revision: 1, storeSeq: 11 },
        snapshotSeq,
      ),
    ).toBe(false);
    expect(
      draftSubscribeFrameApplies(
        { kind: "tombstone", revision: 2, storeSeq: 9 },
        { revision: 3, storeSeq: 11 },
        snapshotSeq,
      ),
    ).toBe(true);
  });

  it("drops a buffered pre-delete upsert against an omitted list id", () => {
    // Reviewer case: list snapshotSeq=N omits a draft deleted at rev 10.
    // Buffered upsert (rev 7, storeSeq < N) must not revive it.
    const snapshotSeq = 20;
    expect(
      draftSubscribeFrameApplies(
        { kind: "absent" },
        { revision: 7, storeSeq: 14 },
        snapshotSeq,
      ),
    ).toBe(false);
  });

  it("applies a post-snapshot create against absent", () => {
    const snapshotSeq = 20;
    expect(
      draftSubscribeFrameApplies(
        { kind: "absent" },
        { revision: 1, storeSeq: 21 },
        snapshotSeq,
      ),
    ).toBe(true);
  });

  it("applies a post-snapshot delete against absent as a tombstone", () => {
    const snapshotSeq = 20;
    expect(
      draftSubscribeFrameApplies(
        { kind: "absent" },
        { revision: 1, storeSeq: 22 },
        snapshotSeq,
      ),
    ).toBe(true);
  });

  it("drops an equal-seq frame against absent", () => {
    const snapshotSeq = 20;
    expect(
      draftSubscribeFrameApplies(
        { kind: "absent" },
        { revision: 7, storeSeq: 20 },
        snapshotSeq,
      ),
    ).toBe(false);
  });

  it("accepts a flush client frame for publication coalescing", () => {
    expect(
      draftsSubscribeClientFrameSchemaV10.parse({
        kind: "flush",
        hasBinaryPayload: false,
        draftIds: ["draft-1"],
      }),
    ).toEqual({
      kind: "flush",
      hasBinaryPayload: false,
      draftIds: ["draft-1"],
    });
    expect(
      draftsSubscribeClientFrameSchemaV10.parse({
        kind: "ping",
        hasBinaryPayload: false,
      }),
    ).toEqual({
      kind: "ping",
      hasBinaryPayload: false,
    });
  });
});

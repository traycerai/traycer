import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import {
  epicArtifactRecordSchema,
  epicCommentThreadRecordSchema,
  epicDeletedArtifactRecordSchema,
  epicStateSnapshotBasisSchema,
  epicStateSubscribeClientFrameSchemaV10,
  epicStateSubscribeOpenRequestSchemaV10,
  epicStateSubscribeServerFrameSchemaV10,
} from "@traycer/protocol/host/epic/state-subscribe";
import {
  epicStatusSubscribeClientFrameSchemaV10,
  epicStatusSubscribeServerFrameSchemaV10,
} from "@traycer/protocol/host/epic/status-subscribe";
import {
  artifactSubscribeClientFrameSchemaV10,
  artifactSubscribeOpenRequestSchemaV10,
  artifactSubscribeSeedOfferSchema,
  artifactSubscribeServerFrameSchemaV10,
  artifactSubscribeUnavailableCodeSchema,
} from "@traycer/protocol/host/epic/artifact-subscribe";
import {
  epicGetWorkspaceContextV10,
  epicRetryMigrationV10,
} from "@traycer/protocol/host/epic/lane-unaries";
import { earlyMetaEpicSchema } from "@traycer/protocol/host/epic/snapshot-meta";
import {
  chatRecordSummaryV11Schema,
  listChatRecordsRequestV11Schema,
} from "@traycer/protocol/host/epic/chat-records";
import { epicListChatRecordsUpgradeV10ToV11 } from "@traycer/protocol/host/epic/contracts";
import { hostRpcRegistry, hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

/**
 * `epic.state.subscribe@1.0` / `epic.status.subscribe@1.0` /
 * `artifact.subscribe@1.0` / the two lane unaries / `epic.listChatRecords@1.1`.
 *
 * These five methods retire the monolithic `epic.subscribe` by splitting it
 * into one lane per data CLASS - see the retirement note at the foot of
 * `epic/subscribe.ts` and the module docs on each lane file for the WHY. This
 * file exists to pin the invariants those docs state, so a later edit to any
 * one lane cannot silently regress the property that justified splitting it
 * out in the first place: the empty-delta guard that stops a lane position
 * being consumed for nothing, the text/binary split that is the whole reason
 * two of the three lanes exist, the closed enums that force a widening
 * contributor through a new minor instead of a silent addition, and the fact
 * that the released `epic.subscribe@1` line these lanes replace was left
 * completely untouched by the split.
 */

describe("registry shape: the epic lane surface installs at the versions the split promised", () => {
  it("installs epic.state.subscribe / epic.status.subscribe / artifact.subscribe at major 1, latestMinor 0", () => {
    for (const method of [
      "epic.state.subscribe",
      "epic.status.subscribe",
      "artifact.subscribe",
    ] as const) {
      const majorLine = hostStreamRpcRegistry[method][1];
      expect(majorLine.latestMinor).toBe(0);
      expect(majorLine.versions[0].contract.schemaVersion).toEqual({
        major: 1,
        minor: 0,
      });
    }
  });

  it("keeps epic.subscribe pinned to exactly major 1, with @2.0 gone and @1 intact at latestMinor 3", () => {
    const epicSubscribeMajors = hostStreamRpcRegistry["epic.subscribe"];
    expect(Object.keys(epicSubscribeMajors)).toEqual(["1"]);
    expect(epicSubscribeMajors[1].latestMinor).toBe(3);
  });

  it("installs the two lane unaries at 1.0, degrade: unsupported, and off the released floor", () => {
    for (const method of [
      "epic.getWorkspaceContext",
      "epic.retryMigration",
    ] as const) {
      const registryEntry = hostRpcRegistry[method];
      expect(registryEntry[1].latestMinor).toBe(0);
      expect(registryEntry[1].versions[0].contract.schemaVersion).toEqual({
        major: 1,
        minor: 0,
      });
      expect(registryEntry.degrade).toEqual({ kind: "unsupported" });
      // A new floor name is handshake-fatal against every released peer - this
      // guard is what stops that mistake from ever landing quietly.
      expect(RELEASED_FLOOR_METHOD_NAMES).not.toContain(method);
    }
  });

  it("installs epic.listChatRecords with both @1.0 and @1.1 minors, latestMinor 1", () => {
    const majorLine = hostRpcRegistry["epic.listChatRecords"][1];
    expect(majorLine.latestMinor).toBe(1);
    expect(majorLine.versions[0].contract.schemaVersion).toEqual({
      major: 1,
      minor: 0,
    });
    expect(majorLine.versions[1].contract.schemaVersion).toEqual({
      major: 1,
      minor: 1,
    });
  });
});

describe("the released epic.subscribe@1 line and epic.listChatRecords@1.0 did not move", () => {
  const fixturePath = join(
    import.meta.dirname,
    "../../__tests__/__fixtures__/released-baseline-surface.json",
  );

  it("stream['epic.subscribe'] is byte-for-byte the released baseline surface", () => {
    const baseline: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
    const mine = buildProtocolSurface({
      unary: hostRpcRegistry,
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: hostStreamRpcRegistry,
    });

    expect(mine.stream["epic.subscribe"]).toEqual(
      (baseline as { stream: Record<string, unknown> }).stream[
        "epic.subscribe"
      ],
    );
  });

  it("optionalUnary['epic.listChatRecords'].schemas['1.0'] is unchanged; only 1.1 was added", () => {
    const baseline: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
    const mine = buildProtocolSurface({
      unary: hostRpcRegistry,
      unaryFloorMethodNames: RELEASED_FLOOR_METHOD_NAMES,
      stream: hostStreamRpcRegistry,
    });

    const baselineSchemas = (
      baseline as {
        optionalUnary: Record<string, { schemas: Record<string, unknown> }>;
      }
    ).optionalUnary["epic.listChatRecords"].schemas;

    expect(mine.optionalUnary["epic.listChatRecords"].schemas["1.0"]).toEqual(
      baselineSchemas["1.0"],
    );
    expect(
      mine.optionalUnary["epic.listChatRecords"].schemas["1.1"],
    ).toBeDefined();
  });
});

// ─── Fixtures shared across the lane describe blocks below ────────────────

const specArtifactFixture = {
  kind: "spec" as const,
  id: "artifact-1",
  folderName: "spec-1",
  title: "A spec",
  createdAt: 1,
  updatedAt: 1,
  createdManually: false,
  parentId: null,
};

const deletedSpecArtifactFixture = {
  kind: "spec" as const,
  id: "artifact-1",
  title: "A spec",
  artifactRoomId: null,
  deletedAt: "2026-01-01T00:00:00.000Z",
};

const commentThreadFixture = {
  threadId: "thread-1",
  resolved: false,
  createdAt: 1,
  comments: [],
  data: { createdByUserId: "user-1" },
  artifactId: "artifact-1",
  revision: 0,
};

const epicMetaFixture = { title: "An epic", updatedAt: 1 };

describe("epic.state.subscribe@1.0", () => {
  describe("the open request's resume cursor is required-and-nullable", () => {
    it("parses resume: null (a cold open)", () => {
      const result = epicStateSubscribeOpenRequestSchemaV10.safeParse({
        epicId: "epic-1",
        resume: null,
      });
      expect(result.success).toBe(true);
    });

    it("parses a resume cursor", () => {
      const result = epicStateSubscribeOpenRequestSchemaV10.safeParse({
        epicId: "epic-1",
        resume: { authorityEpoch: "epoch-1", position: 0 },
      });
      expect(result.success).toBe(true);
    });

    it("rejects an open request that omits resume entirely", () => {
      const result = epicStateSubscribeOpenRequestSchemaV10.safeParse({
        epicId: "epic-1",
      });
      expect(result.success).toBe(false);
    });
  });

  it("parses a snapshot frame carrying every row population", () => {
    const result = epicStateSubscribeServerFrameSchemaV10.safeParse({
      kind: "snapshot",
      authorityEpoch: "epoch-1",
      position: 0,
      basis: "cold",
      reconciledWithCloud: false,
      epicMeta: epicMetaFixture,
      artifactRecords: [specArtifactFixture],
      deletedArtifacts: [deletedSpecArtifactFixture],
      roleClaims: [],
      commentThreads: [commentThreadFixture],
      hasBinaryPayload: false,
    });
    expect(result.success).toBe(true);
  });

  describe("the snapshot basis is a closed enum", () => {
    it.each(["cold", "authorityEpochChanged", "resumeTooOld"] as const)(
      "accepts %s",
      (basis) => {
        expect(epicStateSnapshotBasisSchema.safeParse(basis).success).toBe(
          true,
        );
      },
    );

    it("rejects a basis this contract version cannot represent", () => {
      expect(
        epicStateSnapshotBasisSchema.safeParse("replicaRebuilt").success,
      ).toBe(false);
    });
  });

  it("parses a resumed frame", () => {
    const result = epicStateSubscribeServerFrameSchemaV10.safeParse({
      kind: "resumed",
      authorityEpoch: "epoch-1",
      position: 5,
      hasBinaryPayload: false,
    });
    expect(result.success).toBe(true);
  });

  describe("a delta envelope must carry at least one change", () => {
    const emptyDelta = {
      kind: "delta",
      authorityEpoch: "epoch-1",
      seq: 1,
      artifactUpserts: [],
      artifactTombstones: [],
      commentThreadUpserts: [],
      commentThreadRemovals: [],
      epicMeta: null,
      roleClaims: null,
      hasBinaryPayload: false,
    };

    it("rejects an envelope with all six change fields empty/null - it would consume a position for nothing", () => {
      expect(
        epicStateSubscribeServerFrameSchemaV10.safeParse(emptyDelta).success,
      ).toBe(false);
    });

    it.each([
      ["artifactUpserts", [specArtifactFixture]],
      ["artifactTombstones", [deletedSpecArtifactFixture]],
      ["commentThreadUpserts", [commentThreadFixture]],
      [
        "commentThreadRemovals",
        [{ artifactId: "artifact-1", threadId: "thread-1" }],
      ],
      ["epicMeta", { title: "A renamed epic" }],
      ["roleClaims", []],
    ] as const)("accepts a delta carrying only %s", (field, value) => {
      const delta = { ...emptyDelta, [field]: value };
      const result = epicStateSubscribeServerFrameSchemaV10.safeParse(delta);
      expect(result.success).toBe(true);
    });
  });

  describe("every non-pong server frame is text-only", () => {
    const frameBodies: ReadonlyArray<
      readonly [string, Record<string, unknown>]
    > = [
      [
        "snapshot",
        {
          authorityEpoch: "epoch-1",
          position: 0,
          basis: "cold",
          reconciledWithCloud: false,
          epicMeta: epicMetaFixture,
          artifactRecords: [],
          deletedArtifacts: [],
          roleClaims: [],
          commentThreads: [],
        },
      ],
      ["resumed", { authorityEpoch: "epoch-1", position: 0 }],
      [
        "delta",
        {
          authorityEpoch: "epoch-1",
          seq: 1,
          artifactUpserts: [specArtifactFixture],
          artifactTombstones: [],
          commentThreadUpserts: [],
          commentThreadRemovals: [],
          epicMeta: null,
          roleClaims: null,
        },
      ],
      ["pong", {}],
    ];

    it.each(frameBodies)(
      "declares hasBinaryPayload: false on %s, and rejects true",
      (kind, body) => {
        const withFalse = epicStateSubscribeServerFrameSchemaV10.safeParse({
          kind,
          ...body,
          hasBinaryPayload: false,
        });
        expect(withFalse.success).toBe(true);

        const withTrue = epicStateSubscribeServerFrameSchemaV10.safeParse({
          kind,
          ...body,
          hasBinaryPayload: true,
        });
        expect(withTrue.success).toBe(false);
      },
    );
  });

  it("the client frame union is exactly ['ping'] - the lane is read-only on the wire", () => {
    const kinds = epicStateSubscribeClientFrameSchemaV10.options.map(
      (option) => option.shape.kind.value,
    );
    expect(kinds).toEqual(["ping"]);
  });

  it("strips artifactRoomId off an artifact record - room routing stays host-only", () => {
    const parsed = epicArtifactRecordSchema.parse({
      ...specArtifactFixture,
      artifactRoomId: "room-1",
    });
    expect(parsed).not.toHaveProperty("artifactRoomId");
  });

  it("parses a deleted-artifact tombstone record", () => {
    expect(
      epicDeletedArtifactRecordSchema.safeParse(deletedSpecArtifactFixture)
        .success,
    ).toBe(true);
  });

  it("parses a comment-thread row", () => {
    expect(
      epicCommentThreadRecordSchema.safeParse(commentThreadFixture).success,
    ).toBe(true);
  });
});

describe("epic.status.subscribe@1.0", () => {
  const snapshotBase = {
    authorityEpoch: "epoch-1",
    securityEpoch: 0,
    permissionRole: "owner",
    cloudSyncStatus: "connected",
    dirty: false,
  };

  it("parses a full snapshot frame", () => {
    const result = epicStatusSubscribeServerFrameSchemaV10.safeParse({
      kind: "snapshot",
      ...snapshotBase,
      hasBinaryPayload: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a snapshot missing dirty - pre-snapshot dirtiness is UNKNOWN, never omitted", () => {
    const result = epicStatusSubscribeServerFrameSchemaV10.safeParse({
      kind: "snapshot",
      authorityEpoch: snapshotBase.authorityEpoch,
      securityEpoch: snapshotBase.securityEpoch,
      permissionRole: snapshotBase.permissionRole,
      cloudSyncStatus: snapshotBase.cloudSyncStatus,
      hasBinaryPayload: false,
    });
    expect(result.success).toBe(false);
  });

  it("permissionChanged requires securityEpoch - the stamp is the point of the frame", () => {
    const withEpoch = epicStatusSubscribeServerFrameSchemaV10.safeParse({
      kind: "permissionChanged",
      authorityEpoch: "epoch-1",
      securityEpoch: 1,
      permissionRole: "editor",
      hasBinaryPayload: false,
    });
    expect(withEpoch.success).toBe(true);

    const withoutEpoch = epicStatusSubscribeServerFrameSchemaV10.safeParse({
      kind: "permissionChanged",
      authorityEpoch: "epoch-1",
      permissionRole: "editor",
      hasBinaryPayload: false,
    });
    expect(withoutEpoch.success).toBe(false);
  });

  it("the server frame kind set is exactly the ten documented kinds", () => {
    const kinds = epicStatusSubscribeServerFrameSchemaV10.options.map(
      (option) => option.shape.kind.value,
    );
    expect(kinds).toEqual([
      "snapshot",
      "permissionChanged",
      "cloudSyncStatus",
      "dirtyChanged",
      "epicDeleted",
      "migrationStarted",
      "migrationProgress",
      "migrationFailed",
      "migrationNotAllowed",
      "pong",
    ]);
  });

  describe("every frame is text-only", () => {
    const frameBodies: ReadonlyArray<
      readonly [string, Record<string, unknown>]
    > = [
      ["snapshot", snapshotBase],
      [
        "permissionChanged",
        {
          authorityEpoch: "epoch-1",
          securityEpoch: 1,
          permissionRole: "editor",
        },
      ],
      [
        "cloudSyncStatus",
        { authorityEpoch: "epoch-1", status: "reconnecting" },
      ],
      ["dirtyChanged", { authorityEpoch: "epoch-1", dirty: true }],
      [
        "epicDeleted",
        {
          authorityEpoch: "epoch-1",
          deletedByDisplayName: "A user",
          deletedByTraycerUserId: "user-1",
        },
      ],
      ["migrationStarted", { authorityEpoch: "epoch-1" }],
      [
        "migrationProgress",
        {
          authorityEpoch: "epoch-1",
          phase: "upload",
          chunksDone: 1,
          chunksTotal: 2,
        },
      ],
      ["migrationFailed", { authorityEpoch: "epoch-1", reason: "boom" }],
      ["migrationNotAllowed", { authorityEpoch: "epoch-1" }],
      ["pong", {}],
    ];

    it.each(frameBodies)(
      "declares hasBinaryPayload: false on %s, and rejects true",
      (kind, body) => {
        const withFalse = epicStatusSubscribeServerFrameSchemaV10.safeParse({
          kind,
          ...body,
          hasBinaryPayload: false,
        });
        expect(withFalse.success).toBe(true);

        const withTrue = epicStatusSubscribeServerFrameSchemaV10.safeParse({
          kind,
          ...body,
          hasBinaryPayload: true,
        });
        expect(withTrue.success).toBe(false);
      },
    );
  });

  it("the client frame union is exactly ['ping'] - retryMigration became a unary, not a frame", () => {
    const kinds = epicStatusSubscribeClientFrameSchemaV10.options.map(
      (option) => option.shape.kind.value,
    );
    expect(kinds).toEqual(["ping"]);
  });
});

describe("artifact.subscribe@1.0", () => {
  it("the open request requires authorityEpoch - every attach names its generation", () => {
    const withEpoch = artifactSubscribeOpenRequestSchemaV10.safeParse({
      epicId: "epic-1",
      artifactId: "artifact-1",
      authorityEpoch: "epoch-1",
    });
    expect(withEpoch.success).toBe(true);

    const withoutEpoch = artifactSubscribeOpenRequestSchemaV10.safeParse({
      epicId: "epic-1",
      artifactId: "artifact-1",
    });
    expect(withoutEpoch.success).toBe(false);
  });

  describe("seedOffer is both-or-neither", () => {
    it("parses both knownDocGuid and stateVectorBase64", () => {
      expect(
        artifactSubscribeSeedOfferSchema.safeParse({
          knownDocGuid: "guid-1",
          stateVectorBase64: "AQ==",
        }).success,
      ).toBe(true);
    });

    it("rejects stateVectorBase64 alone", () => {
      expect(
        artifactSubscribeSeedOfferSchema.safeParse({
          stateVectorBase64: "AQ==",
        }).success,
      ).toBe(false);
    });

    it("rejects knownDocGuid alone", () => {
      expect(
        artifactSubscribeSeedOfferSchema.safeParse({
          knownDocGuid: "guid-1",
        }).success,
      ).toBe(false);
    });
  });

  describe("doc frame's seededFromOffer has exactly one representation of 'full seed'", () => {
    const docBase = {
      kind: "doc" as const,
      authorityEpoch: "epoch-1",
      artifactId: "artifact-1",
      docGuid: "guid-1",
      stateVectorBase64: "AQ==",
      hasBinaryPayload: true as const,
    };

    it("true parses (a delta against the client's offer)", () => {
      expect(
        artifactSubscribeServerFrameSchemaV10.safeParse({
          ...docBase,
          seededFromOffer: true,
        }).success,
      ).toBe(true);
    });

    it("omitting seededFromOffer parses (a full seed)", () => {
      expect(
        artifactSubscribeServerFrameSchemaV10.safeParse(docBase).success,
      ).toBe(true);
    });

    it("false is rejected - absence is the only legal spelling of 'full seed'", () => {
      expect(
        artifactSubscribeServerFrameSchemaV10.safeParse({
          ...docBase,
          seededFromOffer: false,
        }).success,
      ).toBe(false);
    });
  });

  describe("unavailable.code is a closed enum", () => {
    it.each([
      "staleAuthorityEpoch",
      "artifactNotFound",
      "bodyUnavailable",
    ] as const)("accepts %s", (code) => {
      expect(
        artifactSubscribeUnavailableCodeSchema.safeParse(code).success,
      ).toBe(true);
    });

    it("rejects an unknown code", () => {
      expect(
        artifactSubscribeUnavailableCodeSchema.safeParse("docCorrupted")
          .success,
      ).toBe(false);
    });
  });

  describe("the binary/text split", () => {
    const binaryFrames: ReadonlyArray<
      readonly [string, Record<string, unknown>]
    > = [
      [
        "doc",
        {
          authorityEpoch: "epoch-1",
          artifactId: "artifact-1",
          docGuid: "guid-1",
          stateVectorBase64: "AQ==",
        },
      ],
      [
        "docUpdate",
        {
          authorityEpoch: "epoch-1",
          artifactId: "artifact-1",
          docGuid: "guid-1",
        },
      ],
      [
        "awareness",
        { authorityEpoch: "epoch-1", artifactId: "artifact-1" },
      ],
    ];

    const textFrames: ReadonlyArray<
      readonly [string, Record<string, unknown>]
    > = [
      [
        "docAck",
        {
          authorityEpoch: "epoch-1",
          artifactId: "artifact-1",
          docGuid: "guid-1",
          coverageStateVectorBase64: "AQ==",
        },
      ],
      [
        "unavailable",
        {
          authorityEpoch: "epoch-1",
          artifactId: "artifact-1",
          code: "bodyUnavailable",
          reason: "retrying",
          terminal: false,
        },
      ],
      ["pong", {}],
    ];

    it.each(binaryFrames)(
      "%s declares hasBinaryPayload: true, and rejects false",
      (kind, body) => {
        const withTrue = artifactSubscribeServerFrameSchemaV10.safeParse({
          kind,
          ...body,
          hasBinaryPayload: true,
        });
        expect(withTrue.success).toBe(true);

        const withFalse = artifactSubscribeServerFrameSchemaV10.safeParse({
          kind,
          ...body,
          hasBinaryPayload: false,
        });
        expect(withFalse.success).toBe(false);
      },
    );

    it.each(textFrames)(
      "%s declares hasBinaryPayload: false, and rejects true",
      (kind, body) => {
        const withFalse = artifactSubscribeServerFrameSchemaV10.safeParse({
          kind,
          ...body,
          hasBinaryPayload: false,
        });
        expect(withFalse.success).toBe(true);

        const withTrue = artifactSubscribeServerFrameSchemaV10.safeParse({
          kind,
          ...body,
          hasBinaryPayload: true,
        });
        expect(withTrue.success).toBe(false);
      },
    );
  });

  it("the client frame union is exactly ['applyUpdate', 'awareness', 'ping'] - no attachArtifact/detachArtifact", () => {
    const kinds = artifactSubscribeClientFrameSchemaV10.options.map(
      (option) => option.shape.kind.value,
    );
    expect(kinds).toEqual(["applyUpdate", "awareness", "ping"]);
  });
});

describe("epic.listChatRecords@1.1", () => {
  it("requires hasDocReplica on the @1.1 request - omitting it is rejected", () => {
    const withField = listChatRecordsRequestV11Schema.safeParse({
      epicId: "epic-1",
      hasDocReplica: false,
    });
    expect(withField.success).toBe(true);

    const withoutField = listChatRecordsRequestV11Schema.safeParse({
      epicId: "epic-1",
    });
    expect(withoutField.success).toBe(false);
  });

  it("chatRecordSummaryV11Schema adds docResident and keeps every @1.0 key", () => {
    const row = {
      chatId: "chat-1",
      ownerUserId: "user-1",
      originHostId: "host-1",
      title: "A chat",
      isTitleEditedByUser: false,
      parentChatId: null,
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      archivedAt: null,
      runSettingsSummary: null,
      revision: 1,
      visibility: "private" as const,
      origin: "own" as const,
      docResident: true,
    };

    const parsed = chatRecordSummaryV11Schema.parse(row);
    expect(parsed).toEqual(row);
  });

  it("the upgrade path fills hasDocReplica: true and docResident: false as FACTS about a @1.0 peer", () => {
    const chatRow = {
      chatId: "chat-1",
      ownerUserId: "user-1",
      originHostId: "host-1",
      title: "A chat",
      isTitleEditedByUser: false,
      parentChatId: null,
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      archivedAt: null,
      runSettingsSummary: null,
      revision: 1,
      visibility: "private" as const,
      origin: "own" as const,
    };

    const upgradedRequest = epicListChatRecordsUpgradeV10ToV11.upgradeRequest({
      epicId: "epic-1",
    });
    expect(upgradedRequest).toEqual({
      epicId: "epic-1",
      hasDocReplica: true,
    });
    expect(
      listChatRecordsRequestV11Schema.safeParse(upgradedRequest).success,
    ).toBe(true);

    const upgradedResponse = epicListChatRecordsUpgradeV10ToV11.upgradeResponse(
      { chats: [chatRow] },
    );
    expect(upgradedResponse.chats.map((row) => row.docResident)).toEqual([
      false,
    ]);
    expect(
      upgradedResponse.chats.every(
        (row) => chatRecordSummaryV11Schema.safeParse(row).success,
      ),
    ).toBe(true);
  });
});

describe("lane unaries", () => {
  it("epic.getWorkspaceContext@1.0 wraps exactly the earlyMeta payload shape", () => {
    const context = {
      epicLight: null,
      permissionRole: null,
      repos: [],
      workspaces: [],
      repoMapping: [],
      workspaceFolders: [],
      unresolvedRepos: [],
    };

    // The same fixture must parse against BOTH the frozen earlyMeta frame's
    // payload schema and the new response's `context` field, so a future
    // divergence between them fails here rather than in the field.
    expect(earlyMetaEpicSchema.safeParse(context).success).toBe(true);

    const response = epicGetWorkspaceContextV10.responseSchema.safeParse({
      context,
    });
    expect(response.success).toBe(true);
  });

  it("epic.retryMigration@1.0 response is { ok: true }, and { ok: false } is rejected", () => {
    expect(
      epicRetryMigrationV10.responseSchema.safeParse({ ok: true }).success,
    ).toBe(true);
    expect(
      epicRetryMigrationV10.responseSchema.safeParse({ ok: false }).success,
    ).toBe(false);
  });
});

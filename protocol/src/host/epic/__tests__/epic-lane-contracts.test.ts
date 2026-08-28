import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProtocolSurface } from "@traycer/protocol/framework/surface-build";
import {
  epicArtifactRecordSchema,
  epicCommentThreadRecordSchema,
  epicCommentThreadRemovalSchema,
  epicDeletedArtifactRecordSchema,
  epicStateRoleClaimsProjectionSchema,
  epicStateSnapshotBasisSchema,
  epicStateSubscribeClientFrameSchemaV10,
  epicStateSubscribeOpenRequestSchemaV10,
  epicStateSubscribeServerFrameSchemaV10,
} from "@traycer/protocol/host/epic/state-subscribe";
import {
  epicDeletionAttributionSchema,
  epicDeletionStatusSchema,
  epicMigrationStatusSchema,
  epicStatusSubscribeClientFrameSchemaV10,
  epicStatusSubscribeServerFrameSchemaV10,
} from "@traycer/protocol/host/epic/status-subscribe";
import { epicCloudSyncStatusSchema } from "@traycer/protocol/host/epic/subscribe";
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
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
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
  revision: 0,
};

const deletedSpecArtifactFixture = {
  kind: "spec" as const,
  id: "artifact-1",
  title: "A spec",
  artifactRoomId: null,
  deletedAt: "2026-01-01T00:00:00.000Z",
  revision: 0,
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

const commentThreadRemovalFixture = {
  artifactId: "artifact-1",
  threadId: "thread-1",
  revision: 0,
};

const emptyRoleClaimsProjectionFixture = { revision: 0, claims: [] };

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
      roleClaims: emptyRoleClaimsProjectionFixture,
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
      ["commentThreadRemovals", [commentThreadRemovalFixture]],
      ["epicMeta", { title: "A renamed epic" }],
      ["roleClaims", emptyRoleClaimsProjectionFixture],
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
          roleClaims: emptyRoleClaimsProjectionFixture,
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

  describe("every row and removal on the lane requires a revision", () => {
    it("rejects an artifact record with no revision, accepts one with it", () => {
      const { revision: _revision, ...withoutRevision } = specArtifactFixture;
      expect(epicArtifactRecordSchema.safeParse(withoutRevision).success).toBe(
        false,
      );
      expect(
        epicArtifactRecordSchema.safeParse(specArtifactFixture).success,
      ).toBe(true);
    });

    it("rejects a deleted-artifact tombstone with no revision, accepts one with it", () => {
      const { revision: _revision, ...withoutRevision } =
        deletedSpecArtifactFixture;
      expect(
        epicDeletedArtifactRecordSchema.safeParse(withoutRevision).success,
      ).toBe(false);
      expect(
        epicDeletedArtifactRecordSchema.safeParse(deletedSpecArtifactFixture)
          .success,
      ).toBe(true);
    });

    it("rejects a comment-thread removal with no revision, accepts one with it", () => {
      const { revision: _revision, ...withoutRevision } =
        commentThreadRemovalFixture;
      expect(
        epicCommentThreadRemovalSchema.safeParse(withoutRevision).success,
      ).toBe(false);
      expect(
        epicCommentThreadRemovalSchema.safeParse(commentThreadRemovalFixture)
          .success,
      ).toBe(true);
    });
  });

  it("a tombstone does not gate absorption on revision ordering - a lower-revision tombstone is a valid frame beside a higher-revision upsert for the same row", () => {
    // The wire only carries the number; the reconciler's absorbing-removal
    // semantics (rule 2 in `epicLaneRowRevisionSchema`'s doc comment) are what
    // makes this pair meaningful, not a schema-level ordering check. The
    // schema's job here is only to prove it does NOT reject this shape.
    const upsertAtRevisionFive = { ...specArtifactFixture, revision: 5 };
    const tombstoneAtRevisionTwo = {
      ...deletedSpecArtifactFixture,
      revision: 2,
    };

    expect(
      epicArtifactRecordSchema.safeParse(upsertAtRevisionFive).success,
    ).toBe(true);
    expect(
      epicDeletedArtifactRecordSchema.safeParse(tombstoneAtRevisionTwo).success,
    ).toBe(true);
  });

  describe("epicStateRoleClaimsProjectionSchema is a revisioned SET, not a bare array", () => {
    it("accepts {revision, claims}", () => {
      expect(
        epicStateRoleClaimsProjectionSchema.safeParse(
          emptyRoleClaimsProjectionFixture,
        ).success,
      ).toBe(true);
    });

    it("rejects the old bare-array shape", () => {
      expect(epicStateRoleClaimsProjectionSchema.safeParse([]).success).toBe(
        false,
      );
    });
  });
});

describe("epic.status.subscribe@1.0", () => {
  const snapshotBase = {
    authorityEpoch: "epoch-1",
    securityEpoch: 0,
    permissionRole: "owner",
    cloudSyncStatus: "connected",
    dirty: false,
    migration: null,
    deletion: { state: "none" as const },
  };

  // The pre-open control basis (see the module doc): the host must be able to
  // emit a truthful snapshot before the epic room is open, during a migration.
  // `permissionRole` and `cloudSyncStatus` already have truthful pre-open
  // values; `dirty` and `deletion` are the two fields that needed an explicit
  // not-established representation to stay honest in that state.
  const preOpenSnapshotBasis = {
    authorityEpoch: "epoch-1",
    securityEpoch: 0,
    permissionRole: null,
    cloudSyncStatus: "disconnected" as const,
    dirty: null,
    migration: { state: "running" as const, progress: null },
    deletion: { state: "unknown" as const },
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
      migration: snapshotBase.migration,
      deletion: snapshotBase.deletion,
      hasBinaryPayload: false,
    });
    expect(result.success).toBe(false);
  });

  describe("migration and deletion are required - a host must not be able to stay silent about them", () => {
    it("rejects a snapshot omitting migration", () => {
      const { migration: _migration, ...withoutMigration } = snapshotBase;
      const result = epicStatusSubscribeServerFrameSchemaV10.safeParse({
        kind: "snapshot",
        ...withoutMigration,
        hasBinaryPayload: false,
      });
      expect(result.success).toBe(false);
    });

    it("rejects a snapshot omitting deletion", () => {
      const { deletion: _deletion, ...withoutDeletion } = snapshotBase;
      const result = epicStatusSubscribeServerFrameSchemaV10.safeParse({
        kind: "snapshot",
        ...withoutDeletion,
        hasBinaryPayload: false,
      });
      expect(result.success).toBe(false);
    });
  });

  it("parses the pre-open control basis: dirty null, deletion unknown, migration running, mid-migration before the epic is open", () => {
    const result = epicStatusSubscribeServerFrameSchemaV10.safeParse({
      kind: "snapshot",
      ...preOpenSnapshotBasis,
      hasBinaryPayload: false,
    });
    expect(result.success).toBe(true);
  });

  describe("dirty is a tri-state on the snapshot: null | true | false, never omitted", () => {
    it.each([null, true, false])("parses dirty: %s", (dirty) => {
      const result = epicStatusSubscribeServerFrameSchemaV10.safeParse({
        kind: "snapshot",
        ...snapshotBase,
        dirty,
        hasBinaryPayload: false,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("epicDeletionStatusSchema - unknown / none / deleted, and the redefine is pinned", () => {
    it("parses unknown", () => {
      expect(
        epicDeletionStatusSchema.safeParse({ state: "unknown" }).success,
      ).toBe(true);
    });

    it("parses none", () => {
      expect(
        epicDeletionStatusSchema.safeParse({ state: "none" }).success,
      ).toBe(true);
    });

    it("parses deleted with attribution", () => {
      expect(
        epicDeletionStatusSchema.safeParse({
          state: "deleted",
          attribution: {
            deletedByDisplayName: "A user",
            deletedByTraycerUserId: "user-1",
          },
        }).success,
      ).toBe(true);
    });

    it("rejects deleted with no attribution", () => {
      expect(
        epicDeletionStatusSchema.safeParse({ state: "deleted" }).success,
      ).toBe(false);
    });

    it("rejects an unknown discriminator value", () => {
      expect(
        epicDeletionStatusSchema.safeParse({ state: "gone" }).success,
      ).toBe(false);
    });

    it("rejects the old two-state shapes - bare null and a bare attribution object", () => {
      expect(epicDeletionStatusSchema.safeParse(null).success).toBe(false);
      expect(
        epicDeletionStatusSchema.safeParse({
          deletedByDisplayName: "A user",
          deletedByTraycerUserId: "user-1",
        }).success,
      ).toBe(false);
    });
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
          attribution: {
            deletedByDisplayName: "A user",
            deletedByTraycerUserId: "user-1",
          },
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

  it("dirtyChanged rejects dirty: null - a transition can only be emitted once the fact is established; the first dirtyChanged after a null snapshot is what establishes it, so this frame never restates 'unknown'", () => {
    const result = epicStatusSubscribeServerFrameSchemaV10.safeParse({
      kind: "dirtyChanged",
      authorityEpoch: "epoch-1",
      dirty: null,
      hasBinaryPayload: false,
    });
    expect(result.success).toBe(false);
  });

  it("cloudSyncStatus has a reachable not-connected member - guards against narrowing away the only truthful pre-open value", () => {
    expect(epicCloudSyncStatusSchema.safeParse("disconnected").success).toBe(
      true,
    );
    const result = epicStatusSubscribeServerFrameSchemaV10.safeParse({
      kind: "snapshot",
      ...snapshotBase,
      cloudSyncStatus: "disconnected",
      hasBinaryPayload: false,
    });
    expect(result.success).toBe(true);
  });

  describe("epicMigrationStatusSchema - the snapshot's current-state projection of the migration lifecycle", () => {
    it.each([
      [
        "running with progress null - the real reconnect window before the first migrationProgress",
        { state: "running" as const, progress: null },
      ],
      [
        "running with progress",
        {
          state: "running" as const,
          progress: { phase: "upload" as const, chunksDone: 1, chunksTotal: 2 },
        },
      ],
      ["failed", { state: "failed" as const, reason: "boom" }],
      ["notAllowed", { state: "notAllowed" as const }],
    ])("parses %s", (_label, status) => {
      expect(epicMigrationStatusSchema.safeParse(status).success).toBe(true);
    });

    it("rejects a running state with no progress key - progress is required, even though it is nullable", () => {
      expect(
        epicMigrationStatusSchema.safeParse({ state: "running" }).success,
      ).toBe(false);
    });

    it("rejects a failed state with no reason", () => {
      expect(
        epicMigrationStatusSchema.safeParse({ state: "failed" }).success,
      ).toBe(false);
    });

    it("rejects a completed state - there is deliberately no terminal-success member", () => {
      expect(
        epicMigrationStatusSchema.safeParse({ state: "completed" }).success,
      ).toBe(false);
    });
  });

  describe("epicDeleted carries a nested attribution, not the old flat fields", () => {
    it("parses with nested attribution", () => {
      const result = epicStatusSubscribeServerFrameSchemaV10.safeParse({
        kind: "epicDeleted",
        authorityEpoch: "epoch-1",
        attribution: {
          deletedByDisplayName: "A user",
          deletedByTraycerUserId: "user-1",
        },
        hasBinaryPayload: false,
      });
      expect(result.success).toBe(true);
    });

    it("rejects the old flat shape - the two flat fields no longer exist on this frame", () => {
      const result = epicStatusSubscribeServerFrameSchemaV10.safeParse({
        kind: "epicDeleted",
        authorityEpoch: "epoch-1",
        deletedByDisplayName: "A user",
        deletedByTraycerUserId: "user-1",
        hasBinaryPayload: false,
      });
      expect(result.success).toBe(false);
    });

    it("epicDeletionAttributionSchema is the exact shape shared by the transition frame and the snapshot projection", () => {
      expect(
        epicDeletionAttributionSchema.safeParse({
          deletedByDisplayName: null,
          deletedByTraycerUserId: null,
        }).success,
      ).toBe(true);
    });
  });

  it("the completeness sweep: every non-snapshot, non-pong frame kind has a snapshot projection, and every projected field actually exists on the snapshot", () => {
    // Mirrors the module doc's frame-kind -> snapshot-projection table verbatim.
    // Adding a frame kind without extending this map fails this test, which is
    // the point: cursor-less-by-design is only honest if the snapshot stays
    // complete, and this is what keeps that from silently rotting.
    const kindToSnapshotFields: Readonly<Record<string, readonly string[]>> = {
      permissionChanged: ["securityEpoch", "permissionRole"],
      cloudSyncStatus: ["cloudSyncStatus"],
      dirtyChanged: ["dirty"],
      epicDeleted: ["deletion"],
      migrationStarted: ["migration"],
      migrationProgress: ["migration"],
      migrationFailed: ["migration"],
      migrationNotAllowed: ["migration"],
    };

    const allKinds = epicStatusSubscribeServerFrameSchemaV10.options.map(
      (option) => option.shape.kind.value,
    );
    const projectableKinds = allKinds.filter(
      (kind) => kind !== "snapshot" && kind !== "pong",
    );

    // Every projectable kind is mapped, and the map contains nothing stale.
    expect(new Set(Object.keys(kindToSnapshotFields))).toEqual(
      new Set(projectableKinds),
    );

    const snapshotOption = epicStatusSubscribeServerFrameSchemaV10.options.find(
      (option) => option.shape.kind.value === "snapshot",
    );
    if (!snapshotOption) {
      throw new Error(
        "no snapshot variant on epicStatusSubscribeServerFrameSchemaV10",
      );
    }
    const snapshotFieldNames = new Set(Object.keys(snapshotOption.shape));

    for (const fields of Object.values(kindToSnapshotFields)) {
      for (const field of fields) {
        expect(snapshotFieldNames.has(field)).toBe(true);
      }
    }
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
      ["awareness", { authorityEpoch: "epoch-1", artifactId: "artifact-1" }],
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

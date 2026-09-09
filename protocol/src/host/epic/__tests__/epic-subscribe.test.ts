import { describe, expect, it } from "vitest";
import {
  epicSubscribeClientFrameSchema,
  epicSubscribeServerFrameSchema,
  epicSubscribeServerFrameSchemaV10,
  epicSubscribeServerFrameSchemaV11,
  epicSubscribeServerFrameSchemaV12,
  epicSubscribeServerFrameSchemaV14,
  epicSubscribeServerFrameSchemaV15,
  epicSubscribeServerFrameSchemaV16,
  epicSubscribeV10,
} from "@traycer/protocol/host/epic/subscribe";

/**
 * `epic.subscribe@1.0` frame fixtures.
 *
 * Covers every frame kind the contract declares, including the binary-bearing
 * frames (`hasBinaryPayload: true`) that ride a paired binary payload and the
 * pure-text frames (`pong`, `permissionChanged`, `ping`) whose
 * `hasBinaryPayload` is pinned to the `false` literal.
 */

describe("epic.subscribe@1.0 server frames", () => {
  it("parses a binary-bearing snapshot frame", () => {
    const parsed = epicSubscribeServerFrameSchemaV10.parse({
      kind: "snapshot",
      epicId: "epic-1",
      meta: {
        schemaVersion: "1.0.0",
        epicLight: null,
        permissionRole: "owner",
        repos: [],
        workspaces: [],
        repoMapping: [],
        workspaceFolders: [],
        unresolvedRepos: [],
        hostStateVectorBase64: "AQ==",
      },
      hasBinaryPayload: true,
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind === "snapshot") {
      expect(parsed.epicId).toBe("epic-1");
      expect(parsed.meta.permissionRole).toBe("owner");
      expect(parsed.hasBinaryPayload).toBe(true);
    }
  });

  it("parses binary-bearing update and awareness frames", () => {
    const update = epicSubscribeServerFrameSchema.parse({
      kind: "update",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    expect(update.kind).toBe("update");
    expect(update.hasBinaryPayload).toBe(true);

    const awareness = epicSubscribeServerFrameSchema.parse({
      kind: "awareness",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    expect(awareness.kind).toBe("awareness");
    expect(awareness.hasBinaryPayload).toBe(true);
  });

  it("parses a text-only permissionChanged frame with a null role", () => {
    const parsed = epicSubscribeServerFrameSchema.parse({
      kind: "permissionChanged",
      epicId: "epic-1",
      permissionRole: null,
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("permissionChanged");
    if (parsed.kind === "permissionChanged") {
      expect(parsed.permissionRole).toBeNull();
      expect(parsed.hasBinaryPayload).toBe(false);
    }
  });

  it("parses every cloudSyncStatus transition variant", () => {
    for (const status of [
      "connected",
      "reconnecting",
      "disconnected",
    ] as const) {
      const parsed = epicSubscribeServerFrameSchema.parse({
        kind: "cloudSyncStatus",
        epicId: "epic-1",
        status,
        hasBinaryPayload: false,
      });

      expect(parsed.kind).toBe("cloudSyncStatus");
      if (parsed.kind === "cloudSyncStatus") {
        expect(parsed.status).toBe(status);
        expect(parsed.hasBinaryPayload).toBe(false);
      }
    }
  });

  it("keeps durability additive for an older renderer", () => {
    const frame = {
      kind: "cloudSyncStatus" as const,
      epicId: "epic-1",
      status: "connected" as const,
      durability: "paused" as const,
      pauseReason: "access-revoked" as const,
      hasBinaryPayload: false as const,
    };
    expect(epicSubscribeServerFrameSchemaV14.parse(frame)).toMatchObject(frame);
    const legacy = epicSubscribeServerFrameSchemaV11.parse(frame);
    expect(legacy).toEqual({
      kind: "cloudSyncStatus",
      epicId: "epic-1",
      status: "connected",
      hasBinaryPayload: false,
    });
  });

  it("@1.6 carries the s5 status keys and @1.5 strips them", () => {
    const frame = {
      kind: "cloudSyncStatus" as const,
      epicId: "epic-1",
      status: "connected" as const,
      durability: "local" as const,
      promotionState: "pending" as const,
      localProtection: "unavailable" as const,
      freshness: {
        kind: "freshnessUnknown" as const,
        state: "local-copy" as const,
      },
      hasBinaryPayload: false as const,
    };
    expect(epicSubscribeServerFrameSchemaV16.parse(frame)).toMatchObject(frame);
    // An older renderer keeps exactly its @1.5 rendering: the new KEYS are
    // stripped rather than refused, which is what makes the minor additive.
    expect(epicSubscribeServerFrameSchemaV15.parse(frame)).toEqual({
      kind: "cloudSyncStatus",
      epicId: "epic-1",
      status: "connected",
      durability: "local",
      promotionState: "pending",
      hasBinaryPayload: false,
    });
  });

  it("@1.6 makes an unarmed session and an unknown durability expressible", () => {
    const parsed = epicSubscribeServerFrameSchemaV16.parse({
      kind: "cloudSyncStatus",
      epicId: "epic-1",
      status: "connected",
      durability: "unknown",
      localProtection: "unavailable",
      hasBinaryPayload: false,
    });
    expect(parsed).toMatchObject({
      durability: "unknown",
      localProtection: "unavailable",
    });
  });

  it("@1.6 VALUE growth is emission-gated: @1.5 refuses the new enum members", () => {
    // Unlike a new key, a new enum value is REFUSED by the older minor rather
    // than stripped - so the host must gate these on the negotiated version.
    for (const widened of [
      { durability: "unknown" },
      { pauseReason: "orphaned-local-edits-after-cloud-delete" },
      { pauseReason: "delete-pending-acknowledgement" },
      { pauseReason: "delete-tombstone-unscoped-cleared" },
    ]) {
      const frame = {
        kind: "cloudSyncStatus",
        epicId: "epic-1",
        status: "connected",
        hasBinaryPayload: false,
        ...widened,
      };
      expect(
        epicSubscribeServerFrameSchemaV16.safeParse(frame).success,
        JSON.stringify(widened),
      ).toBe(true);
      expect(
        epicSubscribeServerFrameSchemaV15.safeParse(frame).success,
        JSON.stringify(widened),
      ).toBe(false);
    }
  });

  it("@1.6 keeps the pause reasons the frozen minors already spoke", () => {
    for (const pauseReason of [
      "entitlement-lapsed",
      "access-revoked",
    ] as const) {
      const frame = {
        kind: "cloudSyncStatus" as const,
        epicId: "epic-1",
        status: "connected" as const,
        durability: "paused" as const,
        pauseReason,
        hasBinaryPayload: false as const,
      };
      expect(epicSubscribeServerFrameSchemaV16.parse(frame)).toMatchObject(
        frame,
      );
      expect(epicSubscribeServerFrameSchemaV14.parse(frame)).toMatchObject(
        frame,
      );
    }
  });

  it("@1.6 cannot claim `current` freshness without a reconciliation timestamp", () => {
    const timestamped = {
      kind: "cloudSyncStatus" as const,
      epicId: "epic-1",
      status: "connected" as const,
      freshness: {
        kind: "lastCloudSyncAt" as const,
        reconciledAtEpochMs: 1_700_000_000_000,
        state: "current" as const,
      },
      hasBinaryPayload: false as const,
    };
    expect(epicSubscribeServerFrameSchemaV16.parse(timestamped)).toMatchObject(
      timestamped,
    );
    // The whole point of the conservative datum: no timestamp, no `current`.
    expect(
      epicSubscribeServerFrameSchemaV16.safeParse({
        ...timestamped,
        freshness: { kind: "freshnessUnknown", state: "current" },
      }).success,
    ).toBe(false);
    for (const state of ["local-copy", "syncing", "stale"] as const) {
      expect(
        epicSubscribeServerFrameSchemaV16.safeParse({
          ...timestamped,
          freshness: { kind: "freshnessUnknown", state },
        }).success,
        state,
      ).toBe(true);
    }
  });

  it("parses a text-only pong frame", () => {
    const parsed = epicSubscribeServerFrameSchema.parse({
      kind: "pong",
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("pong");
    expect(parsed.hasBinaryPayload).toBe(false);
  });

  it("rejects a pong frame that claims a binary payload", () => {
    expect(() =>
      epicSubscribeServerFrameSchema.parse({
        kind: "pong",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });

  it("rejects a snapshot frame that is missing the meta envelope", () => {
    expect(() =>
      epicSubscribeServerFrameSchema.parse({
        kind: "snapshot",
        epicId: "epic-1",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });
});

describe("epic.subscribe@1.2 snapshot room identity (@1.0/@1.1 meta frozen)", () => {
  const snapshotWithRoomId = {
    kind: "snapshot",
    epicId: "epic-1",
    meta: {
      schemaVersion: "1.0.0",
      roomId: "room-x",
      epicLight: null,
      permissionRole: "owner",
      repos: [],
      workspaces: [],
      repoMapping: [],
      workspaceFolders: [],
      unresolvedRepos: [],
      hostStateVectorBase64: "AQ==",
    },
    hasBinaryPayload: true,
  };

  it("strips roomId when a snapshot frame carrying it is parsed under the frozen @1.0 meta shape", () => {
    const parsed = epicSubscribeServerFrameSchemaV10.parse(snapshotWithRoomId);
    if (parsed.kind !== "snapshot") {
      throw new Error("expected snapshot frame");
    }
    // A @1.0 peer discards what a @1.2 host sends - exactly why the host
    // needs no emission gate for this key (`subscribe.ts`).
    expect("roomId" in parsed.meta).toBe(false);
  });

  it("strips roomId when a snapshot frame carrying it is parsed under the frozen @1.1 meta shape", () => {
    const parsed = epicSubscribeServerFrameSchemaV11.parse(snapshotWithRoomId);
    if (parsed.kind !== "snapshot") {
      throw new Error("expected snapshot frame");
    }
    expect("roomId" in parsed.meta).toBe(false);
  });

  it("retains an optional room identity on a snapshot frame", () => {
    const parsed = epicSubscribeServerFrameSchemaV12.parse(snapshotWithRoomId);

    if (parsed.kind !== "snapshot") {
      throw new Error("expected snapshot frame");
    }
    expect(parsed.meta.roomId).toBe("room-x");
  });

  it("parses a snapshot frame with no roomId at all under @1.2", () => {
    // Pins `.optional()` on `roomId`. The GUI client parses every server
    // frame with the LATEST schema regardless of the negotiated minor
    // (`epic-stream-client.ts`), so an @1.0/@1.1 host's snapshot frame -
    // which never carries this key - must stay parseable at a @1.2-capable
    // client. If `roomId` were ever tightened to required, that frame would
    // fail to parse, and the client's parse-failure path returns silently,
    // leaving the canvas stuck on its loading skeleton forever. This test is
    // what catches a future "tighten roomId to required" edit.
    const parsed = epicSubscribeServerFrameSchemaV12.parse({
      kind: "snapshot",
      epicId: "epic-1",
      meta: {
        schemaVersion: "1.0.0",
        epicLight: null,
        permissionRole: "owner",
        repos: [],
        workspaces: [],
        repoMapping: [],
        workspaceFolders: [],
        unresolvedRepos: [],
        hostStateVectorBase64: "AQ==",
      },
      hasBinaryPayload: true,
    });

    if (parsed.kind !== "snapshot") {
      throw new Error("expected snapshot frame");
    }
    expect(parsed.meta.roomId).toBeUndefined();
  });
});

describe("epic.subscribe@1.0 client frames", () => {
  it("parses binary-bearing applyUpdate and awareness frames", () => {
    const applyUpdate = epicSubscribeClientFrameSchema.parse({
      kind: "applyUpdate",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    expect(applyUpdate.kind).toBe("applyUpdate");
    expect(applyUpdate.hasBinaryPayload).toBe(true);

    const awareness = epicSubscribeClientFrameSchema.parse({
      kind: "awareness",
      epicId: "epic-1",
      hasBinaryPayload: true,
    });
    expect(awareness.kind).toBe("awareness");
    expect(awareness.hasBinaryPayload).toBe(true);
  });

  it("parses a text-only ping frame", () => {
    const parsed = epicSubscribeClientFrameSchema.parse({
      kind: "ping",
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("ping");
    expect(parsed.hasBinaryPayload).toBe(false);
  });
});

describe("epic.subscribe@1.0 artifact-room-scoped server frames", () => {
  it("parses a artifactRoomSnapshot frame keyed by artifactRoomId carrying a host artifactRoom state vector", () => {
    const parsed = epicSubscribeServerFrameSchema.parse({
      kind: "artifactRoomSnapshot",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-0",
      hostArtifactRoomStateVectorBase64: "AQ==",
      hasBinaryPayload: true,
    });
    expect(parsed.kind).toBe("artifactRoomSnapshot");
    if (parsed.kind === "artifactRoomSnapshot") {
      expect(parsed.artifactRoomId).toBe("artifact-room-0");
      expect(parsed.hostArtifactRoomStateVectorBase64).toBe("AQ==");
      expect(parsed.hasBinaryPayload).toBe(true);
    }
  });

  it("parses artifactRoomUpdate and artifactRoomAwareness frames keyed by artifactRoomId", () => {
    const update = epicSubscribeServerFrameSchema.parse({
      kind: "artifactRoomUpdate",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-1",
      hostArtifactRoomStateVectorBase64: "AQ==",
      hasBinaryPayload: true,
    });
    expect(update.kind).toBe("artifactRoomUpdate");
    if (update.kind === "artifactRoomUpdate") {
      expect(update.artifactRoomId).toBe("artifact-room-1");
      expect(update.hostArtifactRoomStateVectorBase64).toBe("AQ==");
    }

    const awareness = epicSubscribeServerFrameSchema.parse({
      kind: "artifactRoomAwareness",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-1",
      hasBinaryPayload: true,
    });
    expect(awareness.kind).toBe("artifactRoomAwareness");
  });

  it("rejects a artifactRoomSnapshot/artifactRoomUpdate frame missing hostArtifactRoomStateVectorBase64", () => {
    expect(() =>
      epicSubscribeServerFrameSchema.parse({
        kind: "artifactRoomSnapshot",
        epicId: "epic-1",
        artifactRoomId: "artifact-room-0",
        hasBinaryPayload: true,
      }),
    ).toThrow();
    expect(() =>
      epicSubscribeServerFrameSchema.parse({
        kind: "artifactRoomUpdate",
        epicId: "epic-1",
        artifactRoomId: "artifact-room-0",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });

  it("parses every artifactRoomState transition variant", () => {
    for (const state of ["ready", "unavailable", "retrying"] as const) {
      const parsed = epicSubscribeServerFrameSchema.parse({
        kind: "artifactRoomState",
        epicId: "epic-1",
        artifactRoomId: "artifact-room-2",
        state,
        hasBinaryPayload: false,
      });
      expect(parsed.kind).toBe("artifactRoomState");
      if (parsed.kind === "artifactRoomState") {
        expect(parsed.state).toBe(state);
        expect(parsed.artifactRoomId).toBe("artifact-room-2");
        expect(parsed.hasBinaryPayload).toBe(false);
      }
    }
  });

  it("rejects artifactRoom frames missing the artifactRoomId discriminator", () => {
    expect(() =>
      epicSubscribeServerFrameSchema.parse({
        kind: "artifactRoomSnapshot",
        epicId: "epic-1",
        hostArtifactRoomStateVectorBase64: "AQ==",
        hasBinaryPayload: true,
      }),
    ).toThrow();
    expect(() =>
      epicSubscribeServerFrameSchema.parse({
        kind: "artifactRoomUpdate",
        epicId: "epic-1",
        hostArtifactRoomStateVectorBase64: "AQ==",
        hasBinaryPayload: true,
      }),
    ).toThrow();
    expect(() =>
      epicSubscribeServerFrameSchema.parse({
        kind: "artifactRoomState",
        epicId: "epic-1",
        state: "ready",
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });

  it("rejects an empty-string artifactRoomId", () => {
    expect(() =>
      epicSubscribeServerFrameSchema.parse({
        kind: "artifactRoomSnapshot",
        epicId: "epic-1",
        artifactRoomId: "",
        hostArtifactRoomStateVectorBase64: "AQ==",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });
});

describe("epic.subscribe@1.0 migration frames", () => {
  it("parses a text-only migrationStarted frame", () => {
    const parsed = epicSubscribeServerFrameSchema.parse({
      kind: "migrationStarted",
      epicId: "epic-1",
      hasBinaryPayload: false,
    });

    expect(parsed.kind).toBe("migrationStarted");
    if (parsed.kind === "migrationStarted") {
      expect(parsed.epicId).toBe("epic-1");
      expect(parsed.hasBinaryPayload).toBe(false);
    }
  });

  it("parses a migrationProgress frame for every phase", () => {
    for (const phase of ["prepare", "upload", "finalize"] as const) {
      const parsed = epicSubscribeServerFrameSchema.parse({
        kind: "migrationProgress",
        epicId: "epic-1",
        phase,
        chunksDone: 0,
        chunksTotal: 1,
        hasBinaryPayload: false,
      });

      expect(parsed.kind).toBe("migrationProgress");
      if (parsed.kind === "migrationProgress") {
        expect(parsed.phase).toBe(phase);
        expect(parsed.chunksDone).toBe(0);
        expect(parsed.chunksTotal).toBe(1);
        expect(parsed.hasBinaryPayload).toBe(false);
      }
    }
  });

  it("parses a migrationProgress frame with mid-upload tick counts", () => {
    const parsed = epicSubscribeServerFrameSchema.parse({
      kind: "migrationProgress",
      epicId: "epic-1",
      phase: "upload",
      chunksDone: 7,
      chunksTotal: 12,
      hasBinaryPayload: false,
    });

    if (parsed.kind === "migrationProgress") {
      expect(parsed.chunksDone).toBe(7);
      expect(parsed.chunksTotal).toBe(12);
    }
  });

  it("rejects a migrationProgress frame with chunksTotal=0", () => {
    expect(() =>
      epicSubscribeServerFrameSchema.parse({
        kind: "migrationProgress",
        epicId: "epic-1",
        phase: "upload",
        chunksDone: 0,
        chunksTotal: 0,
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });

  it("rejects a migrationProgress frame with a negative chunksDone", () => {
    expect(() =>
      epicSubscribeServerFrameSchema.parse({
        kind: "migrationProgress",
        epicId: "epic-1",
        phase: "upload",
        chunksDone: -1,
        chunksTotal: 5,
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });

  it("rejects a migrationProgress frame with an unknown phase", () => {
    expect(() =>
      epicSubscribeServerFrameSchema.parse({
        kind: "migrationProgress",
        epicId: "epic-1",
        phase: "uploading",
        chunksDone: 0,
        chunksTotal: 1,
        hasBinaryPayload: false,
      }),
    ).toThrow();
  });

  it("parses a text-only migrationFailed frame carrying a diagnostic reason", () => {
    const parsed = epicSubscribeServerFrameSchema.parse({
      kind: "migrationFailed",
      epicId: "epic-1",
      reason: "publishArtifactRoom timeout",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("migrationFailed");
    if (parsed.kind === "migrationFailed") {
      expect(parsed.epicId).toBe("epic-1");
      expect(parsed.reason).toBe("publishArtifactRoom timeout");
      expect(parsed.hasBinaryPayload).toBe(false);
    }
  });

  it("parses a text-only retryMigration client frame", () => {
    const parsed = epicSubscribeClientFrameSchema.parse({
      kind: "retryMigration",
      epicId: "epic-1",
      hasBinaryPayload: false,
    });
    expect(parsed.kind).toBe("retryMigration");
    if (parsed.kind === "retryMigration") {
      expect(parsed.epicId).toBe("epic-1");
      expect(parsed.hasBinaryPayload).toBe(false);
    }
  });

  it("rejects a retryMigration client frame that claims a binary payload", () => {
    expect(() =>
      epicSubscribeClientFrameSchema.parse({
        kind: "retryMigration",
        epicId: "epic-1",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });
});

describe("epic.subscribe@1.0 artifact-room-scoped client frames", () => {
  it("parses artifactRoomApplyUpdate and artifactRoomAwareness frames", () => {
    const apply = epicSubscribeClientFrameSchema.parse({
      kind: "artifactRoomApplyUpdate",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-3",
      hasBinaryPayload: true,
    });
    expect(apply.kind).toBe("artifactRoomApplyUpdate");
    expect(
      apply.kind === "artifactRoomApplyUpdate" && apply.artifactRoomId,
    ).toBe("artifact-room-3");

    const awareness = epicSubscribeClientFrameSchema.parse({
      kind: "artifactRoomAwareness",
      epicId: "epic-1",
      artifactRoomId: "artifact-room-3",
      hasBinaryPayload: true,
    });
    expect(awareness.kind).toBe("artifactRoomAwareness");
  });

  it("rejects artifactRoom client frames missing artifactRoomId", () => {
    expect(() =>
      epicSubscribeClientFrameSchema.parse({
        kind: "artifactRoomApplyUpdate",
        epicId: "epic-1",
        hasBinaryPayload: true,
      }),
    ).toThrow();
  });
});

describe("epic.subscribe dirtySnapshot + dirty deltas version gate (@1.0 frozen, @1.1 additive)", () => {
  const artifactRoomDirtyFrame = {
    kind: "artifactRoomDirty",
    epicId: "epic-1",
    artifactRoomId: "artifact-room-0",
    dirty: true,
    hasBinaryPayload: false,
  };

  const rootDirtyFrame = {
    kind: "rootDirty",
    epicId: "epic-1",
    dirty: true,
    hasBinaryPayload: false,
  };

  const dirtySnapshotFrame = {
    kind: "dirtySnapshot",
    epicId: "epic-1",
    rootDirty: true,
    rooms: [
      { artifactRoomId: "artifact-room-0", dirty: true },
      { artifactRoomId: "artifact-room-1", dirty: false },
    ],
    hasBinaryPayload: false,
  };

  it("rejects an artifactRoomDirty frame under the frozen @1.0 schema", () => {
    expect(() =>
      epicSubscribeServerFrameSchemaV10.parse(artifactRoomDirtyFrame),
    ).toThrow();
  });

  it("rejects a rootDirty frame under the frozen @1.0 schema", () => {
    expect(() =>
      epicSubscribeServerFrameSchemaV10.parse(rootDirtyFrame),
    ).toThrow();
  });

  it("rejects a dirtySnapshot frame under the frozen @1.0 schema", () => {
    expect(() =>
      epicSubscribeServerFrameSchemaV10.parse(dirtySnapshotFrame),
    ).toThrow();
  });

  it("accepts an artifactRoomDirty frame under @1.1", () => {
    const parsed = epicSubscribeServerFrameSchemaV11.parse(
      artifactRoomDirtyFrame,
    );
    expect(parsed.kind).toBe("artifactRoomDirty");
    if (parsed.kind === "artifactRoomDirty") {
      expect(parsed.artifactRoomId).toBe("artifact-room-0");
      expect(parsed.dirty).toBe(true);
    }
  });

  it("accepts a rootDirty frame under @1.1", () => {
    const parsed = epicSubscribeServerFrameSchemaV11.parse(rootDirtyFrame);
    expect(parsed.kind).toBe("rootDirty");
    if (parsed.kind === "rootDirty") {
      expect(parsed.dirty).toBe(true);
      expect(parsed.epicId).toBe("epic-1");
    }
  });

  it("accepts a dirtySnapshot frame under @1.1 with root + rooms", () => {
    const parsed = epicSubscribeServerFrameSchemaV11.parse(dirtySnapshotFrame);
    expect(parsed.kind).toBe("dirtySnapshot");
    if (parsed.kind === "dirtySnapshot") {
      expect(parsed.rootDirty).toBe(true);
      expect(parsed.rooms).toEqual([
        { artifactRoomId: "artifact-room-0", dirty: true },
        { artifactRoomId: "artifact-room-1", dirty: false },
      ]);
    }
  });

  it("accepts a dirtySnapshot with an empty rooms list (root-only epic)", () => {
    const parsed = epicSubscribeServerFrameSchemaV11.parse({
      ...dirtySnapshotFrame,
      rootDirty: false,
      rooms: [],
    });
    expect(parsed.kind).toBe("dirtySnapshot");
    if (parsed.kind === "dirtySnapshot") {
      expect(parsed.rootDirty).toBe(false);
      expect(parsed.rooms).toEqual([]);
    }
  });

  it("rejects an artifactRoomDirty frame with a non-boolean dirty value", () => {
    expect(() =>
      epicSubscribeServerFrameSchemaV11.parse({
        ...artifactRoomDirtyFrame,
        dirty: "true",
      }),
    ).toThrow();
  });

  it("rejects a rootDirty frame with a non-boolean dirty value", () => {
    expect(() =>
      epicSubscribeServerFrameSchemaV11.parse({
        ...rootDirtyFrame,
        dirty: "true",
      }),
    ).toThrow();
  });

  it("rejects a dirtySnapshot with a non-boolean rootDirty", () => {
    expect(() =>
      epicSubscribeServerFrameSchemaV11.parse({
        ...dirtySnapshotFrame,
        rootDirty: "true",
      }),
    ).toThrow();
  });

  it("rejects an artifactRoomDirty frame with an empty artifactRoomId", () => {
    expect(() =>
      epicSubscribeServerFrameSchemaV11.parse({
        ...artifactRoomDirtyFrame,
        artifactRoomId: "",
      }),
    ).toThrow();
  });

  it("@1.2 still accepts dirtySnapshot, artifactRoomDirty and rootDirty - additive over @1.1", () => {
    const artifactRoomDirty = epicSubscribeServerFrameSchemaV12.parse(
      artifactRoomDirtyFrame,
    );
    expect(artifactRoomDirty.kind).toBe("artifactRoomDirty");

    const rootDirty = epicSubscribeServerFrameSchemaV12.parse(rootDirtyFrame);
    expect(rootDirty.kind).toBe("rootDirty");

    const dirtySnapshot =
      epicSubscribeServerFrameSchemaV12.parse(dirtySnapshotFrame);
    expect(dirtySnapshot.kind).toBe("dirtySnapshot");
  });

  it("@1.1 and @1.2 still accept every @1.0 frame kind - additive, nothing dropped", () => {
    const v10Fixtures: ReadonlyArray<Record<string, unknown>> = [
      {
        kind: "snapshot",
        epicId: "epic-1",
        meta: {
          schemaVersion: "1.0.0",
          epicLight: null,
          permissionRole: "owner",
          repos: [],
          workspaces: [],
          repoMapping: [],
          workspaceFolders: [],
          unresolvedRepos: [],
          hostStateVectorBase64: "AQ==",
        },
        hasBinaryPayload: true,
      },
      {
        kind: "earlyMeta",
        epicId: "epic-1",
        meta: {
          epicLight: null,
          permissionRole: "owner",
          repos: [],
          workspaces: [],
          repoMapping: [],
          workspaceFolders: [],
          unresolvedRepos: [],
        },
        hasBinaryPayload: false,
      },
      { kind: "update", epicId: "epic-1", hasBinaryPayload: true },
      { kind: "awareness", epicId: "epic-1", hasBinaryPayload: true },
      {
        kind: "permissionChanged",
        epicId: "epic-1",
        permissionRole: null,
        hasBinaryPayload: false,
      },
      {
        kind: "cloudSyncStatus",
        epicId: "epic-1",
        status: "connected",
        hasBinaryPayload: false,
      },
      { kind: "pong", hasBinaryPayload: false },
      {
        kind: "artifactRoomSnapshot",
        epicId: "epic-1",
        artifactRoomId: "artifact-room-0",
        hostArtifactRoomStateVectorBase64: "AQ==",
        hasBinaryPayload: true,
      },
      {
        kind: "artifactRoomUpdate",
        epicId: "epic-1",
        artifactRoomId: "artifact-room-0",
        hostArtifactRoomStateVectorBase64: "AQ==",
        hasBinaryPayload: true,
      },
      {
        kind: "artifactRoomAwareness",
        epicId: "epic-1",
        artifactRoomId: "artifact-room-0",
        hasBinaryPayload: true,
      },
      {
        kind: "artifactRoomState",
        epicId: "epic-1",
        artifactRoomId: "artifact-room-0",
        state: "ready",
        hasBinaryPayload: false,
      },
      { kind: "migrationStarted", epicId: "epic-1", hasBinaryPayload: false },
      {
        kind: "migrationProgress",
        epicId: "epic-1",
        phase: "upload",
        chunksDone: 1,
        chunksTotal: 2,
        hasBinaryPayload: false,
      },
      {
        kind: "migrationFailed",
        epicId: "epic-1",
        reason: "boom",
        hasBinaryPayload: false,
      },
      {
        kind: "migrationNotAllowed",
        epicId: "epic-1",
        hasBinaryPayload: false,
      },
      {
        kind: "epicDeleted",
        epicId: "epic-1",
        deletedByDisplayName: null,
        deletedByTraycerUserId: null,
        hasBinaryPayload: false,
      },
    ];
    for (const fixture of v10Fixtures) {
      expect(() =>
        epicSubscribeServerFrameSchemaV10.parse(fixture),
      ).not.toThrow();
      expect(() =>
        epicSubscribeServerFrameSchemaV11.parse(fixture),
      ).not.toThrow();
      // The @1.2 union was built by splicing a new snapshot frame in front of
      // the shared non-snapshot frames - this proves nothing was lost in
      // that splice.
      expect(() =>
        epicSubscribeServerFrameSchemaV12.parse(fixture),
      ).not.toThrow();
    }
  });
});

describe("epic.subscribe@1.0 open request", () => {
  it("requires an epicId", () => {
    const parsed = epicSubscribeV10.openRequestSchema.parse({
      epicId: "epic-1",
    });
    expect(parsed.epicId).toBe("epic-1");

    expect(() => epicSubscribeV10.openRequestSchema.parse({})).toThrow();
  });
});

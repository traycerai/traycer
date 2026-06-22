import { describe, expect, it } from "vitest";
import {
  epicSubscribeClientFrameSchema,
  epicSubscribeServerFrameSchema,
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
    const parsed = epicSubscribeServerFrameSchema.parse({
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
    expect(apply.kind === "artifactRoomApplyUpdate" && apply.artifactRoomId).toBe(
      "artifact-room-3",
    );

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

describe("epic.subscribe@1.0 open request", () => {
  it("requires an epicId", () => {
    const parsed = epicSubscribeV10.openRequestSchema.parse({
      epicId: "epic-1",
    });
    expect(parsed.epicId).toBe("epic-1");

    expect(() => epicSubscribeV10.openRequestSchema.parse({})).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import {
  selectConnectionManifestForPeer,
  SERVES_EVERY_INSTALLED_MAJOR,
  type ManifestRegistry,
} from "@traycer/protocol/framework/index";
import { highestSharedMajor } from "@traycer/protocol/framework/compat-helpers";
import type { ConnectionManifest } from "@traycer/protocol/framework/ws-protocol";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { streamSupportMatrix } from "@traycer/protocol/host/__tests__/__fixtures__/stream-support-matrix";
import {
  deletedReviewArtifactSchema,
  deletedSpecArtifactSchema,
  deletedStoryArtifactSchema,
  deletedTicketArtifactSchema,
  reviewArtifactSchema,
  specArtifactSchema,
  storyArtifactSchema,
  ticketArtifactSchema,
} from "@traycer/protocol/persistence/epic/artifacts";
import {
  epicArtifactRecordSchema,
  epicDeletedArtifactRecordSchema,
  epicSubscribeClientFrameSchema,
  epicSubscribeClientFrameSchemaV20,
  epicSubscribeOpenRequestSchema,
  epicSubscribeOpenRequestSchemaV10,
  epicSubscribeOpenRequestSchemaV20,
  epicSubscribeServerFrameSchema,
  epicSubscribeServerFrameSchemaV20,
  epicSubscribeV13,
  epicSubscribeV20,
  type EpicSubscribeServerFrameV20,
} from "@traycer/protocol/host/epic/subscribe";

const METHOD = "epic.subscribe";
const STREAM_EPOCH = "epoch-a";
const HASH_ROOM_ID = "room-should-never-leave-the-host";

const EMPTY_EARLY_META = {
  epicLight: null,
  permissionRole: "owner" as const,
  repos: [],
  workspaces: [],
  repoMapping: [],
  workspaceFolders: [],
  unresolvedRepos: [],
};

const SPEC_RECORD = {
  kind: "spec" as const,
  id: "spec-1",
  folderName: "overview",
  title: "Overview",
  createdAt: 1,
  updatedAt: 2,
  createdManually: false,
  parentId: null,
};

const TICKET_RECORD = {
  kind: "ticket" as const,
  id: "ticket-1",
  folderName: "implement-subscribe",
  title: "Implement subscribe",
  createdAt: 3,
  updatedAt: 4,
  createdManually: true,
  parentId: "spec-1",
  assignee: "user-1",
  status: 1 as const,
};

const STORY_RECORD = {
  kind: "story" as const,
  id: "story-1",
  folderName: "rollout",
  title: "Rollout",
  createdAt: 5,
  updatedAt: 6,
  createdManually: false,
  parentId: "spec-1",
  assignee: "user-2",
  status: 0 as const,
};

const REVIEW_RECORD = {
  kind: "review" as const,
  id: "review-1",
  folderName: "contract-review",
  title: "Contract review",
  createdAt: 7,
  updatedAt: 8,
  createdManually: true,
  parentId: "story-1",
};

const ROLE_CLAIM = {
  claimId: "550e8400-e29b-41d4-a716-446655440000",
  agentId: "agent-1",
  userId: "user-1",
  role: "Planner",
  scope: "subscribe contract",
  claimedAt: 9,
};

const REPLACEMENT_STATE_KINDS = [
  "epicStateSnapshot",
  "artifactRecordUpsert",
  "artifactRecordRemove",
  "epicMetaChanged",
  "roleClaimsChanged",
] as const;

const DELETED_TICKET = {
  kind: "ticket" as const,
  id: "ticket-1",
  title: "Implement subscribe",
  deletedAt: "2026-08-25T00:00:01.000Z",
  status: 1 as const,
};

type ReplacementStateKind = (typeof REPLACEMENT_STATE_KINDS)[number];
type EpochOnlyKind = Exclude<
  EpicSubscribeServerFrameV20["kind"],
  ReplacementStateKind | "pong"
>;

/**
 * Keyed by kind rather than declared as an array so the fixture set is
 * EXHAUSTIVE over `EpochOnlyKind` by construction: a new epoch-only frame
 * kind on a future `@2` minor fails to compile here until it gets a
 * fixture, instead of silently skipping the loops that assert it requires
 * `streamEpoch` and strips a leaked `seq`. Same discipline as
 * `replacementStateFixture`'s `never` check.
 */
const EPOCH_ONLY_KIND_FIXTURE_BY_KIND: {
  readonly [Kind in EpochOnlyKind]: {
    readonly extra: Record<string, unknown>;
    readonly hasBinaryPayload: boolean;
  };
} = {
  commentThreadsChanged: {
    extra: { artifactIds: ["spec-1"] },
    hasBinaryPayload: false,
  },
  earlyMeta: {
    extra: { meta: EMPTY_EARLY_META },
    hasBinaryPayload: false,
  },
  permissionChanged: {
    extra: { permissionRole: "editor" },
    hasBinaryPayload: false,
  },
  cloudSyncStatus: {
    extra: { status: "connected" },
    hasBinaryPayload: false,
  },
  migrationStarted: {
    extra: {},
    hasBinaryPayload: false,
  },
  migrationProgress: {
    extra: { phase: "upload", chunksDone: 1, chunksTotal: 4 },
    hasBinaryPayload: false,
  },
  migrationFailed: {
    extra: { reason: "cloud unavailable" },
    hasBinaryPayload: false,
  },
  migrationNotAllowed: {
    extra: {},
    hasBinaryPayload: false,
  },
  epicDeleted: {
    extra: {
      deletedByDisplayName: "Ada",
      deletedByTraycerUserId: "user-9",
    },
    hasBinaryPayload: false,
  },
  artifactDoc: {
    extra: {
      artifactId: "spec-1",
      docGuid: "guid-1",
      stateVectorBase64: "AQ==",
    },
    hasBinaryPayload: true,
  },
  artifactDocUpdate: {
    extra: { artifactId: "spec-1", docGuid: "guid-1" },
    hasBinaryPayload: true,
  },
  artifactDocAck: {
    extra: {
      artifactId: "spec-1",
      docGuid: "guid-1",
      coverageStateVectorBase64: "Ag==",
    },
    hasBinaryPayload: false,
  },
  artifactDocAwareness: {
    extra: { artifactId: "spec-1" },
    hasBinaryPayload: true,
  },
  artifactUnavailable: {
    extra: { artifactId: "spec-1", reason: "deleted", terminal: true },
    hasBinaryPayload: false,
  },
};

const EPOCH_ONLY_KIND_FIXTURES: ReadonlyArray<{
  readonly kind: EpochOnlyKind;
  readonly extra: Record<string, unknown>;
  readonly hasBinaryPayload: boolean;
}> = (
  Object.keys(EPOCH_ONLY_KIND_FIXTURE_BY_KIND) as readonly EpochOnlyKind[]
).map((kind) => ({ kind, ...EPOCH_ONLY_KIND_FIXTURE_BY_KIND[kind] }));

function replacementStateFixture(
  kind: ReplacementStateKind,
  streamEpoch: string,
  seq: number,
): Record<string, unknown> {
  switch (kind) {
    case "epicStateSnapshot":
      return {
        kind,
        artifactRecords: [
          SPEC_RECORD,
          TICKET_RECORD,
          STORY_RECORD,
          REVIEW_RECORD,
        ],
        deletedArtifacts: [],
        roleClaims: [ROLE_CLAIM],
        epicMeta: { title: "Epic", updatedAt: 10 },
        streamEpoch,
        seq,
        hasBinaryPayload: false,
      };
    case "artifactRecordUpsert":
      return {
        kind,
        record: TICKET_RECORD,
        streamEpoch,
        seq,
        hasBinaryPayload: false,
      };
    case "artifactRecordRemove":
      return {
        kind,
        artifactId: "ticket-1",
        tombstone: DELETED_TICKET,
        streamEpoch,
        seq,
        hasBinaryPayload: false,
      };
    case "epicMetaChanged":
      return {
        kind,
        epicMeta: { title: "Renamed" },
        streamEpoch,
        seq,
        hasBinaryPayload: false,
      };
    case "roleClaimsChanged":
      return {
        kind,
        roleClaims: [ROLE_CLAIM],
        streamEpoch,
        seq,
        hasBinaryPayload: false,
      };
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled replacement-state kind: ${unhandled}`);
    }
  }
}

function epochOnlyFixture(
  fixture: (typeof EPOCH_ONLY_KIND_FIXTURES)[number],
  streamEpoch: string,
): Record<string, unknown> {
  return {
    kind: fixture.kind,
    ...fixture.extra,
    streamEpoch,
    hasBinaryPayload: fixture.hasBinaryPayload,
  };
}

function epochOnlyByKind(
  kind: EpochOnlyKind,
): (typeof EPOCH_ONLY_KIND_FIXTURES)[number] {
  const fixture = EPOCH_ONLY_KIND_FIXTURES.find((entry) => entry.kind === kind);
  if (fixture === undefined) {
    throw new Error(`missing epoch-only fixture for ${kind}`);
  }
  return fixture;
}

function replacementStateSeq(
  frame: EpicSubscribeServerFrameV20,
): number | null {
  switch (frame.kind) {
    case "epicStateSnapshot":
    case "artifactRecordUpsert":
    case "artifactRecordRemove":
    case "epicMetaChanged":
    case "roleClaimsChanged":
      return frame.seq;
    default:
      return null;
  }
}

function persistRecord<T extends Record<string, unknown>>(
  record: T,
): T & { readonly artifactRoomId: string } {
  return { ...record, artifactRoomId: HASH_ROOM_ID };
}

function omitRoomId<T extends { readonly artifactRoomId: string }>(
  record: T,
): Omit<T, "artifactRoomId"> {
  const { artifactRoomId: _artifactRoomId, ...rest } = record;
  void _artifactRoomId;
  return rest;
}

function frozenLegacyEpicSubscribe(): ConnectionManifest[string] {
  const hostV100 = streamSupportMatrix.find(
    (entry) => entry.version === "host-v1.0.0",
  );
  if (hostV100 === undefined) {
    throw new Error("missing host-v1.0.0 stream baseline");
  }
  const entry = hostV100.manifest[METHOD];
  if (entry === undefined) {
    throw new Error("host-v1.0.0 baseline is missing epic.subscribe");
  }
  return entry;
}

function oldHostStreamRegistry(): ManifestRegistry {
  return {
    [METHOD]: {
      1: { latestMinor: 0 },
    },
  };
}

function requireMethodEntry(
  manifest: ConnectionManifest,
): ConnectionManifest[string] {
  const entry = manifest[METHOD];
  if (entry === undefined) {
    throw new Error(`missing ${METHOD} on connection manifest`);
  }
  return entry;
}

type EpochSeqState = {
  epoch: string | null;
  highWater: number | null;
};

type EpochSeqDecision = "accept" | "discard";

/**
 * Client ingest fence for the @2 typed plane. Snapshot joins/resets an epoch;
 * seq is consulted only for replacement-state mutations; lifecycle and body
 * frames are epoch-gated and otherwise unordered.
 */
function applyEpicV2Ordering(
  state: EpochSeqState,
  frame: EpicSubscribeServerFrameV20,
): { readonly decision: EpochSeqDecision; readonly next: EpochSeqState } {
  // Heartbeats are intercepted below the resolver, so `pong` has no epoch and
  // is not subject to the typed-plane discard fence.
  if (frame.kind === "pong") {
    return { decision: "accept", next: state };
  }

  const isSnapshot = frame.kind === "epicStateSnapshot";
  const seq = replacementStateSeq(frame);

  if (
    state.epoch !== null &&
    frame.streamEpoch !== state.epoch &&
    !isSnapshot
  ) {
    return { decision: "discard", next: state };
  }

  if (isSnapshot) {
    return {
      decision: "accept",
      next: { epoch: frame.streamEpoch, highWater: frame.seq },
    };
  }

  const epoch = state.epoch ?? frame.streamEpoch;
  if (seq === null) {
    return { decision: "accept", next: { epoch, highWater: state.highWater } };
  }

  if (state.highWater !== null && seq <= state.highWater) {
    return { decision: "discard", next: { epoch, highWater: state.highWater } };
  }
  return { decision: "accept", next: { epoch, highWater: seq } };
}

describe("epic.subscribe@2 registry and open request", () => {
  it("registers @2.0 beside the frozen @1 line rather than replacing it", () => {
    expect(epicSubscribeV20.method).toBe(METHOD);
    expect(epicSubscribeV20.schemaVersion).toEqual({ major: 2, minor: 0 });
    expect(epicSubscribeV20.openRequestSchema).toBe(
      epicSubscribeOpenRequestSchemaV20,
    );
    expect(epicSubscribeV20.serverFrameSchema).toBe(
      epicSubscribeServerFrameSchemaV20,
    );
    expect(epicSubscribeV20.clientFrameSchema).toBe(
      epicSubscribeClientFrameSchemaV20,
    );

    const line1 = hostStreamRpcRegistry[METHOD][1];
    const line2 = hostStreamRpcRegistry[METHOD][2];
    expect(line1.latestMinor).toBe(3);
    expect(line1.versions[3]?.contract).toBe(epicSubscribeV13);
    expect(line2.latestMinor).toBe(0);
    expect(line2.versions[0]?.contract).toBe(epicSubscribeV20);
  });

  it("advertises canonical @2 with both installed majors", () => {
    expect(
      buildStreamManifest(hostStreamRpcRegistry, SERVES_EVERY_INSTALLED_MAJOR)[
        METHOD
      ],
    ).toEqual({
      major: 2,
      minor: 0,
      supportedMajors: [1, 2],
    });
  });

  it("opens with epicId only and strips a leftover @1.3 seedOffer", () => {
    expect(Object.keys(epicSubscribeOpenRequestSchemaV20.shape)).toEqual([
      "epicId",
    ]);
    const parsed = epicSubscribeOpenRequestSchemaV20.parse({
      epicId: "epic-1",
      seedOffer: { stateVectorBase64: "AQ==", roomId: "room-1" },
    });
    expect(parsed).toEqual({ epicId: "epic-1" });
    expect("seedOffer" in parsed).toBe(false);
  });

  it("keeps the @2 open request off the frozen @1.0 and grown @1.3 schema objects", () => {
    expect(epicSubscribeV13.openRequestSchema).toBe(
      epicSubscribeOpenRequestSchema,
    );
    expect(epicSubscribeV20.openRequestSchema).toBe(
      epicSubscribeOpenRequestSchemaV20,
    );
    expect(epicSubscribeOpenRequestSchemaV20).not.toBe(
      epicSubscribeOpenRequestSchemaV10,
    );
    expect(epicSubscribeOpenRequestSchemaV20).not.toBe(
      epicSubscribeOpenRequestSchema,
    );
  });
});

describe("epic.subscribe@2 peer combinations", () => {
  const newManifest = buildStreamManifest(
    hostStreamRpcRegistry,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
  const legacyEpicSubscribe = frozenLegacyEpicSubscribe();
  const oldClientManifest: ConnectionManifest = {
    [METHOD]: legacyEpicSubscribe,
  };
  const newClientManifest: ConnectionManifest = {
    [METHOD]: requireMethodEntry(newManifest),
  };
  const oldHostRegistry = oldHostStreamRegistry();
  const oldHostManifest: ConnectionManifest = {
    [METHOD]: legacyEpicSubscribe,
  };

  it("old client × old host selects @1", () => {
    const selected = selectConnectionManifestForPeer(
      oldHostRegistry,
      oldHostManifest,
      oldClientManifest,
    );
    expect(selected[METHOD]).toEqual({
      major: 1,
      minor: 0,
      supportedMajors: [1],
    });
    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        oldHostManifest,
        oldClientManifest,
        "host",
        METHOD,
      ),
    ).toEqual({ ok: true });
    expect(highestSharedMajor(legacyEpicSubscribe, legacyEpicSubscribe)).toBe(
      1,
    );
  });

  it("old client × new host selects @1 and still bridges", () => {
    const selected = selectConnectionManifestForPeer(
      hostStreamRpcRegistry,
      newManifest,
      oldClientManifest,
    );
    expect(selected[METHOD]).toEqual({
      major: 1,
      minor: 3,
      supportedMajors: [1, 2],
    });
    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        newManifest,
        oldClientManifest,
        "host",
        METHOD,
      ),
    ).toEqual({ ok: true });
    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        oldClientManifest,
        newManifest,
        "client",
        METHOD,
      ),
    ).toEqual({ ok: true });
  });

  it("new client × old host selects @1 for the v1 fallback adapter", () => {
    const selected = selectConnectionManifestForPeer(
      oldHostRegistry,
      oldHostManifest,
      newClientManifest,
    );
    expect(selected[METHOD]).toEqual({
      major: 1,
      minor: 0,
      supportedMajors: [1],
    });
    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        oldHostManifest,
        newClientManifest,
        "host",
        METHOD,
      ),
    ).toEqual({ ok: true });
    expect(
      highestSharedMajor(requireMethodEntry(newManifest), legacyEpicSubscribe),
    ).toBe(1);
  });

  // `newClientManifest` advertises every installed major, while the
  // PRODUCTION client advertises `[1]` (`CLIENT_SERVED_STREAM_MAJORS` in
  // `clients/shared`) until `EpicV2StreamClient` is wired into the session
  // factory - so this asserts the negotiation machinery, not a pairing that
  // occurs today. Removing that restriction is the wiring change, not a
  // conclusion to draw from this test.
  it("new client × new host selects @2", () => {
    const selected = selectConnectionManifestForPeer(
      hostStreamRpcRegistry,
      newManifest,
      newClientManifest,
    );
    expect(selected[METHOD]).toEqual({
      major: 2,
      minor: 0,
      supportedMajors: [1, 2],
    });
    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        newManifest,
        newClientManifest,
        "host",
        METHOD,
      ),
    ).toEqual({ ok: true });
    expect(
      highestSharedMajor(
        requireMethodEntry(newManifest),
        requireMethodEntry(newManifest),
      ),
    ).toBe(2);
  });

  it("lets a new host serve simultaneous @1 and @2 subscriptions to one epic", () => {
    const forOldClient = selectConnectionManifestForPeer(
      hostStreamRpcRegistry,
      newManifest,
      oldClientManifest,
    );
    const forNewClient = selectConnectionManifestForPeer(
      hostStreamRpcRegistry,
      newManifest,
      newClientManifest,
    );
    expect(forOldClient[METHOD]?.major).toBe(1);
    expect(forNewClient[METHOD]?.major).toBe(2);
    expect(hostStreamRpcRegistry[METHOD][1].versions[3]?.contract).toBe(
      epicSubscribeV13,
    );
    expect(hostStreamRpcRegistry[METHOD][2].versions[0]?.contract).toBe(
      epicSubscribeV20,
    );
  });

  it("does not parse across majors: v1 snapshot and v2 epicStateSnapshot are disjoint", () => {
    const v1Snapshot = {
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
    };
    const v2Snapshot = replacementStateFixture(
      "epicStateSnapshot",
      STREAM_EPOCH,
      0,
    );

    expect(epicSubscribeServerFrameSchema.safeParse(v1Snapshot).success).toBe(
      true,
    );
    expect(
      epicSubscribeServerFrameSchemaV20.safeParse(v1Snapshot).success,
    ).toBe(false);
    expect(
      epicSubscribeServerFrameSchemaV20.safeParse(v2Snapshot).success,
    ).toBe(true);
    expect(epicSubscribeServerFrameSchema.safeParse(v2Snapshot).success).toBe(
      false,
    );
  });
});

describe("epic.subscribe@2 subscription-scoped server frames", () => {
  it("requires streamEpoch on typed server frames and never retains payload epicId", () => {
    for (const kind of REPLACEMENT_STATE_KINDS) {
      const parsed = epicSubscribeServerFrameSchemaV20.parse(
        replacementStateFixture(kind, STREAM_EPOCH, 0),
      );
      if (parsed.kind === "pong") {
        throw new Error("replacement-state fixture parsed as framework pong");
      }
      expect(parsed.streamEpoch).toBe(STREAM_EPOCH);
      expect("epicId" in parsed).toBe(false);
      expect("seq" in parsed).toBe(true);
    }

    for (const fixture of EPOCH_ONLY_KIND_FIXTURES) {
      const parsed = epicSubscribeServerFrameSchemaV20.parse(
        epochOnlyFixture(fixture, STREAM_EPOCH),
      );
      if (parsed.kind === "pong") {
        throw new Error("epoch-only fixture parsed as framework pong");
      }
      expect(parsed.kind).toBe(fixture.kind);
      expect(parsed.streamEpoch).toBe(STREAM_EPOCH);
      expect("epicId" in parsed).toBe(false);
      expect("seq" in parsed).toBe(false);
    }
  });

  it("parses a framework-level pong without streamEpoch", () => {
    const parsed = epicSubscribeServerFrameSchemaV20.parse({
      kind: "pong",
      hasBinaryPayload: false,
    });
    expect(parsed).toEqual({ kind: "pong", hasBinaryPayload: false });
    expect("streamEpoch" in parsed).toBe(false);
    expect("seq" in parsed).toBe(false);

    const leakedEpoch = epicSubscribeServerFrameSchemaV20.parse({
      kind: "pong",
      streamEpoch: STREAM_EPOCH,
      hasBinaryPayload: false,
    });
    expect(leakedEpoch).toEqual({ kind: "pong", hasBinaryPayload: false });
    expect("streamEpoch" in leakedEpoch).toBe(false);

    expect(
      epicSubscribeServerFrameSchemaV20.safeParse({
        kind: "pong",
        hasBinaryPayload: true,
      }).success,
    ).toBe(false);
  });

  it("strips a leaked epicId even when the host echoes the open-request id", () => {
    const parsed = epicSubscribeServerFrameSchemaV20.parse({
      ...replacementStateFixture("artifactRecordUpsert", STREAM_EPOCH, 4),
      epicId: "epic-1",
    });
    expect("epicId" in parsed).toBe(false);
    expect(parsed.kind).toBe("artifactRecordUpsert");
  });

  it("rejects replacement-state frames that omit seq or streamEpoch", () => {
    for (const kind of REPLACEMENT_STATE_KINDS) {
      const withSeq = replacementStateFixture(kind, STREAM_EPOCH, 1);
      const { seq: _seq, ...missingSeq } = withSeq;
      void _seq;
      const { streamEpoch: _streamEpoch, ...missingEpoch } = withSeq;
      void _streamEpoch;
      expect(
        epicSubscribeServerFrameSchemaV20.safeParse(missingSeq).success,
      ).toBe(false);
      expect(
        epicSubscribeServerFrameSchemaV20.safeParse(missingEpoch).success,
      ).toBe(false);
    }
  });

  it("rejects epoch-only frames that omit streamEpoch, and strips a leaked seq", () => {
    for (const fixture of EPOCH_ONLY_KIND_FIXTURES) {
      const withEpoch = epochOnlyFixture(fixture, STREAM_EPOCH);
      const { streamEpoch: _streamEpoch, ...missingEpoch } = withEpoch;
      void _streamEpoch;
      expect(
        epicSubscribeServerFrameSchemaV20.safeParse(missingEpoch).success,
      ).toBe(false);

      const parsed = epicSubscribeServerFrameSchemaV20.parse({
        ...withEpoch,
        seq: 99,
      });
      expect("seq" in parsed).toBe(false);
    }
  });

  it("rejects an empty streamEpoch and a negative seq", () => {
    expect(
      epicSubscribeServerFrameSchemaV20.safeParse(
        replacementStateFixture("epicMetaChanged", "", 0),
      ).success,
    ).toBe(false);
    expect(
      epicSubscribeServerFrameSchemaV20.safeParse(
        replacementStateFixture("epicMetaChanged", STREAM_EPOCH, -1),
      ).success,
    ).toBe(false);
  });

  it("requires the host tombstone on artifactRecordRemove rather than letting the client invent deletedAt", () => {
    const withTombstone = epicSubscribeServerFrameSchemaV20.parse(
      replacementStateFixture("artifactRecordRemove", STREAM_EPOCH, 2),
    );
    expect(withTombstone.kind).toBe("artifactRecordRemove");
    if (withTombstone.kind !== "artifactRecordRemove") {
      throw new Error("expected artifactRecordRemove");
    }
    expect(withTombstone.tombstone).toEqual(DELETED_TICKET);
    expect(withTombstone.seq).toBe(2);

    expect(
      epicSubscribeServerFrameSchemaV20.safeParse({
        kind: "artifactRecordRemove",
        artifactId: "ticket-1",
        streamEpoch: STREAM_EPOCH,
        seq: 2,
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
  });

  it("treats roleClaimsChanged as whole-set replacement-state, not an epoch-only invalidation", () => {
    const parsed = epicSubscribeServerFrameSchemaV20.parse(
      replacementStateFixture("roleClaimsChanged", STREAM_EPOCH, 3),
    );
    expect(parsed.kind).toBe("roleClaimsChanged");
    if (parsed.kind !== "roleClaimsChanged") {
      throw new Error("expected roleClaimsChanged");
    }
    expect(parsed.roleClaims).toEqual([ROLE_CLAIM]);
    expect(parsed.seq).toBe(3);
    expect(parsed.streamEpoch).toBe(STREAM_EPOCH);

    const { seq: _seq, ...missingSeq } = replacementStateFixture(
      "roleClaimsChanged",
      STREAM_EPOCH,
      3,
    );
    void _seq;
    expect(
      epicSubscribeServerFrameSchemaV20.safeParse(missingSeq).success,
    ).toBe(false);

    const leakedDelta = epicSubscribeServerFrameSchemaV20.parse({
      kind: "roleClaimsChanged",
      roleClaims: [ROLE_CLAIM],
      added: [ROLE_CLAIM.claimId],
      streamEpoch: STREAM_EPOCH,
      seq: 4,
      hasBinaryPayload: false,
    });
    expect(leakedDelta.kind).toBe("roleClaimsChanged");
    if (leakedDelta.kind !== "roleClaimsChanged") {
      throw new Error("expected roleClaimsChanged");
    }
    expect("added" in leakedDelta).toBe(false);
  });
});

describe("epic.subscribe@2 epoch/seq discard rules", () => {
  it("joins on snapshot, drops an older epoch, and uses seq only for replacement-state mutations", () => {
    let state: EpochSeqState = { epoch: null, highWater: null };

    const earlyMeta = epicSubscribeServerFrameSchemaV20.parse(
      epochOnlyFixture(epochOnlyByKind("earlyMeta"), STREAM_EPOCH),
    );
    const joined = applyEpicV2Ordering(state, earlyMeta);
    expect(joined.decision).toBe("accept");
    state = joined.next;
    expect(state).toEqual({ epoch: STREAM_EPOCH, highWater: null });

    const snapshot = epicSubscribeServerFrameSchemaV20.parse(
      replacementStateFixture("epicStateSnapshot", STREAM_EPOCH, 0),
    );
    const afterSnapshot = applyEpicV2Ordering(state, snapshot);
    expect(afterSnapshot.decision).toBe("accept");
    state = afterSnapshot.next;
    expect(state).toEqual({ epoch: STREAM_EPOCH, highWater: 0 });

    const upsert = epicSubscribeServerFrameSchemaV20.parse(
      replacementStateFixture("artifactRecordUpsert", STREAM_EPOCH, 1),
    );
    const afterUpsert = applyEpicV2Ordering(state, upsert);
    expect(afterUpsert.decision).toBe("accept");
    state = afterUpsert.next;

    const duplicateUpsert = applyEpicV2Ordering(state, upsert);
    expect(duplicateUpsert.decision).toBe("discard");
    expect(duplicateUpsert.next).toEqual(state);

    const staleSeq = epicSubscribeServerFrameSchemaV20.parse(
      replacementStateFixture("artifactRecordRemove", STREAM_EPOCH, 1),
    );
    expect(applyEpicV2Ordering(state, staleSeq).decision).toBe("discard");

    const claims = epicSubscribeServerFrameSchemaV20.parse(
      replacementStateFixture("roleClaimsChanged", STREAM_EPOCH, 2),
    );
    const afterClaims = applyEpicV2Ordering(state, claims);
    expect(afterClaims.decision).toBe("accept");
    state = afterClaims.next;
    expect(state.highWater).toBe(2);

    const comments = epicSubscribeServerFrameSchemaV20.parse(
      epochOnlyFixture(epochOnlyByKind("commentThreadsChanged"), STREAM_EPOCH),
    );
    const afterComments = applyEpicV2Ordering(state, comments);
    expect(afterComments.decision).toBe("accept");
    expect(afterComments.next.highWater).toBe(state.highWater);

    const staleEpochUpsert = epicSubscribeServerFrameSchemaV20.parse(
      replacementStateFixture("artifactRecordUpsert", "epoch-old", 99),
    );
    expect(applyEpicV2Ordering(state, staleEpochUpsert).decision).toBe(
      "discard",
    );

    const frameworkPong = epicSubscribeServerFrameSchemaV20.parse({
      kind: "pong",
      hasBinaryPayload: false,
    });
    const afterPong = applyEpicV2Ordering(state, frameworkPong);
    expect(afterPong.decision).toBe("accept");
    expect(afterPong.next).toEqual(state);
    expect("streamEpoch" in frameworkPong).toBe(false);

    const replacement = epicSubscribeServerFrameSchemaV20.parse(
      replacementStateFixture("epicStateSnapshot", "epoch-b", 0),
    );
    const afterReplacement = applyEpicV2Ordering(state, replacement);
    expect(afterReplacement.decision).toBe("accept");
    expect(afterReplacement.next).toEqual({ epoch: "epoch-b", highWater: 0 });
  });
});

describe("epic.subscribe@2 ArtifactRecord derived-union round-trip", () => {
  it("omits artifactRoomId from every live persistence kind and round-trips the rest", () => {
    const persisted = {
      spec: specArtifactSchema.parse(persistRecord(SPEC_RECORD)),
      ticket: ticketArtifactSchema.parse(persistRecord(TICKET_RECORD)),
      story: storyArtifactSchema.parse(persistRecord(STORY_RECORD)),
      review: reviewArtifactSchema.parse(persistRecord(REVIEW_RECORD)),
    };

    const wire = {
      spec: epicArtifactRecordSchema.parse(persisted.spec),
      ticket: epicArtifactRecordSchema.parse(persisted.ticket),
      story: epicArtifactRecordSchema.parse(persisted.story),
      review: epicArtifactRecordSchema.parse(persisted.review),
    };

    expect(wire.spec).toEqual(SPEC_RECORD);
    expect(wire.ticket).toEqual(TICKET_RECORD);
    expect(wire.story).toEqual(STORY_RECORD);
    expect(wire.review).toEqual(REVIEW_RECORD);
    expect("artifactRoomId" in wire.spec).toBe(false);
    expect("artifactRoomId" in wire.ticket).toBe(false);
    expect("status" in wire.ticket).toBe(true);
    expect("assignee" in wire.ticket).toBe(true);
    expect("status" in wire.spec).toBe(false);

    expect(epicArtifactRecordSchema.parse(wire.ticket)).toEqual(TICKET_RECORD);
    expect(specArtifactSchema.parse(persistRecord(wire.spec))).toEqual(
      persisted.spec,
    );
    expect(omitRoomId(persisted.ticket)).toEqual(TICKET_RECORD);
  });

  it("omits artifactRoomId from tombstones and keeps ticket/story status", () => {
    const deletedSpec = deletedSpecArtifactSchema.parse({
      kind: "spec",
      id: "spec-1",
      title: "Overview",
      artifactRoomId: HASH_ROOM_ID,
      deletedAt: "2026-08-25T00:00:00.000Z",
    });
    const deletedTicket = deletedTicketArtifactSchema.parse({
      kind: "ticket",
      id: "ticket-1",
      title: "Implement subscribe",
      artifactRoomId: null,
      deletedAt: "2026-08-25T00:00:01.000Z",
      status: 2,
    });
    const deletedStory = deletedStoryArtifactSchema.parse({
      kind: "story",
      id: "story-1",
      title: "Rollout",
      artifactRoomId: HASH_ROOM_ID,
      deletedAt: "2026-08-25T00:00:02.000Z",
      status: 1,
    });
    const deletedReview = deletedReviewArtifactSchema.parse({
      kind: "review",
      id: "review-1",
      title: "Contract review",
      artifactRoomId: null,
      deletedAt: "2026-08-25T00:00:03.000Z",
    });

    const wireSpec = epicDeletedArtifactRecordSchema.parse(deletedSpec);
    const wireTicket = epicDeletedArtifactRecordSchema.parse(deletedTicket);
    const wireStory = epicDeletedArtifactRecordSchema.parse(deletedStory);
    const wireReview = epicDeletedArtifactRecordSchema.parse(deletedReview);

    expect("artifactRoomId" in wireSpec).toBe(false);
    expect("artifactRoomId" in wireTicket).toBe(false);
    expect(wireTicket.kind).toBe("ticket");
    if (wireTicket.kind !== "ticket") {
      throw new Error("expected a ticket tombstone");
    }
    expect(wireStory.kind).toBe("story");
    if (wireStory.kind !== "story") {
      throw new Error("expected a story tombstone");
    }
    expect(wireTicket.status).toBe(2);
    expect(wireStory.status).toBe(1);
    expect("status" in wireSpec).toBe(false);
    expect("status" in wireReview).toBe(false);
    expect(epicDeletedArtifactRecordSchema.parse(wireTicket)).toEqual(
      wireTicket,
    );
  });

  it("rejects a live ticket that drops status, and a wire row that invents a kind", () => {
    const { status: _status, ...ticketWithoutStatus } = TICKET_RECORD;
    void _status;
    expect(
      epicArtifactRecordSchema.safeParse(ticketWithoutStatus).success,
    ).toBe(false);
    expect(
      epicArtifactRecordSchema.safeParse({
        ...SPEC_RECORD,
        kind: "chat",
      }).success,
    ).toBe(false);
  });
});

describe("epic.subscribe@2 client frames", () => {
  it("are subscription-scoped: no payload epicId, including retryMigration", () => {
    const frames = [
      {
        kind: "attachArtifact",
        artifactId: "spec-1",
        hasBinaryPayload: false,
      },
      {
        kind: "attachArtifact",
        artifactId: "spec-1",
        knownDocGuid: "guid-1",
        stateVectorBase64: "AQ==",
        hasBinaryPayload: false,
      },
      {
        kind: "detachArtifact",
        artifactId: "spec-1",
        hasBinaryPayload: false,
      },
      {
        kind: "artifactDocApplyUpdate",
        artifactId: "spec-1",
        docGuid: "guid-1",
        hasBinaryPayload: true,
      },
      {
        kind: "artifactDocAwareness",
        artifactId: "spec-1",
        hasBinaryPayload: true,
      },
      { kind: "retryMigration", hasBinaryPayload: false },
      { kind: "ping", hasBinaryPayload: false },
    ] as const;

    for (const frame of frames) {
      const parsed = epicSubscribeClientFrameSchemaV20.parse(frame);
      expect(parsed.kind).toBe(frame.kind);
      expect("epicId" in parsed).toBe(false);
    }
  });

  it("does not require attach seed fields to travel as a pair", () => {
    expect(
      epicSubscribeClientFrameSchemaV20.safeParse({
        kind: "attachArtifact",
        artifactId: "spec-1",
        knownDocGuid: "guid-1",
        hasBinaryPayload: false,
      }).success,
    ).toBe(true);
    expect(
      epicSubscribeClientFrameSchemaV20.parse({
        kind: "attachArtifact",
        artifactId: "spec-1",
        epicId: "epic-1",
        hasBinaryPayload: false,
      }),
    ).toEqual({
      kind: "attachArtifact",
      artifactId: "spec-1",
      hasBinaryPayload: false,
    });
  });

  it("rejects @1 root-doc client frames on the @2 union", () => {
    expect(
      epicSubscribeClientFrameSchemaV20.safeParse({
        kind: "applyUpdate",
        epicId: "epic-1",
        hasBinaryPayload: true,
      }).success,
    ).toBe(false);
    expect(
      epicSubscribeClientFrameSchema.safeParse({
        kind: "attachArtifact",
        artifactId: "spec-1",
        hasBinaryPayload: false,
      }).success,
    ).toBe(false);
  });
});

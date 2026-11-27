import { describe, expect, it } from "vitest";
import {
  buildConnectionManifest,
  checkCompatibility,
  downgradeRequestAcrossMajors,
  selectConnectionManifestForPeer,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/index";
import {
  buildStreamManifest,
  checkStreamMethodCompatibility,
} from "@traycer/protocol/framework/stream-compat";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/index";
import {
  draftCloudDocumentSchema,
  draftCloudCurrentSchema,
  draftCloudTombstoneSchema,
  draftsDeleteV20,
  draftsListV30,
  draftsRetractV20,
  draftsSubscribeV10,
  draftsSubscribeV20,
  draftsUpsertV30,
} from "@traycer/protocol/host/drafts/index";

const HASH = "ab".repeat(32);
const TARGET = { epicId: "epic-fake-1", chatId: "chat-fake-1", blockId: null };
const PORTABLE = {
  content: { type: "doc", content: [{ type: "paragraph" }] },
  selection: { from: 1, to: 1 },
  runSettings: {
    harnessId: "claude",
    model: "claude-sonnet-4",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
    ultracode: false,
  },
  composerMode: "chat",
  blobHashes: [],
  closed: false,
  annotations: [],
};

const CLOUD_WRITE = {
  draftId: "draft-fake-1",
  kind: "chat-composer" as const,
  target: TARGET,
  workspace: null,
  lastTouchedAt: 1_753_000_000_000,
  portable: PORTABLE,
};

const HEAD = {
  dialect: "draft/v1" as const,
  schemaVersion: { major: 1, minor: 1 },
  kind: "draft" as const,
  surfaceKind: "chat-composer" as const,
  lastTouchedAt: 1_753_000_000_000,
  target: TARGET,
  portable: PORTABLE,
  hostLocal: { hostId: "host-fake-1", workspace: null },
};

const CLOUD_DOCUMENT = {
  draftId: "draft-fake-1",
  base: { headSha256: HASH, ownerEpoch: 2, revision: 7 },
  head: HEAD,
  operationId: "operation-fake-1",
};

const UPSERT_REQUEST = {
  scopeId: "scope-fake-1",
  draft: CLOUD_WRITE,
  base: null,
  operationId: "operation-fake-1",
};

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("draft cloud v3 wire fixtures", () => {
  it("round-trips the v3 upsert request through its contract JSON shape", () => {
    expect(
      draftsUpsertV30.requestSchema.parse(jsonRoundTrip(UPSERT_REQUEST)),
    ).toEqual(UPSERT_REQUEST);
  });

  it.each([
    ["Ultracode enabled", { ultracode: true }],
    [
      "shared catalog profile binding",
      {
        ultracode: false,
        profileBinding: {
          kind: "environment-profile",
          environmentProfileId: "00000000-0000-4000-8000-000000000001",
        },
      },
    ],
  ])("round-trips %s in a modern portable draft", (_label, settings) => {
    const request = {
      ...UPSERT_REQUEST,
      draft: {
        ...CLOUD_WRITE,
        portable: {
          ...PORTABLE,
          runSettings: { ...PORTABLE.runSettings, ...settings },
        },
      },
    };
    expect(draftsUpsertV30.requestSchema.parse(jsonRoundTrip(request))).toEqual(
      request,
    );
  });

  it.each([
    {
      name: "legacy spend-key binding",
      profileBinding: {
        kind: "key",
        key: {
          providerId: "claude-code",
          email: "synthetic@fixture.invalid",
        },
      },
    },
    {
      name: "provider identifier instead of a catalog ID",
      profileBinding: {
        kind: "environment-profile",
        environmentProfileId: "claude-code",
      },
    },
  ])("rejects $name on the modern wire", ({ profileBinding }) => {
    const request = {
      ...UPSERT_REQUEST,
      draft: {
        ...CLOUD_WRITE,
        portable: {
          ...PORTABLE,
          runSettings: { ...PORTABLE.runSettings, profileBinding },
        },
      },
    };
    expect(draftsUpsertV30.requestSchema.safeParse(request).success).toBe(
      false,
    );
  });

  it("rejects a local profile ID without its shared binding on the modern wire", () => {
    const request = {
      ...UPSERT_REQUEST,
      draft: {
        ...CLOUD_WRITE,
        portable: {
          ...PORTABLE,
          runSettings: {
            ...PORTABLE.runSettings,
            profileId: "local-profile-fake",
          },
        },
      },
    };
    expect(draftsUpsertV30.requestSchema.safeParse(request).success).toBe(
      false,
    );
  });

  it("round-trips committed cloud document, list snapshot, and subscribe frame", () => {
    const current = { kind: "live" as const, draft: CLOUD_DOCUMENT };
    const response = {
      status: "committed" as const,
      operationId: "operation-fake-1",
      current,
    };
    const parsedResponse = draftsUpsertV30.responseSchema.parse(
      jsonRoundTrip(response),
    );
    expect(parsedResponse).toEqual(response);

    const list = {
      scopeId: "scope-fake-1",
      drafts: [CLOUD_DOCUMENT],
      tombstones: [],
      snapshotSeq: 9,
    };
    expect(draftsListV30.responseSchema.parse(jsonRoundTrip(list))).toEqual(
      list,
    );

    const frame = {
      kind: "upsert" as const,
      hasBinaryPayload: false,
      seq: 10,
      draft: CLOUD_DOCUMENT,
    };
    expect(
      draftsSubscribeV20.serverFrameSchema.parse(jsonRoundTrip(frame)),
    ).toEqual(frame);
    expect(draftCloudCurrentSchema.parse(jsonRoundTrip(current))).toEqual(
      current,
    );
    expect(
      draftCloudDocumentSchema.parse(jsonRoundTrip(CLOUD_DOCUMENT)),
    ).toEqual(CLOUD_DOCUMENT);
  });

  it("requires snapshot and stream sequence frontiers", () => {
    const list = {
      scopeId: "scope-fake-1",
      drafts: [CLOUD_DOCUMENT],
      tombstones: [],
      snapshotSeq: 9,
    };
    const { snapshotSeq: _snapshotSeq, ...listWithoutSnapshotSeq } = list;
    expect(
      draftsListV30.responseSchema.safeParse(listWithoutSnapshotSeq).success,
    ).toBe(false);

    const openRequest = { scopeId: "scope-fake-1", afterSeq: 9 };
    const { afterSeq: _afterSeq, ...openWithoutAfterSeq } = openRequest;
    expect(
      draftsSubscribeV20.openRequestSchema.safeParse(openWithoutAfterSeq)
        .success,
    ).toBe(false);

    const upsertFrame = {
      kind: "upsert" as const,
      hasBinaryPayload: false,
      seq: 10,
      draft: CLOUD_DOCUMENT,
    };
    const { seq: _upsertSeq, ...upsertWithoutSeq } = upsertFrame;
    expect(
      draftsSubscribeV20.serverFrameSchema.safeParse(upsertWithoutSeq).success,
    ).toBe(false);

    const deleteFrame = {
      kind: "delete" as const,
      hasBinaryPayload: false,
      seq: 11,
      tombstone: {
        draftId: "draft-fake-1",
        base: { headSha256: HASH, ownerEpoch: 2, revision: 8 },
        operationId: "operation-delete-fake-1",
      },
    };
    const { seq: _deleteSeq, ...deleteWithoutSeq } = deleteFrame;
    expect(
      draftsSubscribeV20.serverFrameSchema.safeParse(deleteWithoutSeq).success,
    ).toBe(false);
  });

  it("requires base, annotations, and scope on modern writes", () => {
    const { base: _base, ...withoutBase } = UPSERT_REQUEST;
    const { scopeId: _scopeId, ...withoutScope } = UPSERT_REQUEST;
    const { annotations: _annotations, ...portableWithoutAnnotations } =
      PORTABLE;
    const withoutAnnotations = {
      ...UPSERT_REQUEST,
      draft: { ...CLOUD_WRITE, portable: portableWithoutAnnotations },
    };

    expect(draftsUpsertV30.requestSchema.safeParse(withoutBase).success).toBe(
      false,
    );
    expect(draftsUpsertV30.requestSchema.safeParse(withoutScope).success).toBe(
      false,
    );
    expect(
      draftsUpsertV30.requestSchema.safeParse(withoutAnnotations).success,
    ).toBe(false);
  });

  it("refuses the legacy host draft shape on the cloud CAS endpoint", () => {
    const legacyWrite = {
      draftId: "draft-fake-1",
      kind: "landing",
      target: TARGET,
      revision: 1,
      lastTouchedAt: 1_753_000_000_000,
      workspace: null,
      supersedes: null,
      portable: {
        content: { type: "doc", content: [{ type: "paragraph" }] },
        selection: { from: 1, to: 1 },
        runSettings: PORTABLE.runSettings,
        composerMode: "chat",
        blobHashes: [],
        closed: false,
      },
    };
    expect(
      draftsUpsertV30.requestSchema.safeParse({
        scopeId: "scope-fake-1",
        draft: legacyWrite,
        base: null,
        operationId: "operation-fake-1",
      }).success,
    ).toBe(false);
  });

  it("round-trips the scoped delete request and rejects a request without scope", () => {
    const request = {
      scopeId: "scope-fake-1",
      draftId: "draft-fake-1",
      base: { headSha256: HASH, ownerEpoch: 2, revision: 7 },
      operationId: "operation-delete-fake-1",
    };
    expect(draftsDeleteV20.requestSchema.parse(jsonRoundTrip(request))).toEqual(
      request,
    );
    const { scopeId: _scopeId, ...withoutScope } = request;
    expect(draftsDeleteV20.requestSchema.safeParse(withoutScope).success).toBe(
      false,
    );
  });

  it("admits a metadata-only legacy tombstone and refuses a modern null hash", () => {
    const legacyTombstone = {
      draftId: "draft-fake-legacy",
      base: { headSha256: null, ownerEpoch: 3, revision: 8 },
      operationId: null,
    };
    const current = {
      kind: "tombstone" as const,
      tombstone: legacyTombstone,
    };
    expect(draftCloudCurrentSchema.parse(jsonRoundTrip(current))).toEqual(
      current,
    );
    expect(
      draftCloudTombstoneSchema.parse(jsonRoundTrip(legacyTombstone)),
    ).toEqual(legacyTombstone);

    const invalidModernTombstone = {
      ...legacyTombstone,
      operationId: "operation-modern-fake",
    };
    expect(
      draftCloudTombstoneSchema.safeParse(invalidModernTombstone).success,
    ).toBe(false);
  });

  it("selects the highest mutually advertised draft majors", () => {
    const unaryManifest = buildConnectionManifest(
      hostRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const olderPeerManifest = {
      ...unaryManifest,
      "drafts.upsert": { major: 2, minor: 0, supportedMajors: [1, 2] },
      "drafts.list": { major: 2, minor: 0, supportedMajors: [1, 2] },
      "drafts.delete": { major: 1, minor: 0 },
      "drafts.retract": { major: 1, minor: 0 },
    };
    const selectedForOlderPeer = selectConnectionManifestForPeer(
      hostRpcRegistry,
      unaryManifest,
      olderPeerManifest,
    );
    expect(selectedForOlderPeer["drafts.upsert"]).toEqual({
      major: 2,
      minor: 0,
      supportedMajors: [1, 2, 3],
    });
    expect(selectedForOlderPeer["drafts.list"]).toEqual({
      major: 2,
      minor: 0,
      supportedMajors: [1, 2, 3],
    });
    expect(selectedForOlderPeer["drafts.delete"]).toEqual({
      major: 1,
      minor: 0,
      supportedMajors: [1, 2],
    });
    expect(selectedForOlderPeer["drafts.retract"]).toEqual({
      major: 1,
      minor: 0,
      supportedMajors: [1, 2],
    });
    expect(
      checkCompatibility(
        hostRpcRegistry,
        selectedForOlderPeer,
        olderPeerManifest,
        "host",
      ),
    ).toEqual({ ok: true });

    const selectedForModernPeer = selectConnectionManifestForPeer(
      hostRpcRegistry,
      unaryManifest,
      unaryManifest,
    );
    expect(selectedForModernPeer["drafts.upsert"]).toEqual(
      unaryManifest["drafts.upsert"],
    );
    expect(selectedForModernPeer["drafts.list"]).toEqual(
      unaryManifest["drafts.list"],
    );
    expect(selectedForModernPeer["drafts.delete"]).toEqual(
      unaryManifest["drafts.delete"],
    );
    expect(selectedForModernPeer["drafts.retract"]).toEqual(
      unaryManifest["drafts.retract"],
    );
    expect(
      checkCompatibility(
        hostRpcRegistry,
        selectedForModernPeer,
        unaryManifest,
        "host",
      ),
    ).toEqual({ ok: true });
  });

  it("keeps stream negotiation on the shared major and preserves the exact modern frame", () => {
    const streamManifest = buildStreamManifest(
      hostStreamRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const olderPeerManifest = {
      ...streamManifest,
      "drafts.subscribe": { major: 1, minor: 1 },
    };
    const selectedForOlderPeer = selectConnectionManifestForPeer(
      hostStreamRpcRegistry,
      streamManifest,
      olderPeerManifest,
    );
    expect(selectedForOlderPeer["drafts.subscribe"]).toMatchObject({
      major: 1,
      minor: 1,
    });
    expect(
      checkStreamMethodCompatibility(
        hostStreamRpcRegistry,
        selectedForOlderPeer,
        olderPeerManifest,
        "host",
        "drafts.subscribe",
      ),
    ).toEqual({ ok: true });

    const selectedForModernPeer = selectConnectionManifestForPeer(
      hostStreamRpcRegistry,
      streamManifest,
      streamManifest,
    );
    expect(selectedForModernPeer["drafts.subscribe"]).toEqual(
      streamManifest["drafts.subscribe"],
    );
    expect(hostStreamRpcRegistry["drafts.subscribe"][2].versions[0].contract)
      .toBe(draftsSubscribeV20);
    expect(draftsSubscribeV20.schemaVersion).toEqual({ major: 2, minor: 0 });

    const frame = {
      kind: "upsert" as const,
      hasBinaryPayload: false,
      seq: 10,
      draft: CLOUD_DOCUMENT,
    };
    expect(
      draftsSubscribeV20.serverFrameSchema.parse(jsonRoundTrip(frame)),
    ).toEqual(frame);
    expect(draftsSubscribeV10.serverFrameSchema.safeParse(frame).success).toBe(
      false,
    );
  });

  it("fails closed when modern draft requests would need a cross-major downgrade", () => {
    const upsertRequest = draftsUpsertV30.requestSchema.parse(UPSERT_REQUEST);
    expect(
      downgradeRequestAcrossMajors(
        hostRpcRegistry["drafts.upsert"],
        3,
        2,
        upsertRequest,
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
    expect(
      downgradeRequestAcrossMajors(
        hostRpcRegistry["drafts.upsert"],
        3,
        1,
        upsertRequest,
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });

    const listRequest = draftsListV30.requestSchema.parse({});
    expect(
      downgradeRequestAcrossMajors(
        hostRpcRegistry["drafts.list"],
        3,
        2,
        listRequest,
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });

    const deleteRequest = draftsDeleteV20.requestSchema.parse({
      scopeId: "scope-fake-1",
      draftId: "draft-fake-1",
      base: { headSha256: HASH, ownerEpoch: 2, revision: 7 },
      operationId: "operation-delete-fake-1",
    });
    expect(
      downgradeRequestAcrossMajors(
        hostRpcRegistry["drafts.delete"],
        2,
        1,
        deleteRequest,
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });

    const retractRequest = draftsRetractV20.requestSchema.parse({
      scopeId: "scope-fake-1",
      draftId: "draft-fake-1",
      base: { headSha256: HASH, ownerEpoch: 2, revision: 7 },
      operationId: "operation-retract-fake-1",
    });
    expect(
      downgradeRequestAcrossMajors(
        hostRpcRegistry["drafts.retract"],
        2,
        1,
        retractRequest,
      ),
    ).toMatchObject({ ok: false, error: { code: "DOWNGRADE_UNSUPPORTED" } });
  });
});

import { describe, expect, it } from "vitest";
import {
  draftCloudDocumentSchema,
  draftCloudCurrentSchema,
  draftCloudTombstoneSchema,
  draftsDeleteV20,
  draftsListV30,
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
});

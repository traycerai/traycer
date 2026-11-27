import { defineVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { ManifestMethodEntry } from "@traycer/protocol/framework/ws-protocol";
import {
  draftsDeleteV10,
  draftsListV20,
  draftsRetractV10,
  draftsSubscribeV10,
  draftsSubscribeV11,
  draftsUpsertV20,
} from "@traycer/protocol/host/drafts/index";

const draftWrite = draftsUpsertV20.requestSchema.parse({
  draft: {
    draftId: "draft-1",
    kind: "landing",
    target: { epicId: null, chatId: null, blockId: null },
    revision: 0,
    lastTouchedAt: 1753000000000,
    workspace: null,
    supersedes: null,
    portable: {
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
      },
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  },
});

const draftDocument = draftsUpsertV20.responseSchema.parse({
  draft: {
    ...draftWrite.draft,
    revision: 1,
    ownerHostId: "host-1",
    origin: "own",
    adoption: { state: "adopted", hostId: "host-1" },
    publication: {
      status: "unpublished",
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
  },
}).draft;

export const releasedDraftWireCases = [
  {
    contract: draftsListV20,
    params: {},
    result: { drafts: [draftDocument], tombstones: [], snapshotSeq: 1 },
  },
  {
    contract: draftsUpsertV20,
    params: draftWrite,
    result: { draft: draftDocument },
  },
  {
    contract: draftsDeleteV10,
    params: { draftId: draftDocument.draftId },
    result: { deleted: true },
  },
  {
    contract: draftsRetractV10,
    params: { draftId: draftDocument.draftId },
    result: { retracted: true },
  },
].flatMap(({ contract, params, result }) => {
  const callerVersion = contract.schemaVersion;
  const major = callerVersion.major;
  const v10 = { major: 1, minor: 0 };
  const activated = { major: major + 1, minor: 0 };
  const callerContract = {
    callerVersion,
    fallbackWireVersions: major === 2 ? [v10] : [],
  };
  const peers: readonly {
    readonly label: string;
    readonly peer: ManifestMethodEntry;
    readonly expected: ManifestMethodEntry;
  }[] = [
    { label: "released 1.0", peer: v10, expected: v10 },
    ...(major === 2
      ? [
          {
            label: "released canonical",
            peer: callerVersion,
            expected: callerVersion,
          },
        ]
      : []),
    {
      label: "activated alternate",
      peer: { ...activated, supportedMajors: major === 2 ? [1, 2, 3] : [1, 2] },
      expected: callerVersion,
    },
  ];
  return peers.map(({ label, peer, expected }) => ({
    label: `${contract.method} to ${label}`,
    method: contract.method,
    params: contract.requestSchema.parse(params),
    result: contract.responseSchema.parse(result),
    callerContract,
    peer,
    expected,
  }));
});

export const releasedLegacyDraftFrame =
  draftsSubscribeV11.serverFrameSchema.parse({
    kind: "upsert",
    hasBinaryPayload: false,
    storeSeq: 1,
    draftId: draftDocument.draftId,
    revision: draftDocument.revision,
    draft: draftDocument,
  });

export const liveLegacyDraftFrame = draftsSubscribeV11.serverFrameSchema.parse({
  ...releasedLegacyDraftFrame,
  draft: {
    ...draftDocument,
    portable: {
      ...draftWrite.draft.portable,
      runSettings: {
        harnessId: "commandcode",
        model: "command-code-test",
        permissionMode: "supervised",
        reasoningEffort: null,
        serviceTier: null,
        agentMode: "regular",
        profileId: null,
      },
    },
  },
});

/** The drafts stream family installed by desktop and host 1.5.4. */
export const releasedDraftStreamRegistry = defineVersionedStreamRpcRegistry({
  "drafts.subscribe": {
    1: {
      latestMinor: 1,
      versions: {
        0: { contract: draftsSubscribeV10 },
        1: { contract: draftsSubscribeV11 },
      },
    },
  },
});

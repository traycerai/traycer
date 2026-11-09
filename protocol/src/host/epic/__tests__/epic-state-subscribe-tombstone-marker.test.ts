/**
 * Protocol-boundary contract for the born-object marker on the wire: a deleted
 * markdown artifact's tombstone carries `markdownBody: "object"` in the epic
 * document, and `epic.state.subscribe` never sends it. Every minor's deleted
 * record schema and server frame strips the key, so a client reads the same
 * tombstone whether or not the artifact was an object.
 *
 * Self-contained per the protocol-test convention (no cross-workspace
 * fixture imports).
 */
import { describe, expect, it } from "vitest";
import {
  buildDeletedEpicArtifact,
  epicArtifactSchema,
} from "@traycer/protocol/persistence/epic/artifacts";
import {
  epicDeletedArtifactRecordSchema,
  epicDeletedArtifactRecordSchemaPreHtml,
  epicStateSubscribeServerFrameSchemaV11,
  epicStateSubscribeServerFrameSchemaV13,
  epicStateSubscribeServerFrameSchemaV14,
  epicStateSubscribeServerFrameSchemaV15,
} from "@traycer/protocol/host/epic/state-subscribe";

const DELETED_AT = "2026-10-18T00:00:00.000Z";
const REVISION = 4;
const MARKDOWN_KINDS = ["spec", "ticket", "story", "review"] as const;

/** A live entry born as an object: the marker, no head yet. */
function bornObjectEntry(kind: (typeof MARKDOWN_KINDS)[number]) {
  return {
    kind,
    id: `art-${kind}`,
    folderName: `art-${kind}`,
    title: `Title ${kind}`,
    createdAt: 1000,
    updatedAt: 1000,
    createdManually: false,
    parentId: null,
    layout: "folder",
    relativePath: `docs/art-${kind}`,
    artifactRoomId: "artifact-room-0",
    assignee: "user-1",
    status: 2,
    markdownBody: "object",
  };
}

/**
 * The tombstone the host writes for each born-object entry, stamped with a
 * lane revision as the lane session stamps it. Each test starts from tombstones
 * that carry the marker: a strip proves nothing unless the marker reaches it.
 */
function objectTombstones() {
  return MARKDOWN_KINDS.map((kind) => {
    const tombstone = buildDeletedEpicArtifact(
      epicArtifactSchema.parse(bornObjectEntry(kind)),
      DELETED_AT,
    );
    expect(tombstone).toHaveProperty("markdownBody", "object");
    return { ...tombstone, revision: REVISION };
  });
}

function snapshotFrame() {
  return {
    kind: "snapshot",
    authorityEpoch: "epoch-1",
    position: 0,
    basis: "cold",
    reconciledWithCloud: false,
    epicMeta: { revision: 0, meta: { title: "An epic", updatedAt: 1 } },
    artifactRecords: [],
    deletedArtifacts: objectTombstones(),
    roleClaims: { revision: 0, claims: [] },
    commentThreads: [],
    hasBinaryPayload: false,
  };
}

function deltaFrame() {
  return {
    kind: "delta",
    authorityEpoch: "epoch-1",
    seq: 1,
    artifactUpserts: [],
    artifactTombstones: objectTombstones(),
    commentThreadUpserts: [],
    commentThreadRemovals: [],
    epicMeta: null,
    roleClaims: null,
    hasBinaryPayload: false,
  };
}

const FRAME_SCHEMAS = [
  { minor: "1.1", schema: epicStateSubscribeServerFrameSchemaV11 },
  { minor: "1.3", schema: epicStateSubscribeServerFrameSchemaV13 },
  { minor: "1.4", schema: epicStateSubscribeServerFrameSchemaV14 },
  { minor: "1.5", schema: epicStateSubscribeServerFrameSchemaV15 },
];

describe("epic.state.subscribe drops the born-object marker from a tombstone", () => {
  it.each([
    { name: "live", schema: epicDeletedArtifactRecordSchema },
    { name: "pre-html", schema: epicDeletedArtifactRecordSchemaPreHtml },
  ])("the $name deleted record schema", ({ schema }) => {
    for (const tombstone of objectTombstones()) {
      const record = schema.parse(tombstone);
      expect(Object.keys(record)).not.toContain("markdownBody");
      expect(record).toMatchObject({
        kind: tombstone.kind,
        id: tombstone.id,
        revision: REVISION,
      });
    }
  });

  it.each(FRAME_SCHEMAS)(
    "@$minor snapshot frame sends each deleted markdown artifact without it",
    ({ schema }) => {
      const frame = schema.parse(snapshotFrame());
      if (frame.kind !== "snapshot") throw new Error("expected a snapshot");
      expect(frame.deletedArtifacts.map((record) => record.kind)).toEqual([
        ...MARKDOWN_KINDS,
      ]);
      expect(
        frame.deletedArtifacts.flatMap((record) => Object.keys(record)),
      ).not.toContain("markdownBody");
    },
  );

  it.each(FRAME_SCHEMAS)(
    "@$minor delta frame sends each tombstone without it",
    ({ schema }) => {
      const frame = schema.parse(deltaFrame());
      if (frame.kind !== "delta") throw new Error("expected a delta");
      expect(frame.artifactTombstones.map((record) => record.kind)).toEqual([
        ...MARKDOWN_KINDS,
      ]);
      expect(
        frame.artifactTombstones.flatMap((record) => Object.keys(record)),
      ).not.toContain("markdownBody");
    },
  );
});

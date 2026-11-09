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
  MARKDOWN_REVISION_HEAD_PATH,
  MARKDOWN_REVISION_HEAD_SCALARS_FIELD,
  MARKDOWN_REVISION_HEAD_SEQ_FIELD,
  MARKDOWN_REVISION_MEDIA_TYPE,
} from "@traycer/protocol/persistence/epic/markdown-revision";
import {
  epicDeletedArtifactRecordSchema,
  epicDeletedArtifactRecordSchemaPreHtml,
  epicStateSubscribeServerFrameSchemaV11,
  epicStateSubscribeServerFrameSchemaV13,
  epicStateSubscribeServerFrameSchemaV14,
  epicStateSubscribeServerFrameSchemaV15,
  epicStateSubscribeServerFrameSchemaV16,
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
  { minor: "1.6", schema: epicStateSubscribeServerFrameSchemaV16 },
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

function markdownHead(kind: (typeof MARKDOWN_KINDS)[number]) {
  const scalars =
    kind === "ticket" || kind === "story"
      ? { kind, title: `Title ${kind}`, assignee: "user-1", status: 2 }
      : { kind, title: `Title ${kind}` };
  return {
    files: {
      [MARKDOWN_REVISION_HEAD_PATH]: {
        sha256: "a".repeat(64),
        byteLength: 10,
        mediaType: MARKDOWN_REVISION_MEDIA_TYPE,
        status: "published",
        [MARKDOWN_REVISION_HEAD_SEQ_FIELD]: 1,
        [MARKDOWN_REVISION_HEAD_SCALARS_FIELD]: scalars,
      },
    },
    capturedAt: 1000,
  };
}

function fileHead() {
  return {
    files: {
      "index.html": {
        sha256: "b".repeat(64),
        byteLength: 20,
        mediaType: "text/html",
        status: "published",
      },
    },
    capturedAt: 1000,
  };
}

function liveMarkdownEntry(kind: (typeof MARKDOWN_KINDS)[number]) {
  return {
    kind,
    id: `live-${kind}`,
    folderName: `live-${kind}`,
    title: `Title ${kind}`,
    createdAt: 1000,
    updatedAt: 1000,
    createdManually: false,
    parentId: null,
    layout: "folder" as const,
    relativePath: `docs/live-${kind}`,
    artifactRoomId: "artifact-room-0",
    ...(kind === "ticket" || kind === "story"
      ? { assignee: "user-1", status: 2 }
      : {}),
    head: markdownHead(kind),
    markdownBody: "object" as const,
    revision: REVISION,
  };
}

const FILE_HEAD_KINDS = ["html", "canvas"] as const;

function liveFileHeadEntry(kind: (typeof FILE_HEAD_KINDS)[number]) {
  return {
    kind,
    id: `live-${kind}`,
    folderName: `live-${kind}`,
    title: `Title ${kind}`,
    createdAt: 1000,
    updatedAt: 1000,
    createdManually: false,
    parentId: null,
    layout: "folder" as const,
    relativePath: `docs/live-${kind}`,
    artifactRoomId: `artifact-room-${kind}`,
    head: fileHead(),
    revision: REVISION,
  };
}

function liveSnapshotFrame(records: readonly unknown[]) {
  return {
    kind: "snapshot",
    authorityEpoch: "epoch-1",
    position: 0,
    basis: "cold",
    reconciledWithCloud: false,
    epicMeta: { revision: 0, meta: { title: "An epic", updatedAt: 1 } },
    artifactRecords: records,
    deletedArtifacts: [],
    roleClaims: { revision: 0, claims: [] },
    commentThreads: [],
    hasBinaryPayload: false,
  };
}

function liveDeltaFrame(records: readonly unknown[]) {
  return {
    kind: "delta",
    authorityEpoch: "epoch-1",
    seq: 1,
    artifactUpserts: records,
    artifactTombstones: [],
    commentThreadUpserts: [],
    commentThreadRemovals: [],
    epicMeta: null,
    roleClaims: null,
    hasBinaryPayload: false,
  };
}

const PRE_MARKDOWN_OBJECT_FRAME_SCHEMAS = [
  { minor: "1.3", schema: epicStateSubscribeServerFrameSchemaV13 },
  { minor: "1.4", schema: epicStateSubscribeServerFrameSchemaV14 },
  { minor: "1.5", schema: epicStateSubscribeServerFrameSchemaV15 },
];

// html and canvas kinds did not exist on the wire before 1.3
// (`epicArtifactRecordSchemaPreHtml`), so they are excluded from 1.1.
const HTML_CANVAS_CAPABLE_SCHEMAS = [
  ...PRE_MARKDOWN_OBJECT_FRAME_SCHEMAS,
  { minor: "1.6", schema: epicStateSubscribeServerFrameSchemaV16 },
];

const STRIP_CASES = PRE_MARKDOWN_OBJECT_FRAME_SCHEMAS.flatMap(
  ({ minor, schema }) =>
    (["snapshot", "delta"] as const).map((frame) => ({
      minor,
      schema,
      frame,
    })),
);

const FILE_HEAD_CASES = HTML_CANVAS_CAPABLE_SCHEMAS.flatMap(
  ({ minor, schema }) =>
    FILE_HEAD_KINDS.map((kind) => ({ minor, schema, kind })),
);

function artifactRecordsOf<T>(
  frame:
    | { readonly kind: "snapshot"; readonly artifactRecords: readonly T[] }
    | { readonly kind: "delta"; readonly artifactUpserts: readonly T[] }
    | { readonly kind: string },
): readonly T[] {
  if ("artifactRecords" in frame) return frame.artifactRecords;
  if ("artifactUpserts" in frame) return frame.artifactUpserts;
  throw new Error(`expected a snapshot or delta frame, got ${frame.kind}`);
}

describe("epic.state.subscribe strips a live markdown entry's head and born-object marker before 1.6, and keeps a valid HTML/canvas head untouched throughout", () => {
  it.each(STRIP_CASES)(
    "@$minor $frame frame strips head and markdownBody from every live markdown kind",
    ({ schema, frame }) => {
      const records = MARKDOWN_KINDS.map((kind) => liveMarkdownEntry(kind));
      const parsed = schema.parse(
        frame === "snapshot"
          ? liveSnapshotFrame(records)
          : liveDeltaFrame(records),
      );
      const parsedRecords = artifactRecordsOf(parsed);
      expect(parsedRecords.map((record) => record.kind)).toEqual([
        ...MARKDOWN_KINDS,
      ]);
      const keys = parsedRecords.flatMap((record) => Object.keys(record));
      expect(keys).not.toContain("head");
      expect(keys).not.toContain("markdownBody");
    },
  );

  it.each(["snapshot", "delta"] as const)(
    "@1.6 %s frame retains head and markdownBody for every live markdown kind",
    (frame) => {
      const records = MARKDOWN_KINDS.map((kind) => liveMarkdownEntry(kind));
      const parsed = epicStateSubscribeServerFrameSchemaV16.parse(
        frame === "snapshot"
          ? liveSnapshotFrame(records)
          : liveDeltaFrame(records),
      );
      const parsedRecords = artifactRecordsOf(parsed);
      for (const [index, record] of parsedRecords.entries()) {
        expect(record).toMatchObject({
          head: records[index]?.head,
          markdownBody: "object",
        });
      }
    },
  );

  it.each(FILE_HEAD_CASES)(
    "@$minor keeps a live $kind artifact's own head untouched",
    ({ schema, kind }) => {
      const frame = schema.parse(liveSnapshotFrame([liveFileHeadEntry(kind)]));
      if (frame.kind !== "snapshot") throw new Error("expected a snapshot");
      const [record] = frame.artifactRecords;
      if (record === undefined) throw new Error(`expected the ${kind} record`);
      expect(record).toMatchObject({ kind, head: fileHead() });
    },
  );
});

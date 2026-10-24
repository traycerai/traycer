import { describe, expect, it } from "vitest";
import { FakeStreamClient } from "../__testing__/fake-stream-client";
import type { StreamFrameEnvelope } from "../i-stream-session";
import {
  EpicStateStreamClient,
  type EpicStateDeltaFrame,
  type EpicStateSnapshotFrame,
} from "../epic-state-stream-client";

const SHA = "b".repeat(64);

/** A `@1.1` snapshot, the base the frames in this file build on. */
const SNAPSHOT_V11 = {
  kind: "snapshot",
  authorityEpoch: "epoch-1",
  position: 0,
  basis: "cold",
  reconciledWithCloud: false,
  epicMeta: { revision: 0, meta: { title: "An epic", updatedAt: 1 } },
  artifactRecords: [],
  deletedArtifacts: [],
  roleClaims: { revision: 0, claims: [] },
  commentThreads: [],
  hasBinaryPayload: false,
};

const FILES = {
  revision: 2,
  files: [
    {
      path: "files/pages/report-1.html",
      entry: {
        v: 1,
        kind: "page",
        sha256: SHA,
        byteLength: 12,
        mediaType: "text/html",
        status: "published",
        createdAt: 1,
        derivedFrom: null,
        title: null,
        deletedAt: null,
      },
      localState: { kind: "present" },
    },
  ],
};

const DELTA_V11 = {
  kind: "delta",
  authorityEpoch: "epoch-1",
  seq: 1,
  artifactUpserts: [],
  artifactTombstones: [],
  commentThreadUpserts: [],
  commentThreadRemovals: [],
  epicMeta: null,
  roleClaims: { revision: 1, claims: [] },
  hasBinaryPayload: false,
};

function open(): {
  readonly emit: (frame: StreamFrameEnvelope) => void;
  readonly snapshots: EpicStateSnapshotFrame[];
  readonly deltas: EpicStateDeltaFrame[];
} {
  const transport = new FakeStreamClient(true);
  const snapshots: EpicStateSnapshotFrame[] = [];
  const deltas: EpicStateDeltaFrame[] = [];
  new EpicStateStreamClient({
    wsStreamClient: transport,
    epicId: "epic-1",
    resumeProvider: () => null,
    callbacks: {
      onSnapshot: (frame) => snapshots.push(frame),
      onResumed: () => {},
      onDelta: (frame) => deltas.push(frame),
      onTrustChanged: () => {},
      onConnectionStatus: () => {},
    },
  });
  const session = transport.sessions[0];
  if (session === undefined) throw new Error("nothing subscribed");
  return { emit: (frame) => session.emit(frame, null), snapshots, deltas };
}

describe("the epic state stream client across host minors", () => {
  it("decodes a @1.1 host's snapshot and delta", () => {
    const client = open();

    client.emit(SNAPSHOT_V11);
    client.emit(DELTA_V11);

    expect(client.snapshots).toHaveLength(1);
    expect(client.deltas).toHaveLength(1);
    expect(client.deltas[0]?.seq).toBe(1);
  });

  it("delivers a snapshot that still carries a files arm, without surfacing the arm", () => {
    // The files arm was removed before any release shipped it, so no minor
    // carries one. A frame that has it anyway is read without it.
    const client = open();

    client.emit({ ...SNAPSHOT_V11, files: FILES });

    expect(client.snapshots).toHaveLength(1);
    expect(client.snapshots[0]).not.toHaveProperty("files");
  });

  it("discards a delta whose only change was the files arm, and keeps one that changes something else", () => {
    const client = open();

    client.emit({ ...DELTA_V11, roleClaims: null, files: FILES });
    expect(client.deltas).toEqual([]);

    client.emit({ ...DELTA_V11, files: FILES });
    expect(client.deltas).toHaveLength(1);
    expect(client.deltas[0]?.roleClaims).toEqual(DELTA_V11.roleClaims);
    expect(client.deltas[0]).not.toHaveProperty("files");
  });

  it("delivers a @1.3 frame whose rows are the new html and file kinds, rather than dropping it", () => {
    const client = open();
    const specRow = {
      kind: "spec",
      id: "spec-1",
      folderName: "spec-1",
      title: "A spec",
      createdAt: 1,
      updatedAt: 1,
      createdManually: false,
      parentId: null,
      layout: "folder",
      revision: 1,
    };
    const htmlRow = {
      kind: "html",
      id: "html-1",
      folderName: "html-1",
      title: "A page",
      createdAt: 1,
      updatedAt: 1,
      createdManually: false,
      parentId: null,
      layout: "folder",
      head: {
        files: {
          "index.html": {
            sha256: SHA,
            byteLength: 12,
            mediaType: "text/html",
            status: "published",
          },
        },
        capturedAt: 1,
      },
      revision: 2,
    };
    const fileTombstone = {
      kind: "file",
      id: "file-1",
      title: "A file",
      artifactRoomId: null,
      deletedAt: "2026-10-18T00:00:00.000Z",
      revision: 3,
    };

    client.emit({
      ...SNAPSHOT_V11,
      artifactRecords: [specRow, htmlRow],
      deletedArtifacts: [fileTombstone],
    });
    client.emit({
      ...DELTA_V11,
      roleClaims: null,
      artifactUpserts: [specRow, htmlRow],
      artifactTombstones: [fileTombstone],
    });

    // A schema that did not know the new discriminants would drop the whole
    // frame, so a missing frame here is the failure this guards against.
    expect(client.snapshots).toHaveLength(1);
    expect(client.deltas).toHaveLength(1);
    const snapshot = client.snapshots[0];
    const delta = client.deltas[0];
    expect(snapshot?.artifactRecords.map((row) => row.kind)).toEqual([
      "spec",
      "html",
    ]);
    expect(snapshot?.deletedArtifacts.map((row) => row.kind)).toEqual(["file"]);
    expect(delta?.artifactUpserts.map((row) => row.kind)).toEqual([
      "spec",
      "html",
    ]);
    expect(delta?.artifactTombstones.map((row) => row.kind)).toEqual(["file"]);
    const html = delta?.artifactUpserts.find((row) => row.kind === "html");
    expect(html?.kind === "html" ? html.head : null).toEqual(htmlRow.head);
  });

  it("keeps the anchor fields a @1.4 host sends on a comment thread, rather than letting an older schema strip them", () => {
    const client = open();
    const anchoredThread = {
      threadId: "thread-1",
      resolved: false,
      createdAt: 1,
      comments: [],
      data: {
        createdByUserId: "user-1",
        anchorKind: "text",
        artboard: "board-1",
        elementId: "tid-1",
        startOffset: 2,
        endOffset: 9,
        label: "Hero heading",
      },
      artifactId: "html-1",
      revision: 1,
    };

    client.emit({ ...SNAPSHOT_V11, commentThreads: [anchoredThread] });
    client.emit({
      ...DELTA_V11,
      roleClaims: null,
      commentThreadUpserts: [anchoredThread],
    });

    expect(client.snapshots[0]?.commentThreads[0]?.data).toEqual(
      anchoredThread.data,
    );
    expect(client.deltas[0]?.commentThreadUpserts[0]?.data).toEqual(
      anchoredThread.data,
    );
  });
});

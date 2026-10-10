import { describe, expect, it } from "vitest";
import { FakeStreamClient } from "../__testing__/fake-stream-client";
import type { StreamFrameEnvelope } from "../i-stream-session";
import {
  EpicStateStreamClient,
  type EpicStateDeltaFrame,
  type EpicStateSnapshotFrame,
} from "../epic-state-stream-client";

const SHA = "b".repeat(64);

/** A `@1.1` snapshot: what a host that predates the files arm sends. */
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

describe("the epic state stream client across the @1.1 / @1.2 skew", () => {
  it("decodes a @1.1 host's snapshot and delta, which carry no files arm", () => {
    const client = open();

    client.emit(SNAPSHOT_V11);
    client.emit(DELTA_V11);

    expect(client.snapshots).toHaveLength(1);
    expect(client.deltas).toHaveLength(1);
    // A host that predates the arm sends no `files`; the lenient arm decodes
    // that as `null`, never as a files set.
    const snapshot = client.snapshots[0];
    expect(
      snapshot !== undefined && "files" in snapshot ? snapshot.files : null,
    ).toBeNull();
    const delta = client.deltas[0];
    expect(
      delta !== undefined && "files" in delta ? delta.files : null,
    ).toBeNull();
    expect(delta?.seq).toBe(1);
  });

  it("keeps the files arm a @1.2 host sends, rather than letting the @1.1 schema strip it", () => {
    const client = open();

    client.emit({ ...SNAPSHOT_V11, files: FILES });
    client.emit({ ...DELTA_V11, roleClaims: null, files: FILES });

    const snapshot = client.snapshots[0];
    const delta = client.deltas[0];
    expect(
      snapshot !== undefined && "files" in snapshot ? snapshot.files : null,
    ).toEqual(FILES);
    expect(
      delta !== undefined && "files" in delta ? delta.files : null,
    ).toEqual(FILES);
  });
});

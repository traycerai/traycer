/**
 * The epic-files manifest reaches the store on the LANE arm.
 *
 * The lane head has no root `Y.Doc`, so before `epic.state.subscribe@1.1` the
 * `files` slice was hard-coded empty on it: a dev host serving the lanes
 * ("EpicLaneSession: state subscribe served") rendered an empty Files panel and
 * an `epic-file` tile that said the file was "no longer listed", on an epic
 * whose doc really did carry the entry. Both arms are driven here on the SAME
 * host-shaped entry so the doc arm stays the reference for what the lane arm
 * has to produce.
 */
import { act } from "react";
import { describe, expect, it } from "vitest";
import { epicStateSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/status-subscribe";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { EpicStateStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { EpicStatusStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { EpicLaneSelectionSources } from "../runtime/epic-replica-runtime";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "../test-support/open-store-for-test";
import { absentLaneUnaries } from "../test-support/absent-lane-unaries";
import { groupEpicFiles } from "@/lib/epic-files/file-rows";

/** Exactly what `recording-controller.captureScreenshot` -> ingest writes. */
const SCREENSHOT_PATH =
  "files/screenshots/2026-09-10T14-35-51-619Z-9cb544e8-dbdc-46ea-bd23-e4a7d135f802.png";
const SCREENSHOT_ENTRY = {
  v: 1,
  kind: "screenshot",
  current: {
    sha256: "ef53b4119305637bdb3dc1cc7cda1f554c2f71f32ac52071a894b7bbb3cb3a34",
    byteLength: 117789,
    mediaType: "image/png",
    createdAt: 1_788_000_000_000,
    createdBy: "user-1",
    producer: { type: "user" },
  },
  versions: [],
  status: "available",
  recordingId: null,
  derivedFrom: [],
  deletedAt: null,
};
const DELETED_PATH = "files/screenshots/older.png";
const DELETED_ENTRY = { ...SCREENSHOT_ENTRY, deletedAt: 1_788_000_100_000 };

function writeScreenshot(handle: OpenedStoreForTest): void {
  act(() => {
    handle.doc.getMap("files").set(SCREENSHOT_PATH, SCREENSHOT_ENTRY);
  });
}

interface LaneHandles {
  readonly handle: OpenedStoreForTest;
  readonly state: EpicStateStreamCallbacks;
}

function openLaneStore(epicId: string): LaneHandles {
  let statusCallbacks: EpicStatusStreamCallbacks | null = null;
  let stateCallbacks: EpicStateStreamCallbacks | null = null;
  const statusFactory: EpicStatusStreamClientFactory = (_id, callbacks) => {
    statusCallbacks = callbacks;
    return { close: () => undefined };
  };
  const stateFactory: EpicStateStreamClientFactory = (_id, callbacks) => {
    stateCallbacks = callbacks;
    return { close: () => undefined };
  };
  const artifactFactory: ArtifactStreamClientFactory = () => ({
    applyUpdate: () => undefined,
    awareness: () => undefined,
    close: () => undefined,
  });
  const laneSelection: EpicLaneSelectionSources = {
    support: () => "supported",
    subscribeSupport: () => () => {},
    unaries: absentLaneUnaries(),
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
  };
  const handle = openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: () => {
        throw new Error("legacy stream must not open on the lane arm");
      },
      laneSelection,
    },
    writeCommand: null,
  });
  const status = statusCallbacks as EpicStatusStreamCallbacks | null;
  const state = stateCallbacks as EpicStateStreamCallbacks | null;
  if (status === null || state === null) {
    throw new Error("lane factories were not invoked");
  }
  status.onConnectionStatus("open", null);
  state.onConnectionStatus("open", null);
  const statusFrame = epicStatusSubscribeServerFrameSchemaV11.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: "epoch-1",
    securityEpoch: 1,
    permissionRole: "editor",
    cloudSyncStatus: "connected",
    dirty: false,
    migration: null,
    deletion: { state: "none" },
  });
  if (statusFrame.kind !== "snapshot") throw new Error("bad status frame");
  status.onSnapshot(statusFrame, true);
  return { handle, state };
}

function snapshotFrame(files: unknown): unknown {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: "epoch-1",
    basis: "cold",
    position: 1,
    reconciledWithCloud: true,
    artifactRecords: [],
    deletedArtifacts: [],
    commentThreads: [],
    roleClaims: { revision: 1, claims: [] },
    epicMeta: { revision: 1, meta: { title: "Lane epic", updatedAt: 1000 } },
    files,
  };
}

async function sendSnapshot(lane: LaneHandles, files: unknown): Promise<void> {
  const frame = epicStateSubscribeServerFrameSchemaV11.parse(
    snapshotFrame(files),
  );
  if (frame.kind !== "snapshot") throw new Error("bad state frame");
  lane.state.onSnapshot(frame);
  await lane.handle.flush();
  await lane.handle.flush();
  await lane.handle.flush();
}

describe("the epic-files manifest on the lane arm", () => {
  it("DOC arm: the row reaches the Files panel", () => {
    const handle = openStoreForTest({
      epicId: "epic-files-doc",
      userId: null,
      factories: {
        streamClientFactory: () => ({
          applyUpdate: () => {},
          awareness: () => {},
          applyArtifactRoomUpdate: () => {},
          artifactRoomAwareness: () => {},
          retryMigration: () => {},
          close: () => {},
        }),
        laneSelection: null,
      },
      writeCommand: null,
    });
    writeScreenshot(handle);
    const files = handle.store.getState().files;
    expect(files.records.map((record) => record.path)).toEqual([
      SCREENSHOT_PATH,
    ]);
    // The panel's own row derivation, default toggles (system folders hidden).
    expect(
      groupEpicFiles(files.records, false).map((group) => group.label),
    ).toEqual(["screenshots/"]);
    handle.dispose();
  });

  it("LANE arm: the snapshot's manifest reaches the Files panel", async () => {
    const lane = openLaneStore("epic-files-lane");
    await sendSnapshot(lane, {
      revision: 1,
      files: [{ path: SCREENSHOT_PATH, entry: SCREENSHOT_ENTRY }],
    });

    const files = lane.handle.store.getState().files;
    expect(files.records.map((record) => record.path)).toEqual([
      SCREENSHOT_PATH,
    ]);
    // The same derivation the doc arm proves above, on the same entry.
    expect(
      groupEpicFiles(files.records, false).map((group) => group.label),
    ).toEqual(["screenshots/"]);
    lane.handle.dispose();
  });

  it("LANE arm: a tombstoned entry lands in `deleted`, not in `records`", async () => {
    const lane = openLaneStore("epic-files-lane-deleted");
    await sendSnapshot(lane, {
      revision: 1,
      files: [
        { path: SCREENSHOT_PATH, entry: SCREENSHOT_ENTRY },
        { path: DELETED_PATH, entry: DELETED_ENTRY },
      ],
    });

    const files = lane.handle.store.getState().files;
    expect(files.records.map((record) => record.path)).toEqual([
      SCREENSHOT_PATH,
    ]);
    expect(files.deleted.map((record) => record.path)).toEqual([DELETED_PATH]);
    lane.handle.dispose();
  });

  it("LANE arm: a delta's manifest replaces the held set", async () => {
    const lane = openLaneStore("epic-files-lane-delta");
    await sendSnapshot(lane, { revision: 1, files: [] });
    expect(lane.handle.store.getState().files.records).toEqual([]);

    const delta = epicStateSubscribeServerFrameSchemaV11.parse({
      kind: "delta",
      hasBinaryPayload: false,
      authorityEpoch: "epoch-1",
      seq: 2,
      artifactUpserts: [],
      artifactTombstones: [],
      commentThreadUpserts: [],
      commentThreadRemovals: [],
      epicMeta: null,
      roleClaims: null,
      files: {
        revision: 2,
        files: [{ path: SCREENSHOT_PATH, entry: SCREENSHOT_ENTRY }],
      },
    });
    if (delta.kind !== "delta") throw new Error("bad delta frame");
    lane.state.onDelta(delta);
    await lane.handle.flush();
    await lane.handle.flush();

    expect(
      lane.handle.store.getState().files.records.map((record) => record.path),
    ).toEqual([SCREENSHOT_PATH]);
    lane.handle.dispose();
  });

  it("LANE arm: a pre-@1.1 host that sends no manifest leaves the slice empty", async () => {
    const lane = openLaneStore("epic-files-lane-old-host");
    // The frame a `@1.0` host produces: no `files` key at all. Absent is not
    // the same claim as empty, but with nothing to render either way the
    // panel shows what it showed before the population existed.
    await sendSnapshot(lane, undefined);
    // The doc really does carry the entry - which is exactly the bug's shape.
    writeScreenshot(lane.handle);
    await lane.handle.flush();

    const files = lane.handle.store.getState().files;
    expect(files.records).toEqual([]);
    expect(files.deleted).toEqual([]);
    lane.handle.dispose();
  });
});

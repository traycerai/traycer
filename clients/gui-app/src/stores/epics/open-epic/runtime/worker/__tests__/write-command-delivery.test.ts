import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { createArtifactInDocForTests } from "@/stores/epics/open-epic/__tests__/projection-helpers-test-shims";
import type { EpicWriteCommandIntent } from "../../epic-write-command";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const EPIC_ID = "epic-write-delivery";

/** The host id main answers, distinct from the harness's bootstrap value. */
const ANSWERING_HOST = "host-that-answered";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Epic test",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

interface DeliveryRig {
  readonly handle: OpenedStoreForTest;
  /** What main's `main/write-command` handler actually received. */
  readonly received: { commandId: string; intent: EpicWriteCommandIntent }[];
}

function openRig(): DeliveryRig {
  const received: { commandId: string; intent: EpicWriteCommandIntent }[] = [];
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    // MAIN's half of the leg under test.
    writeCommand: (commandId, intent) => {
      received.push({ commandId, intent });
      return Promise.resolve({ hostId: ANSWERING_HOST });
    },
  });
  if (captured.value === null) throw new Error("factory not invoked");
  // Transport open BEFORE the snapshot: the control replica clears
  // `hasFreshRootSnapshotForOpenCycle` on every transport-status transition, so opening after would
  captured.value.onConnectionStatus("open", null);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  return { handle, received };
}

async function settle(handle: OpenedStoreForTest): Promise<void> {
  // Three drains rather than one: the command crosses the pipe to the queue, the queue's send
  // crosses BACK for `main/write-command`, and the answer crosses again to resolve the record.
  await handle.flush();
  await handle.flush();
  await handle.flush();
}

describe("a write command enqueued on the worker reaches main", () => {
  it("passes the send gate, arrives at main/write-command, and leaves queued", async () => {
    const rig = openRig();
    const artifactId = createArtifactInDocForTests(
      rig.handle.doc,
      "spec",
      null,
    );

    const commandId = await rig.handle.store.getState().enqueueWriteCommand({
      kind: "rename-artifact",
      artifactId,
      title: "Delivered title",
    });
    expect(commandId).not.toBeNull();
    await settle(rig.handle);

    // 1. DELIVERY - the leg nothing else watched. Under the null-host gate this
    // list was empty: the queue refused before `send` and main never heard.
    expect(rig.received).toHaveLength(1);
    expect(rig.received[0].commandId).toBe(commandId);
    expect(rig.received[0].intent).toEqual({
      kind: "rename-artifact",
      artifactId,
      title: "Delivered title",
    });

    const record = rig.handle.store
      .getState()
      .writeCommands.find((candidate) => candidate.commandId === commandId);
    if (record === undefined) throw new Error("the command record vanished");
    expect(record.delivery).not.toBe("queued");
    expect(record.state).toBe("committed");

    rig.handle.dispose();
  });

  it("attributes the committed command to the host main answered with", async () => {
    const rig = openRig();
    const artifactId = createArtifactInDocForTests(
      rig.handle.doc,
      "spec",
      null,
    );

    const commandId = await rig.handle.store.getState().enqueueWriteCommand({
      kind: "rename-artifact",
      artifactId,
      title: "Attributed title",
    });
    await settle(rig.handle);

    // The gate does two things with the host id and only one of them is the refusal: it also records
    // `attemptedHostByCommandId`, which is what a retry reads to know where the previous attempt went.
    const record = rig.handle.store
      .getState()
      .writeCommands.find((candidate) => candidate.commandId === commandId);
    if (record === undefined) throw new Error("the command record vanished");
    expect(record.state).toBe("committed");
    const resolution = record.resolution;
    if (resolution === null || resolution.kind !== "committed") {
      throw new Error(
        `expected a committed resolution, got ${resolution?.kind ?? "null"}`,
      );
    }
    expect(resolution.hostId).toBe(ANSWERING_HOST);

    // On the absence case there is deliberately no runtime pin: `hostId` is a REQUIRED field of
    // `RuntimeWorkerBootstrap`, so "the worker has no host id" is not a state this suite can
    rig.handle.dispose();
  });
});

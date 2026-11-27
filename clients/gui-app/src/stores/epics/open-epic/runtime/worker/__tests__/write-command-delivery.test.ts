/**
 * A write command enqueued on the worker actually REACHES main.
 *
 * ## Why this suite exists
 *
 * The relocation put the write-command queue in the worker and left the
 * requester on main, so a command now travels: store -> worker queue -> the
 * queue's send gate -> `main/write-command` -> the dispatcher. The gate reads
 * `writeCommandSender.currentHostId()` and refuses with
 * `EpicWriteCommandTransportUnavailableError` when it is null, BEFORE calling
 * `send`.
 *
 * The worker's sender answered `null` unconditionally, so the gate refused
 * every command and `send` was never reached. Every write a worker-hosted
 * runtime enqueued - rename, delete, reparent, epic title - sat in `queued`
 * forever. That is the whole app's write path, and it survived a green tree.
 *
 * ## Why a green tree missed it
 *
 * Every existing suite asserted the ENQUEUE outcome - that a command id is
 * minted, that the record appears, that the projection carries the optimistic
 * overlay - and the queue answers all of that locally, before the gate. **No
 * suite anywhere asserted DELIVERY**: that the gate was passed, that `send`
 * ran, that main's handler received the command. A defect living strictly
 * between "enqueued" and "delivered" was therefore invisible to the entire
 * population, and the suites that did fail (rename hooks, sidebar commits)
 * read as async-conversion premise drift rather than as one broken seam.
 *
 * That gap is what this suite closes: it asserts the leg nothing else watched.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { ARTIFACT_INDEX_UNAVAILABLE_COPY } from "@/lib/artifacts/artifact-index-unavailable-copy";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  createArtifactInDocForTests,
  hostDeltaForTests,
} from "@/stores/epics/open-epic/__tests__/projection-helpers-test-shims";
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
  readonly callbacks: EpicStreamCallbacks;
}

/** The host answers every command it receives. */
function answered(): Promise<{ readonly hostId: string }> {
  return Promise.resolve({ hostId: ANSWERING_HOST });
}

function openRig(
  answer: () => Promise<{ readonly hostId: string }>,
): DeliveryRig {
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
    // MAIN's half of the leg under test. Recording rather than dispatching:
    // this suite is about whether the command arrives, not about what the
    // dispatcher maps it to - that mapping has its own coverage.
    writeCommand: (commandId, intent) => {
      received.push({ commandId, intent });
      return answer();
    },
  });
  if (captured.value === null) throw new Error("factory not invoked");
  // Transport open BEFORE the snapshot: the control replica clears
  // `hasFreshRootSnapshotForOpenCycle` on every transport-status transition,
  // so opening after would wipe the freshness the snapshot set and the send
  // gate's OTHER arm would hold the command - which would make this suite pass
  // or fail for a reason that is not the one it is about.
  captured.value.onConnectionStatus("open", null, false, null);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  return { handle, received, callbacks: captured.value };
}

async function settle(handle: OpenedStoreForTest): Promise<void> {
  // Three drains rather than one: the command crosses the pipe to the queue,
  // the queue's send crosses BACK for `main/write-command`, and the answer
  // crosses again to resolve the record. Named as three hops rather than
  // looped, so a change in the hop count is visible here.
  await handle.flush();
  await handle.flush();
  await handle.flush();
}

describe("a write command enqueued on the worker reaches main", () => {
  it("passes the send gate, arrives at main/write-command, and leaves queued", async () => {
    const rig = openRig(answered);
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

    // 2. The command LEAVES `queued`. Asserted separately from delivery
    // because they failed together and can be fixed apart: a send that runs
    // but whose answer never resolves the record leaves the queue holding a
    // command main has already acted on, which is the worse of the two.
    const record = rig.handle.store
      .getState()
      .writeCommands.find((candidate) => candidate.commandId === commandId);
    if (record === undefined) throw new Error("the command record vanished");
    expect(record.delivery).not.toBe("queued");
    expect(record.state).toBe("committed");

    rig.handle.dispose();
  });

  it("attributes the committed command to the host main answered with", async () => {
    const rig = openRig(answered);
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

    // The gate does two things with the host id and only one of them is the
    // refusal: it also records `attemptedHostByCommandId`, which is what a
    // retry reads to know where the previous attempt went. `ANSWERING_HOST` is
    // deliberately NOT the harness's bootstrap `"test-host"`, so an
    // implementation that echoed the gate's own value instead of the answer
    // main returned would read as equal here and does not.
    const record = rig.handle.store
      .getState()
      .writeCommands.find((candidate) => candidate.commandId === commandId);
    if (record === undefined) throw new Error("the command record vanished");
    expect(record.state).toBe("committed");
    // NARROWED on the union rather than reached through it: `hostId` exists
    // only on the `committed` arm, so `resolution?.hostId` does not compile -
    // and the throw states which arm was expected, which a non-null assertion
    // would not.
    const resolution = record.resolution;
    if (resolution === null || resolution.kind !== "committed") {
      throw new Error(
        `expected a committed resolution, got ${resolution?.kind ?? "null"}`,
      );
    }
    expect(resolution.hostId).toBe(ANSWERING_HOST);

    // On the absence case there is deliberately no runtime pin: `hostId` is a
    // REQUIRED field of `RuntimeWorkerBootstrap`, so "the worker has no host
    // id" is not a state this suite can construct. The type is the pin for it,
    // and that is the stronger of the two - a runtime assertion would only
    // catch a null that the compiler now refuses to produce.
    rig.handle.dispose();
  });
});

/** The host moves the task's artifact index to epoch 1. */
function moveEpoch(host: Y.Doc): void {
  host.getMap("epic").set("artifactIndexEpoch", 1);
}

/** The full snapshot of a host that has moved `doc`'s index to epoch 1. */
function movedSnapshot(doc: Y.Doc): Uint8Array {
  const host = new Y.Doc();
  Y.applyUpdate(host, Y.encodeStateAsUpdate(doc));
  moveEpoch(host);
  return Y.encodeStateAsUpdate(host);
}

function commandRecord(handle: OpenedStoreForTest, commandId: string | null) {
  return handle.store
    .getState()
    .writeCommands.find((candidate) => candidate.commandId === commandId);
}

/** Two specs and a ticket, so every artifact command has a row to act on. */
function seedArtifacts(doc: Y.Doc): ArtifactIds {
  return {
    spec: createArtifactInDocForTests(doc, "spec", null),
    parent: createArtifactInDocForTests(doc, "spec", null),
    ticket: createArtifactInDocForTests(doc, "ticket", null),
  };
}

interface ArtifactIds {
  readonly spec: string;
  readonly parent: string;
  readonly ticket: string;
}

interface ArtifactCommandCase {
  readonly name: string;
  readonly intent: (ids: ArtifactIds) => EpicWriteCommandIntent;
}

const ARTIFACT_COMMANDS: ReadonlyArray<ArtifactCommandCase> = [
  {
    name: "rename",
    intent: (ids) => ({
      kind: "rename-artifact",
      artifactId: ids.spec,
      title: "Renamed",
    }),
  },
  {
    name: "delete",
    intent: (ids) => ({ kind: "delete-artifact", artifactId: ids.spec }),
  },
  {
    name: "reparent",
    intent: (ids) => ({
      kind: "reparent-artifact",
      artifactId: ids.spec,
      parentId: ids.parent,
    }),
  },
  {
    name: "status",
    intent: (ids) => ({
      kind: "update-artifact-status",
      artifactId: ids.ticket,
      artifactType: "ticket",
      status: 2,
    }),
  },
];

describe("write commands while the legacy arm cannot read the artifact index", () => {
  it("does not commit a delete of unknown outcome when the index becomes unavailable", async () => {
    const rig = openRig(() =>
      Promise.reject(
        HostRpcError.fromWireEnvelope(
          {
            code: "E_IDEMPOTENCY_OUTCOME_UNKNOWN",
            message: "outcome unknown",
          },
          "request-1",
          "epic.deleteArtifact",
        ),
      ),
    );
    try {
      const ids = seedArtifacts(rig.handle.doc);
      const commandId = await rig.handle.store.getState().enqueueWriteCommand({
        kind: "delete-artifact",
        artifactId: ids.spec,
      });
      await settle(rig.handle);
      expect(commandRecord(rig.handle, commandId)).toMatchObject({
        state: "pending",
        delivery: "unknown-outcome",
      });

      rig.callbacks.onUpdate(hostDeltaForTests(rig.handle.doc, moveEpoch));
      await settle(rig.handle);

      expect(rig.handle.store.getState().artifacts.allIds).toEqual([]);
      expect(commandRecord(rig.handle, commandId)).toMatchObject({
        state: "pending",
        delivery: "unknown-outcome",
        resolution: null,
      });
    } finally {
      rig.handle.dispose();
    }
  });

  it.each(ARTIFACT_COMMANDS.filter((command) => command.name !== "delete"))(
    "does not retire an in-flight $name as superseded when the index becomes unavailable",
    async ({ intent }) => {
      const rig = openRig(
        () => new Promise<{ readonly hostId: string }>(() => {}),
      );
      try {
        const ids = seedArtifacts(rig.handle.doc);
        const commandId = await rig.handle.store
          .getState()
          .enqueueWriteCommand(intent(ids));
        await settle(rig.handle);
        expect(rig.received).toHaveLength(1);

        rig.callbacks.onUpdate(hostDeltaForTests(rig.handle.doc, moveEpoch));
        await settle(rig.handle);

        expect(rig.handle.store.getState().artifacts.allIds).toEqual([]);
        expect(commandRecord(rig.handle, commandId)).toMatchObject({
          state: "pending",
          resolution: null,
        });
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it("still retires a chat rename its own echo has landed while the index is unavailable", async () => {
    const rig = openRig(answered);
    try {
      const chatId = createArtifactInDocForTests(rig.handle.doc, "chat", null);
      rig.callbacks.onUpdate(hostDeltaForTests(rig.handle.doc, moveEpoch));
      const requestId = await rig.handle.store
        .getState()
        .beginRenameMutation(chatId, "Renamed chat");
      if (requestId === null) throw new Error("expected a request id");
      await rig.handle.store
        .getState()
        .retirePendingMutation(requestId, "landed");
      // Held over the stored title until the echo arrives.
      expect(rig.handle.store.getState().chats.byId[chatId].title).toBe(
        "Renamed chat",
      );

      rig.callbacks.onUpdate(
        hostDeltaForTests(rig.handle.doc, (host) => {
          const chats = host.getMap("epic").get("chats");
          if (!(chats instanceof Y.Map)) throw new Error("no chats map");
          const chat: unknown = chats.get(chatId);
          if (!(chat instanceof Y.Map)) throw new Error("no chat entry");
          chat.set("title", "Renamed chat");
        }),
      );

      // The sweep has already forgotten the chain, so nothing is left to
      // retire.
      expect(
        await rig.handle.store
          .getState()
          .retirePendingMutation(requestId, "failed"),
      ).toBe(false);
    } finally {
      rig.handle.dispose();
    }
  });

  // A command enqueued while the index could be read, and dispatched after a
  // reconnect whose snapshot says it no longer can.
  it.each(ARTIFACT_COMMANDS)(
    "rejects a queued $name with the reason, without sending it",
    async ({ intent }) => {
      const rig = openRig(answered);
      try {
        const ids = seedArtifacts(rig.handle.doc);
        rig.callbacks.onConnectionStatus("reconnecting", null, true, null);
        const commandId = await rig.handle.store
          .getState()
          .enqueueWriteCommand(intent(ids));
        expect(commandId).not.toBeNull();

        rig.callbacks.onConnectionStatus("open", null, true, null);
        rig.callbacks.onSnapshot(makeMeta(), movedSnapshot(rig.handle.doc));
        await settle(rig.handle);

        expect(commandRecord(rig.handle, commandId)).toMatchObject({
          state: "rejected",
          resolution: {
            kind: "rejected",
            code: "E_ARTIFACT_INDEX_UNAVAILABLE",
            reason: ARTIFACT_INDEX_UNAVAILABLE_COPY["host-outdated"],
            retryable: false,
          },
        });
        expect(rig.received).toEqual([]);
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it("still sends an epic title update while the index is unavailable", async () => {
    const rig = openRig(answered);
    try {
      rig.callbacks.onUpdate(hostDeltaForTests(rig.handle.doc, moveEpoch));
      expect(rig.handle.store.getState().artifactIndex.state).toBe(
        "unavailable",
      );
      const intent: EpicWriteCommandIntent = {
        kind: "update-epic-title",
        title: "Retitled",
        updatedAt: 2,
      };

      const commandId = await rig.handle.store
        .getState()
        .enqueueWriteCommand(intent);
      await settle(rig.handle);

      expect(rig.received).toEqual([{ commandId, intent }]);
      expect(commandRecord(rig.handle, commandId)).toMatchObject({
        state: "committed",
      });
    } finally {
      rig.handle.dispose();
    }
  });
});

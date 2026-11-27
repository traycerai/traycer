import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as Y from "yjs";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type {
  CommandRecord,
  CommandSendFailure,
} from "@traycer-clients/shared/replica-runtime";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { settleEpicTitleWrite } from "@/lib/epic-title-write-settlement";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import type { EpicWriteCommandIntent } from "@/stores/epics/open-epic/runtime/epic-write-command";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: vi.fn(),
}));

const EPIC_ID = "epic-title-write-settlement";
const BASE_TITLE = "Before rename";
const TARGET_TITLE = "Requested title";
const EXTERNAL_TITLE = "Changed by another editor";
const COMPUTER_HOST_ID = "computer-serving-epic";
const SETTLEMENT_SOURCE = "epic-title-write-test";

const PEERS = [
  { name: "pool", hostId: POOL_HOST_ID },
  { name: "computer", hostId: COMPUTER_HOST_ID },
] as const;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === null) {
        throw new Error("deferred promise has no resolver");
      }
      resolvePromise(value);
    },
  };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function snapshotMeta(hostDoc: Y.Doc): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: BASE_TITLE,
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "user-a",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(hostDoc)),
  };
}

type WriteReply =
  | { readonly hostId: string }
  | { readonly failure: CommandSendFailure };

interface WriteAttempt {
  readonly commandId: string;
  readonly intent: EpicWriteCommandIntent;
}

interface RenameRig {
  readonly handle: OpenedStoreForTest;
  readonly callbacks: EpicStreamCallbacks;
  readonly hostDoc: Y.Doc;
  readonly attempts: WriteAttempt[];
  readonly dispatched: Promise<void>;
  readonly reply: Deferred<WriteReply>;
}

interface StartedRename {
  readonly commandId: string;
  readonly settled: Promise<CommandRecord<EpicWriteCommandIntent>>;
  readonly onCommitted: Mock<() => void>;
}

async function drain(handle: OpenedStoreForTest): Promise<void> {
  await handle.flush();
  await handle.flush();
  await handle.flush();
}

async function openRenameRig(): Promise<RenameRig> {
  const hostDoc = new Y.Doc();
  hostDoc.getMap("epic").set("title", BASE_TITLE);

  const callbacks: { value: EpicStreamCallbacks | null } = { value: null };
  const attempts: WriteAttempt[] = [];
  const dispatched = deferred<void>();
  const reply = deferred<WriteReply>();
  const streamFactory: EpicStreamClientFactory = (_epicId, nextCallbacks) => {
    callbacks.value = nextCallbacks;
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
    userId: "user-a",
    factories: { streamClientFactory: streamFactory, laneSelection: null },
    writeCommand: (commandId, intent) => {
      attempts.push({ commandId, intent });
      dispatched.resolve(undefined);
      return reply.promise;
    },
  });

  if (callbacks.value === null) {
    throw new Error("the epic stream factory did not capture callbacks");
  }
  const streamCallbacks = callbacks.value;
  streamCallbacks.onConnectionStatus("open", null, false, null);
  streamCallbacks.onSnapshot(
    snapshotMeta(hostDoc),
    Y.encodeStateAsUpdate(hostDoc),
  );
  await drain(handle);

  return {
    handle,
    callbacks: streamCallbacks,
    hostDoc,
    attempts,
    dispatched: dispatched.promise,
    reply,
  };
}

function titleUpdate(hostDoc: Y.Doc, title: string): Uint8Array {
  const stateVector = Y.encodeStateVector(hostDoc);
  hostDoc.transact(() => {
    hostDoc.getMap("epic").set("title", title);
  });
  return Y.encodeStateAsUpdate(hostDoc, stateVector);
}

async function deliverTitleFrame(rig: RenameRig, title: string): Promise<void> {
  rig.callbacks.onUpdate(titleUpdate(rig.hostDoc, title));
  await drain(rig.handle);
}

async function startRename(
  rig: RenameRig,
  title: string,
): Promise<StartedRename> {
  const commandId = await rig.handle.store.getState().enqueueWriteCommand({
    kind: "update-epic-title",
    title,
    updatedAt: 2000,
  });
  if (commandId === null)
    throw new Error("expected the title command to enqueue");
  const settled = rig.handle.store.getState().waitForWriteCommand(commandId);
  const onCommitted = vi.fn<() => void>();
  settleEpicTitleWrite(settled, {
    onCommitted,
    source: SETTLEMENT_SOURCE,
  });
  await rig.dispatched;
  return { commandId, settled, onCommitted };
}

function commandById(rig: RenameRig, commandId: string) {
  const command = rig.handle.store
    .getState()
    .writeCommands.find((candidate) => candidate.commandId === commandId);
  if (command === undefined)
    throw new Error("the write command record vanished");
  return command;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(PEERS)("epic title writes answered by the $name", (peer) => {
  it.each(["before", "after"] as const)(
    "settles a matching room echo when it arrives %s the unary answer",
    async (frameOrder) => {
      const rig = await openRenameRig();
      try {
        const rename = await startRename(rig, TARGET_TITLE);
        expect(rig.attempts).toEqual([
          {
            commandId: rename.commandId,
            intent: {
              kind: "update-epic-title",
              title: TARGET_TITLE,
              updatedAt: 2000,
            },
          },
        ]);
        expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);

        let settledRecord: CommandRecord<EpicWriteCommandIntent> | null = null;
        if (frameOrder === "before") {
          await deliverTitleFrame(rig, TARGET_TITLE);
          expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);
          expect(commandById(rig, rename.commandId).state).toBe("pending");
          expect(reportableErrorToast).not.toHaveBeenCalled();
          expect(rename.onCommitted).not.toHaveBeenCalled();

          rig.reply.resolve({ hostId: peer.hostId });
          await drain(rig.handle);
          settledRecord = await rename.settled;
        } else {
          rig.reply.resolve({ hostId: peer.hostId });
          await drain(rig.handle);
          settledRecord = await rename.settled;
          expect(settledRecord.state).toBe("committed");

          await deliverTitleFrame(rig, TARGET_TITLE);
          expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);
        }

        expect(settledRecord.state).toBe("committed");
        const resolution = settledRecord.resolution;
        if (resolution === null || resolution.kind !== "committed") {
          throw new Error(
            `expected committed title write, got ${resolution?.kind ?? "null"}`,
          );
        }
        expect(resolution.hostId).toBe(peer.hostId);
        expect(
          rig.handle.store
            .getState()
            .writeCommands.filter((command) => command.state === "pending"),
        ).toHaveLength(0);
        expect(rename.onCommitted).toHaveBeenCalledTimes(1);
        expect(reportableErrorToast).not.toHaveBeenCalled();
      } finally {
        rig.handle.dispose();
      }
    },
  );
});

describe("epic title write reconciliation", () => {
  it("keeps a different authoritative title superseding the in-flight command", async () => {
    const rig = await openRenameRig();
    try {
      const rename = await startRename(rig, TARGET_TITLE);
      await deliverTitleFrame(rig, EXTERNAL_TITLE);

      const superseded = await rename.settled;
      expect(superseded.state).toBe("superseded");
      expect(rig.handle.store.getState().epic.title).toBe(EXTERNAL_TITLE);
      expect(rename.onCommitted).not.toHaveBeenCalled();
      expect(reportableErrorToast).toHaveBeenCalledWith(
        "Couldn't rename epic.",
        undefined,
        {
          title: "Could not rename Epic",
          message: "A newer authoritative title superseded this rename.",
          code: null,
          source: SETTLEMENT_SOURCE,
        },
      );

      rig.reply.resolve({ hostId: COMPUTER_HOST_ID });
      await drain(rig.handle);

      expect(commandById(rig, rename.commandId).state).toBe("superseded");
      expect(rig.handle.store.getState().epic.title).toBe(EXTERNAL_TITLE);
    } finally {
      rig.handle.dispose();
    }
  });

  it("does not treat a matching room frame as proof when the unary refuses", async () => {
    const rig = await openRenameRig();
    try {
      const rename = await startRename(rig, TARGET_TITLE);
      await deliverTitleFrame(rig, TARGET_TITLE);

      expect(commandById(rig, rename.commandId).state).toBe("pending");
      expect(reportableErrorToast).not.toHaveBeenCalled();

      const refusal: CommandSendFailure = {
        kind: "rejected",
        resolution: {
          kind: "rejected",
          code: "FORBIDDEN",
          reason: "The title update was refused.",
          retryable: false,
        },
      };
      rig.reply.resolve({ failure: refusal });
      await drain(rig.handle);

      const rejected = await rename.settled;
      expect(rejected.state).toBe("rejected");
      const resolution = rejected.resolution;
      if (resolution === null || resolution.kind !== "rejected") {
        throw new Error(
          `expected rejected title write, got ${resolution?.kind ?? "null"}`,
        );
      }
      expect(resolution.code).toBe("FORBIDDEN");
      expect(resolution.reason).toBe("The title update was refused.");
      expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);
      expect(rename.onCommitted).not.toHaveBeenCalled();
      expect(reportableErrorToast).toHaveBeenCalledWith(
        "Couldn't rename epic.",
        undefined,
        {
          title: "Could not rename Epic",
          message: "The title update was refused.",
          code: null,
          source: SETTLEMENT_SOURCE,
        },
      );
    } finally {
      rig.handle.dispose();
    }
  });
});

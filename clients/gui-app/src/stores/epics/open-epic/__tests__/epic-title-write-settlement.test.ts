import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import * as Y from "yjs";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import {
  EPIC_STATE_SUBSCRIBE_METHOD,
  EpicStateStreamClient,
  type EpicStateDeltaFrame,
  type EpicStateSnapshotFrame,
  type EpicStateTrustChangedFrame,
} from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import {
  EPIC_STATUS_SUBSCRIBE_METHOD,
  EpicStatusStreamClient,
  type EpicStatusSnapshotFrame,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import { epicStateSubscribeServerFrameSchemaV16 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeServerFrameSchemaV12 } from "@traycer/protocol/host/epic/status-subscribe";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { EpicLaneSelectionSources } from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import { absentLaneUnaries } from "@/stores/epics/open-epic/test-support/absent-lane-unaries";
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
const COMPUTER_AUTHORITY_EPOCH = "computer-title-authority-1";
const REPLACEMENT_AUTHORITY_EPOCH = "computer-title-authority-2";

const COMPUTER_PEER = [{ name: "computer", hostId: COMPUTER_HOST_ID }] as const;
const POOL_AUTHORITY_EPOCH = "pool-title-authority-1";

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
  readonly replies: Map<string, Deferred<WriteReply>>;
  readonly attemptedCommandIds: Set<string>;
  readonly attemptWaiters: Map<string, Deferred<void>>;
}

interface LaneRenameRig {
  readonly handle: OpenedStoreForTest;
  readonly transport: FakeStreamClient;
  readonly statusSession: FakeStreamClient["sessions"][number];
  readonly stateSession: FakeStreamClient["sessions"][number];
  readonly authorityEpoch: string;
  readonly hostId: string;
  readonly attempts: WriteAttempt[];
  readonly replies: Map<string, Deferred<WriteReply>>;
  readonly attemptedCommandIds: Set<string>;
  readonly attemptWaiters: Map<string, Deferred<void>>;
}

interface RenameCommandRig {
  readonly handle: OpenedStoreForTest;
  readonly attempts: WriteAttempt[];
  readonly replies: Map<string, Deferred<WriteReply>>;
  readonly attemptedCommandIds: Set<string>;
  readonly attemptWaiters: Map<string, Deferred<void>>;
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
  const replies = new Map<string, Deferred<WriteReply>>();
  const attemptedCommandIds = new Set<string>();
  const attemptWaiters = new Map<string, Deferred<void>>();
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
      const reply = deferred<WriteReply>();
      replies.set(commandId, reply);
      attemptedCommandIds.add(commandId);
      attemptWaiters.get(commandId)?.resolve(undefined);
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
    replies,
    attemptedCommandIds,
    attemptWaiters,
  };
}

function laneStatusSnapshot(authorityEpoch: string): EpicStatusSnapshotFrame {
  const frame = epicStatusSubscribeServerFrameSchemaV12.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch,
    securityEpoch: 1,
    permissionRole: "editor",
    cloudSyncStatus: "connected",
    dirty: false,
    durability: "cloud",
    migration: null,
    deletion: { state: "none" },
  });
  if (frame.kind !== "snapshot") {
    throw new Error(`expected a pool status snapshot, got ${frame.kind}`);
  }
  return frame;
}

interface LaneSnapshotInput {
  readonly authorityEpoch: string;
  readonly basis: "cold" | "resumeTooOld" | "authorityEpochChanged";
  readonly position: number;
  readonly title: string;
  readonly updatedAt: number;
  readonly reconciledWithCloud: boolean;
}

interface LaneTitleObservation {
  readonly authorityEpoch: string;
  readonly sequence: number;
  readonly title: string;
  readonly updatedAt: number;
}

function laneStateSnapshot(input: LaneSnapshotInput): EpicStateSnapshotFrame {
  const frame = epicStateSubscribeServerFrameSchemaV16.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: input.authorityEpoch,
    position: input.position,
    basis: input.basis,
    reconciledWithCloud: input.reconciledWithCloud,
    artifactRecords: [],
    deletedArtifacts: [],
    commentThreads: [],
    roleClaims: { revision: 1, claims: [] },
    epicMeta: {
      revision: input.position,
      meta: { title: input.title, updatedAt: input.updatedAt },
    },
  });
  if (frame.kind !== "snapshot") {
    throw new Error(`expected a pool state snapshot, got ${frame.kind}`);
  }
  return frame;
}

function laneTitleDelta(
  authorityEpoch: string,
  sequence: number,
  title: string,
  updatedAt: number,
): EpicStateDeltaFrame {
  const frame = epicStateSubscribeServerFrameSchemaV16.parse({
    kind: "delta",
    hasBinaryPayload: false,
    authorityEpoch,
    seq: sequence,
    artifactUpserts: [],
    artifactTombstones: [],
    commentThreadUpserts: [],
    commentThreadRemovals: [],
    epicMeta: { revision: sequence, meta: { title, updatedAt } },
    roleClaims: null,
  });
  if (frame.kind !== "delta") {
    throw new Error(`expected a pool state delta, got ${frame.kind}`);
  }
  return frame;
}

function laneTimestampOnlyDelta(
  authorityEpoch: string,
  sequence: number,
  updatedAt: number,
): EpicStateDeltaFrame {
  const frame = epicStateSubscribeServerFrameSchemaV16.parse({
    kind: "delta",
    hasBinaryPayload: false,
    authorityEpoch,
    seq: sequence,
    artifactUpserts: [],
    artifactTombstones: [],
    commentThreadUpserts: [],
    commentThreadRemovals: [],
    epicMeta: { revision: sequence, meta: { updatedAt } },
    roleClaims: null,
  });
  if (frame.kind !== "delta") {
    throw new Error(`expected a recency-only state delta, got ${frame.kind}`);
  }
  return frame;
}

function laneTrustChangedFrame(
  authorityEpoch: string,
  reconciledWithCloud: boolean,
): EpicStateTrustChangedFrame {
  const frame = epicStateSubscribeServerFrameSchemaV16.parse({
    kind: "trustChanged",
    hasBinaryPayload: false,
    authorityEpoch,
    reconciledWithCloud,
  });
  if (frame.kind !== "trustChanged") {
    throw new Error(`expected a lane trust change, got ${frame.kind}`);
  }
  return frame;
}

async function openLaneRenameRig(
  hostId: string,
  authorityEpoch: string,
): Promise<LaneRenameRig> {
  const transport = new FakeStreamClient(true);
  const attempts: WriteAttempt[] = [];
  const replies = new Map<string, Deferred<WriteReply>>();
  const attemptedCommandIds = new Set<string>();
  const attemptWaiters = new Map<string, Deferred<void>>();
  const laneSelection: EpicLaneSelectionSources = {
    support: () => "supported",
    subscribeSupport: () => () => undefined,
    unaries: absentLaneUnaries(),
    stateStreamClientFactory: (epicId, callbacks) =>
      new EpicStateStreamClient({
        wsStreamClient: transport,
        epicId,
        callbacks,
        resumeProvider: () => null,
      }),
    statusStreamClientFactory: (epicId, callbacks) =>
      new EpicStatusStreamClient({
        wsStreamClient: transport,
        epicId,
        callbacks,
      }),
    artifactStreamClientFactory: () => ({
      applyUpdate: () => undefined,
      awareness: () => undefined,
      close: () => undefined,
    }),
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: "user-a",
    hostId,
    factories: {
      streamClientFactory: () => {
        throw new Error("the pool runtime must not open the legacy stream");
      },
      laneSelection,
    },
    writeCommand: (commandId, intent) => {
      attempts.push({ commandId, intent });
      const reply = deferred<WriteReply>();
      replies.set(commandId, reply);
      attemptedCommandIds.add(commandId);
      attemptWaiters.get(commandId)?.resolve(undefined);
      return reply.promise;
    },
  });
  const statusIndex = transport.subscribes.findIndex(
    (subscription) => subscription.method === EPIC_STATUS_SUBSCRIBE_METHOD,
  );
  const stateIndex = transport.subscribes.findIndex(
    (subscription) => subscription.method === EPIC_STATE_SUBSCRIBE_METHOD,
  );
  const statusSession = transport.sessions[statusIndex];
  const stateSession = transport.sessions[stateIndex];
  if (statusIndex < 0 || stateIndex < 0) {
    handle.dispose();
    throw new Error("the pool status/state lanes did not subscribe");
  }
  statusSession.negotiatedSchemaVersion = {
    major: 1,
    minor: 1,
  } satisfies SchemaVersion;
  statusSession.emit(laneStatusSnapshot(authorityEpoch), null);
  stateSession.emit(
    laneStateSnapshot({
      authorityEpoch,
      basis: "cold",
      position: 1,
      title: BASE_TITLE,
      updatedAt: 1000,
      reconciledWithCloud: true,
    }),
    null,
  );
  await drain(handle);

  return {
    handle,
    transport,
    statusSession,
    stateSession,
    authorityEpoch,
    hostId,
    attempts,
    replies,
    attemptedCommandIds,
    attemptWaiters,
  };
}

async function deliverLaneTitleFrame(
  rig: LaneRenameRig,
  observation: LaneTitleObservation,
): Promise<void> {
  rig.stateSession.emit(
    laneTitleDelta(
      observation.authorityEpoch,
      observation.sequence,
      observation.title,
      observation.updatedAt,
    ),
    null,
  );
  await drain(rig.handle);
}

async function openPoolRenameRig(): Promise<LaneRenameRig> {
  return openLaneRenameRig(POOL_HOST_ID, POOL_AUTHORITY_EPOCH);
}

async function deliverPoolTitleFrame(
  rig: LaneRenameRig,
  title: string,
): Promise<void> {
  await deliverLaneTitleFrame(rig, {
    authorityEpoch: rig.authorityEpoch,
    sequence: 2,
    title,
    updatedAt: 2000,
  });
}

async function deliverLaneSnapshot(
  rig: LaneRenameRig,
  snapshot: LaneSnapshotInput,
): Promise<void> {
  rig.stateSession.emit(laneStateSnapshot(snapshot), null);
  await drain(rig.handle);
}

async function deliverLaneTrustChange(
  rig: LaneRenameRig,
  authorityEpoch: string,
  reconciledWithCloud: boolean,
): Promise<void> {
  rig.stateSession.emit(
    laneTrustChangedFrame(authorityEpoch, reconciledWithCloud),
    null,
  );
  await drain(rig.handle);
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
  rig: RenameCommandRig,
  title: string,
): Promise<StartedRename> {
  const rename = await enqueueRename(rig, title);
  await waitForAttempt(rig, rename.commandId);
  return rename;
}

async function waitForAttempt(
  rig: RenameCommandRig,
  commandId: string,
): Promise<void> {
  if (rig.attemptedCommandIds.has(commandId)) return;
  let waiter = rig.attemptWaiters.get(commandId);
  if (waiter === undefined) {
    waiter = deferred<void>();
    rig.attemptWaiters.set(commandId, waiter);
  }
  await waiter.promise;
}

async function enqueueRename(
  rig: RenameCommandRig,
  title: string,
): Promise<StartedRename> {
  return enqueueRenameAt(rig, title, 2000);
}

async function enqueueRenameAt(
  rig: RenameCommandRig,
  title: string,
  updatedAt: number,
): Promise<StartedRename> {
  const commandId = await rig.handle.store.getState().enqueueWriteCommand({
    kind: "update-epic-title",
    title,
    updatedAt,
  });
  if (commandId === null)
    throw new Error("expected the title command to enqueue");
  const settled = rig.handle.store.getState().waitForWriteCommand(commandId);
  const onCommitted = vi.fn<() => void>();
  settleEpicTitleWrite(settled, {
    onCommitted,
    source: SETTLEMENT_SOURCE,
  });
  return { commandId, settled, onCommitted };
}

async function startRenameAt(
  rig: RenameCommandRig,
  title: string,
  updatedAt: number,
): Promise<StartedRename> {
  const rename = await enqueueRenameAt(rig, title, updatedAt);
  await waitForAttempt(rig, rename.commandId);
  return rename;
}

function answerWrite(
  rig: RenameCommandRig,
  commandId: string,
  reply: WriteReply,
): void {
  const deferredReply = rig.replies.get(commandId);
  if (deferredReply === undefined) {
    throw new Error(`command ${commandId} has not reached the sender`);
  }
  deferredReply.resolve(reply);
}

function commandById(rig: Pick<RenameCommandRig, "handle">, commandId: string) {
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

describe.each(COMPUTER_PEER)(
  "legacy epic title writes answered by the $name",
  (peer) => {
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

          let settledRecord: CommandRecord<EpicWriteCommandIntent> | null =
            null;
          if (frameOrder === "before") {
            await deliverTitleFrame(rig, TARGET_TITLE);
            expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);
            expect(commandById(rig, rename.commandId).state).toBe("pending");
            expect(reportableErrorToast).not.toHaveBeenCalled();
            expect(rename.onCommitted).not.toHaveBeenCalled();

            answerWrite(rig, rename.commandId, { hostId: peer.hostId });
            await drain(rig.handle);
            settledRecord = await rename.settled;
          } else {
            answerWrite(rig, rename.commandId, { hostId: peer.hostId });
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
  },
);

describe("pool epic title writes through the status/state lanes", () => {
  it.each(["before", "after"] as const)(
    "settles a matching pool state metadata patch when it arrives %s the unary answer",
    async (frameOrder) => {
      const rig = await openPoolRenameRig();
      try {
        expect(rig.handle.hostId).toBe(POOL_HOST_ID);
        expect(
          rig.transport.subscribes.map((subscription) => subscription.method),
        ).toEqual(
          expect.arrayContaining([
            EPIC_STATUS_SUBSCRIBE_METHOD,
            EPIC_STATE_SUBSCRIBE_METHOD,
          ]),
        );
        expect(rig.handle.store.getState().epic.title).toBe(BASE_TITLE);
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
          await deliverPoolTitleFrame(rig, TARGET_TITLE);
          expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);
          expect(rig.handle.store.getState().epic.updatedAt).toBe(2000);
          expect(commandById(rig, rename.commandId).state).toBe("pending");
          expect(reportableErrorToast).not.toHaveBeenCalled();
          expect(rename.onCommitted).not.toHaveBeenCalled();

          answerWrite(rig, rename.commandId, { hostId: POOL_HOST_ID });
          await drain(rig.handle);
          settledRecord = await rename.settled;
        } else {
          answerWrite(rig, rename.commandId, { hostId: POOL_HOST_ID });
          await drain(rig.handle);
          settledRecord = await rename.settled;
          expect(settledRecord.state).toBe("committed");

          await deliverPoolTitleFrame(rig, TARGET_TITLE);
          expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);
          expect(rig.handle.store.getState().epic.updatedAt).toBe(2000);
        }

        expect(settledRecord.state).toBe("committed");
        const resolution = settledRecord.resolution;
        if (resolution === null || resolution.kind !== "committed") {
          throw new Error(
            `expected committed title write, got ${resolution?.kind ?? "null"}`,
          );
        }
        expect(resolution.hostId).toBe(POOL_HOST_ID);
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
  it("keeps a delayed A echo compatible while B settles", async () => {
    const rig = await openRenameRig();
    try {
      const renameA = await startRename(rig, "Rename A");
      const renameB = await enqueueRename(rig, "Rename B");
      expect(rig.attempts.map((attempt) => attempt.commandId)).toEqual([
        renameA.commandId,
      ]);

      await deliverTitleFrame(rig, "Rename A");
      answerWrite(rig, renameA.commandId, { hostId: COMPUTER_HOST_ID });
      await drain(rig.handle);
      expect((await renameA.settled).state).toBe("committed");

      await drain(rig.handle);
      expect(rig.attempts.map((attempt) => attempt.commandId)).toEqual([
        renameA.commandId,
        renameB.commandId,
      ]);
      answerWrite(rig, renameB.commandId, { hostId: COMPUTER_HOST_ID });
      await drain(rig.handle);
      expect((await renameB.settled).state).toBe("committed");
      expect(rig.handle.store.getState().epic.title).toBe("Rename B");
      expect(reportableErrorToast).not.toHaveBeenCalled();

      await deliverTitleFrame(rig, "Rename B");
      expect(rig.handle.store.getState().epic.title).toBe("Rename B");
      expect(commandById(rig, renameB.commandId).state).toBe("committed");
      expect(
        rig.handle.store
          .getState()
          .writeCommands.filter((command) => command.state === "pending"),
      ).toHaveLength(0);
      expect(reportableErrorToast).not.toHaveBeenCalled();
    } finally {
      rig.handle.dispose();
    }
  });

  it("retains A's authoritative anchor after its refusal and sends B", async () => {
    const rig = await openRenameRig();
    try {
      const renameA = await startRename(rig, "Rename A");
      const renameB = await enqueueRename(rig, "Rename B");
      await deliverTitleFrame(rig, "Rename A");

      answerWrite(rig, renameA.commandId, {
        failure: {
          kind: "rejected",
          resolution: {
            kind: "rejected",
            code: "FORBIDDEN",
            reason: "A was refused.",
            retryable: false,
          },
        },
      });
      await drain(rig.handle);
      expect((await renameA.settled).state).toBe("rejected");
      expect(rig.attempts.map((attempt) => attempt.commandId)).toEqual([
        renameA.commandId,
        renameB.commandId,
      ]);
      expect(reportableErrorToast).toHaveBeenCalledTimes(1);

      answerWrite(rig, renameB.commandId, { hostId: COMPUTER_HOST_ID });
      await drain(rig.handle);
      expect((await renameB.settled).state).toBe("committed");
      await deliverTitleFrame(rig, "Rename B");

      expect(rig.handle.store.getState().epic.title).toBe("Rename B");
      expect(commandById(rig, renameB.commandId).state).toBe("committed");
      expect(reportableErrorToast).toHaveBeenCalledTimes(1);
    } finally {
      rig.handle.dispose();
    }
  });

  it("keeps a refused A echo compatible when its first frame arrives during B", async () => {
    const rig = await openRenameRig();
    try {
      const renameA = await startRename(rig, "Rename A");
      const renameB = await enqueueRename(rig, "Rename B");
      answerWrite(rig, renameA.commandId, {
        failure: {
          kind: "rejected",
          resolution: {
            kind: "rejected",
            code: "FORBIDDEN",
            reason: "A was refused.",
            retryable: false,
          },
        },
      });
      await drain(rig.handle);
      expect((await renameA.settled).state).toBe("rejected");
      expect(rig.attempts.map((attempt) => attempt.commandId)).toEqual([
        renameA.commandId,
        renameB.commandId,
      ]);

      await deliverTitleFrame(rig, "Rename A");
      expect(commandById(rig, renameB.commandId).state).toBe("pending");
      expect(rig.handle.store.getState().epic.title).toBe("Rename B");
      expect(reportableErrorToast).toHaveBeenCalledTimes(1);

      answerWrite(rig, renameB.commandId, { hostId: COMPUTER_HOST_ID });
      await drain(rig.handle);
      await deliverTitleFrame(rig, "Rename B");
      expect((await renameB.settled).state).toBe("committed");
      expect(rig.handle.store.getState().epic.title).toBe("Rename B");
      expect(reportableErrorToast).toHaveBeenCalledTimes(1);
    } finally {
      rig.handle.dispose();
    }
  });

  it("treats a fresh return to A after the room advanced to B as supersession", async () => {
    const rig = await openRenameRig();
    try {
      const renameA = await startRename(rig, "Rename A");
      const renameB = await enqueueRename(rig, "Rename B");
      const renameC = await enqueueRename(rig, "Rename C");
      answerWrite(rig, renameA.commandId, { hostId: COMPUTER_HOST_ID });
      await drain(rig.handle);
      expect((await renameA.settled).state).toBe("committed");
      expect(commandById(rig, renameB.commandId).delivery).toBe("sending");

      answerWrite(rig, renameB.commandId, { hostId: COMPUTER_HOST_ID });
      await drain(rig.handle);
      expect((await renameB.settled).state).toBe("committed");
      expect(commandById(rig, renameC.commandId).delivery).toBe("sending");

      // A and B were eligible, but B arrived first and made A obsolete.
      await deliverTitleFrame(rig, "Rename B");
      expect(commandById(rig, renameC.commandId).state).toBe("pending");
      await deliverTitleFrame(rig, "Rename A");
      expect(commandById(rig, renameC.commandId).state).toBe("superseded");
      expect(rig.handle.store.getState().epic.title).toBe("Rename A");

      answerWrite(rig, renameC.commandId, { hostId: COMPUTER_HOST_ID });
      await drain(rig.handle);
      expect(commandById(rig, renameC.commandId).state).toBe("superseded");
    } finally {
      rig.handle.dispose();
    }
  });

  it("does not reconcile an ambiguous rename from the old baseline alone", async () => {
    const rig = await openRenameRig();
    try {
      const renameA = await startRename(rig, "Rename A");
      answerWrite(rig, renameA.commandId, { hostId: COMPUTER_HOST_ID });
      await drain(rig.handle);
      expect((await renameA.settled).state).toBe("committed");
      expect(rig.handle.store.getState().epic.title).toBe("Rename A");

      const renameBack = await startRename(rig, BASE_TITLE);
      expect(rig.handle.store.getState().epic.title).toBe(BASE_TITLE);
      answerWrite(rig, renameBack.commandId, {
        failure: { kind: "unknown-outcome", reason: "response was lost" },
      });
      await drain(rig.handle);

      const unresolved = commandById(rig, renameBack.commandId);
      expect(unresolved.state).toBe("pending");
      expect(unresolved.delivery).toBe("unknown-outcome");
      expect(rig.handle.store.getState().epic.title).toBe(BASE_TITLE);
      expect(reportableErrorToast).not.toHaveBeenCalled();
    } finally {
      rig.handle.dispose();
    }
  });

  it.each([
    ["frame first, alone", "before", false],
    ["unknown first, alone", "after", false],
    ["frame first, with sibling", "before", true],
    ["unknown first, with sibling", "after", true],
  ] as const)(
    "reconciles an unknown A only from its eligible echo (%s)",
    async (_label, frameOrder, hasSibling) => {
      const rig = await openRenameRig();
      try {
        const renameA = await startRename(rig, "Rename A");
        const renameB = hasSibling
          ? await enqueueRename(rig, "Rename B")
          : null;
        if (frameOrder === "before") {
          await deliverTitleFrame(rig, "Rename A");
          expect(commandById(rig, renameA.commandId).state).toBe("pending");
          answerWrite(rig, renameA.commandId, {
            failure: { kind: "unknown-outcome", reason: "response was lost" },
          });
        } else {
          answerWrite(rig, renameA.commandId, {
            failure: { kind: "unknown-outcome", reason: "response was lost" },
          });
          await drain(rig.handle);
          expect(commandById(rig, renameA.commandId).delivery).toBe(
            "unknown-outcome",
          );
          await deliverTitleFrame(rig, "Rename A");
        }
        await drain(rig.handle);

        expect(commandById(rig, renameA.commandId).state).toBe("committed");
        expect((await renameA.settled).state).toBe("committed");
        expect(rig.attempts.map((attempt) => attempt.commandId)).toEqual(
          hasSibling
            ? [renameA.commandId, renameB?.commandId]
            : [renameA.commandId],
        );
        expect(reportableErrorToast).not.toHaveBeenCalled();

        if (renameB !== null) {
          answerWrite(rig, renameB.commandId, { hostId: COMPUTER_HOST_ID });
          await drain(rig.handle);
          expect((await renameB.settled).state).toBe("committed");
          await deliverTitleFrame(rig, "Rename B");
          expect(commandById(rig, renameB.commandId).state).toBe("committed");
          expect(rig.handle.store.getState().epic.title).toBe("Rename B");
        } else {
          expect(rig.handle.store.getState().epic.title).toBe("Rename A");
        }
        expect(
          rig.handle.store
            .getState()
            .writeCommands.filter((command) => command.state === "pending"),
        ).toHaveLength(0);
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it.each([false, true] as const)(
    "only treats a retryable title attempt as echo evidence when it may have reached the host (%s)",
    async (mayHaveReachedHost) => {
      const rig = await openRenameRig();
      try {
        const rename = await startRename(rig, "Rename A");
        answerWrite(rig, rename.commandId, {
          failure: {
            kind: "queued",
            reason: "temporary transport refusal",
            boundedRetry: false,
            retryAfterMs: null,
            mayHaveReachedHost,
          },
        });
        await drain(rig.handle);
        expect(commandById(rig, rename.commandId).delivery).toBe("queued");

        await deliverTitleFrame(rig, "Rename A");
        const record = commandById(rig, rename.commandId);
        if (mayHaveReachedHost) {
          expect(record.state).toBe("pending");
          expect(record.delivery).toBe("queued");
          expect(rig.handle.store.getState().epic.title).toBe("Rename A");
          expect(reportableErrorToast).not.toHaveBeenCalled();
        } else {
          expect(record.state).toBe("superseded");
          expect(rig.handle.store.getState().epic.title).toBe("Rename A");
          expect(reportableErrorToast).toHaveBeenCalledTimes(1);
        }
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it("rechecks a provisional echo after the sender proves the attempt was not dispatched", async () => {
    const rig = await openRenameRig();
    try {
      const rename = await startRename(rig, "Rename A");
      await deliverTitleFrame(rig, "Rename A");
      expect(commandById(rig, rename.commandId).delivery).toBe("sending");

      answerWrite(rig, rename.commandId, {
        failure: {
          kind: "queued",
          reason: "temporary transport refusal",
          boundedRetry: false,
          retryAfterMs: null,
          mayHaveReachedHost: false,
        },
      });
      await drain(rig.handle);
      expect(commandById(rig, rename.commandId).state).toBe("superseded");
      expect(rig.handle.store.getState().epic.title).toBe("Rename A");
    } finally {
      rig.handle.dispose();
    }
  });

  it("treats a room title matching only the never-sent queued sibling as a different writer", async () => {
    const rig = await openRenameRig();
    try {
      const renameA = await startRename(rig, "Rename A");
      const renameB = await enqueueRename(rig, "Rename B");
      await deliverTitleFrame(rig, "Rename B");

      expect(commandById(rig, renameA.commandId).state).toBe("superseded");
      expect(commandById(rig, renameB.commandId).state).toBe("superseded");
      expect(rig.attempts.map((attempt) => attempt.commandId)).toEqual([
        renameA.commandId,
      ]);
      expect(rig.handle.store.getState().epic.title).toBe("Rename B");
    } finally {
      rig.handle.dispose();
    }
  });

  it("keeps a different authoritative title superseding the in-flight command", async () => {
    const rig = await openRenameRig();
    try {
      const rename = await startRename(rig, TARGET_TITLE);
      await deliverTitleFrame(rig, EXTERNAL_TITLE);

      expect(commandById(rig, rename.commandId).state).toBe("superseded");
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

      answerWrite(rig, rename.commandId, { hostId: COMPUTER_HOST_ID });
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
      answerWrite(rig, rename.commandId, { failure: refusal });
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

describe("amended title echo evidence through state lanes", () => {
  it("keeps the committed anchor and pending sibling across a same-authority reseed", async () => {
    const rig = await openLaneRenameRig(
      COMPUTER_HOST_ID,
      COMPUTER_AUTHORITY_EPOCH,
    );
    try {
      const renameA = await startRenameAt(rig, "Rename A", 6101);
      await deliverLaneTitleFrame(rig, {
        authorityEpoch: COMPUTER_AUTHORITY_EPOCH,
        sequence: 2,
        title: "Rename A",
        updatedAt: 6101,
      });
      expect(commandById(rig, renameA.commandId).state).toBe("pending");
      const renameB = await enqueueRenameAt(rig, "Rename B", 6102);
      expect(commandById(rig, renameB.commandId).delivery).toBe("queued");
      answerWrite(rig, renameA.commandId, { hostId: COMPUTER_HOST_ID });
      await drain(rig.handle);
      expect((await renameA.settled).state).toBe("committed");
      await waitForAttempt(rig, renameB.commandId);
      expect(commandById(rig, renameA.commandId).state).toBe("committed");
      expect(commandById(rig, renameB.commandId).delivery).toBe("sending");

      // This same-authority snapshot is seed-only and conflicts with the
      // committed anchor. It cannot supersede the in-flight sibling.
      await deliverLaneSnapshot(rig, {
        authorityEpoch: COMPUTER_AUTHORITY_EPOCH,
        basis: "resumeTooOld",
        position: 3,
        title: EXTERNAL_TITLE,
        updatedAt: 6200,
        reconciledWithCloud: false,
      });
      expect(commandById(rig, renameB.commandId).state).toBe("pending");
      expect(commandById(rig, renameB.commandId).delivery).toBe("sending");

      // A missing title (recency-only) and an empty title cannot settle B.
      rig.stateSession.emit(
        laneTimestampOnlyDelta(COMPUTER_AUTHORITY_EPOCH, 4, 6102),
        null,
      );
      await drain(rig.handle);
      await deliverLaneTitleFrame(rig, {
        authorityEpoch: COMPUTER_AUTHORITY_EPOCH,
        sequence: 5,
        title: "",
        updatedAt: 6102,
      });
      expect(commandById(rig, renameB.commandId).state).toBe("pending");
      expect(commandById(rig, renameB.commandId).delivery).toBe("sending");

      // The first trusted observation after the seed-only interval restores
      // the prior anchor; B remains the only live title intent.
      await deliverLaneTitleFrame(rig, {
        authorityEpoch: COMPUTER_AUTHORITY_EPOCH,
        sequence: 6,
        title: "Rename A",
        updatedAt: 6101,
      });
      await deliverLaneTrustChange(rig, COMPUTER_AUTHORITY_EPOCH, true);
      expect(commandById(rig, renameB.commandId).state).toBe("pending");

      answerWrite(rig, renameB.commandId, { hostId: COMPUTER_HOST_ID });
      await drain(rig.handle);
      expect((await renameB.settled).state).toBe("committed");
      await deliverLaneTitleFrame(rig, {
        authorityEpoch: COMPUTER_AUTHORITY_EPOCH,
        sequence: 7,
        title: "Rename B",
        updatedAt: 6102,
      });

      expect(rig.handle.store.getState().epic.title).toBe("Rename B");
      expect(commandById(rig, renameA.commandId).state).toBe("committed");
      expect(commandById(rig, renameB.commandId).state).toBe("committed");
      expect(
        rig.handle.store
          .getState()
          .writeCommands.filter((command) => command.state === "pending"),
      ).toHaveLength(0);
      expect(reportableErrorToast).not.toHaveBeenCalled();
    } finally {
      rig.handle.dispose();
    }
  });

  it("does not carry an ambiguous echo across a real authority replacement", async () => {
    const rig = await openLaneRenameRig(
      COMPUTER_HOST_ID,
      COMPUTER_AUTHORITY_EPOCH,
    );
    try {
      const rename = await startRenameAt(rig, "Rename A", 7101);
      answerWrite(rig, rename.commandId, {
        failure: { kind: "unknown-outcome", reason: "response was lost" },
      });
      await drain(rig.handle);
      expect(commandById(rig, rename.commandId).delivery).toBe(
        "unknown-outcome",
      );

      rig.statusSession.emit(
        laneStatusSnapshot(REPLACEMENT_AUTHORITY_EPOCH),
        null,
      );
      await drain(rig.handle);
      await deliverLaneSnapshot(rig, {
        authorityEpoch: REPLACEMENT_AUTHORITY_EPOCH,
        basis: "authorityEpochChanged",
        position: 1,
        title: "Rename A",
        updatedAt: 7101,
        reconciledWithCloud: true,
      });

      expect(commandById(rig, rename.commandId).state).not.toBe("committed");
      expect(rename.onCommitted).not.toHaveBeenCalled();
      expect(rig.handle.store.getState().epic.title).toBe("Rename A");
    } finally {
      rig.handle.dispose();
    }
  });

  it("uses a fresh Alpha row with C's timestamp to reconcile C and release D", async () => {
    const rig = await openPoolRenameRig();
    try {
      const renameA = await startRenameAt(rig, "Alpha", 8101);
      answerWrite(rig, renameA.commandId, { hostId: POOL_HOST_ID });
      await drain(rig.handle);
      expect((await renameA.settled).state).toBe("committed");

      const renameB = await startRenameAt(rig, "Beta", 8102);
      answerWrite(rig, renameB.commandId, { hostId: POOL_HOST_ID });
      await drain(rig.handle);
      expect((await renameB.settled).state).toBe("committed");

      const renameC = await startRenameAt(rig, "Alpha", 8103);
      const renameD = await enqueueRenameAt(rig, "Delta", 8104);
      answerWrite(rig, renameC.commandId, {
        failure: { kind: "unknown-outcome", reason: "response was lost" },
      });
      await drain(rig.handle);
      await deliverLaneTitleFrame(rig, {
        authorityEpoch: rig.authorityEpoch,
        sequence: 2,
        title: "Alpha",
        updatedAt: 8103,
      });

      expect(commandById(rig, renameC.commandId).state).toBe("committed");
      expect((await renameC.settled).state).toBe("committed");
      await waitForAttempt(rig, renameD.commandId);
      expect(rig.attempts.map((attempt) => attempt.commandId)).toEqual([
        renameA.commandId,
        renameB.commandId,
        renameC.commandId,
        renameD.commandId,
      ]);

      answerWrite(rig, renameD.commandId, { hostId: POOL_HOST_ID });
      await drain(rig.handle);
      expect((await renameD.settled).state).toBe("committed");
      await deliverLaneTitleFrame(rig, {
        authorityEpoch: rig.authorityEpoch,
        sequence: 3,
        title: "Delta",
        updatedAt: 8104,
      });
      expect(rig.handle.store.getState().epic.title).toBe("Delta");
      expect(commandById(rig, renameA.commandId).state).toBe("committed");
      expect(commandById(rig, renameB.commandId).state).toBe("committed");
      expect(commandById(rig, renameC.commandId).state).toBe("committed");
      expect(commandById(rig, renameD.commandId).state).toBe("committed");
      expect(reportableErrorToast).not.toHaveBeenCalled();
    } finally {
      rig.handle.dispose();
    }
  });

  it("leaves C ambiguous when a delayed A echo is distinguishable from C", async () => {
    const rig = await openPoolRenameRig();
    try {
      const renameA = await startRenameAt(rig, "Alpha", 9101);
      answerWrite(rig, renameA.commandId, { hostId: POOL_HOST_ID });
      await drain(rig.handle);
      expect((await renameA.settled).state).toBe("committed");

      const renameB = await startRenameAt(rig, "Beta", 9102);
      answerWrite(rig, renameB.commandId, { hostId: POOL_HOST_ID });
      await drain(rig.handle);
      expect((await renameB.settled).state).toBe("committed");

      const renameC = await startRenameAt(rig, "Alpha", 9103);
      const renameD = await enqueueRenameAt(rig, "Delta", 9104);
      answerWrite(rig, renameC.commandId, {
        failure: { kind: "unknown-outcome", reason: "response was lost" },
      });
      await drain(rig.handle);
      await deliverLaneTitleFrame(rig, {
        authorityEpoch: rig.authorityEpoch,
        sequence: 2,
        title: "Alpha",
        updatedAt: 9101,
      });

      expect(commandById(rig, renameA.commandId).state).toBe("committed");
      expect(commandById(rig, renameC.commandId).state).toBe("pending");
      expect(commandById(rig, renameC.commandId).delivery).toBe(
        "unknown-outcome",
      );
      expect(commandById(rig, renameD.commandId).delivery).toBe("queued");
      rig.stateSession.emit(
        laneTimestampOnlyDelta(rig.authorityEpoch, 3, 9103),
        null,
      );
      await drain(rig.handle);
      expect(commandById(rig, renameC.commandId).state).toBe("pending");
      expect(commandById(rig, renameC.commandId).delivery).toBe(
        "unknown-outcome",
      );
      expect(commandById(rig, renameD.commandId).delivery).toBe("queued");
      expect(rig.attempts.map((attempt) => attempt.commandId)).toEqual([
        renameA.commandId,
        renameB.commandId,
        renameC.commandId,
      ]);
    } finally {
      rig.handle.dispose();
    }
  });

  it("keeps C ambiguous when Alpha's timestamp collides between A and C", async () => {
    const rig = await openPoolRenameRig();
    try {
      const renameA = await startRenameAt(rig, "Alpha", 10101);
      answerWrite(rig, renameA.commandId, { hostId: POOL_HOST_ID });
      await drain(rig.handle);
      expect((await renameA.settled).state).toBe("committed");

      const renameB = await startRenameAt(rig, "Beta", 10102);
      answerWrite(rig, renameB.commandId, { hostId: POOL_HOST_ID });
      await drain(rig.handle);
      expect((await renameB.settled).state).toBe("committed");

      const renameC = await startRenameAt(rig, "Alpha", 10101);
      const renameD = await enqueueRenameAt(rig, "Delta", 10104);
      answerWrite(rig, renameC.commandId, {
        failure: { kind: "unknown-outcome", reason: "response was lost" },
      });
      await drain(rig.handle);
      await deliverLaneTitleFrame(rig, {
        authorityEpoch: rig.authorityEpoch,
        sequence: 2,
        title: "Alpha",
        updatedAt: 10101,
      });

      expect(commandById(rig, renameC.commandId).state).toBe("pending");
      expect(commandById(rig, renameC.commandId).delivery).toBe(
        "unknown-outcome",
      );
      expect(commandById(rig, renameD.commandId).delivery).toBe("queued");
      expect(rig.attempts.map((attempt) => attempt.commandId)).toEqual([
        renameA.commandId,
        renameB.commandId,
        renameC.commandId,
      ]);
    } finally {
      rig.handle.dispose();
    }
  });

  it("keeps the pool post-answer B echo pending until B's unary answers", async () => {
    const rig = await openPoolRenameRig();
    try {
      expect(rig.handle.hostId).toBe(POOL_HOST_ID);
      const renameA = await startRenameAt(rig, "Rename A", 11101);
      await deliverLaneTitleFrame(rig, {
        authorityEpoch: rig.authorityEpoch,
        sequence: 2,
        title: "Rename A",
        updatedAt: 11101,
      });
      expect(commandById(rig, renameA.commandId).state).toBe("pending");
      answerWrite(rig, renameA.commandId, { hostId: POOL_HOST_ID });
      await drain(rig.handle);
      expect((await renameA.settled).state).toBe("committed");
      expect(commandById(rig, renameA.commandId).state).toBe("committed");

      const renameB = await startRenameAt(rig, "Rename B", 11102);
      expect(rig.attempts.map((attempt) => attempt.commandId)).toEqual([
        renameA.commandId,
        renameB.commandId,
      ]);
      await deliverLaneTitleFrame(rig, {
        authorityEpoch: rig.authorityEpoch,
        sequence: 3,
        title: "Rename B",
        updatedAt: 11102,
      });
      expect(commandById(rig, renameB.commandId).state).toBe("pending");
      expect(commandById(rig, renameB.commandId).delivery).toBe("sending");
      expect(rig.handle.store.getState().epic.title).toBe("Rename B");
      expect(reportableErrorToast).not.toHaveBeenCalled();

      answerWrite(rig, renameB.commandId, { hostId: POOL_HOST_ID });
      await drain(rig.handle);
      expect((await renameB.settled).state).toBe("committed");
      expect(commandById(rig, renameA.commandId).state).toBe("committed");
      expect(commandById(rig, renameB.commandId).state).toBe("committed");
      expect(rig.handle.store.getState().epic.title).toBe("Rename B");
      expect(reportableErrorToast).not.toHaveBeenCalled();
    } finally {
      rig.handle.dispose();
    }
  });
});

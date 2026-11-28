import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { epicStateSubscribeServerFrameSchemaV16 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/status-subscribe";
import type {
  EpicArtifactRecord,
  EpicDeletedArtifactRecord,
} from "@traycer/protocol/host/epic/state-subscribe";
import type { TicketStatus } from "@traycer/protocol/common/registry";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import {
  EPIC_STATE_SUBSCRIBE_METHOD,
  EpicStateStreamClient,
} from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import {
  EPIC_STATUS_SUBSCRIBE_METHOD,
  EpicStatusStreamClient,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type {
  CommandRecord,
  CommandSendFailure,
} from "@traycer-clients/shared/replica-runtime";
import type { EpicLaneUnaries } from "../runtime/epic-replica-runtime";
import type { EpicWriteCommandIntent } from "../runtime/epic-write-command";
import {
  deriveEpicWriteCommandAlert,
  summarizeEpicWriteCommands,
} from "@/lib/epic-sync-pill-state";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { settleEpicTitleWrite } from "@/lib/epic-title-write-settlement";
import {
  openStoreForTestAtHost,
  type OpenedStoreForTest,
} from "../test-support/open-store-for-test";
import { absentLaneUnaries } from "../test-support/absent-lane-unaries";
import {
  ensureMap,
  getEpicMap,
} from "@/stores/epics/open-epic/projection-helpers";
import { createArtifactInDocForTests } from "./projection-helpers-test-shims";

vi.mock("@/lib/reportable-error-toast", () => ({
  reportableErrorToast: vi.fn(),
}));

const EPIC_ID = "minimal-rename-hold-epic";
const POOL_HOST = POOL_HOST_ID;
const COMPUTER_HOST = "rename-hold-computer";
const INITIAL_EPOCH = "rename-hold-epoch-1";
const REPLACEMENT_EPOCH = "rename-hold-epoch-2";
const INITIAL_TITLE = "Alpha";
const TARGET_TITLE = "Beta";
const SUCCESSOR_TITLE = "Gamma";
const THIRD_TITLE = "Delta";

type WriteReply = { readonly hostId: string } | CommandSendFailure;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface SentWrite {
  readonly commandId: string;
  readonly intent: EpicWriteCommandIntent;
  readonly resolve: (reply: WriteReply) => void;
  readonly completion: Promise<WriteReply>;
  readonly commandStatesAtDispatch: ReadonlyMap<string, string>;
}

interface RenameRig {
  readonly handle: OpenedStoreForTest;
  readonly dispatches: SentWrite[];
  readonly nextDispatch: () => Promise<SentWrite>;
  readonly emitArtifactChanges: (
    upserts: readonly EpicArtifactRecord[],
    tombstones: readonly EpicDeletedArtifactRecord[],
    sequence: number,
  ) => Promise<void>;
  readonly emitTitle: (
    title: string,
    updatedAt: number,
    sequence: number,
  ) => Promise<void>;
  readonly emitReplacement: (title: string) => Promise<void>;
  readonly emitArtifactReplacement: (
    artifacts: readonly EpicArtifactRecord[],
  ) => Promise<void>;
  readonly emitResumeTooOld: (title: string) => Promise<void>;
  readonly emitStatusAuthority: (authorityEpoch: string) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("deferred answer was resolved before initialization");
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value) };
}

function makeRig(hostId: string): RenameRig {
  const transport = new FakeStreamClient(true);
  const waitingDispatches: Array<(write: SentWrite) => void> = [];
  const availableDispatches: SentWrite[] = [];
  const dispatches: SentWrite[] = [];
  let commandStatesAtDispatch = (): ReadonlyMap<string, string> => new Map();
  const laneUnaries: EpicLaneUnaries = absentLaneUnaries();

  const stateStreamClientFactory = (
    epicId: string,
    callbacks: ConstructorParameters<
      typeof EpicStateStreamClient
    >[0]["callbacks"],
    resumeProvider: ConstructorParameters<
      typeof EpicStateStreamClient
    >[0]["resumeProvider"],
  ) =>
    new EpicStateStreamClient({
      wsStreamClient: transport,
      epicId,
      callbacks,
      resumeProvider,
    });
  const statusStreamClientFactory = (
    epicId: string,
    callbacks: ConstructorParameters<
      typeof EpicStatusStreamClient
    >[0]["callbacks"],
  ) =>
    new EpicStatusStreamClient({
      wsStreamClient: transport,
      epicId,
      callbacks,
    });
  const statusIndex = (): number =>
    transport.subscribes.findIndex(
      (entry) => entry.method === EPIC_STATUS_SUBSCRIBE_METHOD,
    );
  const stateIndex = (): number =>
    transport.subscribes.findLastIndex(
      (entry) => entry.method === EPIC_STATE_SUBSCRIBE_METHOD,
    );
  const statusSession = () => {
    const index = statusIndex();
    const session = transport.sessions.at(index);
    if (index < 0 || session === undefined) {
      throw new Error("the actual status lane session was not opened");
    }
    return session;
  };
  const stateSession = () => {
    const index = stateIndex();
    const session = transport.sessions.at(index);
    if (index < 0 || session === undefined) {
      throw new Error("the actual state lane session was not opened");
    }
    return session;
  };

  const handle = openStoreForTestAtHost(
    {
      epicId: EPIC_ID,
      userId: null,
      factories: {
        streamClientFactory: () => {
          throw new Error("the legacy stream must not open for a lane session");
        },
        laneSelection: {
          support: () => "supported",
          subscribeSupport: () => () => {},
          unaries: laneUnaries,
          stateStreamClientFactory,
          statusStreamClientFactory,
          artifactStreamClientFactory: () => ({
            applyUpdate: () => undefined,
            awareness: () => undefined,
            close: () => undefined,
          }),
        },
      },
      writeCommand: (commandId, intent) => {
        const answer = deferred<WriteReply>();
        const sent: SentWrite = {
          commandId,
          intent,
          resolve: answer.resolve,
          completion: answer.promise,
          commandStatesAtDispatch: commandStatesAtDispatch(),
        };
        dispatches.push(sent);
        const waiter = waitingDispatches.shift();
        if (waiter === undefined) availableDispatches.push(sent);
        else waiter(sent);
        return answer.promise;
      },
    },
    hostId,
  );

  const nextDispatch = (): Promise<SentWrite> => {
    const available = availableDispatches.shift();
    if (available !== undefined) return Promise.resolve(available);
    return new Promise((resolve) => waitingDispatches.push(resolve));
  };

  commandStatesAtDispatch = () => {
    const states = new Map<string, string>();
    for (const record of handle.store.getState().writeCommands) {
      states.set(record.commandId, record.state);
    }
    return states;
  };

  function emitStatusAuthority(authorityEpoch: string): void {
    const parsed = epicStatusSubscribeServerFrameSchemaV11.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      authorityEpoch,
      securityEpoch: authorityEpoch === INITIAL_EPOCH ? 1 : 2,
      permissionRole: "editor",
      cloudSyncStatus: "connected",
      dirty: false,
      migration: null,
      deletion: { state: "none" },
    });
    statusSession().emit(parsed, null);
  }

  async function emitReplacementSnapshot(
    title: string,
    artifacts: readonly EpicArtifactRecord[],
  ): Promise<void> {
    emitStatusAuthority(REPLACEMENT_EPOCH);
    await drain(handle);
    const parsed = epicStateSubscribeServerFrameSchemaV16.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      authorityEpoch: REPLACEMENT_EPOCH,
      basis: "authorityEpochChanged",
      position: 1,
      reconciledWithCloud: true,
      epicMeta: { revision: 1, meta: { title, updatedAt: 3000 } },
      artifactRecords: [...artifacts],
      deletedArtifacts: [],
      roleClaims: { revision: 1, claims: [] },
      commentThreads: [],
    });
    stateSession().emit(parsed, null);
    await drain(handle);
  }

  async function emitReplacement(title: string): Promise<void> {
    await emitReplacementSnapshot(title, []);
  }

  async function emitArtifactReplacement(
    artifacts: readonly EpicArtifactRecord[],
  ): Promise<void> {
    await emitReplacementSnapshot(INITIAL_TITLE, artifacts);
  }

  async function emitResumeTooOld(title: string): Promise<void> {
    const parsed = epicStateSubscribeServerFrameSchemaV16.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      authorityEpoch: INITIAL_EPOCH,
      basis: "resumeTooOld",
      position: 1,
      reconciledWithCloud: true,
      epicMeta: { revision: 1, meta: { title, updatedAt: 4000 } },
      artifactRecords: [],
      deletedArtifacts: [],
      roleClaims: { revision: 1, claims: [] },
      commentThreads: [],
    });
    stateSession().emit(parsed, null);
    await drain(handle);
  }

  const emitTitle = async (
    title: string,
    updatedAt: number,
    sequence: number,
  ): Promise<void> => {
    const parsed = epicStateSubscribeServerFrameSchemaV16.parse({
      kind: "delta",
      hasBinaryPayload: false,
      authorityEpoch: INITIAL_EPOCH,
      seq: sequence,
      artifactUpserts: [],
      artifactTombstones: [],
      commentThreadUpserts: [],
      commentThreadRemovals: [],
      epicMeta: { revision: sequence, meta: { title, updatedAt } },
      roleClaims: null,
    });
    stateSession().emit(parsed, null);
    await drain(handle);
  };

  async function emitArtifactChanges(
    upserts: readonly EpicArtifactRecord[],
    tombstones: readonly EpicDeletedArtifactRecord[],
    sequence: number,
  ): Promise<void> {
    const parsed = epicStateSubscribeServerFrameSchemaV16.parse({
      kind: "delta",
      hasBinaryPayload: false,
      authorityEpoch: INITIAL_EPOCH,
      seq: sequence,
      artifactUpserts: [...upserts],
      artifactTombstones: [...tombstones],
      commentThreadUpserts: [],
      commentThreadRemovals: [],
      epicMeta: null,
      roleClaims: null,
    });
    if (parsed.kind !== "delta") {
      throw new Error("expected an artifact state delta");
    }
    stateSession().emit(parsed, null);
    await drain(handle);
  }

  emitStatusAuthority(INITIAL_EPOCH);
  const initial = epicStateSubscribeServerFrameSchemaV16.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch: INITIAL_EPOCH,
    basis: "cold",
    position: 1,
    reconciledWithCloud: true,
    epicMeta: {
      revision: 1,
      meta: { title: INITIAL_TITLE, updatedAt: 1000 },
    },
    artifactRecords: [],
    deletedArtifacts: [],
    roleClaims: { revision: 1, claims: [] },
    commentThreads: [],
  });
  stateSession().emit(initial, null);

  return {
    handle,
    dispatches,
    nextDispatch,
    emitArtifactChanges,
    emitTitle,
    emitReplacement,
    emitArtifactReplacement,
    emitResumeTooOld,
    emitStatusAuthority,
  };
}

interface LegacyDeleteRig {
  readonly handle: OpenedStoreForTest;
  readonly artifactId: string;
  readonly dispatched: Promise<SentWrite>;
  readonly emitRemoteRemoval: () => void;
  readonly emitRemoteReappearance: () => void;
}

function legacySnapshotMeta(doc: Y.Doc): SnapshotMetaEpic {
  const stateVector = Y.encodeStateVector(doc);
  const hostStateVectorBase64 = btoa(String.fromCharCode(...stateVector));
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: INITIAL_TITLE,
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 1,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "test-user",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64,
  };
}

function makeLegacyDeleteRig(): LegacyDeleteRig {
  const remoteDoc = new Y.Doc();
  const artifactId = createArtifactInDocForTests(remoteDoc, "spec", null);
  const artifacts = ensureMap(getEpicMap(remoteDoc), "artifacts");
  const originalArtifact = artifacts.get(artifactId);
  if (!(originalArtifact instanceof Y.Map)) {
    throw new Error("the producer fixture did not create a spec artifact");
  }

  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const dispatched = deferred<SentWrite>();
  let handle: OpenedStoreForTest | null = null;
  const streamClientFactory = (
    _epicId: string,
    callbacks: EpicStreamCallbacks,
  ) => {
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
  handle = openStoreForTestAtHost(
    {
      epicId: EPIC_ID,
      userId: null,
      factories: { streamClientFactory, laneSelection: null },
      writeCommand: (commandId, intent) => {
        if (handle === null) throw new Error("the legacy handle is not ready");
        const answer = deferred<WriteReply>();
        const commandStatesAtDispatch = new Map<string, string>();
        for (const record of handle.store.getState().writeCommands) {
          commandStatesAtDispatch.set(record.commandId, record.state);
        }
        dispatched.resolve({
          commandId,
          intent,
          resolve: answer.resolve,
          completion: answer.promise,
          commandStatesAtDispatch,
        });
        return answer.promise;
      },
    },
    COMPUTER_HOST,
  );
  const callbacks = captured.value;
  if (callbacks === null) throw new Error("legacy stream factory not invoked");
  callbacks.onConnectionStatus("open", null, false, null);
  callbacks.onSnapshot(
    legacySnapshotMeta(remoteDoc),
    Y.encodeStateAsUpdate(remoteDoc),
  );

  function emitRemoteUpdate(mutate: () => void): void {
    const updateCallbacks = captured.value;
    if (updateCallbacks === null) {
      throw new Error("legacy stream factory not invoked");
    }
    const before = Y.encodeStateVector(remoteDoc);
    remoteDoc.transact(mutate);
    updateCallbacks.onUpdate(Y.encodeStateAsUpdate(remoteDoc, before));
  }

  return {
    handle,
    artifactId,
    dispatched: dispatched.promise,
    emitRemoteRemoval: () =>
      emitRemoteUpdate(() => artifacts.delete(artifactId)),
    emitRemoteReappearance: () =>
      emitRemoteUpdate(() => {
        const restored = new Y.Map<unknown>();
        restored.set("id", artifactId);
        restored.set("kind", "spec");
        restored.set("title", originalArtifact.get("title"));
        restored.set("parentId", originalArtifact.get("parentId"));
        restored.set("createdAt", originalArtifact.get("createdAt"));
        restored.set("updatedAt", originalArtifact.get("updatedAt"));
        artifacts.set(artifactId, restored);
      }),
  };
}

async function drain(handle: OpenedStoreForTest): Promise<void> {
  await handle.flush();
}

async function enqueueTitle(
  handle: OpenedStoreForTest,
  title: string,
  updatedAt: number,
): Promise<string> {
  const commandId = await handle.store
    .getState()
    .enqueueWriteCommand({ kind: "update-epic-title", title, updatedAt });
  if (commandId === null) throw new Error("the title command was not enqueued");
  return commandId;
}

function recordFor(handle: OpenedStoreForTest, commandId: string) {
  const record = handle.store
    .getState()
    .writeCommands.find((candidate) => candidate.commandId === commandId);
  if (record === undefined)
    throw new Error("the write command was not retained");
  return record;
}

type QueuedArtifactIntent = Exclude<
  EpicWriteCommandIntent,
  { readonly kind: "update-epic-title" }
>;
type SpecRecord = Extract<EpicArtifactRecord, { readonly kind: "spec" }>;
type TicketRecord = Extract<EpicArtifactRecord, { readonly kind: "ticket" }>;
type SpecTombstone = Extract<
  EpicDeletedArtifactRecord,
  { readonly kind: "spec" }
>;

const ARTIFACT_ID = "artifact-write-hold-target";
const TICKET_ID = "artifact-write-hold-ticket";
const PARENT_ONE_ID = "artifact-write-hold-parent-one";
const PARENT_TWO_ID = "artifact-write-hold-parent-two";
const PARENT_THREE_ID = "artifact-write-hold-parent-three";

function specRecord(
  id: string,
  title: string,
  parentId: string | null,
  revision: number,
): SpecRecord {
  return {
    kind: "spec",
    id,
    folderName: id,
    title,
    createdAt: 1000,
    updatedAt: 1000,
    createdManually: false,
    parentId,
    layout: "folder",
    revision,
  };
}

function ticketRecord(
  title: string,
  status: TicketStatus,
  revision: number,
): TicketRecord {
  return {
    kind: "ticket",
    id: TICKET_ID,
    folderName: TICKET_ID,
    title,
    createdAt: 1000,
    updatedAt: 1000,
    createdManually: false,
    parentId: null,
    layout: "folder",
    revision,
    assignee: "",
    status,
  };
}

function specTombstone(revision: number): SpecTombstone {
  return {
    kind: "spec",
    id: ARTIFACT_ID,
    title: "Plan",
    deletedAt: "2026-11-28T00:00:00.000Z",
    folderName: ARTIFACT_ID,
    parentId: null,
    createdAt: 1000,
    createdManually: false,
    status: null,
    revision,
  };
}

interface ArtifactWriteScenario {
  readonly name: string;
  readonly hostId: string;
  readonly intent: QueuedArtifactIntent;
  readonly seed: readonly EpicArtifactRecord[];
  readonly targetUpserts: readonly EpicArtifactRecord[];
  readonly targetTombstones: readonly EpicDeletedArtifactRecord[];
  readonly changedUpserts: readonly EpicArtifactRecord[];
  readonly changedTombstones: readonly EpicDeletedArtifactRecord[];
  readonly expectTarget: (rig: RenameRig) => void;
  readonly expectChanged: (rig: RenameRig) => void;
}

const PARENTS = [
  specRecord(PARENT_ONE_ID, "One", null, 1),
  specRecord(PARENT_TWO_ID, "Two", null, 1),
  specRecord(PARENT_THREE_ID, "Three", null, 1),
];

const RENAME_HOLD: ArtifactWriteScenario = {
  name: "rename",
  hostId: POOL_HOST,
  intent: {
    kind: "rename-artifact",
    artifactId: ARTIFACT_ID,
    title: "Beta",
  },
  seed: [specRecord(ARTIFACT_ID, "Alpha", null, 1)],
  targetUpserts: [specRecord(ARTIFACT_ID, "Beta", null, 2)],
  targetTombstones: [],
  changedUpserts: [specRecord(ARTIFACT_ID, "Peer title", null, 3)],
  changedTombstones: [],
  expectTarget: (rig) =>
    expect(rig.handle.store.getState().artifacts.byId[ARTIFACT_ID]?.title).toBe(
      "Beta",
    ),
  expectChanged: (rig) =>
    expect(rig.handle.store.getState().artifacts.byId[ARTIFACT_ID]?.title).toBe(
      "Peer title",
    ),
};

const REPARENT_HOLD: ArtifactWriteScenario = {
  name: "reparent",
  hostId: POOL_HOST,
  intent: {
    kind: "reparent-artifact",
    artifactId: ARTIFACT_ID,
    parentId: PARENT_ONE_ID,
  },
  seed: [...PARENTS, specRecord(ARTIFACT_ID, "Child", null, 1)],
  targetUpserts: [specRecord(ARTIFACT_ID, "Child", PARENT_ONE_ID, 2)],
  targetTombstones: [],
  changedUpserts: [specRecord(ARTIFACT_ID, "Child", PARENT_THREE_ID, 3)],
  changedTombstones: [],
  expectTarget: (rig) =>
    expect(
      rig.handle.store.getState().artifacts.byId[ARTIFACT_ID]?.parentId,
    ).toBe(PARENT_ONE_ID),
  expectChanged: (rig) =>
    expect(
      rig.handle.store.getState().artifacts.byId[ARTIFACT_ID]?.parentId,
    ).toBe(PARENT_THREE_ID),
};

const STATUS_HOLD: ArtifactWriteScenario = {
  name: "ticket status",
  hostId: COMPUTER_HOST,
  intent: {
    kind: "update-artifact-status",
    artifactId: TICKET_ID,
    artifactType: "ticket",
    status: 1,
  },
  seed: [ticketRecord("Task", 0, 1)],
  targetUpserts: [ticketRecord("Task", 1, 2)],
  targetTombstones: [],
  changedUpserts: [ticketRecord("Task", 2, 3)],
  changedTombstones: [],
  expectTarget: (rig) =>
    expect(rig.handle.store.getState().artifacts.byId[TICKET_ID]?.status).toBe(
      1,
    ),
  expectChanged: (rig) =>
    expect(rig.handle.store.getState().artifacts.byId[TICKET_ID]?.status).toBe(
      2,
    ),
};

const DELETE_HOLD: ArtifactWriteScenario = {
  name: "delete",
  hostId: POOL_HOST,
  intent: { kind: "delete-artifact", artifactId: ARTIFACT_ID },
  seed: [specRecord(ARTIFACT_ID, "Plan", null, 1)],
  targetUpserts: [],
  targetTombstones: [specTombstone(2)],
  changedUpserts: [specRecord(ARTIFACT_ID, "Plan", null, 3)],
  changedTombstones: [],
  expectTarget: (rig) =>
    expect(
      Object.hasOwn(rig.handle.store.getState().artifacts.byId, ARTIFACT_ID),
    ).toBe(false),
  expectChanged: (rig) =>
    expect(
      Object.hasOwn(rig.handle.store.getState().artifacts.byId, ARTIFACT_ID),
    ).toBe(true),
};

const ARTIFACT_WRITE_CASES = [
  RENAME_HOLD,
  REPARENT_HOLD,
  STATUS_HOLD,
  DELETE_HOLD,
] as const;

interface ArtifactSuccessorScenario {
  readonly name: string;
  readonly first: ArtifactWriteScenario;
  readonly successor: QueuedArtifactIntent;
  readonly successorUpserts: readonly EpicArtifactRecord[];
}

const ARTIFACT_SUCCESSOR_CASES: readonly ArtifactSuccessorScenario[] = [
  {
    name: "rename successor",
    first: RENAME_HOLD,
    successor: {
      kind: "rename-artifact",
      artifactId: ARTIFACT_ID,
      title: "Gamma",
    },
    successorUpserts: [specRecord(ARTIFACT_ID, "Gamma", null, 3)],
  },
  {
    name: "reparent successor",
    first: REPARENT_HOLD,
    successor: {
      kind: "reparent-artifact",
      artifactId: ARTIFACT_ID,
      parentId: PARENT_TWO_ID,
    },
    successorUpserts: [specRecord(ARTIFACT_ID, "Child", PARENT_TWO_ID, 3)],
  },
  {
    name: "status successor",
    first: STATUS_HOLD,
    successor: {
      kind: "update-artifact-status",
      artifactId: TICKET_ID,
      artifactType: "ticket",
      status: 2,
    },
    successorUpserts: [ticketRecord("Task", 2, 3)],
  },
];

const ARTIFACT_HELD_FAILURES: readonly {
  readonly name: string;
  readonly scenario: ArtifactWriteScenario;
  readonly reply: CommandSendFailure;
}[] = [
  {
    name: "rename refusal",
    scenario: RENAME_HOLD,
    reply: {
      kind: "rejected",
      resolution: {
        kind: "rejected",
        code: "FORBIDDEN",
        reason: "permission denied",
        retryable: false,
      },
    },
  },
  {
    name: "reparent pre-send failure",
    scenario: REPARENT_HOLD,
    reply: {
      kind: "queued",
      reason: "request was not sent",
      boundedRetry: false,
      retryAfterMs: null,
    },
  },
  {
    name: "status retryable transport failure",
    scenario: STATUS_HOLD,
    reply: {
      kind: "queued",
      reason: "the unary dial failed after its retry budget",
      boundedRetry: true,
      retryAfterMs: 1000,
    },
  },
  {
    name: "delete unknown outcome",
    scenario: DELETE_HOLD,
    reply: {
      kind: "unknown-outcome",
      reason: "the response was lost",
    },
  },
];

async function enqueueArtifactWrite(
  handle: OpenedStoreForTest,
  intent: QueuedArtifactIntent,
): Promise<string> {
  const commandId = await handle.store.getState().enqueueWriteCommand(intent);
  if (commandId === null)
    throw new Error("the artifact command was not enqueued");
  return commandId;
}

async function seedArtifactScenario(
  rig: RenameRig,
  scenario: ArtifactWriteScenario,
): Promise<void> {
  await rig.emitArtifactChanges(scenario.seed, [], 2);
}

async function emitScenarioTarget(
  rig: RenameRig,
  scenario: ArtifactWriteScenario,
  sequence: number,
): Promise<void> {
  await rig.emitArtifactChanges(
    scenario.targetUpserts,
    scenario.targetTombstones,
    sequence,
  );
  scenario.expectTarget(rig);
}

async function beginUnqueuedOverlay(
  rig: RenameRig,
  scenario: ArtifactWriteScenario,
): Promise<string | null> {
  if (scenario.intent.kind === "rename-artifact") {
    return rig.handle.store
      .getState()
      .beginRenameMutation(scenario.intent.artifactId, scenario.intent.title);
  }
  if (scenario.intent.kind === "reparent-artifact") {
    return rig.handle.store
      .getState()
      .beginReparentMutation(
        scenario.intent.artifactId,
        scenario.intent.parentId,
      );
  }
  return null;
}

interface HeldSuccessor {
  readonly firstId: string;
  readonly first: SentWrite;
  readonly firstResult: Promise<CommandRecord<EpicWriteCommandIntent>>;
  readonly secondId: string;
  readonly secondDispatch: Promise<SentWrite>;
}

async function holdFirstThenQueueSuccessor(
  rig: RenameRig,
  successorTitle: string,
  successorUpdatedAt: number,
): Promise<HeldSuccessor> {
  await drain(rig.handle);
  const firstDispatch = rig.nextDispatch();
  const firstId = await enqueueTitle(rig.handle, TARGET_TITLE, 2000);
  const first = await firstDispatch;
  await rig.emitTitle(TARGET_TITLE, 2000, 2);
  const firstResult = rig.handle.store.getState().waitForWriteCommand(firstId);
  const secondDispatch = rig.nextDispatch();
  const secondId = await enqueueTitle(
    rig.handle,
    successorTitle,
    successorUpdatedAt,
  );
  return { firstId, first, firstResult, secondId, secondDispatch };
}

function writeCommandAlert(rig: RenameRig) {
  return deriveEpicWriteCommandAlert(
    summarizeEpicWriteCommands(rig.handle.store.getState().writeCommands),
  );
}

function trackTitleSettlement(
  result: Promise<CommandRecord<EpicWriteCommandIntent>>,
): void {
  settleEpicTitleWrite(result, {
    onCommitted: () => undefined,
    source: "minimal rename hold",
  });
}

afterEach(() => {
  vi.mocked(reportableErrorToast).mockClear();
});

const HELD_SUCCESSOR_FAILURES: readonly {
  readonly name: string;
  readonly reply: CommandSendFailure;
}[] = [
  {
    name: "definitive refusal",
    reply: {
      kind: "rejected",
      resolution: {
        kind: "rejected",
        code: "FORBIDDEN",
        reason: "permission denied",
        retryable: false,
      },
    },
  },
  {
    name: "predispatch failure",
    reply: {
      kind: "queued",
      reason: "request was not sent",
      boundedRetry: false,
      retryAfterMs: null,
    },
  },
  {
    name: "retryable failure",
    reply: {
      kind: "queued",
      reason: "the unary dial failed after its retry budget",
      boundedRetry: true,
      retryAfterMs: 1000,
    },
  },
  {
    name: "unknown outcome",
    reply: {
      kind: "unknown-outcome",
      reason: "the response was lost",
    },
  },
];

describe("minimal title echo hold through the real records lane and command queue", () => {
  it("holds a pool target frame until its unary succeeds", async () => {
    const rig = makeRig(POOL_HOST);
    await drain(rig.handle);
    expect(rig.handle.store.getState().epic.title).toBe(INITIAL_TITLE);

    const send = rig.nextDispatch();
    const commandId = await enqueueTitle(rig.handle, TARGET_TITLE, 2000);
    const sent = await send;
    expect(sent.commandId).toBe(commandId);
    expect(recordFor(rig.handle, commandId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });

    await rig.emitTitle(TARGET_TITLE, 2000, 2);
    expect(rig.handle.store.getState().epic).toMatchObject({
      title: TARGET_TITLE,
      updatedAt: 2000,
    });
    expect(recordFor(rig.handle, commandId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });

    const result = rig.handle.store.getState().waitForWriteCommand(commandId);
    sent.resolve({ hostId: POOL_HOST });
    expect(await result).toMatchObject({
      state: "committed",
      delivery: "settled",
    });
    expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);
    rig.handle.dispose();
  });

  it("keeps the response-first pool control committed when the matching frame follows", async () => {
    const rig = makeRig(POOL_HOST);
    await drain(rig.handle);

    const send = rig.nextDispatch();
    const commandId = await enqueueTitle(rig.handle, TARGET_TITLE, 2000);
    const sent = await send;
    const result = rig.handle.store.getState().waitForWriteCommand(commandId);
    sent.resolve({ hostId: POOL_HOST });
    expect(await result).toMatchObject({ state: "committed" });

    expect(rig.handle.store.getState().epic.updatedAt).toBe(1000);
    await rig.emitTitle(TARGET_TITLE, 2000, 2);
    expect(rig.handle.store.getState().epic).toMatchObject({
      title: TARGET_TITLE,
      updatedAt: 2000,
    });
    rig.handle.dispose();
  });

  it("uses the same frame-first hold for a computer state lane", async () => {
    const rig = makeRig(COMPUTER_HOST);
    await drain(rig.handle);

    const send = rig.nextDispatch();
    const commandId = await enqueueTitle(rig.handle, TARGET_TITLE, 2000);
    const sent = await send;
    await rig.emitTitle(TARGET_TITLE, 2000, 2);
    expect(rig.handle.store.getState().epic).toMatchObject({
      title: TARGET_TITLE,
      updatedAt: 2000,
    });
    expect(recordFor(rig.handle, commandId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });

    const result = rig.handle.store.getState().waitForWriteCommand(commandId);
    sent.resolve({ hostId: COMPUTER_HOST });
    expect(await result).toMatchObject({ state: "committed" });
    rig.handle.dispose();
  });

  it("lets a different title supersede the held target", async () => {
    const rig = makeRig(POOL_HOST);
    await drain(rig.handle);

    const send = rig.nextDispatch();
    const commandId = await enqueueTitle(rig.handle, TARGET_TITLE, 2000);
    const sent = await send;
    await rig.emitTitle("Gamma", 3000, 3);
    expect(rig.handle.store.getState().epic).toMatchObject({
      title: "Gamma",
      updatedAt: 3000,
    });
    expect(
      await rig.handle.store.getState().waitForWriteCommand(commandId),
    ).toMatchObject({ state: "superseded" });

    sent.resolve({ hostId: POOL_HOST });
    await drain(rig.handle);
    expect(rig.handle.store.getState().epic.title).toBe("Gamma");
    rig.handle.dispose();
  });

  it("does not reuse the matching frame after the title moves away and back", async () => {
    const rig = makeRig(POOL_HOST);
    await drain(rig.handle);

    const send = rig.nextDispatch();
    const commandId = await enqueueTitle(rig.handle, TARGET_TITLE, 2000);
    const sent = await send;
    await rig.emitTitle(TARGET_TITLE, 2000, 2);
    expect(recordFor(rig.handle, commandId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });

    await rig.emitTitle(INITIAL_TITLE, 1000, 3);
    expect(
      await rig.handle.store.getState().waitForWriteCommand(commandId),
    ).toMatchObject({ state: "superseded" });
    await rig.emitTitle(TARGET_TITLE, 4000, 4);
    expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);

    sent.resolve({ hostId: POOL_HOST });
    await drain(rig.handle);
    expect(recordFor(rig.handle, commandId)).toMatchObject({
      state: "superseded",
    });
    rig.handle.dispose();
  });

  it("does not hold the first echo when a sibling title was already queued", async () => {
    const rig = makeRig(POOL_HOST);
    await drain(rig.handle);

    const sendFirst = rig.nextDispatch();
    const firstId = await enqueueTitle(rig.handle, TARGET_TITLE, 2000);
    const first = await sendFirst;
    const secondId = await enqueueTitle(rig.handle, "Gamma", 3000);

    await rig.emitTitle(TARGET_TITLE, 2000, 2);
    expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);
    expect(recordFor(rig.handle, firstId)).toMatchObject({
      state: "superseded",
    });
    expect(recordFor(rig.handle, secondId)).toMatchObject({
      state: "superseded",
    });

    first.resolve({ hostId: POOL_HOST });
    await drain(rig.handle);
    expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);
    rig.handle.dispose();
  });

  it.each([
    { order: "frame-first", hostId: POOL_HOST },
    { order: "reply-first", hostId: POOL_HOST },
  ] as const)(
    "transfers the held pool frame to one queued successor ($order)",
    async ({ order, hostId }) => {
      const rig = makeRig(hostId);
      const pair = await holdFirstThenQueueSuccessor(
        rig,
        SUCCESSOR_TITLE,
        3000,
      );
      trackTitleSettlement(pair.firstResult);

      expect(rig.handle.store.getState().epic).toMatchObject({
        title: SUCCESSOR_TITLE,
        updatedAt: 2000,
      });
      expect(recordFor(rig.handle, pair.firstId)).toMatchObject({
        state: "pending",
        delivery: "sending",
      });
      expect(recordFor(rig.handle, pair.secondId)).toMatchObject({
        state: "pending",
        delivery: "queued",
        attempts: 0,
      });
      expect(rig.dispatches.map((write) => write.commandId)).toEqual([
        pair.firstId,
      ]);
      expect(writeCommandAlert(rig)).toBeNull();

      pair.first.resolve({ hostId });
      expect(await pair.firstResult).toMatchObject({
        state: "committed",
        delivery: "settled",
      });
      expect(recordFor(rig.handle, pair.firstId)).toMatchObject({
        state: "committed",
        delivery: "settled",
      });
      expect(reportableErrorToast).not.toHaveBeenCalled();

      const second = await pair.secondDispatch;
      expect(second.commandId).toBe(pair.secondId);
      expect(second.intent).toEqual({
        kind: "update-epic-title",
        title: SUCCESSOR_TITLE,
        updatedAt: 3000,
      });
      expect(second.commandStatesAtDispatch.get(pair.firstId)).toBe(
        "committed",
      );
      expect(rig.dispatches.map((write) => write.commandId)).toEqual([
        pair.firstId,
        pair.secondId,
      ]);
      expect(writeCommandAlert(rig)).toBeNull();

      const secondResult = rig.handle.store
        .getState()
        .waitForWriteCommand(pair.secondId);
      trackTitleSettlement(secondResult);
      if (order === "frame-first") {
        await rig.emitTitle(SUCCESSOR_TITLE, 3000, 3);
        expect(rig.handle.store.getState().epic).toMatchObject({
          title: SUCCESSOR_TITLE,
          updatedAt: 3000,
        });
        expect(recordFor(rig.handle, pair.secondId)).toMatchObject({
          state: "pending",
          delivery: "sending",
        });
      } else {
        second.resolve({ hostId });
        expect(await secondResult).toMatchObject({
          state: "committed",
          delivery: "settled",
        });
        expect(rig.handle.store.getState().epic).toMatchObject({
          title: SUCCESSOR_TITLE,
          updatedAt: 2000,
        });
        await rig.emitTitle(SUCCESSOR_TITLE, 3000, 3);
      }
      if (order === "frame-first") {
        second.resolve({ hostId });
        expect(await secondResult).toMatchObject({
          state: "committed",
          delivery: "settled",
        });
      }
      expect(recordFor(rig.handle, pair.firstId)).toMatchObject({
        state: "committed",
      });
      expect(recordFor(rig.handle, pair.secondId)).toMatchObject({
        state: "committed",
      });
      expect(rig.handle.store.getState().epic).toMatchObject({
        title: SUCCESSOR_TITLE,
        updatedAt: 3000,
      });
      expect(rig.dispatches).toHaveLength(2);
      expect(writeCommandAlert(rig)).toBeNull();
      expect(reportableErrorToast).not.toHaveBeenCalled();
      rig.handle.dispose();
    },
  );

  it("transfers the held frame on the computer lane", async () => {
    const rig = makeRig(COMPUTER_HOST);
    const pair = await holdFirstThenQueueSuccessor(rig, SUCCESSOR_TITLE, 3000);
    trackTitleSettlement(pair.firstResult);
    expect(recordFor(rig.handle, pair.firstId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });
    expect(recordFor(rig.handle, pair.secondId)).toMatchObject({
      state: "pending",
      delivery: "queued",
      attempts: 0,
    });
    expect(rig.handle.store.getState().epic).toMatchObject({
      title: SUCCESSOR_TITLE,
      updatedAt: 2000,
    });

    pair.first.resolve({ hostId: COMPUTER_HOST });
    expect(await pair.firstResult).toMatchObject({ state: "committed" });
    const second = await pair.secondDispatch;
    expect(second.commandStatesAtDispatch.get(pair.firstId)).toBe("committed");
    const secondResult = rig.handle.store
      .getState()
      .waitForWriteCommand(pair.secondId);
    trackTitleSettlement(secondResult);
    await rig.emitTitle(SUCCESSOR_TITLE, 3000, 3);
    expect(rig.handle.store.getState().epic).toMatchObject({
      title: SUCCESSOR_TITLE,
      updatedAt: 3000,
    });
    expect(recordFor(rig.handle, pair.secondId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });
    second.resolve({ hostId: COMPUTER_HOST });
    expect(await secondResult).toMatchObject({ state: "committed" });
    expect(rig.dispatches).toHaveLength(2);
    expect(writeCommandAlert(rig)).toBeNull();
    expect(reportableErrorToast).not.toHaveBeenCalled();
    rig.handle.dispose();
  });

  it.each([
    { movement: "an unrelated title", title: "Outside", updatedAt: 3000 },
    {
      movement: "a return to the original title",
      title: INITIAL_TITLE,
      updatedAt: 3000,
    },
    {
      movement: "the unsent successor's target",
      title: SUCCESSOR_TITLE,
      updatedAt: 3000,
    },
  ])("lets the current row win on $movement", async ({ title, updatedAt }) => {
    const rig = makeRig(POOL_HOST);
    const pair = await holdFirstThenQueueSuccessor(rig, SUCCESSOR_TITLE, 3000);
    const secondResult = rig.handle.store
      .getState()
      .waitForWriteCommand(pair.secondId);

    await rig.emitTitle(title, updatedAt, 3);
    expect(rig.handle.store.getState().epic).toMatchObject({
      title,
      updatedAt,
    });
    expect(await pair.firstResult).toMatchObject({
      state: "superseded",
      delivery: "settled",
    });
    expect(await secondResult).toMatchObject({
      state: "superseded",
      delivery: "settled",
    });
    expect(writeCommandAlert(rig)).toBe("superseded");

    pair.first.resolve({ hostId: POOL_HOST });
    await pair.first.completion;
    await drain(rig.handle);
    expect(recordFor(rig.handle, pair.firstId)).toMatchObject({
      state: "superseded",
      delivery: "settled",
    });
    expect(recordFor(rig.handle, pair.secondId)).toMatchObject({
      state: "superseded",
      delivery: "settled",
      attempts: 0,
    });
    expect(rig.dispatches.map((write) => write.commandId)).toEqual([
      pair.firstId,
    ]);
    expect(rig.handle.store.getState().epic).toMatchObject({
      title,
      updatedAt,
    });
    expect(writeCommandAlert(rig)).toBe("superseded");
    rig.handle.dispose();
  });

  it("keeps the transferred successor queued across a timestamp-only title projection", async () => {
    const rig = makeRig(POOL_HOST);
    const pair = await holdFirstThenQueueSuccessor(rig, SUCCESSOR_TITLE, 3000);

    await rig.emitTitle(TARGET_TITLE, 2500, 3);
    expect(rig.handle.store.getState().epic).toMatchObject({
      title: SUCCESSOR_TITLE,
      updatedAt: 2500,
    });
    expect(recordFor(rig.handle, pair.firstId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });
    expect(recordFor(rig.handle, pair.secondId)).toMatchObject({
      state: "pending",
      delivery: "queued",
      attempts: 0,
    });
    expect(rig.dispatches.map((write) => write.commandId)).toEqual([
      pair.firstId,
    ]);

    pair.first.resolve({ hostId: POOL_HOST });
    expect(await pair.firstResult).toMatchObject({ state: "committed" });
    const second = await pair.secondDispatch;
    expect(second.commandStatesAtDispatch.get(pair.firstId)).toBe("committed");
    second.resolve({ hostId: POOL_HOST });
    await rig.handle.store.getState().waitForWriteCommand(pair.secondId);
    rig.handle.dispose();
  });

  it("lets a dispatched successor return to the original title under its own hold", async () => {
    const rig = makeRig(POOL_HOST);
    const pair = await holdFirstThenQueueSuccessor(rig, INITIAL_TITLE, 3000);
    expect(rig.handle.store.getState().epic).toMatchObject({
      title: INITIAL_TITLE,
      updatedAt: 2000,
    });
    expect(recordFor(rig.handle, pair.firstId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });
    expect(recordFor(rig.handle, pair.secondId)).toMatchObject({
      state: "pending",
      delivery: "queued",
      attempts: 0,
    });

    pair.first.resolve({ hostId: POOL_HOST });
    expect(await pair.firstResult).toMatchObject({ state: "committed" });
    const second = await pair.secondDispatch;
    expect(second.intent).toEqual({
      kind: "update-epic-title",
      title: INITIAL_TITLE,
      updatedAt: 3000,
    });
    expect(second.commandStatesAtDispatch.get(pair.firstId)).toBe("committed");
    const secondResult = rig.handle.store
      .getState()
      .waitForWriteCommand(pair.secondId);
    await rig.emitTitle(INITIAL_TITLE, 3000, 3);
    expect(rig.handle.store.getState().epic).toMatchObject({
      title: INITIAL_TITLE,
      updatedAt: 3000,
    });
    expect(recordFor(rig.handle, pair.secondId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });
    second.resolve({ hostId: POOL_HOST });
    expect(await secondResult).toMatchObject({ state: "committed" });
    expect(rig.dispatches).toHaveLength(2);
    rig.handle.dispose();
  });

  it.each(HELD_SUCCESSOR_FAILURES)(
    "discharges the first hold after its $name while keeping the successor eligible",
    async ({ reply }) => {
      const rig = makeRig(POOL_HOST);
      const pair = await holdFirstThenQueueSuccessor(
        rig,
        SUCCESSOR_TITLE,
        3000,
      );

      pair.first.resolve(reply);
      await pair.first.completion;
      expect(await pair.firstResult).toMatchObject({
        state: "superseded",
        delivery: "settled",
      });
      expect(recordFor(rig.handle, pair.firstId)).toMatchObject({
        state: "superseded",
        delivery: "settled",
      });

      const second = await pair.secondDispatch;
      expect(second.commandId).toBe(pair.secondId);
      expect(second.commandStatesAtDispatch.get(pair.firstId)).toBe(
        "superseded",
      );
      expect(second.intent).toEqual({
        kind: "update-epic-title",
        title: SUCCESSOR_TITLE,
        updatedAt: 3000,
      });
      const secondResult = rig.handle.store
        .getState()
        .waitForWriteCommand(pair.secondId);
      await rig.emitTitle(SUCCESSOR_TITLE, 3000, 3);
      expect(recordFor(rig.handle, pair.secondId)).toMatchObject({
        state: "pending",
        delivery: "sending",
      });
      second.resolve({ hostId: POOL_HOST });
      expect(await secondResult).toMatchObject({ state: "committed" });
      expect(rig.handle.store.getState().epic).toMatchObject({
        title: SUCCESSOR_TITLE,
        updatedAt: 3000,
      });
      expect(rig.dispatches.map((write) => write.commandId)).toEqual([
        pair.firstId,
        pair.secondId,
      ]);
      rig.handle.dispose();
    },
  );

  it("caps the frame transfer at one accepted successor", async () => {
    const rig = makeRig(POOL_HOST);
    const pair = await holdFirstThenQueueSuccessor(rig, SUCCESSOR_TITLE, 3000);
    const thirdId = await enqueueTitle(rig.handle, THIRD_TITLE, 4000);
    const firstResult = rig.handle.store
      .getState()
      .waitForWriteCommand(pair.firstId);
    expect(await firstResult).toMatchObject({
      state: "superseded",
      delivery: "settled",
    });
    expect(recordFor(rig.handle, pair.secondId)).toMatchObject({
      state: "pending",
      delivery: "queued",
      attempts: 0,
    });
    expect(recordFor(rig.handle, thirdId)).toMatchObject({
      state: "pending",
      delivery: "queued",
      attempts: 0,
    });
    expect(rig.handle.store.getState().epic).toMatchObject({
      title: THIRD_TITLE,
      updatedAt: 2000,
    });

    pair.first.resolve({ hostId: POOL_HOST });
    await pair.first.completion;
    const second = await pair.secondDispatch;
    expect(second.commandStatesAtDispatch.get(pair.firstId)).toBe("superseded");
    expect(second.commandId).toBe(pair.secondId);
    second.resolve({ hostId: POOL_HOST });
    await rig.handle.store.getState().waitForWriteCommand(pair.secondId);
    const third = await rig.nextDispatch();
    expect(third.commandId).toBe(thirdId);
    third.resolve({ hostId: POOL_HOST });
    await rig.handle.store.getState().waitForWriteCommand(thirdId);
    expect(rig.dispatches.map((write) => write.commandId)).toEqual([
      pair.firstId,
      pair.secondId,
      thirdId,
    ]);
    rig.handle.dispose();
  });

  it("does not let a late answer from the old authority affect a replacement", async () => {
    const rig = makeRig(COMPUTER_HOST);
    await drain(rig.handle);

    const send = rig.nextDispatch();
    const commandId = await enqueueTitle(rig.handle, TARGET_TITLE, 2000);
    const sent = await send;
    await rig.emitTitle(TARGET_TITLE, 2000, 2);
    expect(recordFor(rig.handle, commandId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });

    await rig.emitReplacement("Replacement");
    expect(rig.handle.store.getState().epic.title).toBe("Replacement");
    expect(
      await rig.handle.store.getState().waitForWriteCommand(commandId),
    ).toMatchObject({ state: "superseded" });

    sent.resolve({ hostId: COMPUTER_HOST });
    await drain(rig.handle);
    expect(rig.handle.store.getState().epic.title).toBe("Replacement");
    rig.handle.dispose();
  });

  it("supersedes a held command when a same-authority resumeTooOld reseeds the state lane", async () => {
    const rig = makeRig(POOL_HOST);
    await drain(rig.handle);

    const send = rig.nextDispatch();
    const commandId = await enqueueTitle(rig.handle, TARGET_TITLE, 2000);
    const sent = await send;
    await rig.emitTitle(TARGET_TITLE, 2000, 2);
    expect(recordFor(rig.handle, commandId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });

    await rig.emitResumeTooOld("Reseeded");
    expect(rig.handle.store.getState().epic.title).toBe("Reseeded");
    expect(
      await rig.handle.store.getState().waitForWriteCommand(commandId),
    ).toMatchObject({ state: "superseded" });

    sent.resolve({ hostId: POOL_HOST });
    await drain(rig.handle);
    expect(rig.handle.store.getState().epic.title).toBe("Reseeded");
    rig.handle.dispose();
  });
});

async function expectHeldFailureToSupersede(
  reply: CommandSendFailure,
): Promise<void> {
  const rig = makeRig(POOL_HOST);
  await drain(rig.handle);

  const send = rig.nextDispatch();
  const commandId = await enqueueTitle(rig.handle, TARGET_TITLE, 2000);
  const sent = await send;
  await rig.emitTitle(TARGET_TITLE, 2000, 2);
  expect(rig.handle.store.getState().epic).toMatchObject({
    title: TARGET_TITLE,
    updatedAt: 2000,
  });
  expect(recordFor(rig.handle, commandId)).toMatchObject({
    state: "pending",
    delivery: "sending",
  });

  const result = rig.handle.store.getState().waitForWriteCommand(commandId);
  sent.resolve(reply);
  expect(await result).toMatchObject({
    state: "superseded",
    delivery: "settled",
    attempts: 1,
    resolution: { kind: "superseded" },
  });
  expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);
  rig.handle.dispose();
}

describe("a matching frame is not unary success", () => {
  it("releases the held match as superseded after a definitive refusal", async () => {
    await expectHeldFailureToSupersede({
      kind: "rejected",
      resolution: {
        kind: "rejected",
        code: "FORBIDDEN",
        reason: "permission denied",
        retryable: false,
      },
    });
  });

  it("releases the held match as superseded after a proved predispatch failure", async () => {
    await expectHeldFailureToSupersede({
      kind: "queued",
      reason: "request was not sent",
      boundedRetry: false,
      retryAfterMs: null,
    });
  });

  it("does not retry a held match after another retryable failure", async () => {
    await expectHeldFailureToSupersede({
      kind: "queued",
      reason: "the unary dial failed after its retry budget",
      boundedRetry: true,
      retryAfterMs: 1000,
    });
  });

  it("releases the held match as superseded after an unknown outcome", async () => {
    await expectHeldFailureToSupersede({
      kind: "unknown-outcome",
      reason: "the response was lost",
    });
  });
});

describe("artifact write echo holds through the real records lane and queue", () => {
  it.each(ARTIFACT_WRITE_CASES)(
    "holds the $name target frame until its successful answer",
    async (scenario) => {
      const rig = makeRig(scenario.hostId);
      try {
        await seedArtifactScenario(rig, scenario);
        const dispatch = rig.nextDispatch();
        const commandId = await enqueueArtifactWrite(
          rig.handle,
          scenario.intent,
        );
        const sent = await dispatch;
        const result = rig.handle.store
          .getState()
          .waitForWriteCommand(commandId);

        await emitScenarioTarget(rig, scenario, 3);
        expect(recordFor(rig.handle, commandId)).toMatchObject({
          state: "pending",
          delivery: "sending",
        });
        expect(writeCommandAlert(rig)).toBeNull();

        sent.resolve({ hostId: scenario.hostId });
        expect(await result).toMatchObject({
          state: "committed",
          delivery: "settled",
        });
        expect(writeCommandAlert(rig)).toBeNull();
        expect(reportableErrorToast).not.toHaveBeenCalled();
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it.each(ARTIFACT_WRITE_CASES)(
    "keeps the $name answer-first control committed",
    async (scenario) => {
      const rig = makeRig(scenario.hostId);
      try {
        await seedArtifactScenario(rig, scenario);
        const dispatch = rig.nextDispatch();
        const commandId = await enqueueArtifactWrite(
          rig.handle,
          scenario.intent,
        );
        const sent = await dispatch;
        const result = rig.handle.store
          .getState()
          .waitForWriteCommand(commandId);
        sent.resolve({ hostId: scenario.hostId });
        expect(await result).toMatchObject({
          state: "committed",
          delivery: "settled",
        });

        await emitScenarioTarget(rig, scenario, 3);
        expect(recordFor(rig.handle, commandId)).toMatchObject({
          state: "committed",
          delivery: "settled",
        });
        expect(writeCommandAlert(rig)).toBeNull();
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it.each(ARTIFACT_HELD_FAILURES)(
    "applies deferred supersession for $name",
    async ({ scenario, reply }) => {
      const rig = makeRig(scenario.hostId);
      try {
        await seedArtifactScenario(rig, scenario);
        const dispatch = rig.nextDispatch();
        const commandId = await enqueueArtifactWrite(
          rig.handle,
          scenario.intent,
        );
        const sent = await dispatch;
        const result = rig.handle.store
          .getState()
          .waitForWriteCommand(commandId);

        await emitScenarioTarget(rig, scenario, 3);
        expect(recordFor(rig.handle, commandId)).toMatchObject({
          state: "pending",
          delivery: "sending",
        });
        sent.resolve(reply);
        expect(await result).toMatchObject({
          state: "superseded",
          delivery: "settled",
          resolution: { kind: "superseded" },
        });
        expect(writeCommandAlert(rig)).toBe("superseded");
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it.each([RENAME_HOLD, REPARENT_HOLD, STATUS_HOLD] as const)(
    "ends the $name hold when the observed field changes",
    async (scenario) => {
      const rig = makeRig(scenario.hostId);
      try {
        await seedArtifactScenario(rig, scenario);
        const dispatch = rig.nextDispatch();
        const commandId = await enqueueArtifactWrite(
          rig.handle,
          scenario.intent,
        );
        const sent = await dispatch;
        const result = rig.handle.store
          .getState()
          .waitForWriteCommand(commandId);

        await emitScenarioTarget(rig, scenario, 3);
        expect(recordFor(rig.handle, commandId)).toMatchObject({
          state: "pending",
          delivery: "sending",
        });
        await rig.emitArtifactChanges(
          scenario.changedUpserts,
          scenario.changedTombstones,
          4,
        );
        scenario.expectChanged(rig);
        expect(await result).toMatchObject({
          state: "superseded",
          delivery: "settled",
        });

        sent.resolve({ hostId: scenario.hostId });
        await sent.completion;
        await drain(rig.handle);
        expect(recordFor(rig.handle, commandId).state).toBe("superseded");
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it("releases a legacy computer delete hold when the artifact reappears remotely", async () => {
    const rig = makeLegacyDeleteRig();
    try {
      const intent: QueuedArtifactIntent = {
        kind: "delete-artifact",
        artifactId: rig.artifactId,
      };
      expect(
        Object.hasOwn(
          rig.handle.store.getState().artifacts.byId,
          rig.artifactId,
        ),
      ).toBe(true);

      const commandId = await enqueueArtifactWrite(rig.handle, intent);
      expect(recordFor(rig.handle, commandId)).toMatchObject({
        state: "pending",
        delivery: "sending",
      });
      const sent = await rig.dispatched;
      const result = rig.handle.store.getState().waitForWriteCommand(commandId);

      rig.emitRemoteRemoval();
      expect(recordFor(rig.handle, commandId)).toMatchObject({
        state: "pending",
        delivery: "sending",
      });
      expect(
        Object.hasOwn(
          rig.handle.store.getState().artifacts.byId,
          rig.artifactId,
        ),
      ).toBe(false);

      rig.emitRemoteReappearance();
      expect(
        Object.hasOwn(
          rig.handle.store.getState().artifacts.byId,
          rig.artifactId,
        ),
      ).toBe(true);
      expect(await result).toMatchObject({
        state: "superseded",
        delivery: "settled",
      });

      sent.resolve({ hostId: COMPUTER_HOST });
      await sent.completion;
      expect(recordFor(rig.handle, commandId).state).toBe("superseded");
    } finally {
      rig.handle.dispose();
    }
  });

  it("ends an artifact rename hold when the raw title returns to its baseline", async () => {
    const rig = makeRig(POOL_HOST);
    try {
      await seedArtifactScenario(rig, RENAME_HOLD);
      const dispatch = rig.nextDispatch();
      const commandId = await enqueueArtifactWrite(
        rig.handle,
        RENAME_HOLD.intent,
      );
      const sent = await dispatch;
      const result = rig.handle.store.getState().waitForWriteCommand(commandId);
      await emitScenarioTarget(rig, RENAME_HOLD, 3);
      expect(recordFor(rig.handle, commandId)).toMatchObject({
        state: "pending",
        delivery: "sending",
      });

      await rig.emitArtifactChanges(
        [specRecord(ARTIFACT_ID, "Alpha", null, 3)],
        [],
        4,
      );
      expect(
        rig.handle.store.getState().artifacts.byId[ARTIFACT_ID]?.title,
      ).toBe("Alpha");
      expect(await result).toMatchObject({ state: "superseded" });
      sent.resolve({ hostId: POOL_HOST });
      await sent.completion;
      expect(recordFor(rig.handle, commandId).state).toBe("superseded");
    } finally {
      rig.handle.dispose();
    }
  });

  it.each(ARTIFACT_SUCCESSOR_CASES)(
    "hands a held $name to its valid same-field successor",
    async ({ first: scenario, successor, successorUpserts }) => {
      const rig = makeRig(scenario.hostId);
      try {
        await seedArtifactScenario(rig, scenario);
        const firstDispatch = rig.nextDispatch();
        const firstId = await enqueueArtifactWrite(rig.handle, scenario.intent);
        const first = await firstDispatch;
        const firstResult = rig.handle.store
          .getState()
          .waitForWriteCommand(firstId);
        await emitScenarioTarget(rig, scenario, 3);
        expect(recordFor(rig.handle, firstId)).toMatchObject({
          state: "pending",
          delivery: "sending",
        });

        const successorDispatch = rig.nextDispatch();
        const successorId = await enqueueArtifactWrite(rig.handle, successor);
        const successorResult = rig.handle.store
          .getState()
          .waitForWriteCommand(successorId);
        expect(recordFor(rig.handle, successorId)).toMatchObject({
          state: "pending",
          delivery: "queued",
          attempts: 0,
        });
        expect(rig.dispatches.map((write) => write.commandId)).toEqual([
          firstId,
        ]);

        first.resolve({ hostId: scenario.hostId });
        expect(await firstResult).toMatchObject({
          state: "committed",
          delivery: "settled",
        });
        const next = await successorDispatch;
        expect(next.commandId).toBe(successorId);
        expect(next.intent).toEqual(successor);
        expect(next.commandStatesAtDispatch.get(firstId)).toBe("committed");
        expect(rig.dispatches.map((write) => write.commandId)).toEqual([
          firstId,
          successorId,
        ]);

        await rig.emitArtifactChanges(successorUpserts, [], 4);
        expect(recordFor(rig.handle, successorId)).toMatchObject({
          state: "pending",
          delivery: "sending",
        });
        next.resolve({ hostId: scenario.hostId });
        expect(await successorResult).toMatchObject({
          state: "committed",
          delivery: "settled",
        });
        expect(writeCommandAlert(rig)).toBeNull();
        expect(reportableErrorToast).not.toHaveBeenCalled();
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it.each(ARTIFACT_SUCCESSOR_CASES)(
    "keeps the $name pre-frame sibling control superseded",
    async ({ first: scenario, successor }) => {
      const rig = makeRig(scenario.hostId);
      try {
        await seedArtifactScenario(rig, scenario);
        const dispatch = rig.nextDispatch();
        const firstId = await enqueueArtifactWrite(rig.handle, scenario.intent);
        const first = await dispatch;
        const firstResult = rig.handle.store
          .getState()
          .waitForWriteCommand(firstId);
        const successorId = await enqueueArtifactWrite(rig.handle, successor);
        const successorResult = rig.handle.store
          .getState()
          .waitForWriteCommand(successorId);

        await emitScenarioTarget(rig, scenario, 3);
        expect(await firstResult).toMatchObject({
          state: "superseded",
          delivery: "settled",
        });
        expect(await successorResult).toMatchObject({
          state: "superseded",
          delivery: "settled",
          attempts: 0,
        });
        expect(rig.dispatches.map((write) => write.commandId)).toEqual([
          firstId,
        ]);

        first.resolve({ hostId: scenario.hostId });
        await first.completion;
        await drain(rig.handle);
        expect(recordFor(rig.handle, firstId).state).toBe("superseded");
        expect(recordFor(rig.handle, successorId)).toMatchObject({
          state: "superseded",
          attempts: 0,
        });
        expect(rig.dispatches).toHaveLength(1);
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it("keeps a held rename when its queued cross-kind write targets another artifact", async () => {
    const rig = makeRig(POOL_HOST);
    try {
      await rig.emitArtifactChanges(
        [...RENAME_HOLD.seed, ticketRecord("Task", 0, 1)],
        [],
        2,
      );
      const firstDispatch = rig.nextDispatch();
      const firstId = await enqueueArtifactWrite(
        rig.handle,
        RENAME_HOLD.intent,
      );
      const first = await firstDispatch;
      const firstResult = rig.handle.store
        .getState()
        .waitForWriteCommand(firstId);
      await emitScenarioTarget(rig, RENAME_HOLD, 3);
      expect(recordFor(rig.handle, firstId)).toMatchObject({
        state: "pending",
        delivery: "sending",
      });

      const secondIntent: QueuedArtifactIntent = {
        kind: "update-artifact-status",
        artifactId: TICKET_ID,
        artifactType: "ticket",
        status: 1,
      };
      const secondDispatch = rig.nextDispatch();
      const secondId = await enqueueArtifactWrite(rig.handle, secondIntent);
      expect(recordFor(rig.handle, secondId)).toMatchObject({
        state: "pending",
        delivery: "queued",
        attempts: 0,
      });
      expect(rig.dispatches.map((write) => write.commandId)).toEqual([firstId]);

      first.resolve({ hostId: POOL_HOST });
      expect(await firstResult).toMatchObject({ state: "committed" });
      const second = await secondDispatch;
      expect(second.commandStatesAtDispatch.get(firstId)).toBe("committed");
      expect(second.intent).toEqual(secondIntent);
      const secondResult = rig.handle.store
        .getState()
        .waitForWriteCommand(secondId);
      await rig.emitArtifactChanges([ticketRecord("Task", 1, 2)], [], 4);
      expect(recordFor(rig.handle, secondId)).toMatchObject({
        state: "pending",
        delivery: "sending",
      });
      second.resolve({ hostId: POOL_HOST });
      expect(await secondResult).toMatchObject({ state: "committed" });
      expect(writeCommandAlert(rig)).toBeNull();
    } finally {
      rig.handle.dispose();
    }
  });

  it("clears a computer hold on authority replacement and ignores its late answer for the next write", async () => {
    const rig = makeRig(COMPUTER_HOST);
    try {
      await seedArtifactScenario(rig, STATUS_HOLD);
      const firstDispatch = rig.nextDispatch();
      const firstId = await enqueueArtifactWrite(
        rig.handle,
        STATUS_HOLD.intent,
      );
      const first = await firstDispatch;
      const firstResult = rig.handle.store
        .getState()
        .waitForWriteCommand(firstId);
      await emitScenarioTarget(rig, STATUS_HOLD, 3);
      expect(recordFor(rig.handle, firstId)).toMatchObject({
        state: "pending",
        delivery: "sending",
      });

      await rig.emitArtifactReplacement(STATUS_HOLD.targetUpserts);
      expect(
        rig.handle.store.getState().artifacts.byId[TICKET_ID]?.status,
      ).toBe(1);
      expect(await firstResult).toMatchObject({
        state: "superseded",
        delivery: "settled",
      });

      const nextIntent: QueuedArtifactIntent = {
        kind: "update-artifact-status",
        artifactId: TICKET_ID,
        artifactType: "ticket",
        status: 2,
      };
      const nextDispatch = rig.nextDispatch();
      const nextId = await enqueueArtifactWrite(rig.handle, nextIntent);
      expect(recordFor(rig.handle, nextId)).toMatchObject({
        state: "pending",
        delivery: "queued",
        attempts: 0,
      });

      first.resolve({ hostId: COMPUTER_HOST });
      const next = await nextDispatch;
      expect(recordFor(rig.handle, firstId).state).toBe("superseded");
      expect(next.commandStatesAtDispatch.get(firstId)).toBe("superseded");
      expect(next.commandId).toBe(nextId);
      expect(recordFor(rig.handle, nextId)).toMatchObject({
        state: "pending",
        delivery: "sending",
        attempts: 1,
      });
      const nextResult = rig.handle.store
        .getState()
        .waitForWriteCommand(nextId);
      next.resolve({ hostId: COMPUTER_HOST });
      expect(await nextResult).toMatchObject({ state: "committed" });
    } finally {
      rig.handle.dispose();
    }
  });

  it("tears down a held delete without waiting for a terminal write row", async () => {
    const rig = makeRig(POOL_HOST);
    await seedArtifactScenario(rig, DELETE_HOLD);
    const dispatch = rig.nextDispatch();
    const commandId = await enqueueArtifactWrite(
      rig.handle,
      DELETE_HOLD.intent,
    );
    const sent = await dispatch;
    await emitScenarioTarget(rig, DELETE_HOLD, 3);
    expect(recordFor(rig.handle, commandId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });

    rig.handle.dispose();
    sent.resolve({ hostId: POOL_HOST });
    await sent.completion;
  });

  it.each([
    { name: "nonqueued rename", scenario: RENAME_HOLD },
    { name: "nonqueued reparent", scenario: REPARENT_HOLD },
  ])(
    "does not hold the $name overlay without a queued send",
    async ({ scenario }) => {
      const rig = makeRig(scenario.hostId);
      try {
        await seedArtifactScenario(rig, scenario);
        const requestId = await beginUnqueuedOverlay(rig, scenario);
        if (requestId === null) throw new Error("the overlay was not stamped");
        await emitScenarioTarget(rig, scenario, 3);
        expect(
          await rig.handle.store
            .getState()
            .retirePendingMutation(requestId, "landed"),
        ).toBe(false);
        expect(rig.dispatches).toHaveLength(0);
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it("supersedes the transferred rename when its first target observation changes", async () => {
    const rig = makeRig(POOL_HOST);
    try {
      await seedArtifactScenario(rig, RENAME_HOLD);
      const dispatch = rig.nextDispatch();
      const firstId = await enqueueArtifactWrite(
        rig.handle,
        RENAME_HOLD.intent,
      );
      const first = await dispatch;
      const firstResult = rig.handle.store
        .getState()
        .waitForWriteCommand(firstId);
      await emitScenarioTarget(rig, RENAME_HOLD, 3);
      const successor = ARTIFACT_SUCCESSOR_CASES[0];
      const successorId = await enqueueArtifactWrite(
        rig.handle,
        successor.successor,
      );
      const successorResult = rig.handle.store
        .getState()
        .waitForWriteCommand(successorId);
      expect(recordFor(rig.handle, firstId)).toMatchObject({
        state: "pending",
        delivery: "sending",
      });
      expect(recordFor(rig.handle, successorId)).toMatchObject({
        state: "pending",
        delivery: "queued",
        attempts: 0,
      });
      expect(rig.dispatches.map((write) => write.commandId)).toEqual([firstId]);

      await rig.emitArtifactChanges(
        RENAME_HOLD.changedUpserts,
        RENAME_HOLD.changedTombstones,
        4,
      );
      RENAME_HOLD.expectChanged(rig);
      expect(await firstResult).toMatchObject({ state: "superseded" });
      expect(await successorResult).toMatchObject({
        state: "superseded",
        attempts: 0,
      });

      first.resolve({ hostId: POOL_HOST });
      await first.completion;
      await drain(rig.handle);
      expect(rig.dispatches.map((write) => write.commandId)).toEqual([firstId]);
      expect(recordFor(rig.handle, successorId).attempts).toBe(0);
    } finally {
      rig.handle.dispose();
    }
  });
});

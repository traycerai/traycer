import { afterEach, describe, expect, it, vi } from "vitest";
import { epicStateSubscribeServerFrameSchemaV16 } from "@traycer/protocol/host/epic/state-subscribe";
import { epicStatusSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/status-subscribe";
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
  readonly emitTitle: (
    title: string,
    updatedAt: number,
    sequence: number,
  ) => Promise<void>;
  readonly emitReplacement: (title: string) => Promise<void>;
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
    transport.subscribes.findIndex(
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

  async function emitReplacement(title: string): Promise<void> {
    emitStatusAuthority(REPLACEMENT_EPOCH);
    const parsed = epicStateSubscribeServerFrameSchemaV16.parse({
      kind: "snapshot",
      hasBinaryPayload: false,
      authorityEpoch: REPLACEMENT_EPOCH,
      basis: "authorityEpochChanged",
      position: 1,
      reconciledWithCloud: true,
      epicMeta: { revision: 1, meta: { title, updatedAt: 3000 } },
      artifactRecords: [],
      deletedArtifacts: [],
      roleClaims: { revision: 1, claims: [] },
      commentThreads: [],
    });
    stateSession().emit(parsed, null);
    await drain(handle);
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
    emitTitle,
    emitReplacement,
    emitResumeTooOld,
    emitStatusAuthority,
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

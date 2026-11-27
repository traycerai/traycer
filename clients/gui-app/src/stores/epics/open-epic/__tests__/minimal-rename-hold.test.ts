import { describe, expect, it } from "vitest";
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
import type { CommandSendFailure } from "@traycer-clients/shared/replica-runtime";
import type { EpicLaneUnaries } from "../runtime/epic-replica-runtime";
import type { EpicWriteCommandIntent } from "../runtime/epic-write-command";
import {
  openStoreForTestAtHost,
  type OpenedStoreForTest,
} from "../test-support/open-store-for-test";
import { absentLaneUnaries } from "../test-support/absent-lane-unaries";

const EPIC_ID = "minimal-rename-hold-epic";
const POOL_HOST = POOL_HOST_ID;
const COMPUTER_HOST = "rename-hold-computer";
const INITIAL_EPOCH = "rename-hold-epoch-1";
const REPLACEMENT_EPOCH = "rename-hold-epoch-2";
const INITIAL_TITLE = "Alpha";
const TARGET_TITLE = "Beta";

type WriteReply = { readonly hostId: string } | CommandSendFailure;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

interface SentWrite {
  readonly commandId: string;
  readonly intent: EpicWriteCommandIntent;
  readonly resolve: (reply: WriteReply) => void;
}

interface RenameRig {
  readonly handle: OpenedStoreForTest;
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
        };
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

    await rig.emitTitle(TARGET_TITLE, 2000, 2);
    expect(rig.handle.store.getState().epic.title).toBe(TARGET_TITLE);
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

  it("retires a held title before stamping a successor enqueued after the echo", async () => {
    const rig = makeRig(POOL_HOST);
    await drain(rig.handle);

    const sendFirst = rig.nextDispatch();
    const firstId = await enqueueTitle(rig.handle, TARGET_TITLE, 2000);
    const first = await sendFirst;
    await rig.emitTitle(TARGET_TITLE, 2000, 2);
    expect(recordFor(rig.handle, firstId)).toMatchObject({
      state: "pending",
      delivery: "sending",
    });

    const firstResult = rig.handle.store
      .getState()
      .waitForWriteCommand(firstId);
    const sendSecond = rig.nextDispatch();
    const secondId = await enqueueTitle(rig.handle, "Gamma", 3000);
    expect(await firstResult).toMatchObject({ state: "superseded" });

    first.resolve({ hostId: POOL_HOST });
    const second = await sendSecond;
    expect(second.commandId).toBe(secondId);
    expect(second.intent).toEqual({
      kind: "update-epic-title",
      title: "Gamma",
      updatedAt: 3000,
    });
    expect(rig.handle.store.getState().epic.title).toBe("Gamma");

    const secondResult = rig.handle.store
      .getState()
      .waitForWriteCommand(secondId);
    second.resolve({ hostId: POOL_HOST });
    await rig.emitTitle("Gamma", 3000, 3);
    expect(await secondResult).toMatchObject({ state: "committed" });
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

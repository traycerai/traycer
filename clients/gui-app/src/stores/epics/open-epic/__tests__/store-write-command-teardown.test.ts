/**
 * `waitForWriteCommand` is a bare `new Promise((resolve) => …)` with no
 * reject, no timeout, no signal (`store.ts:1524-1543`). On a cross-host
 * re-point the registry disposes the outgoing handle, the worker's command
 * queue splices its records, and the waiter hangs forever - so
 * `enqueueAndWait` (`use-epic-node-mutations.ts`) never returns and the
 * sidebar's bulk delete leaves `deletePending` stuck true for the life of the
 * tab.
 *
 * Post-fix, `store.ts` exports `EpicSessionEndedError`, and
 * `waitForWriteCommand` rejects with it when the store disposes or detaches
 * its transport - and rejects immediately if called after either.
 *
 * `EpicSessionEndedError` does not exist yet, so a static import of it would
 * fail this file at IMPORT (a crash, not a red assertion). Assert on the
 * error's `name` instead via `errorName`, which keeps the file importable
 * before the fix and exact after it.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { createArtifactInDocForTests } from "@/stores/epics/open-epic/__tests__/projection-helpers-test-shims";
import {
  ensureMap,
  getEpicMap,
} from "@/stores/epics/open-epic/projection-helpers";
import {
  openStoreForTest,
  openStoreForTestWithQueuedBridge,
  type OpenStoreForTestOptions,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { writeFieldKey } from "@/stores/epics/open-epic/write-field-key";

const EPIC_ID = "epic-write-command-teardown";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** The exact shape `write-command-delivery.test.ts` uses to open the write gate. */
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

/**
 * Opens a store with the write gate already passed (transport open, a fresh
 * root snapshot) and one artifact seeded in the doc, and a `writeCommand`
 * that NEVER settles - so an enqueued command stays genuinely in flight, the
 * exact window `waitForWriteCommand` hangs in today.
 */
function openRigWithNeverSettlingWrite(
  queued: boolean,
  writeCommand: OpenStoreForTestOptions["writeCommand"] | undefined,
): {
  readonly handle: OpenedStoreForTest;
  readonly artifactId: string;
  readonly emitRemoteArtifactTitle: (title: string) => void;
} {
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
  const options = {
    epicId: EPIC_ID,
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand:
      writeCommand ??
      (() => new Promise<{ readonly hostId: string }>(() => {})),
  };
  const handle = queued
    ? openStoreForTestWithQueuedBridge(options)
    : openStoreForTest(options);
  if (captured.value === null) throw new Error("factory not invoked");
  // Transport open BEFORE the snapshot - see `write-command-delivery.test.ts`
  // for why the order matters.
  captured.value.onConnectionStatus("open", null, false, null);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  const artifactId = createArtifactInDocForTests(handle.doc, "spec", null);
  return {
    handle,
    artifactId,
    emitRemoteArtifactTitle: (title) => {
      const callbacks = captured.value;
      if (callbacks === null) throw new Error("factory not invoked");
      const stateVector = Y.encodeStateVector(handle.doc);
      const remoteDoc = new Y.Doc();
      Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(handle.doc));
      const artifact = ensureMap(getEpicMap(remoteDoc), "artifacts").get(
        artifactId,
      );
      if (!(artifact instanceof Y.Map)) {
        throw new Error("the echoed artifact was not present");
      }
      artifact.set("title", title);
      callbacks.onUpdate(Y.encodeStateAsUpdate(remoteDoc, stateVector));
      remoteDoc.destroy();
    },
  };
}

type ProjectionPatch = Parameters<OpenedStoreForTest["projection"]["apply"]>[0];

interface BufferedProjection {
  readonly patch: ProjectionPatch;
  readonly revision: number;
}

function holdProjectionDelivery(handle: OpenedStoreForTest): {
  readonly buffered: BufferedProjection[];
  readonly deliverAll: () => void;
  readonly deliverLatestForCommand: (commandId: string) => void;
} {
  const buffered: BufferedProjection[] = [];
  const apply = handle.projection.apply.bind(handle.projection);
  handle.projection.apply = (patch, revision) => {
    buffered.push({ patch, revision });
  };
  return {
    buffered,
    deliverAll: () => {
      for (const entry of buffered.splice(0)) {
        apply(entry.patch, entry.revision);
      }
    },
    deliverLatestForCommand: (commandId) => {
      const latest = buffered.findLast((entry) =>
        entry.patch.writeCommands?.some(
          (command) => command.commandId === commandId,
        ),
      );
      if (latest === undefined) {
        throw new Error("the queued bridge did not project the command");
      }
      buffered.length = 0;
      apply(latest.patch, latest.revision);
    },
  };
}

function errorName(value: unknown): string {
  return value instanceof Error ? value.name : `not-an-error:${String(value)}`;
}

/** Races a promise against a short timer, so a genuine hang reddens fast. */
function raceAgainstHang(waiter: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    waiter.then(
      () => "settled" as const,
      (cause: unknown) => cause,
    ),
    new Promise<"hung">((resolve) => {
      setTimeout(() => {
        resolve("hung");
      }, 250);
    }),
  ]);
}

describe("waitForWriteCommand settles when the session ends", () => {
  it("THE REDDENING ONE - rejects a waiter whose command was still in flight when the store was disposed", async () => {
    const { handle } = openRigWithNeverSettlingWrite(false, undefined);
    const artifactId = createArtifactInDocForTests(handle.doc, "ticket", null);

    const commandId = await handle.store.getState().enqueueWriteCommand({
      kind: "rename-artifact",
      artifactId,
      title: "New",
    });
    // A refusal must not masquerade as the pin passing.
    expect(commandId).not.toBeNull();
    if (commandId === null) {
      throw new Error("expected enqueueWriteCommand to mint a command id");
    }
    await handle.flush();
    const waiter = handle.store.getState().waitForWriteCommand(commandId);
    handle.dispose();

    const outcome = await raceAgainstHang(waiter);
    // Red today as `expected 'not-an-error:hung' to be 'EpicSessionEndedError'`
    // - the waiter genuinely hangs, so this races out at "hung".
    expect(errorName(outcome)).toBe("EpicSessionEndedError");
  });

  it("rejects a waiter created AFTER dispose() has already run", async () => {
    const { handle, artifactId } = openRigWithNeverSettlingWrite(
      false,
      undefined,
    );

    const commandId = await handle.store.getState().enqueueWriteCommand({
      kind: "rename-artifact",
      artifactId,
      title: "New",
    });
    expect(commandId).not.toBeNull();
    if (commandId === null) {
      throw new Error("expected enqueueWriteCommand to mint a command id");
    }
    await handle.flush();
    handle.dispose();
    const waiter = handle.store.getState().waitForWriteCommand(commandId);

    const outcome = await raceAgainstHang(waiter);
    expect(errorName(outcome)).toBe("EpicSessionEndedError");
  });

  it("rejects a waiter through detachTransport() too - the retention path detaches without disposing", async () => {
    const { handle, artifactId } = openRigWithNeverSettlingWrite(
      false,
      undefined,
    );

    const commandId = await handle.store.getState().enqueueWriteCommand({
      kind: "rename-artifact",
      artifactId,
      title: "New",
    });
    expect(commandId).not.toBeNull();
    if (commandId === null) {
      throw new Error("expected enqueueWriteCommand to mint a command id");
    }
    await handle.flush();
    const waiter = handle.store.getState().waitForWriteCommand(commandId);
    handle.detachTransport();

    const outcome = await raceAgainstHang(waiter);
    // A command in a socketless retained buffer can never be answered either.
    expect(errorName(outcome)).toBe("EpicSessionEndedError");
  });
});

describe("write-field admission at the real store bridge", () => {
  it("reserves synchronously across same-turn submissions and scopes the reservation to the field and item", async () => {
    const { handle } = openRigWithNeverSettlingWrite(false, undefined);
    const artifactId = createArtifactInDocForTests(handle.doc, "ticket", null);
    try {
      const first = handle.store.getState().submitWriteCommand({
        kind: "rename-artifact",
        artifactId,
        title: "First test title",
      });

      expect(
        handle.store.getState().occupiedWriteFields[
          writeFieldKey("rename", artifactId)
        ],
      ).toBe(true);
      const second = handle.store.getState().submitWriteCommand({
        kind: "rename-artifact",
        artifactId,
        title: "Second test title",
      });
      expect(second).toBe("busy");
      const otherField = await handle.store.getState().submitWriteCommand({
        kind: "update-artifact-status",
        artifactId,
        artifactType: "ticket",
        status: 2,
      });
      expect(otherField).not.toBeNull();
      const otherArtifactId = createArtifactInDocForTests(
        handle.doc,
        "spec",
        null,
      );
      const otherArtifact = await handle.store.getState().submitWriteCommand({
        kind: "rename-artifact",
        artifactId: otherArtifactId,
        title: "Other artifact title",
      });
      expect(otherArtifact).not.toBeNull();

      const firstId = await first;
      expect(firstId).not.toBeNull();
      await handle.flush();
      expect(
        handle.store
          .getState()
          .writeCommands.filter(
            (command) =>
              command.intent.kind === "rename-artifact" &&
              command.intent.artifactId === artifactId,
          ),
      ).toHaveLength(1);
      expect(
        handle.store.getState().occupiedWriteFields[
          writeFieldKey("rename", artifactId)
        ],
      ).toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it("keeps the field occupied when the command projection arrives before the enqueue reply", async () => {
    const { handle, artifactId } = openRigWithNeverSettlingWrite(
      true,
      undefined,
    );
    const key = writeFieldKey("rename", artifactId);
    let enqueueReplyObserved = false;
    let commandProjectedBeforeReply = false;
    const apply = handle.projection.apply.bind(handle.projection);
    handle.projection.apply = (patch, revision) => {
      if (
        !enqueueReplyObserved &&
        patch.writeCommands?.some(
          (command) =>
            command.intent.kind === "rename-artifact" &&
            command.intent.artifactId === artifactId,
        )
      ) {
        commandProjectedBeforeReply = true;
      }
      apply(patch, revision);
    };

    try {
      const submitted = handle.store.getState().submitWriteCommand({
        kind: "rename-artifact",
        artifactId,
        title: "First title",
      });
      if (submitted === "busy")
        throw new Error("the initial rename was refused");
      const commandIdResult = submitted.then((commandId) => {
        enqueueReplyObserved = true;
        return commandId;
      });

      await handle.flush();
      const commandId = await commandIdResult;
      expect(commandId).not.toBeNull();
      expect(commandProjectedBeforeReply).toBe(true);
      expect(
        handle.store
          .getState()
          .writeCommands.some((command) => command.commandId === commandId),
      ).toBe(true);
      expect(handle.store.getState().occupiedWriteFields[key]).toBe(true);
      expect(
        handle.store.getState().submitWriteCommand({
          kind: "rename-artifact",
          artifactId,
          title: "Second title",
        }),
      ).toBe("busy");
    } finally {
      handle.dispose();
    }
  });

  it("keeps a synchronous reservation until a delayed command projection arrives after the enqueue reply", async () => {
    const { handle, artifactId } = openRigWithNeverSettlingWrite(
      true,
      undefined,
    );
    const key = writeFieldKey("rename", artifactId);
    const projections = holdProjectionDelivery(handle);

    try {
      const submitted = handle.store.getState().submitWriteCommand({
        kind: "rename-artifact",
        artifactId,
        title: "First title",
      });
      if (submitted === "busy")
        throw new Error("the initial rename was refused");
      const flush = handle.flush();
      const commandId = await submitted;
      await flush;
      expect(commandId).not.toBeNull();
      await handle.flush();
      expect(handle.store.getState().writeCommands).toHaveLength(0);
      expect(handle.store.getState().occupiedWriteFields[key]).toBe(true);
      expect(
        handle.store.getState().submitWriteCommand({
          kind: "rename-artifact",
          artifactId,
          title: "Second title",
        }),
      ).toBe("busy");

      projections.deliverAll();
      expect(
        handle.store
          .getState()
          .writeCommands.some((command) => command.commandId === commandId),
      ).toBe(true);
      expect(handle.store.getState().occupiedWriteFields[key]).toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it("keeps a fast successful answer busy while its landed overlay awaits an echo", async () => {
    const { handle, artifactId } = openRigWithNeverSettlingWrite(true, () =>
      Promise.resolve({ hostId: "test-host" }),
    );
    const key = writeFieldKey("rename", artifactId);
    const projections = holdProjectionDelivery(handle);

    try {
      const submitted = handle.store.getState().submitWriteCommand({
        kind: "rename-artifact",
        artifactId,
        title: "Settled title",
      });
      if (submitted === "busy")
        throw new Error("the initial rename was refused");
      await handle.flush();
      const commandId = await submitted;
      expect(commandId).not.toBeNull();
      if (commandId === null)
        throw new Error("the fast-settled command did not receive an id");

      const fastSwept = projections.buffered.findLast((entry) =>
        entry.patch.writeCommands?.some(
          (command) =>
            command.commandId === commandId && command.state === "committed",
        ),
      );
      expect(fastSwept).toBeDefined();
      projections.deliverAll();

      expect(
        handle.store
          .getState()
          .writeCommands.find((command) => command.commandId === commandId)
          ?.state,
      ).toBe("committed");
      // The committed result's landed overlay still owns the field until an
      // echo or its TTL; the command list being fast-swept cannot unlock it.
      expect(handle.store.getState().occupiedWriteFields[key]).toBe(true);
      expect(
        handle.store.getState().submitWriteCommand({
          kind: "rename-artifact",
          artifactId,
          title: "Next title",
        }),
      ).toBe("busy");
    } finally {
      handle.dispose();
    }
  });

  it("holds the renderer reservation until the enqueue reply and fast-swept echo projection arrive", async () => {
    const { handle, artifactId, emitRemoteArtifactTitle } =
      openRigWithNeverSettlingWrite(true, () =>
        Promise.resolve({ hostId: "test-host" }),
      );
    const key = writeFieldKey("rename", artifactId);
    const projections = holdProjectionDelivery(handle);

    try {
      const submitted = handle.store.getState().submitWriteCommand({
        kind: "rename-artifact",
        artifactId,
        title: "Echoed title",
      });
      if (submitted === "busy")
        throw new Error("the initial rename was refused");
      const flush = handle.flush();
      const commandId = await submitted;
      if (commandId === null)
        throw new Error("the command did not receive an id");
      await flush;

      const fastSettled = projections.buffered.findLast((entry) =>
        entry.patch.writeCommands?.some(
          (command) =>
            command.commandId === commandId && command.state === "committed",
        ),
      );
      expect(fastSettled).toBeDefined();
      expect(handle.store.getState().writeCommands).toHaveLength(0);
      expect(handle.store.getState().occupiedWriteFields[key]).toBe(true);
      expect(
        handle.store.getState().submitWriteCommand({
          kind: "rename-artifact",
          artifactId,
          title: "Before echo projection",
        }),
      ).toBe("busy");

      emitRemoteArtifactTitle("Echoed title");
      await handle.flush();
      expect(
        projections.buffered.some(
          ({ patch }) =>
            patch.occupiedWriteFields !== undefined &&
            !(key in patch.occupiedWriteFields),
        ),
      ).toBe(true);
      expect(
        projections.buffered.some((entry) =>
          entry.patch.writeCommands?.some(
            (command) => command.commandId === commandId,
          ),
        ),
      ).toBe(true);
      expect(handle.store.getState().occupiedWriteFields[key]).toBe(true);

      projections.deliverAll();

      expect(handle.store.getState().occupiedWriteFields[key]).toBeUndefined();
      const next = handle.store.getState().submitWriteCommand({
        kind: "rename-artifact",
        artifactId,
        title: "Next title",
      });
      if (next === "busy")
        throw new Error("the echoed rename field stayed busy");
      const nextFlush = handle.flush();
      expect(await next).not.toBeNull();
      await nextFlush;
    } finally {
      handle.dispose();
    }
  });

  it("retains projected pending membership on detach while releasing an unprojected local reservation", async () => {
    const pending = openRigWithNeverSettlingWrite(false, undefined);
    const command = pending.handle.store.getState().enqueueWriteCommand({
      kind: "rename-artifact",
      artifactId: pending.artifactId,
      title: "Pending title",
    });
    await pending.handle.flush();
    const commandId = await command;
    expect(commandId).not.toBeNull();
    const pendingKey = writeFieldKey("rename", pending.artifactId);
    expect(
      pending.handle.store.getState().occupiedWriteFields[pendingKey],
    ).toBe(true);
    pending.handle.detachTransport();
    expect(
      pending.handle.store.getState().occupiedWriteFields[pendingKey],
    ).toBe(true);
    pending.handle.dispose();

    const unprojected = openRigWithNeverSettlingWrite(true, undefined);
    const beforeProjection = unprojected.handle.store
      .getState()
      .submitWriteCommand({
        kind: "rename-artifact",
        artifactId: unprojected.artifactId,
        title: "Reserved title",
      });
    if (beforeProjection === "busy")
      throw new Error("the initial title reservation was refused");
    void beforeProjection.catch(() => undefined);
    const unprojectedKey = writeFieldKey("rename", unprojected.artifactId);
    expect(
      unprojected.handle.store.getState().occupiedWriteFields[unprojectedKey],
    ).toBe(true);
    unprojected.handle.detachTransport();
    expect(
      unprojected.handle.store.getState().occupiedWriteFields[unprojectedKey],
    ).toBeUndefined();
    unprojected.handle.dispose();
  });

  it("detach clears landed membership while an unresolved pending field stays occupied", async () => {
    const hostAnswer: {
      resolve: ((value: { readonly hostId: string }) => void) | null;
    } = { resolve: null };
    const landed = openRigWithNeverSettlingWrite(
      false,
      () =>
        new Promise<{ readonly hostId: string }>((resolve) => {
          hostAnswer.resolve = resolve;
        }),
    );
    try {
      const landedId = await landed.handle.store
        .getState()
        .enqueueWriteCommand({
          kind: "rename-artifact",
          artifactId: landed.artifactId,
          title: "Landed title",
        });
      expect(landedId).not.toBeNull();
      await landed.handle.flush();
      if (hostAnswer.resolve === null)
        throw new Error("expected the host write to start");
      hostAnswer.resolve({ hostId: "test-host" });
      await landed.handle.flush();
      if (landedId === null) throw new Error("expected an admitted command id");
      await expect(
        landed.handle.store.getState().waitForWriteCommand(landedId),
      ).resolves.toMatchObject({ state: "committed" });

      const landedKey = writeFieldKey("rename", landed.artifactId);
      expect(
        landed.handle.store.getState().occupiedWriteFields[landedKey],
      ).toBe(true);
      landed.handle.detachTransport();
      expect(
        landed.handle.store.getState().occupiedWriteFields[landedKey],
      ).toBeUndefined();
    } finally {
      landed.handle.dispose();
    }
  });
});

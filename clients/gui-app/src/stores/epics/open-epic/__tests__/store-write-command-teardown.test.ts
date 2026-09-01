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
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

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
function openRigWithNeverSettlingWrite(): {
  readonly handle: OpenedStoreForTest;
  readonly artifactId: string;
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
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: () => new Promise<{ readonly hostId: string }>(() => {}),
  });
  if (captured.value === null) throw new Error("factory not invoked");
  // Transport open BEFORE the snapshot - see `write-command-delivery.test.ts`
  // for why the order matters.
  captured.value.onConnectionStatus("open", null, false);
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  const artifactId = createArtifactInDocForTests(handle.doc, "spec", null);
  return { handle, artifactId };
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
    const { handle, artifactId } = openRigWithNeverSettlingWrite();

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
    const { handle, artifactId } = openRigWithNeverSettlingWrite();

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
    const { handle, artifactId } = openRigWithNeverSettlingWrite();

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

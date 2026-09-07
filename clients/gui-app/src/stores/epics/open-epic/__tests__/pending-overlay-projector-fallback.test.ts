/**
 * `epic-projector.ts`'s incremental-vs-full-projection fork: with a pending metadata mutation in
 * flight, an ordinary doc edit must still take the FULL projection path so the overlay stays
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createArtifactInDocForTests } from "./projection-helpers-test-shims";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-test",
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

function newSession(): {
  handle: OpenedStoreForTest;
  callbacks: EpicStreamCallbacks;
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
    epicId: "epic-test",
    userId: null,
    // `handle.doc` still resolves because this harness builds the runtime in THIS thread.
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes, so a write in
    // one that said so fails rather than resolving quietly.
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  const seed = Y.encodeStateAsUpdate(new Y.Doc());
  captured.value.onSnapshot(makeMeta(), seed);
  return { handle, callbacks: captured.value };
}

describe("projector full-projection fallback while a mutation is pending", () => {
  it("an UNRELATED artifact's doc edit still shows the pending row's overlay", async () => {
    const { handle } = newSession();
    const renamed = createArtifactInDocForTests(handle.doc, "spec", null);
    const other = createArtifactInDocForTests(handle.doc, "ticket", null);

    const requestId = await handle.store
      .getState()
      .beginRenameMutation(renamed, "Optimistic title");
    if (requestId === null) throw new Error("expected a request id");
    expect(handle.store.getState().artifacts.byId[renamed].title).toBe(
      "Optimistic title",
    );

    // An ordinary doc edit on a DIFFERENT node.
    await handle.store.getState().renameArtifact(other, "Other renamed");

    expect(handle.store.getState().artifacts.byId[other].title).toBe(
      "Other renamed",
    );
    // The overlay must still be applied - this is the fallback under test.
    expect(handle.store.getState().artifacts.byId[renamed].title).toBe(
      "Optimistic title",
    );
    handle.dispose();
  });

  it("reference stabilization: an untouched bystander row keeps its === identity through the full-projection fallback", async () => {
    const { handle } = newSession();
    const renamed = createArtifactInDocForTests(handle.doc, "spec", null);
    const other = createArtifactInDocForTests(handle.doc, "ticket", null);
    const bystander = createArtifactInDocForTests(handle.doc, "spec", null);
    const bystanderBefore = handle.store.getState().artifacts.byId[bystander];

    const requestId = await handle.store
      .getState()
      .beginRenameMutation(renamed, "Optimistic title");
    if (requestId === null) throw new Error("expected a request id");

    await handle.store.getState().renameArtifact(other, "Other renamed");

    expect(handle.store.getState().artifacts.byId[bystander]).toBe(
      bystanderBefore,
    );
    handle.dispose();
  });

  it("a doc edit that lands the pending row's OWN authoritative value keeps showing the overlay's chain rules", async () => {
    const { handle } = newSession();
    const id = createArtifactInDocForTests(handle.doc, "spec", null);

    const requestId = await handle.store
      .getState()
      .beginRenameMutation(id, "Optimistic title");
    if (requestId === null) throw new Error("expected a request id");

    // Simulate the host's own dual-write reaching the doc for THIS row while the mutation is still
    // pending (the scenario the module doc calls out: "a doc patch during that window is not rare, it
    const rawArtifactsMap = handle.doc.getMap("epic").get("artifacts");
    if (!(rawArtifactsMap instanceof Y.Map)) throw new Error("expected map");
    const artifactsMap: Y.Map<unknown> = rawArtifactsMap;
    const rawEntry = artifactsMap.get(id);
    if (!(rawEntry instanceof Y.Map)) throw new Error("expected entry");
    const entry: Y.Map<unknown> = rawEntry;
    handle.doc.transact(() => {
      entry.set("title", "Optimistic title");
      entry.set("updatedAt", 123);
    });

    // Still shows the optimistic title.
    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Optimistic title",
    );
    handle.dispose();
  });

  it("once the overlay empties, the next doc edit resumes the incremental path without error", async () => {
    const { handle } = newSession();
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const requestId = await handle.store
      .getState()
      .beginRenameMutation(id, "Optimistic title");
    if (requestId === null) throw new Error("expected a request id");
    await handle.store.getState().retirePendingMutation(requestId, "failed");

    await handle.store.getState().renameArtifact(id, "Plain rename");

    expect(handle.store.getState().artifacts.byId[id].title).toBe(
      "Plain rename",
    );
    handle.dispose();
  });
});

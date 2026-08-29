/**
 * Persist path for an artifact sidebar reparent: a live `createOpenEpicStore`
 * (not the routing-test store stub) plus the real session registry, so a drop
 * actually moves `parentId` on the Y.Doc and fires `epic.reparentArtifact`.
 *
 * The projector suite already covers the store action in isolation
 * (`epic-projector.test.ts` "structural change (parent move) updates
 * childrenByParent buckets"). This file is the commit-level proof that the
 * commit is not a persist no-op.
 *
 * RETARGETED for T11's write-command queue. It used to assert a DUAL WRITE -
 * the local Y `parentId` moved AND `epic.reparentArtifact` went out - because
 * that is what the commit did. The queue now owns the write: the drop enqueues
 * a `reparent-artifact` command, the optimistic overlay moves the PROJECTION
 * immediately, and the doc is not written locally at all. A surviving direct Y
 * write would apply the move twice, once locally and once when the command
 * commits, which is the double-apply the queue exists to prevent - so the
 * absence of it is now part of what this file proves. Reload/second-session
 * against a real host is out of scope here.
 *
 * Only `getEpicSessionHandleHostClient` is stubbed — the same request seam
 * the routing suite uses — so peek returns the live handle. The rest of the
 * registry stays real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import * as Y from "yjs";
import { commitSidebarReparentDrop } from "@/components/epic-canvas/dnd/root-dnd-commits";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { getArtifactEntry } from "@/stores/epics/open-epic/projection-helpers";
import { createArtifactInDocForTests } from "@/stores/epics/open-epic/__tests__/projection-helpers-test-shims";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

const seam = vi.hoisted(() => ({
  request: vi.fn<(method: string, params: unknown) => Promise<unknown>>(),
  hasClient: true,
}));

vi.mock("@/lib/registries/epic-session-registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/registries/epic-session-registry")
    >();
  return {
    ...actual,
    getEpicSessionHandleHostClient: () =>
      seam.hasClient ? { request: seam.request } : null,
  };
});

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-1",
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

function newSession(): OpenEpicStoreHandle {
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
  const handle = createOpenEpicStore({
    epicId: "epic-1",
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  const seed = Y.encodeStateAsUpdate(new Y.Doc());
  captured.value.onSnapshot(makeMeta(), seed);
  return handle;
}

const queryClient = new QueryClient();

describe("commitSidebarReparentDrop persists an artifact reparent on a live doc", () => {
  afterEach(() => {
    __getOpenEpicRegistryForTests().disposeAll();
  });

  beforeEach(() => {
    seam.request.mockClear();
    seam.request.mockResolvedValue({ updated: true });
    seam.hasClient = true;
  });

  it("moves the projected parent optimistically and leaves the doc to the queue", () => {
    const handle = newSession();
    const parent = createArtifactInDocForTests(handle.doc, "spec", null);
    const child = createArtifactInDocForTests(handle.doc, "spec", null);
    __getOpenEpicRegistryForTests().acquireMounted("epic-1", () => handle);

    const childBefore = getArtifactEntry(handle.doc, child);
    if (childBefore === null) throw new Error("seeded child missing from doc");
    expect(childBefore.get("parentId")).toBeNull();

    commitSidebarReparentDrop({
      epicId: "epic-1",
      sourceNodeId: child,
      newParentId: parent,
      panelId: "artifacts",
      viewTabId: "tab-1",
      queryClient,
    });

    // The user sees the move immediately - that is the optimistic overlay the
    // queue stamps on enqueue, and it is what makes the drop feel committed
    // before any round trip.
    expect(handle.store.getState().tree.nodeById[child].parentId).toBe(parent);

    // The command is queued, carrying exactly the intent the direct pair used
    // to express.
    const queued = handle.store.getState().writeCommands;
    expect(queued).toHaveLength(1);
    expect(queued[0].intent).toEqual({
      kind: "reparent-artifact",
      artifactId: child,
      parentId: parent,
    });

    // And the doc is NOT written locally. The queue is the only writer; a
    // direct Y write beside it would apply the move twice.
    const childAfter = getArtifactEntry(handle.doc, child);
    if (childAfter === null)
      throw new Error("child missing from doc after drop");
    expect(childAfter.get("parentId")).toBeNull();
    // The RPC is the queue's to send on its own schedule, not this commit's.
    expect(seam.request).not.toHaveBeenCalled();
  });
});

import * as Y from "yjs";
import {
  __setEpicStreamClientFactoryForTests,
  __getOpenEpicRegistryForTests,
} from "@/lib/registries/epic-session-registry";
import type {
  EpicStreamCallbacks,
  EpicStreamClient,
} from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";

interface FakeStream {
  callbacks: EpicStreamCallbacks;
  applied: Uint8Array[];
}

function makeMeta(
  epicId: string,
  permissionRole: PermissionRole | null,
): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight:
      permissionRole === null
        ? null
        : {
            id: epicId,
            title: `Epic ${epicId}`,
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
    permissionRole,
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

export interface TestEpicHarness {
  /** Forward `seed` (a `(donor: Y.Doc) => void`) so the helper can also
   * be used purely for layout-only sidebar tests that read no doc data.
   * Pass `null` for both args to install with no seed and editor role. */
  readonly install: (
    seed: ((doc: Y.Doc) => void) | null,
    permissionRole: PermissionRole | null,
  ) => void;
  readonly teardown: () => void;
}

/**
 * Test seam: install a deterministic in-memory stream client factory that
 * fires a single snapshot frame with the seeded Y.Doc immediately when
 * the provider first acquires its handle, so any consumer hook reading
 * the per-Epic store state observes `snapshotLoaded === true` from the
 * first render.
 *
 * Call `install()` in `beforeEach` BEFORE rendering, and `teardown()` in
 * `afterEach` to clear the factory + dispose the registry so subsequent
 * tests start from a clean slate.
 */
export function createEpicSessionTestHarness(epicId: string): TestEpicHarness {
  return {
    install: (
      seed: ((doc: Y.Doc) => void) | null,
      permissionRole: PermissionRole | null,
    ) => {
      __setEpicStreamClientFactoryForTests((_factoryEpicId, callbacks) => {
        const stream: FakeStream = { callbacks, applied: [] };
        const donor = new Y.Doc();
        if (seed !== null) {
          seed(donor);
        }
        const snapshot = Y.encodeStateAsUpdate(donor);
        // Fire connection + snapshot via setTimeout(0) so the per-Epic
        // store's `create()` has fully returned before the callbacks
        // touch state - calling them synchronously inside the factory
        // would race the initial-state construction. Tests await one
        // act() tick after render to flush this.
        setTimeout(() => {
          stream.callbacks.onConnectionStatus("open", null);
          stream.callbacks.onSnapshot(
            makeMeta(epicId, permissionRole),
            snapshot,
          );
        }, 0);
        const client: Pick<
          EpicStreamClient,
          | "applyUpdate"
          | "awareness"
          | "applyArtifactRoomUpdate"
          | "artifactRoomAwareness"
          | "retryMigration"
          | "close"
        > = {
          applyUpdate: (bytes) => {
            stream.applied.push(bytes);
          },
          awareness: () => undefined,
          applyArtifactRoomUpdate: () => undefined,
          artifactRoomAwareness: () => undefined,
          retryMigration: () => undefined,
          close: () => undefined,
        };
        return client;
      });
    },
    teardown: () => {
      __setEpicStreamClientFactoryForTests(null);
      __getOpenEpicRegistryForTests().disposeAll();
    },
  };
}

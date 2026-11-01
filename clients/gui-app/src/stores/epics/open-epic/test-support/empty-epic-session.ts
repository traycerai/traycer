import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import {
  getOpenEpicRegistry,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeEmptySessionMeta(epicId: string): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: epicId,
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
 * A live, loaded Epic session with an EMPTY tree - the projection a remote
 * deletion leaves behind once it has synced. No `tuiAgents`/`chats` entry is
 * ever seeded for the closed row, and `epic.listTuiAgents` has not answered
 * until a case says so.
 */
export function newEmptyEpicSession(
  epicId: string,
  hostId: string,
): OpenedStoreForTest {
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
    epicId,
    userId: null,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  captured.value.onSnapshot(
    makeEmptySessionMeta(epicId),
    Y.encodeStateAsUpdate(new Y.Doc()),
  );
  getOpenEpicRegistry().acquireMounted(epicId, () => handle);
  const sessionHandle = getOpenEpicRegistry().peek(epicId);
  if (sessionHandle === null) throw new Error("expected a mounted session");
  // The record gate judges same-host-ness against the
  // SESSION's own stamped host, not the app-wide effective one.
  handleHostIds.set(sessionHandle, hostId);
  return handle;
}

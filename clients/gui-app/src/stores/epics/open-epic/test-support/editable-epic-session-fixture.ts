import * as Y from "yjs";
import type { EpicStreamClientFactory } from "../store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  openStoreForTestAtHost,
  type OpenedStoreForTest,
} from "./open-store-for-test";
import type { EpicWriteCommandIntent } from "../runtime/epic-write-command";

export interface EditableEpicSessionFixture {
  readonly handle: OpenedStoreForTest;
  release(): void;
}

export function registerEditableEpicSession(input: {
  readonly epicId: string;
  readonly title: string;
  readonly userId: string | null;
  readonly hostId: string;
  readonly writes: EpicWriteCommandIntent[];
  readonly deferWriteCompletion?: boolean;
}): EditableEpicSessionFixture {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const streamClientFactory: EpicStreamClientFactory = (_id, callbacks) => {
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
  const handle = openStoreForTestAtHost(
    {
      epicId: input.epicId,
      userId: input.userId,
      factories: { streamClientFactory, laneSelection: null },
      writeCommand: (_commandId, intent) => {
        input.writes.push(intent);
        if (input.deferWriteCompletion === true) {
          return new Promise<{ readonly hostId: string }>(() => undefined);
        }
        return Promise.resolve({ hostId: input.hostId });
      },
    },
    input.hostId,
  );
  if (captured.value === null) throw new Error("stream factory not invoked");
  captured.value.onConnectionStatus("open", null, false, null);
  captured.value.onSnapshot(
    snapshotMeta(input.epicId, input.title),
    Y.encodeStateAsUpdate(new Y.Doc()),
  );
  const registry = __getOpenEpicRegistryForTests();
  registry.acquire(input.epicId, () => handle);
  return {
    handle,
    release: () => registry.release(input.epicId, "discard", null),
  };
}

function snapshotMeta(epicId: string, title: string): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: epicId,
      title,
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "editable-epic-session-fixture",
      version: "1",
    },
    permissionRole: "owner",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: btoa(
      String.fromCharCode(...Y.encodeStateVector(new Y.Doc())),
    ),
  };
}

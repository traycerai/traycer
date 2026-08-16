import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearChatForkWorkspace,
  clearChatForkWorkspacesForEpic,
} from "@/lib/worktree/chat-fork-workspace-staging";
import {
  pendingForkChatStagingKey,
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
} from "@/stores/worktree/worktree-intent-staging-store";
import {
  readSeededWorkspaceSnapshot,
  seededWorkspaceSnapshotKeyIds,
  useSeededWorkspaceSnapshotStore,
} from "@/stores/worktree/seeded-workspace-snapshot-store";

const EPIC_A = "epic-A";
const EPIC_B = "epic-B";
const HOST_1 = "host-1";
const HOST_2 = "host-2";

const FOLDER = {
  path: "/repo/a",
  name: "a",
  repoIdentifier: null,
  hostId: null,
};

function seedSlot(epicId: string, hostId: string): void {
  const key = pendingForkChatStagingKey(epicId, hostId);
  useSeededWorkspaceSnapshotStore.getState().setSnapshot(key, {
    folders: [FOLDER.path],
    folderInfoByPath: { [FOLDER.path]: FOLDER },
    primaryPath: FOLDER.path,
  });
  useWorktreeIntentStagingStore.getState().setIntent(key, {
    entries: [
      {
        kind: "local",
        workspacePath: FOLDER.path,
        repoIdentifier: null,
        isPrimary: true,
      },
    ],
  });
}

describe("chat-fork-workspace-staging", () => {
  beforeEach(() => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
  });

  afterEach(() => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    useSeededWorkspaceSnapshotStore.getState().resetForTests();
  });

  it("clears one host slot's intent and snapshot together", () => {
    seedSlot(EPIC_A, HOST_1);
    seedSlot(EPIC_A, HOST_2);
    clearChatForkWorkspace(pendingForkChatStagingKey(EPIC_A, HOST_1));

    expect(
      readStagedWorktreeIntent(pendingForkChatStagingKey(EPIC_A, HOST_1)),
    ).toBeNull();
    expect(
      readSeededWorkspaceSnapshot(pendingForkChatStagingKey(EPIC_A, HOST_1)),
    ).toBeNull();
    expect(
      readStagedWorktreeIntent(pendingForkChatStagingKey(EPIC_A, HOST_2)),
    ).not.toBeNull();
  });

  it("clears every host slot staged for an epic, including snapshot-only keys", () => {
    seedSlot(EPIC_A, HOST_1);
    const snapshotOnly = pendingForkChatStagingKey(EPIC_A, HOST_2);
    useSeededWorkspaceSnapshotStore.getState().setSnapshot(snapshotOnly, {
      folders: [FOLDER.path],
      folderInfoByPath: { [FOLDER.path]: FOLDER },
      primaryPath: FOLDER.path,
    });
    seedSlot(EPIC_B, HOST_1);

    expect(seededWorkspaceSnapshotKeyIds()).toEqual(
      expect.arrayContaining([
        worktreeStagingKeyString(pendingForkChatStagingKey(EPIC_A, HOST_1)),
        worktreeStagingKeyString(snapshotOnly),
      ]),
    );

    clearChatForkWorkspacesForEpic(EPIC_A);

    expect(
      readStagedWorktreeIntent(pendingForkChatStagingKey(EPIC_A, HOST_1)),
    ).toBeNull();
    expect(readSeededWorkspaceSnapshot(snapshotOnly)).toBeNull();
    expect(
      readStagedWorktreeIntent(pendingForkChatStagingKey(EPIC_B, HOST_1)),
    ).not.toBeNull();
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import { useQueueEditWorkspace } from "@/components/epic-canvas/renderers/use-queue-edit-workspace";
import {
  queueEditStagingKey,
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";

const HOST_ID = "host-a";
const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const QUEUE_ITEM_ID = "queue-item-1";

const OWNER_SLOT: WorktreeStagingKey = {
  surface: "owner",
  hostId: HOST_ID,
  epicId: EPIC_ID,
  ownerKind: "chat",
  ownerId: CHAT_ID,
};
const EDIT_SLOT = queueEditStagingKey(HOST_ID, EPIC_ID, CHAT_ID, QUEUE_ITEM_ID);

function localIntent(path: string): WorktreeIntent {
  return {
    entries: [
      {
        kind: "local",
        workspacePath: path,
        repoIdentifier: null,
        isPrimary: false,
      },
    ],
  };
}

function renderEditing(editingQueueItemId: string | null) {
  return renderHook(
    (props: { readonly editingQueueItemId: string | null }) =>
      useQueueEditWorkspace({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        editingQueueItemId: props.editingQueueItemId,
        rowWorktreeIntent: null,
        seeded: null,
        carriesWorktreeIntent: true,
        missingWorktreePaths: [],
      }),
    { initialProps: { editingQueueItemId } },
  );
}

afterEach(() => {
  useWorktreeIntentStagingStore.getState().resetForTests();
});

describe("useQueueEditWorkspace", () => {
  it("is null while no queued message is edited", () => {
    expect(renderEditing(null).result.current).toBeNull();
  });

  it("reports a change only once a folder is picked that the row does not already have", () => {
    const { result } = renderEditing(QUEUE_ITEM_ID);
    expect(result.current?.changesWorkspace).toBe(false);

    act(() => {
      useWorktreeIntentStagingStore
        .getState()
        .setIntent(EDIT_SLOT, localIntent("/repo/a"));
    });

    expect(result.current?.changesWorkspace).toBe(true);
  });

  it("clears the edit's slot and leaves the chat's own pick as it was when the edit is cancelled", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(OWNER_SLOT, localIntent("/repo/earlier"));
    const view = renderEditing(QUEUE_ITEM_ID);
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(EDIT_SLOT, localIntent("/repo/a"));

    view.rerender({ editingQueueItemId: null });

    expect(readStagedWorktreeIntent(EDIT_SLOT)).toBeNull();
    expect(readStagedWorktreeIntent(OWNER_SLOT)).toEqual(
      localIntent("/repo/earlier"),
    );
  });

  it("clears the edit's slot when the tile unmounts mid-edit", () => {
    const view = renderEditing(QUEUE_ITEM_ID);
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(EDIT_SLOT, localIntent("/repo/a"));

    view.unmount();

    expect(readStagedWorktreeIntent(EDIT_SLOT)).toBeNull();
  });
});

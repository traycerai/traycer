import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  WorktreeBinding,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import type { SeededWorktreeIntentDisplay } from "@/stores/chats/chat-session-store";
import {
  useQueueEditWorkspace,
  type QueueEditSession,
} from "@/components/epic-canvas/renderers/use-queue-edit-workspace";
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

const SESSION_A: QueueEditSession = {
  queueItemId: QUEUE_ITEM_ID,
  sessionId: "session-a",
};
const SESSION_B: QueueEditSession = {
  queueItemId: QUEUE_ITEM_ID,
  sessionId: "session-b",
};

const OWNER_SLOT: WorktreeStagingKey = {
  surface: "owner",
  hostId: HOST_ID,
  epicId: EPIC_ID,
  ownerKind: "chat",
  ownerId: CHAT_ID,
};

function slotOf(edit: QueueEditSession): WorktreeStagingKey {
  return queueEditStagingKey(HOST_ID, EPIC_ID, CHAT_ID, edit);
}

function importIntent(path: string): WorktreeIntent {
  return {
    entries: [
      {
        kind: "import",
        workspacePath: path,
        repoIdentifier: null,
        isPrimary: false,
        worktreePath: `${path}-wt`,
      },
    ],
  };
}

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

interface EditProps {
  readonly edit: QueueEditSession | null;
  readonly carriesWorktreeIntent: boolean | null;
  readonly rowWorktreeIntent: WorktreeIntent | null;
  readonly seeded: SeededWorktreeIntentDisplay | null;
  readonly binding: WorktreeBinding | null;
  readonly missingWorktreePaths: ReadonlyArray<string>;
}

function renderEditing(initial: EditProps) {
  return renderHook(
    (props: EditProps) =>
      useQueueEditWorkspace({
        hostId: HOST_ID,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        edit: props.edit,
        rowWorktreeIntent: props.rowWorktreeIntent,
        seeded: props.seeded,
        binding: props.binding,
        carriesWorktreeIntent: props.carriesWorktreeIntent,
        missingWorktreePaths: props.missingWorktreePaths,
      }),
    { initialProps: initial },
  );
}

function editing(edit: QueueEditSession | null): EditProps {
  return {
    edit,
    carriesWorktreeIntent: true,
    rowWorktreeIntent: null,
    seeded: null,
    binding: null,
    missingWorktreePaths: [],
  };
}

function pick(edit: QueueEditSession, path: string): void {
  act(() => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(slotOf(edit), localIntent(path));
  });
}

afterEach(() => {
  useWorktreeIntentStagingStore.getState().resetForTests();
});

describe("useQueueEditWorkspace", () => {
  it("is null while no queued message is edited", () => {
    expect(renderEditing(editing(null)).result.current).toBeNull();
  });

  it("reports a change only once a folder is picked that the row does not already have", () => {
    const { result } = renderEditing(editing(SESSION_A));
    expect(result.current?.changesWorkspace).toBe(false);

    pick(SESSION_A, "/repo/a");

    expect(result.current?.changesWorkspace).toBe(true);
  });

  it("clears the edit's slot and leaves the chat's own pick as it was when the edit is cancelled", () => {
    useWorktreeIntentStagingStore
      .getState()
      .setIntent(OWNER_SLOT, localIntent("/repo/earlier"));
    const view = renderEditing(editing(SESSION_A));
    pick(SESSION_A, "/repo/a");

    view.rerender(editing(null));

    expect(readStagedWorktreeIntent(slotOf(SESSION_A))).toBeNull();
    expect(readStagedWorktreeIntent(OWNER_SLOT)).toEqual(
      localIntent("/repo/earlier"),
    );
  });

  it("clears the edit's slot when the tile unmounts mid-edit", () => {
    const view = renderEditing(editing(SESSION_A));
    pick(SESSION_A, "/repo/a");

    view.unmount();

    expect(readStagedWorktreeIntent(slotOf(SESSION_A))).toBeNull();
  });

  it("keeps two editing sessions of the same row apart", () => {
    const a = renderEditing(editing(SESSION_A));
    const b = renderEditing(editing(SESSION_B));

    pick(SESSION_A, "/repo/a");

    expect(a.result.current?.changesWorkspace).toBe(true);
    expect(b.result.current?.changesWorkspace).toBe(false);
    expect(readStagedWorktreeIntent(slotOf(SESSION_B))).toBeNull();

    pick(SESSION_B, "/repo/b");
    a.unmount();

    expect(readStagedWorktreeIntent(slotOf(SESSION_B))).toEqual(
      localIntent("/repo/b"),
    );
    expect(b.result.current?.changesWorkspace).toBe(true);
  });

  it("refuses a pick that arrives after the edit ended, as a late autosave would", () => {
    const view = renderEditing(editing(SESSION_A));
    pick(SESSION_A, "/repo/a");
    view.rerender(editing(null));

    act(() => {
      useWorktreeIntentStagingStore
        .getState()
        .stageIntent(slotOf(SESSION_A), localIntent("/repo/late"));
    });

    expect(readStagedWorktreeIntent(slotOf(SESSION_A))).toBeNull();
  });

  describe("on a line that cannot carry the folders", () => {
    const below: EditProps = {
      ...editing(SESSION_A),
      carriesWorktreeIntent: false,
    };

    it("blocks saving once a pick changes the folders, and makes the picker read-only", () => {
      const { result } = renderEditing(below);
      expect(result.current?.foldersBlocked).toBe(false);

      pick(SESSION_A, "/repo/a");

      expect(result.current?.foldersBlocked).toBe(true);
      expect(result.current?.changesWorkspace).toBe(false);
      expect(result.current?.surface.carriesWorktreeIntent).toBe(false);
    });

    it("neither blocks nor saves the folders while the line is not yet known", () => {
      const { result } = renderEditing({
        ...editing(SESSION_A),
        carriesWorktreeIntent: null,
      });

      pick(SESSION_A, "/repo/a");

      expect(result.current?.foldersBlocked).toBe(false);
      expect(result.current?.changesWorkspace).toBe(false);
      expect(result.current?.surface.carriesWorktreeIntent).toBeNull();
    });

    it("does not block when the line carries them", () => {
      const { result } = renderEditing(editing(SESSION_A));

      pick(SESSION_A, "/repo/a");

      expect(result.current?.foldersBlocked).toBe(false);
    });
  });

  it("stops reporting a change once the pick matches the folder the chat is bound to", () => {
    const { result } = renderEditing({
      ...editing(SESSION_A),
      binding: {
        entries: [
          {
            workspacePath: "/repo/a",
            mode: "local",
            repoIdentifier: null,
            worktreePath: null,
            branch: "main",
            isPrimary: true,
            isImported: false,
            setupState: "not_required",
            setupTerminalSessionId: null,
            setupExitCode: null,
            setupFailedAt: null,
            createdAt: 1,
            ownedSubmodules: [],
          },
        ],
      },
    });

    act(() => {
      useWorktreeIntentStagingStore
        .getState()
        .setIntent(slotOf(SESSION_A), importIntent("/repo/a"));
    });
    expect(result.current?.changesWorkspace).toBe(true);

    pick(SESSION_A, "/repo/a");

    expect(result.current?.changesWorkspace).toBe(false);
  });

  it("gates on the folders the edited message would still run in: neither its own choice nor a pick names a missing one", () => {
    const { result } = renderEditing({
      ...editing(SESSION_A),
      rowWorktreeIntent: localIntent("/repo/a"),
      missingWorktreePaths: ["/repo/a", "/repo/b", "/repo/c"],
    });
    expect(result.current?.missingWorktreePaths).toEqual([
      "/repo/b",
      "/repo/c",
    ]);

    pick(SESSION_A, "/repo/b");

    expect(result.current?.missingWorktreePaths).toEqual(["/repo/c"]);
  });

  it("lays the edit's picks over the row's own choice, one entry per folder, without the chat's owed request", () => {
    const { result } = renderEditing({
      ...editing(SESSION_A),
      rowWorktreeIntent: {
        entries: [
          ...importIntent("/repo/a").entries,
          ...importIntent("/repo/b").entries,
        ],
      },
      seeded: { intent: importIntent("/repo/owed"), failed: false },
    });
    expect(result.current?.worktreeIntent).toEqual({
      entries: [
        ...importIntent("/repo/a").entries,
        ...importIntent("/repo/b").entries,
      ],
    });

    pick(SESSION_A, "/repo/a");

    expect(result.current?.worktreeIntent).toEqual({
      entries: [
        ...localIntent("/repo/a").entries,
        ...importIntent("/repo/b").entries,
      ],
    });
  });
});

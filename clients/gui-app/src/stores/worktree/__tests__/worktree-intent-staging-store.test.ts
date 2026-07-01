import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorktreeFolderIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  newConversationModalStagingKey,
  pendingChildTerminalAgentStagingKey,
  pendingForkChatStagingKey,
  pendingTerminalAgentStagingKey,
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { worktreeIntentStagingKey } from "@/lib/persist";

const LANDING_KEY: WorktreeStagingKey = {
  surface: "landing",
  draftId: "draft-1",
};
const OWNER_KEY: WorktreeStagingKey = {
  surface: "owner",
  epicId: "epic-1",
  ownerKind: "chat",
  ownerId: "chat-1",
};

function localEntry(
  workspacePath: string,
  isPrimary: boolean,
): WorktreeFolderIntent {
  return { kind: "local", workspacePath, repoIdentifier: null, isPrimary };
}

function worktreeEntry(workspacePath: string): WorktreeFolderIntent {
  return {
    kind: "worktree",
    scripts: null,
    workspacePath,
    repoIdentifier: null,
    isPrimary: true,
    branch: {
      type: "new",
      name: "feat",
      source: "main",
      carryUncommittedChanges: false,
    },
  };
}

describe("worktree-intent-staging-store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorktreeIntentStagingStore.getState().resetForTests();
  });

  afterEach(() => {
    useWorktreeIntentStagingStore.getState().resetForTests();
    window.localStorage.clear();
  });

  it("serializes keys distinctly per surface", () => {
    expect(worktreeStagingKeyString(LANDING_KEY)).toBe("landing:draft-1");
    expect(
      worktreeStagingKeyString({ surface: "landing", draftId: null }),
    ).toBe("landing:");
    expect(worktreeStagingKeyString(OWNER_KEY)).toBe(
      "owner:epic-1:chat:chat-1",
    );
  });

  it("stageEntry merges a single folder, normalizing the primary", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(LANDING_KEY, localEntry("/a", true));
    store.stageEntry(LANDING_KEY, worktreeEntry("/b"));
    const staged = readStagedWorktreeIntent(LANDING_KEY);
    expect(staged?.entries.map((e) => e.workspacePath)).toEqual(["/a", "/b"]);
    // The later primary wins; the earlier entry is demoted.
    expect(
      staged?.entries.find((e) => e.workspacePath === "/a")?.isPrimary,
    ).toBe(false);
  });

  it("stageIntent merges every entry of an intent", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageIntent(LANDING_KEY, {
      entries: [localEntry("/a", false), worktreeEntry("/b")],
    });
    expect(readStagedWorktreeIntent(LANDING_KEY)?.entries).toHaveLength(2);
  });

  it("setIntent replaces, and clears the key on null / empty", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(LANDING_KEY, worktreeEntry("/b"));
    store.setIntent(LANDING_KEY, { entries: [localEntry("/a", true)] });
    expect(readStagedWorktreeIntent(LANDING_KEY)?.entries).toEqual([
      localEntry("/a", true),
    ]);
    store.setIntent(LANDING_KEY, { entries: [] });
    expect(readStagedWorktreeIntent(LANDING_KEY)).toBeNull();
  });

  it("unstageEntry drops one folder and clears the key once empty", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(OWNER_KEY, localEntry("/a", true));
    store.stageEntry(OWNER_KEY, worktreeEntry("/b"));
    store.unstageEntry(OWNER_KEY, "/a");
    expect(
      readStagedWorktreeIntent(OWNER_KEY)?.entries.map((e) => e.workspacePath),
    ).toEqual(["/b"]);
    store.unstageEntry(OWNER_KEY, "/b");
    expect(readStagedWorktreeIntent(OWNER_KEY)).toBeNull();
  });

  it("clear removes only the targeted key", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(LANDING_KEY, localEntry("/a", true));
    store.stageEntry(OWNER_KEY, localEntry("/b", true));
    store.clear(LANDING_KEY);
    expect(readStagedWorktreeIntent(LANDING_KEY)).toBeNull();
    expect(readStagedWorktreeIntent(OWNER_KEY)).not.toBeNull();
  });

  it("scopes the pending launcher / fork keys per epic (no cross-epic bleed)", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(
      pendingTerminalAgentStagingKey("epic-A"),
      worktreeEntry("/a"),
    );
    // A different epic's launcher slot is independent.
    expect(
      readStagedWorktreeIntent(pendingTerminalAgentStagingKey("epic-B")),
    ).toBeNull();
    expect(
      readStagedWorktreeIntent(pendingTerminalAgentStagingKey("epic-A")),
    ).not.toBeNull();
    // The launcher and the fork dialog are distinct slots within one epic.
    expect(
      worktreeStagingKeyString(pendingTerminalAgentStagingKey("epic-A")),
    ).not.toBe(worktreeStagingKeyString(pendingForkChatStagingKey("epic-A")));
  });

  it("scopes the per-parent child slot per parent (no concurrent-row collisions)", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(
      pendingChildTerminalAgentStagingKey("epic-A", "parent-1"),
      worktreeEntry("/a"),
    );
    // A sibling row (different parent) has an independent slot.
    expect(
      readStagedWorktreeIntent(
        pendingChildTerminalAgentStagingKey("epic-A", "parent-2"),
      ),
    ).toBeNull();
    expect(
      readStagedWorktreeIntent(
        pendingChildTerminalAgentStagingKey("epic-A", "parent-1"),
      ),
    ).not.toBeNull();
    // The per-parent slot is distinct from the shared epic launcher slot.
    expect(
      worktreeStagingKeyString(
        pendingChildTerminalAgentStagingKey("epic-A", "parent-1"),
      ),
    ).not.toBe(
      worktreeStagingKeyString(pendingTerminalAgentStagingKey("epic-A")),
    );
  });

  it("scopes the new-conversation modal slot per parent (child vs top-level)", () => {
    const store = useWorktreeIntentStagingStore.getState();
    // A top-level create stages under the epic/null slot.
    store.stageEntry(
      newConversationModalStagingKey("epic-A", null),
      worktreeEntry("/a"),
    );
    // Reopening the modal to add a CHILD reads an independent slot, so it never
    // inherits the top-level (or another parent's) staged worktree intent.
    expect(
      readStagedWorktreeIntent(
        newConversationModalStagingKey("epic-A", "parent-1"),
      ),
    ).toBeNull();
    expect(
      readStagedWorktreeIntent(newConversationModalStagingKey("epic-A", null)),
    ).not.toBeNull();
    // Different parents get distinct slots.
    expect(
      worktreeStagingKeyString(
        newConversationModalStagingKey("epic-A", "parent-1"),
      ),
    ).not.toBe(
      worktreeStagingKeyString(
        newConversationModalStagingKey("epic-A", "parent-2"),
      ),
    );
  });

  it("never persists the per-parent child scratch slot", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(
      pendingChildTerminalAgentStagingKey("epic-A", "parent-1"),
      worktreeEntry("/a"),
    );
    const raw = window.localStorage.getItem(worktreeIntentStagingKey(null));
    const persisted =
      raw === null
        ? { state: { intentByKey: {} } }
        : (JSON.parse(raw) as {
            state: { intentByKey: Record<string, unknown> };
          });
    expect(Object.keys(persisted.state.intentByKey)).not.toContain(
      worktreeStagingKeyString(
        pendingChildTerminalAgentStagingKey("epic-A", "parent-1"),
      ),
    );
    // Still readable in-memory for the open submenu.
    expect(
      readStagedWorktreeIntent(
        pendingChildTerminalAgentStagingKey("epic-A", "parent-1"),
      ),
    ).not.toBeNull();
  });

  it("persists owner + landing intents to localStorage but not the scratch slots", () => {
    const store = useWorktreeIntentStagingStore.getState();
    store.stageEntry(OWNER_KEY, worktreeEntry("/a"));
    store.stageEntry(LANDING_KEY, localEntry("/b", true));
    store.stageEntry(
      pendingTerminalAgentStagingKey("epic-A"),
      worktreeEntry("/c"),
    );

    const raw = window.localStorage.getItem(worktreeIntentStagingKey(null));
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw ?? "{}") as {
      state: { intentByKey: Record<string, unknown> };
    };
    const keys = Object.keys(persisted.state.intentByKey);
    expect(keys).toContain(worktreeStagingKeyString(OWNER_KEY));
    expect(keys).toContain(worktreeStagingKeyString(LANDING_KEY));
    // The transient launcher scratch slot is staged in-memory but never written.
    expect(keys).not.toContain(
      worktreeStagingKeyString(pendingTerminalAgentStagingKey("epic-A")),
    );
    expect(
      readStagedWorktreeIntent(pendingTerminalAgentStagingKey("epic-A")),
    ).not.toBeNull();
  });

  it("restores a persisted pending pick on rehydrate", async () => {
    const ownerId = worktreeStagingKeyString(OWNER_KEY);
    window.localStorage.setItem(
      worktreeIntentStagingKey(null),
      JSON.stringify({
        state: {
          intentByKey: {
            [ownerId]: { entries: [worktreeEntry("/a")] },
          },
        },
        version: 1,
      }),
    );

    await useWorktreeIntentStagingStore.persist.rehydrate();

    expect(readStagedWorktreeIntent(OWNER_KEY)?.entries[0]?.workspacePath).toBe(
      "/a",
    );
  });
});

import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  WorktreeFolderIntent,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import {
  WORKTREE_INTENT_MEMORY_EPIC_CAP,
  WORKTREE_INTENT_MEMORY_FOLDER_CAP,
  useWorktreeIntentMemoryStore,
} from "@/stores/worktree/worktree-intent-memory-store";
import { worktreeIntentMemoryKey } from "@/lib/persist";

function localIntent(workspacePath: string): WorktreeIntent {
  return {
    entries: [
      { kind: "local", workspacePath, repoIdentifier: null, isPrimary: true },
    ],
  };
}

function localFolder(workspacePath: string): WorktreeFolderIntent {
  return {
    kind: "local",
    workspacePath,
    repoIdentifier: null,
    isPrimary: true,
  };
}

function newWorktreeFolder(
  workspacePath: string,
  source: string,
): WorktreeFolderIntent {
  return {
    kind: "worktree",
    scripts: null,
    workspacePath,
    repoIdentifier: null,
    isPrimary: true,
    branch: {
      type: "new",
      name: "feat/x",
      source,
      carryUncommittedChanges: false,
    },
  };
}

describe("useWorktreeIntentMemoryStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorktreeIntentMemoryStore.getState().resetForTests();
  });

  afterEach(() => {
    useWorktreeIntentMemoryStore.getState().resetForTests();
    window.localStorage.clear();
  });

  it("stores and reads per-folder intent keyed by workspace path", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    store.setFolderIntent(localFolder("/a"), 1);
    expect(
      useWorktreeIntentMemoryStore.getState().getFolderIntent("/a"),
    ).toEqual(localFolder("/a"));
    expect(
      useWorktreeIntentMemoryStore.getState().getFolderIntent("/missing"),
    ).toBeNull();
  });

  it("strips the scripts override from a remembered worktree folder", () => {
    const withScripts: WorktreeFolderIntent = {
      kind: "worktree",
      workspacePath: "/a",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/x",
        source: "main",
        carryUncommittedChanges: false,
      },
      scripts: {
        setup: { default: "echo hi", macos: null, windows: null, linux: null },
        teardown: { default: "", macos: null, windows: null, linux: null },
      },
    };
    useWorktreeIntentMemoryStore.getState().setFolderIntent(withScripts, 1);
    const remembered = useWorktreeIntentMemoryStore
      .getState()
      .getFolderIntent("/a");
    expect(remembered?.kind).toBe("worktree");
    if (remembered?.kind === "worktree") {
      expect(remembered.scripts).toBeNull();
    }
  });

  it("strips the scripts override from a remembered per-epic worktree entry", () => {
    const withScripts: WorktreeFolderIntent = {
      kind: "worktree",
      workspacePath: "/a",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/x",
        source: "main",
        carryUncommittedChanges: false,
      },
      scripts: {
        setup: { default: "echo hi", macos: null, windows: null, linux: null },
        teardown: { default: "", macos: null, windows: null, linux: null },
      },
    };
    useWorktreeIntentMemoryStore
      .getState()
      .setEpicIntent("epic-a", { entries: [withScripts] }, 1);
    const remembered = useWorktreeIntentMemoryStore
      .getState()
      .getEpicIntent("epic-a");
    const entry = remembered?.entries[0];
    expect(entry?.kind).toBe("worktree");
    if (entry?.kind === "worktree") {
      expect(entry.scripts).toBeNull();
    }
  });

  it("evicts the least-recently-updated folder beyond the cap", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    for (
      let index = 0;
      index <= WORKTREE_INTENT_MEMORY_FOLDER_CAP;
      index += 1
    ) {
      store.setFolderIntent(localFolder(`/ws-${index}`), index);
    }
    const entries = useWorktreeIntentMemoryStore.getState().folderIntentByPath;
    expect(Object.keys(entries)).toHaveLength(
      WORKTREE_INTENT_MEMORY_FOLDER_CAP,
    );
    expect(Object.hasOwn(entries, "/ws-0")).toBe(false);
    expect(
      Object.hasOwn(entries, `/ws-${WORKTREE_INTENT_MEMORY_FOLDER_CAP}`),
    ).toBe(true);
  });

  it("refreshes folder recency on re-write so a touched folder is not evicted", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    store.setFolderIntent(localFolder("/old"), 0);
    for (let index = 1; index < WORKTREE_INTENT_MEMORY_FOLDER_CAP; index += 1) {
      store.setFolderIntent(localFolder(`/ws-${index}`), index);
    }
    store.setFolderIntent(localFolder("/old"), 10_000);
    store.setFolderIntent(localFolder("/overflow"), 1);
    const entries = useWorktreeIntentMemoryStore.getState().folderIntentByPath;
    expect(Object.keys(entries)).toHaveLength(
      WORKTREE_INTENT_MEMORY_FOLDER_CAP,
    );
    expect(Object.hasOwn(entries, "/old")).toBe(true);
  });

  it("stores and reads per-epic intent", () => {
    useWorktreeIntentMemoryStore
      .getState()
      .setEpicIntent("epic-a", localIntent("/a"), 1);
    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent("epic-a"),
    ).toEqual(localIntent("/a"));
    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent("missing"),
    ).toBeNull();
  });

  it("evicts the least-recently-updated epic beyond the cap", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    for (let index = 0; index <= WORKTREE_INTENT_MEMORY_EPIC_CAP; index += 1) {
      store.setEpicIntent(`epic-${index}`, localIntent(`/ws-${index}`), index);
    }
    const entries = useWorktreeIntentMemoryStore.getState().epicIntentByEpicId;
    expect(Object.keys(entries)).toHaveLength(WORKTREE_INTENT_MEMORY_EPIC_CAP);
    expect(Object.hasOwn(entries, "epic-0")).toBe(false);
    expect(
      Object.hasOwn(entries, `epic-${WORKTREE_INTENT_MEMORY_EPIC_CAP}`),
    ).toBe(true);
  });

  it("clears named epics", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    store.setEpicIntent("epic-a", localIntent("/a"), 1);
    store.setEpicIntent("epic-b", localIntent("/b"), 2);
    store.clearEpicIntent(["epic-a"]);
    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent("epic-a"),
    ).toBeNull();
    expect(
      useWorktreeIntentMemoryStore.getState().getEpicIntent("epic-b"),
    ).not.toBeNull();
  });

  it("buckets the persist key by email", () => {
    expect(worktreeIntentMemoryKey(null)).toContain(":anon");
    expect(worktreeIntentMemoryKey("a@b.com")).toContain(":a@b.com");
    expect(worktreeIntentMemoryKey("a@b.com")).not.toEqual(
      worktreeIntentMemoryKey("c@d.com"),
    );
  });

  it("round-trips persisted state through localStorage and validates it", () => {
    const store = useWorktreeIntentMemoryStore.getState();
    store.setFolderIntent(newWorktreeFolder("/a", "main"), 5);
    store.setEpicIntent("epic-a", localIntent("/a"), 5);

    const raw = window.localStorage.getItem(worktreeIntentMemoryKey(null));
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw ?? "{}") as {
      state: {
        folderIntentByPath: Record<string, unknown>;
        epicIntentByEpicId: Record<string, unknown>;
      };
    };
    expect(Object.keys(persisted.state.folderIntentByPath)).toEqual(["/a"]);
    expect(Object.keys(persisted.state.epicIntentByEpicId)).toEqual(["epic-a"]);
  });
});

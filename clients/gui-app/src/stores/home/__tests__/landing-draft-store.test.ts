import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyLandingDraftDesktopProjection,
  emptyLandingDraftWorkspaceSnapshot,
  EMPTY_LANDING_DRAFT_CONTENT,
  LANDING_DRAFT_PERSIST_KEY,
  mergeLandingDraftWorkspaceFolders,
  removeLandingDraftWorkspaceFolder,
  setLandingDraftDesktopProjectionBridge,
  setLandingDraftWorkspacePrimary,
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import * as landingImageGc from "@/lib/composer/landing-image-gc";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { JsonContent } from "@traycer/protocol/common/registry";

function textContent(text: string): JsonContent {
  if (text.length === 0) return EMPTY_LANDING_DRAFT_CONTENT;
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

// Inbound desktop projections carry `content` as opaque `DesktopJsonValue`.
// Mirror `textContent` in that shape so a fixture draft passes the doc-shape
// guard and restores to the same `JsonContent` the assertions expect.
function desktopTextContent(text: string): DesktopJsonValue {
  if (text.length === 0) {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

// `lastTouchedAt` is stamped with `Date.now()` (and excluded from draft
// equality), so assert every other field exactly while only checking the
// timestamp is a number - substituting the live value keeps `toEqual` strict on
// the deterministic fields without an `expect.any` `any`-typed literal.
function expectLandingDraftsMatch(
  expected: ReadonlyArray<Omit<LandingDraftTab, "lastTouchedAt">>,
): void {
  const drafts = useLandingDraftStore.getState().drafts;
  expect(drafts).toEqual(
    expected.map((draft, index) => ({
      ...draft,
      lastTouchedAt: drafts[index]?.lastTouchedAt,
    })),
  );
  for (const draft of drafts) {
    expect(typeof draft.lastTouchedAt).toBe("number");
  }
}
import {
  applyEpicCanvasDesktopProjection,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import {
  useWorkspaceFoldersStore,
  type WorkspaceFolderInfo,
} from "@/stores/workspace/workspace-folders-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type {
  DesktopJsonValue,
  DesktopPerWindowSnapshot,
  DesktopPerWindowStatePatch,
} from "@/lib/windows/types";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { useTabsStore } from "@/stores/tabs/store";

const HAIKU_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "haiku",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "regular",
  profileId: null,
};

const SONNET_SETTINGS: ChatRunSettings = {
  harnessId: "claude",
  model: "sonnet",
  permissionMode: "supervised",
  reasoningEffort: null,
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};
const WORKSPACE_A = {
  path: "/tmp/workspace-a",
  name: "workspace-a",
  repoIdentifier: { owner: "traycerai", repo: "workspace-a" },
};
const WORKSPACE_B = {
  path: "/tmp/workspace-b",
  name: "workspace-b",
  repoIdentifier: { owner: "traycerai", repo: "workspace-b" },
};
const WORKSPACE_C = {
  path: "/tmp/workspace-c",
  name: "workspace-c",
  repoIdentifier: { owner: "traycerai", repo: "workspace-c" },
};
function resetStore(): void {
  setLandingDraftDesktopProjectionBridge(null);
  useLandingDraftStore.setState({
    drafts: [],
    activeDraftId: null,
  });
  useWorkspaceFoldersStore.setState({
    folders: [],
    folderInfoByPath: {},
    primaryPath: null,
  });
  useSettingsStore.setState({
    composerMode: "chat",
  });
  useEpicCanvasStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
    mostRecentTabIdByEpicId: {},
  });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
}

function emptyWindowSnapshot(
  patch: Partial<DesktopPerWindowSnapshot>,
): DesktopPerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
    ...patch,
  };
}

function worktreeIntentEntry(workspacePath: string) {
  return {
    kind: "worktree" as const,
    workspacePath,
    repoIdentifier: null,
    isPrimary: false,
    branch: {
      type: "new" as const,
      name: "feature/test",
      source: "main",
      carryUncommittedChanges: false,
    },
    scripts: null,
  };
}

function numberedWorkspace(index: number) {
  return {
    path: `/tmp/workspace-${index}`,
    name: `workspace-${index}`,
    repoIdentifier: null,
  };
}

describe("removeLandingDraftWorkspaceFolder / setLandingDraftWorkspacePrimary (pure helpers)", () => {
  function workspaceOf(folders: ReadonlyArray<WorkspaceFolderInfo>) {
    return mergeLandingDraftWorkspaceFolders(
      emptyLandingDraftWorkspaceSnapshot(),
      folders,
    );
  }

  it("setLandingDraftWorkspacePrimary switches primary; a non-member path is a no-op (same reference)", () => {
    const workspace = workspaceOf([WORKSPACE_A, WORKSPACE_B]);
    const switched = setLandingDraftWorkspacePrimary(
      workspace,
      WORKSPACE_B.path,
    );
    expect(switched.primaryPath).toBe(WORKSPACE_B.path);

    const noop = setLandingDraftWorkspacePrimary(switched, "/not-a-member");
    expect(noop).toBe(switched);
  });

  it("removing the primary folder deterministically falls back to the first remaining folder", () => {
    const workspace = setLandingDraftWorkspacePrimary(
      workspaceOf([WORKSPACE_A, WORKSPACE_B, WORKSPACE_C]),
      WORKSPACE_B.path,
    );

    const afterRemove = removeLandingDraftWorkspaceFolder(
      workspace,
      WORKSPACE_B.path,
    );

    expect(afterRemove.primaryPath).toBe(WORKSPACE_A.path);
  });

  it("removing a secondary folder leaves primary unchanged", () => {
    const workspace = setLandingDraftWorkspacePrimary(
      workspaceOf([WORKSPACE_A, WORKSPACE_B, WORKSPACE_C]),
      WORKSPACE_B.path,
    );

    const afterRemove = removeLandingDraftWorkspaceFolder(
      workspace,
      WORKSPACE_C.path,
    );

    expect(afterRemove.primaryPath).toBe(WORKSPACE_B.path);
  });

  it("removing the last folder empties the workspace and its primary (empty state)", () => {
    const workspace = workspaceOf([WORKSPACE_A]);
    const afterRemove = removeLandingDraftWorkspaceFolder(
      workspace,
      WORKSPACE_A.path,
    );
    expect(afterRemove.folders).toEqual([]);
    expect(afterRemove.primaryPath).toBeNull();
  });

  it("promotes a non-git (local-only) folder to primary just like any other folder", () => {
    const nonGitFolder = {
      path: "/tmp/non-git",
      name: "non-git",
      repoIdentifier: null,
    };
    const workspace = workspaceOf([WORKSPACE_A, nonGitFolder]);
    const switched = setLandingDraftWorkspacePrimary(
      workspace,
      nonGitFolder.path,
    );
    expect(switched.primaryPath).toBe(nonGitFolder.path);
  });
});

describe("useLandingDraftStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  describe("localStorage rehydration sanitization", () => {
    it("keeps a legacy draft that predates `workspace` and reads folders safely", async () => {
      setLandingDraftDesktopProjectionBridge(null);
      window.localStorage.setItem(
        LANDING_DRAFT_PERSIST_KEY,
        JSON.stringify({
          state: {
            drafts: [
              {
                id: "legacy-no-workspace",
                content: { type: "doc", content: [{ type: "paragraph" }] },
                selection: null,
                lastTouchedAt: 123,
                settings: null,
                composerMode: "chat",
                // no `workspace` - the pre-workspace persisted shape
              },
            ],
            activeDraftId: "legacy-no-workspace",
          },
          version: 1,
        }),
      );
      await useLandingDraftStore.persist.rehydrate();

      const drafts = useLandingDraftStore.getState().drafts;
      expect(drafts).toHaveLength(1);
      const draft = drafts[0];
      // The former crash site: reading `.workspace.folders` must not throw.
      expect(draft.workspace.folders).toEqual([]);
      expect(useLandingDraftStore.getState().activeDraftId).toBe(
        "legacy-no-workspace",
      );
    });

    it("rehydrates a v1 draft with a POPULATED workspace and no primaryPath to first-folder primary", async () => {
      setLandingDraftDesktopProjectionBridge(null);
      window.localStorage.setItem(
        LANDING_DRAFT_PERSIST_KEY,
        JSON.stringify({
          state: {
            drafts: [
              {
                id: "v1-populated",
                content: { type: "doc", content: [{ type: "paragraph" }] },
                selection: null,
                lastTouchedAt: 123,
                settings: null,
                composerMode: "chat",
                // v1 workspace shape: folders + metadata, no `primaryPath`.
                workspace: {
                  folders: [WORKSPACE_A.path, WORKSPACE_B.path],
                  folderInfoByPath: {
                    [WORKSPACE_A.path]: WORKSPACE_A,
                    [WORKSPACE_B.path]: WORKSPACE_B,
                  },
                },
              },
            ],
            activeDraftId: "v1-populated",
          },
          version: 1,
        }),
      );
      await useLandingDraftStore.persist.rehydrate();

      const workspace = useLandingDraftStore.getState().drafts[0].workspace;
      expect(workspace.folders).toEqual([WORKSPACE_A.path, WORKSPACE_B.path]);
      expect(workspace.primaryPath).toBe(WORKSPACE_A.path);
    });

    it("rehydrates a switched (non-first) primaryPath verbatim after a reload", async () => {
      setLandingDraftDesktopProjectionBridge(null);
      window.localStorage.setItem(
        LANDING_DRAFT_PERSIST_KEY,
        JSON.stringify({
          state: {
            drafts: [
              {
                id: "switched-primary",
                content: { type: "doc", content: [{ type: "paragraph" }] },
                selection: null,
                lastTouchedAt: 123,
                settings: null,
                composerMode: "chat",
                workspace: {
                  folders: [WORKSPACE_A.path, WORKSPACE_B.path],
                  folderInfoByPath: {
                    [WORKSPACE_A.path]: WORKSPACE_A,
                    [WORKSPACE_B.path]: WORKSPACE_B,
                  },
                  // The user switched primary to the SECOND folder before
                  // the reload; rehydration must not fall back to first.
                  primaryPath: WORKSPACE_B.path,
                },
              },
            ],
            activeDraftId: "switched-primary",
          },
          version: 1,
        }),
      );
      await useLandingDraftStore.persist.rehydrate();

      expect(
        useLandingDraftStore.getState().drafts[0].workspace.primaryPath,
      ).toBe(WORKSPACE_B.path);
    });

    it("drops a ghost folder (no metadata) from a persisted draft workspace and never resolves it as primary", async () => {
      setLandingDraftDesktopProjectionBridge(null);
      window.localStorage.setItem(
        LANDING_DRAFT_PERSIST_KEY,
        JSON.stringify({
          state: {
            drafts: [
              {
                id: "ghost-folder",
                content: { type: "doc", content: [{ type: "paragraph" }] },
                selection: null,
                lastTouchedAt: 123,
                settings: null,
                composerMode: "chat",
                workspace: {
                  // "/tmp/ghost" is in the folder array but has NO metadata
                  // entry - corrupt persisted state.
                  folders: ["/tmp/ghost", WORKSPACE_A.path],
                  folderInfoByPath: {
                    [WORKSPACE_A.path]: WORKSPACE_A,
                  },
                  primaryPath: "/tmp/ghost",
                },
              },
            ],
            activeDraftId: "ghost-folder",
          },
          version: 1,
        }),
      );
      await useLandingDraftStore.persist.rehydrate();

      const workspace = useLandingDraftStore.getState().drafts[0].workspace;
      expect(workspace.folders).toEqual([WORKSPACE_A.path]);
      expect(workspace.primaryPath).toBe(WORKSPACE_A.path);
    });

    it("drops a legacy prompt-only draft with no valid content", async () => {
      setLandingDraftDesktopProjectionBridge(null);
      window.localStorage.setItem(
        LANDING_DRAFT_PERSIST_KEY,
        JSON.stringify({
          state: {
            drafts: [{ id: "legacy-prompt", prompt: "hello there" }],
            activeDraftId: "legacy-prompt",
          },
          version: 1,
        }),
      );
      await useLandingDraftStore.persist.rehydrate();

      expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
      expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    });
  });

  it("createDraft always creates a new draft and sets it active", () => {
    const { createDraft } = useLandingDraftStore.getState();
    const first = createDraft(null);
    expect(first.length).toBeGreaterThan(0);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(first);

    const second = createDraft(null);
    expect(second).not.toBe(first);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(2);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(second);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
  });

  it("setDraftContent stores content on the target draft and bails on no-op writes", () => {
    const { createDraft, setDraftContent } = useLandingDraftStore.getState();

    const id = createDraft(null);
    setDraftContent(id, textContent("hello world"), null);
    expect(useLandingDraftStore.getState().drafts[0].content).toEqual(
      textContent("hello world"),
    );
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);

    // Identical content + selection short-circuits by value (excludes
    // `lastTouchedAt`), so the drafts array reference is preserved.
    const snapshot = useLandingDraftStore.getState().drafts;
    setDraftContent(id, textContent("hello world"), null);
    expect(useLandingDraftStore.getState().drafts).toBe(snapshot);
  });

  it("keeps run settings independent per draft", () => {
    const { createDraft, setDraftSettings } = useLandingDraftStore.getState();
    const mutableHaikuSettings = { ...HAIKU_SETTINGS };
    const mutableSonnetSettings = { ...SONNET_SETTINGS };
    const haikuDraftId = createDraft(mutableHaikuSettings);
    const sonnetDraftId = createDraft(mutableSonnetSettings);

    setDraftSettings(sonnetDraftId, mutableSonnetSettings);
    mutableHaikuSettings.model = "mutated-haiku";
    mutableSonnetSettings.model = "mutated-sonnet";

    const settingsByDraftId = new Map(
      useLandingDraftStore
        .getState()
        .drafts.map((draft) => [draft.id, draft.settings]),
    );
    expect(settingsByDraftId.get(haikuDraftId)).toEqual(HAIKU_SETTINGS);
    expect(settingsByDraftId.get(sonnetDraftId)).toEqual(SONNET_SETTINGS);
  });

  it("keeps composer mode independent per draft", () => {
    const { createDraft, setDraftComposerMode } =
      useLandingDraftStore.getState();
    const a = createDraft(null);
    const b = createDraft(null);

    setDraftComposerMode(a, "terminal");

    const modeByDraftId = new Map(
      useLandingDraftStore
        .getState()
        .drafts.map((draft) => [draft.id, draft.composerMode]),
    );
    expect(modeByDraftId.get(a)).toBe("terminal");
    expect(modeByDraftId.get(b)).toBe("chat");
  });

  it("seeds new drafts with the global last-used composer mode", () => {
    useSettingsStore.setState({ composerMode: "terminal" });

    const id = useLandingDraftStore.getState().createDraft(null);

    expect(
      useLandingDraftStore.getState().drafts.find((draft) => draft.id === id)
        ?.composerMode,
    ).toBe("terminal");
  });

  it("keeps workspace snapshots independent per draft", () => {
    useWorkspaceFoldersStore.setState({
      folders: [WORKSPACE_A.path],
      folderInfoByPath: { [WORKSPACE_A.path]: WORKSPACE_A },
    });
    const draftA = useLandingDraftStore.getState().createDraft(null);

    useWorkspaceFoldersStore.setState({
      folders: [WORKSPACE_B.path],
      folderInfoByPath: { [WORKSPACE_B.path]: WORKSPACE_B },
    });
    const draftB = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore
      .getState()
      .addDraftResolvedFolders(draftB, [WORKSPACE_C]);

    const workspaceByDraftId = new Map(
      useLandingDraftStore
        .getState()
        .drafts.map((draft) => [draft.id, draft.workspace]),
    );
    expect(workspaceByDraftId.get(draftA)?.folders).toEqual([WORKSPACE_A.path]);
    expect(workspaceByDraftId.get(draftB)?.folders).toEqual([
      WORKSPACE_B.path,
      WORKSPACE_C.path,
    ]);
  });

  it("drops invalid projected draft workspace data", () => {
    const snapshot = emptyWindowSnapshot({
      landingDrafts: [
        {
          id: "draft-a",
          content: desktopTextContent(""),
          selection: null,
          lastTouchedAt: 1,
          settings: null,
          composerMode: null,
          workspace: {
            folders: [WORKSPACE_A.path, WORKSPACE_B.path],
            folderInfoByPath: {
              [WORKSPACE_A.path]: WORKSPACE_A,
              [WORKSPACE_B.path]: {
                ...WORKSPACE_B,
                path: "/tmp/mismatched-workspace",
              },
            },
            worktreeMode: "local",
            capturedWorktreeIntent: {
              entries: [worktreeIntentEntry(WORKSPACE_A.path)],
            },
            folderModes: {
              [WORKSPACE_A.path]: "worktree",
              [WORKSPACE_B.path]: "worktree",
            },
          },
        },
      ],
      activeLandingDraftId: "draft-a",
    });

    applyLandingDraftDesktopProjection(snapshot);

    expect(useLandingDraftStore.getState().drafts[0].workspace).toEqual({
      folders: [WORKSPACE_A.path],
      folderInfoByPath: { [WORKSPACE_A.path]: WORKSPACE_A },
      primaryPath: WORKSPACE_A.path,
    });
  });

  it("caps draft-added workspace folders to the newest 50 entries, never evicting primary", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const folders = Array.from({ length: 55 }, (_, index) =>
      numberedWorkspace(index),
    );

    useLandingDraftStore.getState().addDraftResolvedFolders(draftId, folders);

    const workspace = useLandingDraftStore.getState().drafts[0].workspace;
    expect(workspace.folders).toHaveLength(50);
    // Primary resolves to the first folder (nothing was explicitly marked
    // primary yet) and the cap trim must preserve it even though it is the
    // OLDEST entry - the eviction trims the oldest SECONDARIES instead.
    expect(workspace.primaryPath).toBe("/tmp/workspace-0");
    expect(workspace.folders[0]).toBe("/tmp/workspace-0");
    expect(workspace.folders.at(-1)).toBe("/tmp/workspace-54");
    expect(workspace.folderInfoByPath["/tmp/workspace-0"]).toEqual(
      numberedWorkspace(0),
    );
    expect(workspace.folderInfoByPath["/tmp/workspace-5"]).toBeUndefined();
    expect(workspace.folderInfoByPath["/tmp/workspace-54"]).toEqual(
      numberedWorkspace(54),
    );
  });

  it("50->51 cap transition never silently moves an EXPLICIT primary that isn't the oldest folder", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    const folders = Array.from({ length: 50 }, (_, index) =>
      numberedWorkspace(index),
    );
    useLandingDraftStore.getState().addDraftResolvedFolders(draftId, folders);
    // Mark a folder that is NOT the oldest (and would otherwise be the first
    // trimmed) as primary.
    useLandingDraftStore
      .getState()
      .setDraftWorkspacePrimary(draftId, "/tmp/workspace-2");

    useLandingDraftStore
      .getState()
      .addDraftResolvedFolders(draftId, [numberedWorkspace(50)]);

    const workspace = useLandingDraftStore.getState().drafts[0].workspace;
    expect(workspace.folders).toHaveLength(50);
    expect(workspace.primaryPath).toBe("/tmp/workspace-2");
    expect(workspace.folders).toContain("/tmp/workspace-2");
    expect(workspace.folders).toContain("/tmp/workspace-50");
    // The oldest secondary (not the explicit primary) is evicted instead.
    expect(workspace.folders).not.toContain("/tmp/workspace-0");
  });

  it("setDraftWorkspacePrimary scopes primary to the draft, leaving the global workspace store untouched", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore
      .getState()
      .addDraftResolvedFolders(draftId, [WORKSPACE_A, WORKSPACE_B]);

    useLandingDraftStore
      .getState()
      .setDraftWorkspacePrimary(draftId, WORKSPACE_B.path);

    const draftWorkspace = useLandingDraftStore.getState().drafts[0].workspace;
    expect(draftWorkspace.primaryPath).toBe(WORKSPACE_B.path);
    // The global store was never touched by a draft-scoped mutation - it
    // has no folders at all in this test, so its primary stays null.
    expect(useWorkspaceFoldersStore.getState().primaryPath).toBeNull();
  });

  it("a folder outside the draft's workspace is not settable as primary (no-op)", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    useLandingDraftStore
      .getState()
      .addDraftResolvedFolders(draftId, [WORKSPACE_A]);

    useLandingDraftStore
      .getState()
      .setDraftWorkspacePrimary(draftId, "/not-in-this-draft");

    expect(
      useLandingDraftStore.getState().drafts[0].workspace.primaryPath,
    ).toBe(WORKSPACE_A.path);
  });

  it("closeDraft removes the draft and picks another as active", () => {
    const { createDraft, setDraftContent, closeDraft } =
      useLandingDraftStore.getState();
    const a = createDraft(null);
    setDraftContent(a, textContent("wip"), null);
    const b = createDraft(null);

    closeDraft(a);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(1);
    expect(useLandingDraftStore.getState().drafts[0].id).toBe(b);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(b);
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
  });

  it("closeDraft sets activeDraftId to null when last draft is removed", () => {
    const { createDraft, closeDraft } = useLandingDraftStore.getState();
    const id = createDraft(null);
    closeDraft(id);
    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([]);
  });

  it("closeDraft is a no-op when id not found", () => {
    const before = useLandingDraftStore.getState();
    useLandingDraftStore.getState().closeDraft("nonexistent");
    expect(useLandingDraftStore.getState()).toBe(before);
  });

  it("setActiveDraft switches the active draft", () => {
    const { createDraft, setActiveDraft } = useLandingDraftStore.getState();
    const a = createDraft(null);
    const b = createDraft(null);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(b);
    setActiveDraft(a);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(a);
  });

  it("clearActiveDraft clears the active marker without removing drafts", () => {
    const { createDraft, clearActiveDraft } = useLandingDraftStore.getState();
    const draftId = createDraft(null);

    clearActiveDraft();

    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
    expect(
      useLandingDraftStore.getState().drafts.map((draft) => draft.id),
    ).toEqual([draftId]);
  });

  it("keeps drafts owned by the landing store while epic tabs stay in canvas store", () => {
    const { createDraft } = useLandingDraftStore.getState();
    const epicTabId = useEpicCanvasStore
      .getState()
      .openEpicTab("epic-a", "Epic A");
    const a = createDraft(null);
    const b = createDraft(null);

    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([epicTabId]);
    expect(useLandingDraftStore.getState().drafts.map((tab) => tab.id)).toEqual(
      [a, b],
    );
    expect(useLandingDraftStore.getState().activeDraftId).toBe(b);
  });

  it("collapses duplicate draft ids when opening a new draft", () => {
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "draft-old",
          content: EMPTY_LANDING_DRAFT_CONTENT,
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
        },
        {
          id: "draft-old",
          content: EMPTY_LANDING_DRAFT_CONTENT,
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
        },
      ],
      activeDraftId: "draft-old",
    });

    const next = useLandingDraftStore.getState().createDraft(null);

    expect(
      useLandingDraftStore.getState().drafts.map((draft) => draft.id),
    ).toEqual(["draft-old", next]);
  });

  it("materializes header tabs from typed strip refs and source stores", () => {
    const epicCanvas = createEmptyCanvas();
    useEpicCanvasStore.setState({
      tabsById: {
        "tab-a": {
          tabId: "tab-a",
          epicId: "epic-a",
          name: "Epic A",
        },
        "tab-b": {
          tabId: "tab-b",
          epicId: "epic-b",
          name: "Epic B",
        },
      },
      canvasByTabId: {
        "tab-a": epicCanvas,
        "tab-b": epicCanvas,
      },
      openTabOrder: ["tab-a", "tab-b"],
      activeTabId: "tab-a",
      mostRecentTabIdByEpicId: { "epic-a": "tab-a" },
    });
    useLandingDraftStore.setState({
      drafts: [
        {
          id: "draft-a",
          content: EMPTY_LANDING_DRAFT_CONTENT,
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: "chat",
          workspace: emptyLandingDraftWorkspaceSnapshot(),
        },
      ],
      activeDraftId: "draft-a",
    });
    useTabsStore.setState({
      stripOrder: [
        { kind: "epic", id: "tab-a" },
        { kind: "draft", id: "draft-a" },
        { kind: "epic", id: "tab-b" },
      ],
    });

    expect(getHeaderTabs().map((tab) => tab.id)).toEqual([
      "tab-a",
      "draft-a",
      "tab-b",
    ]);
  });

  it("keeps a blank-named epic tab but rejects structurally-malformed ones while applying a window projection", () => {
    // A blank `name` is now legitimate: epics/agents are created untitled and
    // the display layer derives the shown title. Identity is `id` + `epicId`,
    // so a blank-named tab with both present is a real untitled tab and must
    // survive the projection round-trip. Only entries missing `id`/`epicId` are
    // structurally malformed and dropped.
    const snapshot = emptyWindowSnapshot({
      epicTabs: [
        { id: "untitled-tab", epicId: "epic-untitled", name: "" },
        { id: "malformed-tab", epicId: "", name: "" },
      ],
      landingDrafts: [
        {
          id: "draft-a",
          content: desktopTextContent(""),
          selection: null,
          lastTouchedAt: 1,
          settings: null,
          composerMode: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    });

    applyEpicCanvasDesktopProjection(snapshot);
    applyLandingDraftDesktopProjection(snapshot);

    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([
      "untitled-tab",
    ]);
    expect(useEpicCanvasStore.getState().tabsById["untitled-tab"]?.name).toBe(
      "",
    );
    expectLandingDraftsMatch([
      {
        id: "draft-a",
        content: textContent(""),
        selection: null,
        settings: null,
        composerMode: "chat",
        workspace: emptyLandingDraftWorkspaceSnapshot(),
      },
    ]);
  });

  it("deduplicates repeated header tabs while applying a window projection", () => {
    const snapshot = emptyWindowSnapshot({
      epicTabs: [
        { id: "tab-a", epicId: "epic-a", name: "Epic A" },
        { id: "tab-a", epicId: "epic-a", name: "Epic A" },
      ],
      activeTabId: "tab-a",
      landingDrafts: [
        {
          id: "draft-a",
          content: desktopTextContent(""),
          selection: null,
          lastTouchedAt: 1,
          settings: null,
          composerMode: null,
          workspace: null,
        },
        {
          id: "draft-a",
          content: desktopTextContent(""),
          selection: null,
          lastTouchedAt: 1,
          settings: null,
          composerMode: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    });

    applyEpicCanvasDesktopProjection(snapshot);
    applyLandingDraftDesktopProjection(snapshot);

    expect(useEpicCanvasStore.getState().openTabOrder).toEqual(["tab-a"]);
    expectLandingDraftsMatch([
      {
        id: "draft-a",
        content: textContent(""),
        selection: null,
        settings: null,
        composerMode: "chat",
        workspace: emptyLandingDraftWorkspaceSnapshot(),
      },
    ]);
  });

  it("keeps the initial landing-draft projection clean for a new window", () => {
    const { createDraft, setDraftContent } = useLandingDraftStore.getState();
    const id = createDraft(null);
    setDraftContent(id, textContent("do not inherit me"), null);

    const initial = useLandingDraftStore.getInitialState();
    expect(initial.drafts).toEqual([]);
    expect(initial.activeDraftId).toBeNull();

    useLandingDraftStore.setState(initial);
    expect(useLandingDraftStore.getState().drafts).toEqual([]);
    expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
  });

  it("can replace current landing drafts with an explicit window projection", () => {
    applyLandingDraftDesktopProjection(
      emptyWindowSnapshot({
        landingDrafts: [
          {
            id: "draft-window-a",
            content: desktopTextContent("Window A prompt"),
            selection: null,
            lastTouchedAt: 1,
            settings: null,
            composerMode: null,
            workspace: null,
          },
          {
            id: "draft-window-b",
            content: desktopTextContent("Window B prompt"),
            selection: null,
            lastTouchedAt: 1,
            settings: null,
            composerMode: null,
            workspace: null,
          },
        ],
        activeLandingDraftId: "draft-window-b",
      }),
    );
    expectLandingDraftsMatch([
      {
        id: "draft-window-a",
        content: textContent("Window A prompt"),
        selection: null,
        settings: null,
        composerMode: "chat",
        workspace: emptyLandingDraftWorkspaceSnapshot(),
      },
      {
        id: "draft-window-b",
        content: textContent("Window B prompt"),
        selection: null,
        settings: null,
        composerMode: "chat",
        workspace: emptyLandingDraftWorkspaceSnapshot(),
      },
    ]);
    expect(useLandingDraftStore.getState().activeDraftId).toBe(
      "draft-window-b",
    );
  });

  it("round-trips rich content (including a hash-only image) through the desktop projection", () => {
    // T6: outbound projection -> inbound parse must preserve the full editor
    // JSON by value. A hash-only image node and the selection survive intact;
    // nothing is downgraded to plain text.
    const imageContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "img-1",
                hash: "deadbeef",
                fileName: "shot.png",
                mimeType: "image/png",
                size: 2048,
              },
            },
          ],
        },
      ],
    };

    const patches: DesktopPerWindowStatePatch[] = [];
    setLandingDraftDesktopProjectionBridge({
      update: (patch) => {
        patches.push(patch);
        return Promise.resolve();
      },
      flush: () => Promise.resolve(),
      dispose: () => undefined,
    });

    try {
      const id = useLandingDraftStore.getState().createDraft(null);
      useLandingDraftStore
        .getState()
        .setDraftContent(id, imageContent, { from: 2, to: 5 });

      const outbound = patches.at(-1)?.landingDrafts;
      expect(outbound).toHaveLength(1);
      // content out === content in (hash-only image survives the walk).
      expect(outbound?.[0].content).toEqual(imageContent);
      expect(outbound?.[0].selection).toEqual({ from: 2, to: 5 });

      // Feed the projected snapshot back inbound and confirm it restores.
      applyLandingDraftDesktopProjection({
        epicTabs: [],
        activeTabId: null,
        canvasByTabId: {},
        landingDrafts: outbound ?? [],
        activeLandingDraftId: patches.at(-1)?.activeLandingDraftId ?? null,
      });
    } finally {
      setLandingDraftDesktopProjectionBridge(null);
    }

    const restored = useLandingDraftStore.getState().drafts;
    expect(restored).toHaveLength(1);
    expect(restored[0].content).toEqual(imageContent);
    expect(restored[0].selection).toEqual({ from: 2, to: 5 });
  });

  it("drops an inbound draft whose doc `content` is not an array (malformed)", () => {
    // A corrupted snapshot: doc-typed but `content` is not an array. The inbound
    // guard must reject it, not let `draftTabName` walk a non-array and throw at
    // tab-strip render.
    const snapshot = emptyWindowSnapshot({
      epicTabs: [],
      activeTabId: null,
      landingDrafts: [
        {
          id: "bad",
          content: { type: "doc", content: "not-an-array" },
          selection: null,
          lastTouchedAt: 1,
          settings: null,
          composerMode: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "bad",
    });

    applyLandingDraftDesktopProjection(snapshot);

    expect(useLandingDraftStore.getState().drafts).toHaveLength(0);
  });

  it("projects epic tabs and landing drafts into their separate source stores", () => {
    const snapshot = emptyWindowSnapshot({
      epicTabs: [
        { id: "tab-a", epicId: "epic-a", name: "Epic A" },
        { id: "tab-b", epicId: "epic-b", name: "Epic B" },
      ],
      activeTabId: "tab-a",
      landingDrafts: [
        {
          id: "draft-a",
          content: desktopTextContent("Draft A"),
          selection: null,
          lastTouchedAt: 1,
          settings: null,
          composerMode: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    });

    applyEpicCanvasDesktopProjection(snapshot);
    applyLandingDraftDesktopProjection(snapshot);

    expect(useEpicCanvasStore.getState().openTabOrder).toEqual([
      "tab-a",
      "tab-b",
    ]);
    expectLandingDraftsMatch([
      {
        id: "draft-a",
        content: textContent("Draft A"),
        selection: null,
        settings: null,
        composerMode: "chat",
        workspace: emptyLandingDraftWorkspaceSnapshot(),
      },
    ]);
  });

  it("persists drafts to localStorage under the versioned key", async () => {
    const { createDraft, setDraftContent } = useLandingDraftStore.getState();
    const id = createDraft(null);
    setDraftContent(id, textContent("survives reload"), null);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const raw = window.localStorage.getItem(LANDING_DRAFT_PERSIST_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "{}") as {
      state?: {
        drafts?: Array<{
          id: string;
          content: JsonContent;
          settings: unknown;
        }>;
      };
    };
    expect(parsed.state?.drafts?.[0]?.content).toEqual(
      textContent("survives reload"),
    );
    expect(parsed.state?.drafts?.[0]?.settings).toBeNull();
  });

  // Mechanism A (round 5): the strip lives at the two SERIALIZATION seams — the
  // localStorage `partialize` and the desktop projection — NOT in
  // `setDraftContent`. The in-memory draft is canonical and keeps a paste's
  // still-pending b64 node so a keyed remount / in-session navigate-back can
  // re-ingest it; only the serialized forms are guaranteed base64-free.
  describe("base64 image nodes strip only at the serialization seams", () => {
    const mixedPendingContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A" },
            {
              type: "imageAttachment",
              attrs: {
                id: "pending-b64",
                fileName: "pending.png",
                b64content: "YWJj",
                mimeType: "image/png",
                size: 3,
              },
            },
            { type: "text", text: "B" },
            {
              type: "imageAttachment",
              attrs: {
                id: "stored-hash",
                fileName: "stored.png",
                hash: "a".repeat(64),
                mimeType: "image/png",
                size: 10,
              },
            },
          ],
        },
      ],
    };
    const strippedContent: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A" },
            { type: "text", text: "B" },
            {
              type: "imageAttachment",
              attrs: {
                id: "stored-hash",
                fileName: "stored.png",
                hash: "a".repeat(64),
                mimeType: "image/png",
                size: 10,
              },
            },
          ],
        },
      ],
    };

    it("setDraftContent keeps the pending b64 node in the canonical in-memory draft", () => {
      const id = useLandingDraftStore.getState().createDraft(null);
      useLandingDraftStore
        .getState()
        .setDraftContent(id, mixedPendingContent, null);
      // Verbatim — this is the content the keyed remount reads back and the
      // mount-time re-entry re-ingests.
      expect(
        useLandingDraftStore.getState().drafts.find((d) => d.id === id)
          ?.content,
      ).toEqual(mixedPendingContent);
    });

    it("the desktop projection strips the pending b64 node (keeping text + hash)", () => {
      const patches: DesktopPerWindowStatePatch[] = [];
      setLandingDraftDesktopProjectionBridge({
        update: (patch) => {
          patches.push(patch);
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
        dispose: () => undefined,
      });
      try {
        const id = useLandingDraftStore.getState().createDraft(null);
        useLandingDraftStore
          .getState()
          .setDraftContent(id, mixedPendingContent, null);
        const outbound = patches.at(-1)?.landingDrafts;
        expect(outbound).toHaveLength(1);
        expect(outbound?.[0].content).toEqual(strippedContent);
      } finally {
        setLandingDraftDesktopProjectionBridge(null);
      }
    });

    it("the localStorage partialize strips the pending b64 node (keeping text + hash)", async () => {
      const id = useLandingDraftStore.getState().createDraft(null);
      useLandingDraftStore
        .getState()
        .setDraftContent(id, mixedPendingContent, null);

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const raw = window.localStorage.getItem(LANDING_DRAFT_PERSIST_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw ?? "{}") as {
        state?: { drafts?: Array<{ id: string; content: JsonContent }> };
      };
      expect(parsed.state?.drafts?.[0]?.content).toEqual(strippedContent);
    });

    it("drops an attachmentGroup left empty after stripping its only b64 child from the serialized form", () => {
      const onlyPending: JsonContent = {
        type: "doc",
        content: [
          {
            type: "attachmentGroup",
            content: [
              {
                type: "imageAttachment",
                attrs: {
                  id: "only-pending",
                  fileName: "x.png",
                  b64content: "eA==",
                  mimeType: "image/png",
                  size: 1,
                },
              },
            ],
          },
        ],
      };
      const patches: DesktopPerWindowStatePatch[] = [];
      setLandingDraftDesktopProjectionBridge({
        update: (patch) => {
          patches.push(patch);
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
        dispose: () => undefined,
      });
      try {
        const id = useLandingDraftStore.getState().createDraft(null);
        useLandingDraftStore.getState().setDraftContent(id, onlyPending, null);
        // In-memory keeps the pending group verbatim...
        expect(
          useLandingDraftStore.getState().drafts.find((d) => d.id === id)
            ?.content,
        ).toEqual(onlyPending);
        // ...but the projected form drops the now-empty attachmentGroup (strip
        // returns the doc node, not null, once its children are gone).
        expect(patches.at(-1)?.landingDrafts?.[0].content).toEqual({
          type: "doc",
          content: [],
        });
      } finally {
        setLandingDraftDesktopProjectionBridge(null);
      }
    });
  });

  describe("[B1] empty-inbound clobber guard", () => {
    it("preserves non-empty in-memory drafts on empty inbound and re-projects outbound", () => {
      // Stub the GC gates (no call-through): this suite has no idb-keyval mock,
      // and the assertion is about whether the guard fires them, not the sweep.
      // [B1-P2] mount→readiness is covered with the real GC in
      // landing-image-gc.test.ts `[B1+B2]` (spyOn cannot intercept same-module
      // internal calls from markLandingEditorMounted → markLandingDraftsReady).
      const markReady = vi
        .spyOn(landingImageGc, "markLandingDraftsReady")
        .mockImplementation(() => undefined);
      const markAuthoritative = vi
        .spyOn(landingImageGc, "markLandingDraftsAuthoritativeNonEmpty")
        .mockImplementation(() => undefined);
      const patches: DesktopPerWindowStatePatch[] = [];
      setLandingDraftDesktopProjectionBridge({
        update: (patch) => {
          patches.push(patch);
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
        dispose: () => undefined,
      });

      try {
        // The first host-owned snapshot is authoritative even when empty. Only
        // later empty updates may be rejected as spurious live-window churn.
        applyLandingDraftDesktopProjection(emptyWindowSnapshot({}));
        const id = useLandingDraftStore.getState().createDraft(null);
        useLandingDraftStore
          .getState()
          .setDraftContent(id, textContent("alive draft"), null);
        const inMemoryBefore = useLandingDraftStore.getState().drafts;
        expect(inMemoryBefore).toHaveLength(1);
        patches.length = 0;
        markReady.mockClear();
        markAuthoritative.mockClear();

        // Spurious empty projection (registry churn / stale cold-start read).
        applyLandingDraftDesktopProjection(
          emptyWindowSnapshot({
            landingDrafts: [],
            activeLandingDraftId: null,
          }),
        );

        // In-memory truth is preserved.
        expect(useLandingDraftStore.getState().drafts).toEqual(inMemoryBefore);
        expect(useLandingDraftStore.getState().activeDraftId).toBe(id);
        // Guard re-projects outbound so disk reconverges to the live draft.
        expect(patches).toHaveLength(1);
        expect(patches[0].landingDrafts).toHaveLength(1);
        expect(patches[0].landingDrafts?.[0]?.id).toBe(id);
        expect(patches[0].activeLandingDraftId).toBe(id);
        // Ready/authoritative gates must NOT flip on a bad empty inbound -
        // that is the exact path that would fire a reaping reconcile.
        expect(markReady).not.toHaveBeenCalled();
        expect(markAuthoritative).not.toHaveBeenCalled();
      } finally {
        setLandingDraftDesktopProjectionBridge(null);
        markReady.mockRestore();
        markAuthoritative.mockRestore();
      }
    });

    it("applies the first empty desktop hydrate over stale local drafts", () => {
      const markReady = vi
        .spyOn(landingImageGc, "markLandingDraftsReady")
        .mockImplementation(() => undefined);
      const patches: DesktopPerWindowStatePatch[] = [];
      setLandingDraftDesktopProjectionBridge({
        update: (patch) => {
          patches.push(patch);
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
        dispose: () => undefined,
      });

      try {
        const staleId = useLandingDraftStore.getState().createDraft(null);
        useLandingDraftStore
          .getState()
          .setDraftContent(staleId, textContent("stale local draft"), null);
        patches.length = 0;
        markReady.mockClear();

        applyLandingDraftDesktopProjection(
          emptyWindowSnapshot({
            landingDrafts: [],
            activeLandingDraftId: null,
          }),
        );

        expect(useLandingDraftStore.getState().drafts).toEqual([]);
        expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
        expect(patches).toEqual([]);
        expect(markReady).toHaveBeenCalledOnce();
      } finally {
        setLandingDraftDesktopProjectionBridge(null);
        markReady.mockRestore();
      }
    });

    it("applies an empty inbound normally when in-memory drafts are already empty", () => {
      const markReady = vi
        .spyOn(landingImageGc, "markLandingDraftsReady")
        .mockImplementation(() => undefined);
      markReady.mockClear();

      try {
        expect(useLandingDraftStore.getState().drafts).toEqual([]);

        applyLandingDraftDesktopProjection(
          emptyWindowSnapshot({
            landingDrafts: [],
            activeLandingDraftId: null,
          }),
        );

        expect(useLandingDraftStore.getState().drafts).toEqual([]);
        expect(useLandingDraftStore.getState().activeDraftId).toBeNull();
        // Empty+empty is a legitimate first projection: ready gate may fire.
        expect(markReady).toHaveBeenCalled();
      } finally {
        markReady.mockRestore();
      }
    });
  });
});

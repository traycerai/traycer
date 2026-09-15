import { describe, expect, it } from "vitest";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  SessionImportCandidate,
  SessionImportCandidateState,
  SessionImportGroup,
} from "@traycer/protocol/host/session-import/candidate";
import {
  buildWelcomeSessionsView,
  groupImportableKeys,
  welcomeGroupKey,
  type WelcomeProviderSection,
  type WelcomeSessionsView,
} from "@/components/onboarding/welcome/welcome-sessions-model";
import {
  SESSION_IMPORT_DELETED_FOLDERS_GROUP_KEY,
  SESSION_IMPORT_INITIAL_STATE,
  sessionImportWizardReducer,
  type SessionImportWizardAction,
  type SessionImportWizardState,
} from "@/components/session-import/session-import-model";

function candidate(input: {
  readonly harness: GuiHarnessId;
  readonly id: string;
  readonly state: SessionImportCandidateState;
  readonly updatedAt: number;
}): SessionImportCandidate {
  return {
    harness: input.harness,
    nativeSessionId: input.id,
    title: `Session ${input.id}`,
    firstPrompt: null,
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
    messageCount: null,
    hasSubagents: false,
    state: input.state,
  };
}

const IMPORTABLE: SessionImportCandidateState = { kind: "importable" };
const UNREADABLE: SessionImportCandidateState = {
  kind: "unreadable",
  reason: "source_unreadable",
  detail: "Corrupt session file",
};
const IMPORTED: SessionImportCandidateState = {
  kind: "already_in_traycer",
  epicId: "epic-1",
  chatId: "chat-1",
};

function folder(
  path: string,
  gitBacked: boolean,
  sessions: ReadonlyArray<SessionImportCandidate>,
): SessionImportGroup {
  return {
    location: { kind: "folder", path, workspaceId: null },
    gitBacked,
    sessions: [...sessions],
  };
}

function missingFolder(
  path: string,
  sessions: ReadonlyArray<SessionImportCandidate>,
): SessionImportGroup {
  return {
    location: { kind: "missing_folder", path },
    gitBacked: false,
    sessions: [...sessions],
  };
}

/** Plays frames and user actions through the REAL reducer. */
function reduce(
  actions: ReadonlyArray<SessionImportWizardAction>,
): SessionImportWizardState {
  return actions.reduce(
    sessionImportWizardReducer,
    SESSION_IMPORT_INITIAL_STATE,
  );
}

// Folder A (a repo): claude×2 + codex×1 + one claude row already imported.
// Folder B (loose): claude×1, unreadable. One deleted folder: claude×1.
const FIXTURE: ReadonlyArray<SessionImportWizardAction> = [
  { kind: "scanStarted", providers: ["claude", "codex"] },
  {
    kind: "scanGroupArrived",
    group: folder("/repo/b", false, [
      candidate({
        harness: "claude",
        id: "b1",
        state: UNREADABLE,
        updatedAt: 5,
      }),
    ]),
  },
  {
    kind: "scanGroupArrived",
    group: folder("/repo/a", true, [
      candidate({
        harness: "claude",
        id: "a1",
        state: IMPORTABLE,
        updatedAt: 3,
      }),
      candidate({
        harness: "codex",
        id: "a2",
        state: IMPORTABLE,
        updatedAt: 2,
      }),
      candidate({
        harness: "claude",
        id: "a3",
        state: IMPORTABLE,
        updatedAt: 1,
      }),
      candidate({ harness: "claude", id: "a4", state: IMPORTED, updatedAt: 9 }),
    ]),
  },
  {
    kind: "scanGroupArrived",
    group: missingFolder("/gone", [
      candidate({
        harness: "claude",
        id: "g1",
        state: IMPORTABLE,
        updatedAt: 4,
      }),
    ]),
  },
];

function sectionFor(
  view: WelcomeSessionsView,
  harness: GuiHarnessId,
): WelcomeProviderSection {
  const section = view.sections.find((entry) => entry.harness === harness);
  if (section === undefined) throw new Error(`no ${harness} section`);
  return section;
}

describe("buildWelcomeSessionsView", () => {
  it("sections by provider in the app's provider order, folders repos → loose → deleted", () => {
    const view = buildWelcomeSessionsView(reduce(FIXTURE));
    // Codex before Claude: `PROVIDER_ID_ORDER`, not arrival order (Claude's
    // folder landed first).
    expect(view.sections.map((section) => section.harness)).toEqual([
      "codex",
      "claude",
    ]);
    const claude = sectionFor(view, "claude");
    expect(claude.name).toBe("Claude Code");
    expect(claude.groups.map((group) => group.groupKey)).toEqual([
      welcomeGroupKey("claude", "folder:/repo/a"),
      welcomeGroupKey("claude", "folder:/repo/b"),
      welcomeGroupKey("claude", SESSION_IMPORT_DELETED_FOLDERS_GROUP_KEY),
    ]);
    expect(claude.groups.map((group) => group.name)).toEqual([
      "a",
      "b",
      "Deleted Folders",
    ]);
    expect(claude.groups[2]?.path).toBe("1 folder no longer on this machine");
    expect(claude.groups[2]?.rows[0]?.folderPath).toBe("/gone");

    const codex = sectionFor(view, "codex");
    expect(codex.groups.map((group) => group.groupKey)).toEqual([
      welcomeGroupKey("codex", "folder:/repo/a"),
    ]);
    // Codex's slice of folder A carries only Codex's row.
    expect(codex.groups[0]?.rows.map((row) => row.selectionKey)).toEqual([
      "codex:a2",
    ]);
  });

  it("hides imported rows, keeps unreadable ones unselectable, and counts the rest", () => {
    const view = buildWelcomeSessionsView(reduce(FIXTURE));
    const claude = sectionFor(view, "claude");
    const allKeys = claude.groups.flatMap((group) =>
      group.rows.map((row) => row.selectionKey),
    );
    expect(allKeys).not.toContain("claude:a4");
    expect(allKeys).toContain("claude:b1");
    expect(claude.importableKeys).toEqual([
      "claude:a1",
      "claude:a3",
      "claude:g1",
    ]);
    const folderB = claude.groups.at(1);
    if (folderB === undefined) throw new Error("no folder b");
    expect(groupImportableKeys(folderB)).toEqual([]);
    expect(folderB.rows[0]?.unavailableLabel).toBe("Unreadable");
    expect(folderB.rows[0]?.unavailableDetail).toBe(
      "Could not be read: Corrupt session file",
    );
    expect(folderB.selectionState).toBe("none");

    expect(view.selectableCount).toBe(4);
    expect(view.totalSessions).toBe(5);
  });

  it("tracks the three-state at provider and folder level through the reducer", () => {
    const arrived = reduce(FIXTURE);
    let view = buildWelcomeSessionsView(arrived);
    // Arrival pre-selects everything importable.
    expect(view.selectedCount).toBe(4);
    expect(view.sections.map((section) => section.selectionState)).toEqual([
      "all",
      "all",
    ]);
    expect(sectionFor(view, "claude").selectedCount).toBe(3);

    // Untick one Claude row in folder A: provider and folder go partial.
    const oneOff = sessionImportWizardReducer(arrived, {
      kind: "sessionToggled",
      selectionKey: "claude:a1",
    });
    view = buildWelcomeSessionsView(oneOff);
    expect(sectionFor(view, "claude").selectionState).toBe("partial");
    expect(sectionFor(view, "claude").groups[0]?.selectionState).toBe(
      "partial",
    );
    expect(sectionFor(view, "claude").groups[2]?.selectionState).toBe("all");
    expect(sectionFor(view, "codex").selectionState).toBe("all");
    expect(view.selectedCount).toBe(3);

    // Clear the whole Claude section through its own key set: Codex holds.
    const claudeKeys = sectionFor(view, "claude").importableKeys;
    const cleared = sessionImportWizardReducer(oneOff, {
      kind: "visibleSelectionSet",
      selectionKeys: claudeKeys,
      selected: false,
    });
    view = buildWelcomeSessionsView(cleared);
    expect(sectionFor(view, "claude").selectionState).toBe("none");
    expect(sectionFor(view, "claude").selectedCount).toBe(0);
    expect(sectionFor(view, "codex").selectionState).toBe("all");
    expect(view.selectedCount).toBe(1);
  });

  it("expands a folder group under its composite key only", () => {
    const state = sessionImportWizardReducer(reduce(FIXTURE), {
      kind: "groupExpansionToggled",
      groupKey: welcomeGroupKey("claude", "folder:/repo/a"),
    });
    const view = buildWelcomeSessionsView(state);
    expect(sectionFor(view, "claude").groups[0]?.expanded).toBe(true);
    // The same folder under Codex is its own group and stays collapsed.
    expect(sectionFor(view, "codex").groups[0]?.expanded).toBe(false);
  });

  it("keeps a header-only section for a scanned provider with nothing, and a failed one", () => {
    const state = reduce([
      { kind: "scanStarted", providers: ["claude", "codex", "opencode"] },
      {
        kind: "scanProviderFailed",
        failure: {
          harness: "codex",
          reason: "source_unreadable",
          detail: "~/.codex is unreadable",
        },
      },
      { kind: "scanGroupArrived", group: folder("/repo/a", true, []) },
    ]);
    const view = buildWelcomeSessionsView(state);
    expect(view.sections.map((section) => section.harness)).toEqual([
      "codex",
      "claude",
      "opencode",
    ]);
    expect(view.sections.map((section) => section.failure)).toEqual([
      "~/.codex is unreadable",
      null,
      null,
    ]);
    expect(view.sections.every((section) => section.groups.length === 0)).toBe(
      true,
    );
    expect(view.selectableCount).toBe(0);
  });
});

import type {
  SessionImportCandidate,
  SessionImportFailureReason,
  SessionImportGroup,
  SessionImportGroupLocation,
} from "@traycer/protocol/host/session-import/candidate";
import type { SessionImportScanTotals } from "@traycer/protocol/host/session-import/scan";
import type { SessionImportOutcome } from "@traycer/protocol/host/session-import/run";
import type { SessionImportProviderFailure } from "@traycer-clients/shared/host-transport/session-import-scan-client";
import { describe, expect, it } from "vitest";
import {
  buildSessionImportSubmission,
  buildSessionImportView,
  candidateDisplayTitle,
  groupSessionImportFailures,
  harnessDisplayName,
  sessionImportFailureLabel,
  sessionImportFailureDetailVaries,
  sessionImportNotImportedLine,
  sessionImportGroupKey,
  sessionImportScanWindowLabel,
  sessionImportSelectionKey,
  sessionImportWizardReducer,
  SESSION_IMPORT_INITIAL_STATE,
  SESSION_IMPORT_SCAN_WINDOW_OPTIONS,
  type SessionImportOutcomeEntry,
  type SessionImportWizardAction,
  type SessionImportWizardState,
} from "@/components/session-import/session-import-model";

/**
 * Every test builds its own candidates and groups rather than sharing
 * literals, so a test that mutates a field (a title, a state) can never leak
 * into another - the reducer's whole job is to react to what arrives, and a
 * shared fixture would hide which arrival caused which effect.
 */
let candidateSequence = 0;

function candidate(
  overrides: Partial<SessionImportCandidate>,
): SessionImportCandidate {
  candidateSequence += 1;
  return {
    harness: "claude",
    nativeSessionId: `session-${candidateSequence}`,
    title: `Session ${candidateSequence}`,
    firstPrompt: null,
    createdAt: 0,
    updatedAt: 0,
    messageCount: null,
    hasSubagents: false,
    state: { kind: "importable" },
    ...overrides,
  };
}

function group(
  location: SessionImportGroupLocation,
  sessions: ReadonlyArray<SessionImportCandidate>,
): SessionImportGroup {
  return { location, gitBacked: false, sessions: [...sessions] };
}

function folderLocation(path: string): SessionImportGroupLocation {
  return { kind: "folder", path, workspaceId: null };
}

function applyActions(
  actions: ReadonlyArray<SessionImportWizardAction>,
): SessionImportWizardState {
  return actions.reduce(
    sessionImportWizardReducer,
    SESSION_IMPORT_INITIAL_STATE,
  );
}

describe("sessionImportWizardReducer - selection defaults as groups stream in", () => {
  it("pre-selects every importable candidate in an arriving group, skipping already-imported and unreadable ones", () => {
    const importableA = candidate({ nativeSessionId: "s1" });
    const importableB = candidate({ nativeSessionId: "s2" });
    const alreadyImported = candidate({
      nativeSessionId: "s3",
      state: { kind: "already_in_traycer", epicId: "epic-1", chatId: "chat-1" },
    });
    const unreadable = candidate({
      nativeSessionId: "s4",
      state: {
        kind: "unreadable",
        reason: "source_unreadable",
        detail: "corrupt",
      },
    });
    const arrivingGroup = group(folderLocation("/repo/a"), [
      importableA,
      importableB,
      alreadyImported,
      unreadable,
    ]);

    const state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
    ]);

    expect(state.selected).toEqual(
      new Set([
        sessionImportSelectionKey("claude", "s1"),
        sessionImportSelectionKey("claude", "s2"),
      ]),
    );
    // The already-imported row is not merely unticked - it never enters the
    // state at all (older hosts still send it; current ones hide it).
    expect(state.groups[0]?.sessions.map((one) => one.nativeSessionId)).toEqual(
      ["s1", "s2", "s4"],
    );
  });

  it("pre-selects importable candidates in a missing_folder group too", () => {
    const orphaned = candidate({ nativeSessionId: "s1" });
    const arrivingGroup = group({ kind: "missing_folder", path: "/gone" }, [
      orphaned,
    ]);

    const state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
    ]);

    expect(state.selected.has(sessionImportSelectionKey("claude", "s1"))).toBe(
      true,
    );
  });

  it("keeps a user's deselection of a group-A candidate when group B arrives", () => {
    const a1 = candidate({ nativeSessionId: "a1" });
    const a2 = candidate({ nativeSessionId: "a2" });
    const groupA = group(folderLocation("/repo/a"), [a1, a2]);
    const b1 = candidate({ nativeSessionId: "b1" });
    const groupB = group(folderLocation("/repo/b"), [b1]);
    const keyA1 = sessionImportSelectionKey("claude", "a1");

    const state = applyActions([
      { kind: "scanGroupArrived", group: groupA },
      { kind: "sessionToggled", selectionKey: keyA1 },
      { kind: "scanGroupArrived", group: groupB },
    ]);

    expect(state.selected.has(keyA1)).toBe(false);
    expect(state.selected.has(sessionImportSelectionKey("claude", "a2"))).toBe(
      true,
    );
    expect(state.selected.has(sessionImportSelectionKey("claude", "b1"))).toBe(
      true,
    );
  });

  it("is a no-op when a group with the same location kind + path arrives twice", () => {
    const first = candidate({ nativeSessionId: "s1" });
    const firstArrival = group(folderLocation("/repo/a"), [first]);
    const stateAfterFirst = sessionImportWizardReducer(
      SESSION_IMPORT_INITIAL_STATE,
      { kind: "scanGroupArrived", group: firstArrival },
    );

    // A distinct object, but the same location kind + path - a re-broadcast
    // of a group the reducer has already applied.
    const secondArrival = group(folderLocation("/repo/a"), [
      candidate({ nativeSessionId: "s1" }),
    ]);
    const stateAfterSecond = sessionImportWizardReducer(stateAfterFirst, {
      kind: "scanGroupArrived",
      group: secondArrival,
    });

    expect(stateAfterSecond).toBe(stateAfterFirst);
    expect(stateAfterSecond.groups).toHaveLength(1);
  });
});

describe("buildSessionImportView - disabled rows", () => {
  it("drops an arriving group that holds nothing but already-imported rows", () => {
    // An older host still sends already_in_traycer rows; a current one hides
    // them at the scan. Either way the wizard shows only what is new, so a
    // group with nothing new never appears.
    const alreadyImported = candidate({
      nativeSessionId: "s1",
      state: { kind: "already_in_traycer", epicId: "epic-1", chatId: "chat-1" },
    });
    const state = applyActions([
      {
        kind: "scanGroupArrived",
        group: group(folderLocation("/repo/a"), [alreadyImported]),
      },
    ]);

    expect(state.groups).toHaveLength(0);
    expect(buildSessionImportView(state).groups).toHaveLength(0);
  });

  it("projects an unreadable row's unavailableDetail with both the reason label and the raw detail", () => {
    const unreadable = candidate({
      nativeSessionId: "s1",
      state: {
        kind: "unreadable",
        reason: "source_unreadable",
        detail: "database is locked",
      },
    });
    const state = applyActions([
      {
        kind: "scanGroupArrived",
        group: group(folderLocation("/repo/a"), [unreadable]),
      },
    ]);

    const view = buildSessionImportView(state);
    expect(view.groups[0]?.rows).toHaveLength(1);
    const row = view.groups[0]?.rows[0];

    expect(row.selectable).toBe(false);
    expect(row.unavailableDetail).toContain(
      sessionImportFailureLabel("source_unreadable"),
    );
    expect(row.unavailableDetail).toContain("database is locked");
  });
});

describe("buildSessionImportView - group header counts and tri-state", () => {
  it("keeps a group header's selectableCount/selectedCount over the whole group, not the filtered slice", () => {
    const matching = candidate({
      nativeSessionId: "match",
      title: "Fix login bug",
    });
    const other = candidate({
      nativeSessionId: "other",
      title: "Refactor styles",
    });
    const arrivingGroup = group(folderLocation("/repo/a"), [matching, other]);

    const state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
      { kind: "queryChanged", query: "login" },
    ]);
    const view = buildSessionImportView(state);

    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]?.rows).toHaveLength(1);
    expect(view.groups[0]?.selectableCount).toBe(2);
    expect(view.groups[0]?.selectedCount).toBe(2);
  });

  it("computes selectionState as all, then partial, then none as candidates are untoggled, and none for a group with zero importable candidates", () => {
    const s1 = candidate({ nativeSessionId: "s1" });
    const s2 = candidate({ nativeSessionId: "s2" });
    const groupA = group(folderLocation("/repo/a"), [s1, s2]);
    const onlyUnavailable = candidate({
      nativeSessionId: "s3",
      state: { kind: "already_in_traycer", epicId: "e", chatId: "c" },
    });
    const groupB = group(folderLocation("/repo/b"), [onlyUnavailable]);

    let state = applyActions([
      { kind: "scanGroupArrived", group: groupA },
      { kind: "scanGroupArrived", group: groupB },
    ]);
    let view = buildSessionImportView(state);
    expect(view.groups.find((g) => g.path === "/repo/a")?.selectionState).toBe(
      "all",
    );
    // Its only row was already imported, so the group never arrived at all.
    expect(view.groups.find((g) => g.path === "/repo/b")).toBeUndefined();

    state = sessionImportWizardReducer(state, {
      kind: "sessionToggled",
      selectionKey: sessionImportSelectionKey("claude", "s1"),
    });
    view = buildSessionImportView(state);
    expect(view.groups.find((g) => g.path === "/repo/a")?.selectionState).toBe(
      "partial",
    );

    state = sessionImportWizardReducer(state, {
      kind: "sessionToggled",
      selectionKey: sessionImportSelectionKey("claude", "s2"),
    });
    view = buildSessionImportView(state);
    expect(view.groups.find((g) => g.path === "/repo/a")?.selectionState).toBe(
      "none",
    );
  });

  it("groupSelectionSet with selected:false clears only that group's importable candidates", () => {
    const a1 = candidate({ nativeSessionId: "a1" });
    const groupA = group(folderLocation("/repo/a"), [a1]);
    const b1 = candidate({ nativeSessionId: "b1" });
    const groupB = group(folderLocation("/repo/b"), [b1]);

    const state = applyActions([
      { kind: "scanGroupArrived", group: groupA },
      { kind: "scanGroupArrived", group: groupB },
      {
        kind: "groupSelectionSet",
        groupKey: sessionImportGroupKey(groupA.location),
        selected: false,
      },
    ]);

    expect(state.selected.has(sessionImportSelectionKey("claude", "a1"))).toBe(
      false,
    );
    expect(state.selected.has(sessionImportSelectionKey("claude", "b1"))).toBe(
      true,
    );
  });

  // Both folders below hold the same two providers and differ only in the
  // order the host reported them, so a pill row that reshuffled with arrival
  // order would render the same fact two different ways on one screen.
  it("pills providers in the app's harness order, with counts summed across every group, not the order the host reported", () => {
    const claudeFirst = group(folderLocation("/repo/a"), [
      candidate({ harness: "claude", nativeSessionId: "a1" }),
      candidate({ harness: "codex", nativeSessionId: "a2" }),
      candidate({ harness: "claude", nativeSessionId: "a3" }),
    ]);
    const codexFirst = group(folderLocation("/repo/b"), [
      candidate({ harness: "codex", nativeSessionId: "b1" }),
      candidate({ harness: "claude", nativeSessionId: "b2" }),
    ]);

    const view = buildSessionImportView(
      applyActions([
        { kind: "scanGroupArrived", group: claudeFirst },
        { kind: "scanGroupArrived", group: codexFirst },
      ]),
    );

    // 3 claude sessions (a1, a3, b2) and 2 codex sessions (a2, b1), summed
    // over both groups - there are no per-group provider counts any more.
    expect(view.providers).toEqual([
      {
        harness: "codex",
        name: harnessDisplayName("codex"),
        count: 2,
        enabled: true,
      },
      {
        harness: "claude",
        name: harnessDisplayName("claude"),
        count: 3,
        enabled: true,
      },
    ]);
  });

  // The pill row is STATIC: the scan's `started` frame names every provider
  // it covers, so the row is complete before the first folder lands instead
  // of pills popping in with results.
  it("pills every provider the scan covers from scanStarted, before any group arrives", () => {
    const view = buildSessionImportView(
      applyActions([{ kind: "scanStarted", providers: ["claude", "codex"] }]),
    );

    expect(view.providers).toEqual([
      {
        harness: "codex",
        name: harnessDisplayName("codex"),
        count: 0,
        enabled: true,
      },
      {
        harness: "claude",
        name: harnessDisplayName("claude"),
        count: 0,
        enabled: true,
      },
    ]);
  });

  // A window change starts a fresh scan that wipes the groups - but which
  // providers the host scans is not a per-scan fact, so the roster (and with
  // it the pill row) holds instead of blinking empty until `started` re-lands.
  it("keeps the provider roster through a fresh restart", () => {
    const view = buildSessionImportView(
      applyActions([
        { kind: "scanStarted", providers: ["claude", "codex"] },
        { kind: "scanRestarted", reason: "fresh" },
      ]),
    );

    expect(view.providers.map((provider) => provider.harness)).toEqual([
      "codex",
      "claude",
    ]);
  });
});

describe("buildSessionImportView - search + provider filter", () => {
  it("keeps a candidate whose title matches the query and drops one that doesn't; a folder-path match keeps every row in the group", () => {
    const matching = candidate({
      nativeSessionId: "s1",
      title: "Fix login bug",
    });
    const nonMatching = candidate({
      nativeSessionId: "s2",
      title: "Refactor styles",
    });
    const arrivingGroup = group(folderLocation("/Users/dev/my-project"), [
      matching,
      nonMatching,
    ]);

    let state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
      { kind: "queryChanged", query: "login" },
    ]);
    let view = buildSessionImportView(state);
    expect(view.groups[0]?.rows.map((row) => row.selectionKey)).toEqual([
      sessionImportSelectionKey("claude", "s1"),
    ]);

    state = sessionImportWizardReducer(state, {
      kind: "queryChanged",
      query: "my-project",
    });
    view = buildSessionImportView(state);
    expect(view.groups[0]?.rows).toHaveLength(2);
  });

  it("matches a title:null candidate by firstPrompt, and candidateDisplayTitle falls back title -> firstPrompt -> Untitled session, collapsing/truncating a long prompt", () => {
    const withTitle = candidate({ title: "Explicit title" });
    expect(candidateDisplayTitle(withTitle)).toBe("Explicit title");

    const untitled = candidate({ title: null, firstPrompt: null });
    expect(candidateDisplayTitle(untitled)).toBe("Untitled session");

    const whitespacePrompt = candidate({
      title: null,
      firstPrompt: "  fix   the   bug  ",
    });
    expect(candidateDisplayTitle(whitespacePrompt)).toBe("fix the bug");

    const longPrompt = "word ".repeat(60).trim();
    expect(longPrompt.length).toBeGreaterThan(140);
    const longPromptCandidate = candidate({
      nativeSessionId: "long",
      title: null,
      firstPrompt: longPrompt,
    });
    expect(candidateDisplayTitle(longPromptCandidate)).toBe(
      `${longPrompt.slice(0, 140)}…`,
    );

    const state = applyActions([
      {
        kind: "scanGroupArrived",
        group: group(folderLocation("/repo/a"), [longPromptCandidate]),
      },
      { kind: "queryChanged", query: "word" },
    ]);
    const view = buildSessionImportView(state);
    expect(view.groups[0]?.rows).toHaveLength(1);
  });

  it("narrows matchedSessions via a disabled provider without changing totalSessions, but drops that provider's picks from selectedCount", () => {
    const claudeCandidate = candidate({
      harness: "claude",
      nativeSessionId: "c1",
    });
    const codexCandidate = candidate({
      harness: "codex",
      nativeSessionId: "x1",
    });
    const arrivingGroup = group(folderLocation("/repo/a"), [
      claudeCandidate,
      codexCandidate,
    ]);

    const state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
      { kind: "providerScopeToggled", harness: "codex" },
    ]);
    const view = buildSessionImportView(state);

    // Scope is not a view filter: switching codex out both hides its row and
    // unticks it, so totalSessions (everything the scan produced) holds at 2
    // while matchedSessions and selectedCount both drop to the claude-only 1.
    expect(view.matchedSessions).toBe(1);
    expect(view.totalSessions).toBe(2);
    expect(view.selectedCount).toBe(1);
  });

  it("counts only pickable sessions in selectableSessions, whatever the filters hide", () => {
    const importable = candidate({ nativeSessionId: "s1" });
    const alreadyImported = candidate({
      nativeSessionId: "s2",
      state: { kind: "already_in_traycer", epicId: "epic-1", chatId: "chat-1" },
    });
    const unreadable = candidate({
      nativeSessionId: "s3",
      state: {
        kind: "unreadable",
        reason: "source_unreadable",
        detail: "corrupt",
      },
    });
    const arrivingGroup = group(folderLocation("/repo/a"), [
      importable,
      alreadyImported,
      unreadable,
    ]);

    const state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
      { kind: "queryChanged", query: "nothing-matches-this" },
    ]);
    const view = buildSessionImportView(state);

    expect(view.totalSessions).toBe(2);
    expect(view.selectableSessions).toBe(1);
    expect(view.selectedCount).toBe(1);
  });

  it("limits visibleSelectionKeys to visible selectable rows, and visibleSelectionSet toggles exactly those", () => {
    const claudeCandidate = candidate({
      harness: "claude",
      nativeSessionId: "c1",
    });
    const codexCandidate = candidate({
      harness: "codex",
      nativeSessionId: "x1",
    });
    const alreadyImported = candidate({
      harness: "claude",
      nativeSessionId: "c2",
      state: { kind: "already_in_traycer", epicId: "e", chatId: "c" },
    });
    const arrivingGroup = group(folderLocation("/repo/a"), [
      claudeCandidate,
      codexCandidate,
      alreadyImported,
    ]);

    let state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
      { kind: "providerScopeToggled", harness: "codex" },
    ]);
    const view = buildSessionImportView(state);
    expect(view.visibleSelectionKeys).toEqual([
      sessionImportSelectionKey("claude", "c1"),
    ]);

    state = sessionImportWizardReducer(state, {
      kind: "visibleSelectionSet",
      selectionKeys: view.visibleSelectionKeys,
      selected: false,
    });

    expect(state.selected.has(sessionImportSelectionKey("claude", "c1"))).toBe(
      false,
    );
    // Out of scope from the providerScopeToggled above, not merely filtered
    // out of the view - so it was already untouched by ITS toggle too.
    expect(state.selected.has(sessionImportSelectionKey("codex", "x1"))).toBe(
      false,
    );
  });

  it("omits a group whose every row is filtered out", () => {
    const onlyCandidate = candidate({ nativeSessionId: "s1", title: "Alpha" });
    const state = applyActions([
      {
        kind: "scanGroupArrived",
        group: group(folderLocation("/repo/a"), [onlyCandidate]),
      },
      { kind: "queryChanged", query: "does-not-match-anything" },
    ]);

    const view = buildSessionImportView(state);
    expect(view.groups).toHaveLength(0);
  });
});

describe("sessionImportWizardReducer - provider scope toggling", () => {
  it("switching a provider out drops its rows from the view AND from the submission, in one move", () => {
    const claudeCandidate = candidate({
      harness: "claude",
      nativeSessionId: "c1",
    });
    const codexCandidate = candidate({
      harness: "codex",
      nativeSessionId: "x1",
    });
    const arrivingGroup = group(folderLocation("/repo/a"), [
      claudeCandidate,
      codexCandidate,
    ]);

    const state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
      { kind: "providerScopeToggled", harness: "codex" },
    ]);

    const view = buildSessionImportView(state);
    expect(view.groups[0]?.rows.map((row) => row.selectionKey)).toEqual([
      sessionImportSelectionKey("claude", "c1"),
    ]);
    expect(view.groups[0]?.totalCount).toBe(1);

    // Scope, not a view filter: an out-of-scope row cannot ride along in the
    // submission just because nobody unticked it by hand.
    const submission = buildSessionImportSubmission(state);
    expect(submission.selections).toEqual([
      { harness: "claude", nativeSessionId: "c1" },
    ]);
  });

  it("switching a provider back in re-selects its importable rows, but not one already imported or unreadable", () => {
    const importable = candidate({
      harness: "codex",
      nativeSessionId: "x1",
    });
    const alreadyImported = candidate({
      harness: "codex",
      nativeSessionId: "x2",
      state: { kind: "already_in_traycer", epicId: "epic-1", chatId: "chat-1" },
    });
    const unreadable = candidate({
      harness: "codex",
      nativeSessionId: "x3",
      state: {
        kind: "unreadable",
        reason: "source_unreadable",
        detail: "corrupt",
      },
    });
    const arrivingGroup = group(folderLocation("/repo/a"), [
      importable,
      alreadyImported,
      unreadable,
    ]);

    const state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
      { kind: "providerScopeToggled", harness: "codex" },
      { kind: "providerScopeToggled", harness: "codex" },
    ]);

    // A pill turned off and back on lands where a fresh arrival would have:
    // pre-selected, minus the two rows nothing can ever tick.
    expect(state.selected).toEqual(
      new Set([sessionImportSelectionKey("codex", "x1")]),
    );
  });

  it("does not pre-select a group's candidates for a harness the user already switched out", () => {
    const claudeCandidate = candidate({
      harness: "claude",
      nativeSessionId: "c1",
    });
    const codexCandidate = candidate({
      harness: "codex",
      nativeSessionId: "x1",
    });

    const state = applyActions([
      { kind: "providerScopeToggled", harness: "codex" },
      {
        kind: "scanGroupArrived",
        group: group(folderLocation("/repo/a"), [
          claudeCandidate,
          codexCandidate,
        ]),
      },
    ]);

    expect(state.selected).toEqual(
      new Set([sessionImportSelectionKey("claude", "c1")]),
    );
  });

  it("keeps a disabled provider's pill at count 0 even when the groups on hand hold nothing for it", () => {
    // Nothing has arrived for codex - or anything else - yet, but the user
    // already switched it out; the pill has to survive that with no group to
    // read a count off, because it's the only way back to turning it on.
    const state = applyActions([
      { kind: "providerScopeToggled", harness: "codex" },
    ]);

    const view = buildSessionImportView(state);
    expect(view.providers).toEqual([
      {
        harness: "codex",
        name: harnessDisplayName("codex"),
        count: 0,
        enabled: false,
      },
    ]);
  });
});

describe("sessionImportWizardReducer - frame folding into view state", () => {
  it("moves phase to complete with totals on scanCompleted, and ignores a scanFailed that arrives afterward", () => {
    const totals: SessionImportScanTotals = {
      groups: 1,
      sessions: 1,
      importable: 1,
      alreadyInTraycer: 0,
      unreadable: 0,
    };
    const state = sessionImportWizardReducer(SESSION_IMPORT_INITIAL_STATE, {
      kind: "scanCompleted",
      totals,
    });
    expect(state.phase).toBe("complete");
    expect(state.totals).toEqual(totals);

    const afterFailed = sessionImportWizardReducer(state, {
      kind: "scanFailed",
      detail: "socket dropped",
    });
    expect(afterFailed).toBe(state);
  });

  it("sets phase to failed with the detail when scanFailed arrives while still scanning", () => {
    const state = sessionImportWizardReducer(SESSION_IMPORT_INITIAL_STATE, {
      kind: "scanFailed",
      detail: "host unreachable",
    });
    expect(state.phase).toBe("failed");
    expect(state.scanErrorDetail).toBe("host unreachable");
  });

  it("accumulates scanProviderFailed entries without touching groups or selection", () => {
    const arrivingGroup = group(folderLocation("/repo/a"), [
      candidate({ nativeSessionId: "s1" }),
    ]);
    const failureA: SessionImportProviderFailure = {
      harness: "codex",
      reason: "source_unreadable",
      detail: "boom",
    };
    const failureB: SessionImportProviderFailure = {
      harness: "grok",
      reason: "internal_error",
      detail: "timed out",
    };

    const state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
      { kind: "scanProviderFailed", failure: failureA },
      { kind: "scanProviderFailed", failure: failureB },
    ]);

    expect(state.providerFailures).toEqual([failureA, failureB]);
    expect(state.groups).toEqual([arrivingGroup]);
    expect(state.selected.has(sessionImportSelectionKey("claude", "s1"))).toBe(
      true,
    );
  });

  it("replaces an earlier failure for the same harness rather than reporting it twice", () => {
    const stale: SessionImportProviderFailure = {
      harness: "codex",
      reason: "source_unreadable",
      detail: "first attempt",
    };
    const corrected: SessionImportProviderFailure = {
      harness: "codex",
      reason: "internal_error",
      detail: "second attempt",
    };
    const otherHarness: SessionImportProviderFailure = {
      harness: "claude",
      reason: "internal_error",
      detail: "unrelated",
    };

    const state = applyActions([
      { kind: "scanProviderFailed", failure: stale },
      { kind: "scanProviderFailed", failure: otherHarness },
      { kind: "scanProviderFailed", failure: corrected },
    ]);

    expect(state.providerFailures).toEqual([otherHarness, corrected]);
  });

  it("keeps selection and expanded folders across a reconnect restart, including a deliberate untick", () => {
    const kept = candidate({ nativeSessionId: "s1" });
    const unticked = candidate({ nativeSessionId: "s2" });
    const arrivingGroup = group(folderLocation("/repo/a"), [kept, unticked]);
    const groupKey = sessionImportGroupKey(arrivingGroup.location);

    const state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
      {
        kind: "sessionToggled",
        selectionKey: sessionImportSelectionKey("claude", "s2"),
      },
      { kind: "groupExpansionToggled", groupKey },
      { kind: "scanRestarted", reason: "reconnect" },
      // The reconnected scan re-reads the same folders and re-delivers them.
      { kind: "scanGroupArrived", group: arrivingGroup },
    ]);

    expect(state.selected).toEqual(
      new Set([sessionImportSelectionKey("claude", "s1")]),
    );
    expect(state.expandedGroups.has(groupKey)).toBe(true);
    expect(state.phase).toBe("scanning");
    expect(state.totals).toBeNull();
  });

  it("clears groups/selection/expansion/phase on a fresh scanRestarted but preserves query, disabledHarnesses, and scanWindow", () => {
    const arrivingGroup = group(folderLocation("/repo/a"), [
      candidate({ nativeSessionId: "s1" }),
    ]);

    const state = applyActions([
      { kind: "scanGroupArrived", group: arrivingGroup },
      {
        kind: "groupExpansionToggled",
        groupKey: sessionImportGroupKey(arrivingGroup.location),
      },
      { kind: "queryChanged", query: "login" },
      { kind: "providerScopeToggled", harness: "codex" },
      { kind: "windowChanged", window: 30 },
      {
        kind: "scanCompleted",
        totals: {
          groups: 1,
          sessions: 1,
          importable: 1,
          alreadyInTraycer: 0,
          unreadable: 0,
        },
      },
      { kind: "scanRestarted", reason: "fresh" },
    ]);

    expect(state.groups).toEqual([]);
    expect(state.selected.size).toBe(0);
    expect(state.expandedGroups.size).toBe(0);
    expect(state.phase).toBe("scanning");
    expect(state.totals).toBeNull();
    expect(state.query).toBe("login");
    expect(state.disabledHarnesses).toEqual(new Set(["codex"]));
    expect(state.scanWindow).toBe(30);
  });
});

describe("buildSessionImportView - group ordering", () => {
  it("orders repos before loose folders before missing ones, by in-scope count within a tier", () => {
    const busyRepo = {
      ...group(folderLocation("/repo/busy"), [
        candidate({ nativeSessionId: "r1" }),
        candidate({ nativeSessionId: "r2" }),
      ]),
      gitBacked: true,
    };
    const quietRepo = {
      ...group(folderLocation("/repo/quiet"), [
        candidate({ nativeSessionId: "r3" }),
      ]),
      gitBacked: true,
    };
    const looseFolder = group(folderLocation("/home/loose"), [
      candidate({ nativeSessionId: "l1" }),
      candidate({ nativeSessionId: "l2" }),
      candidate({ nativeSessionId: "l3" }),
    ]);
    const missingFolder = group({ kind: "missing_folder", path: "/gone" }, [
      candidate({ nativeSessionId: "m1" }),
      candidate({ nativeSessionId: "m2" }),
      candidate({ nativeSessionId: "m3" }),
      candidate({ nativeSessionId: "m4" }),
    ]);

    // Arrival order is adversarial on purpose: the busiest loose folder and
    // the missing one land first, and the tiers still win.
    const state = applyActions([
      { kind: "scanGroupArrived", group: missingFolder },
      { kind: "scanGroupArrived", group: looseFolder },
      { kind: "scanGroupArrived", group: quietRepo },
      { kind: "scanGroupArrived", group: busyRepo },
    ]);

    expect(buildSessionImportView(state).groups.map((one) => one.path)).toEqual(
      ["/repo/busy", "/repo/quiet", "/home/loose", "/gone"],
    );
  });

  it("breaks a count tie by the group's most recent session", () => {
    const stale = group(folderLocation("/home/stale"), [
      candidate({ nativeSessionId: "s1", updatedAt: 100 }),
    ]);
    const fresh = group(folderLocation("/home/fresh"), [
      candidate({ nativeSessionId: "f1", updatedAt: 900 }),
    ]);

    const state = applyActions([
      { kind: "scanGroupArrived", group: stale },
      { kind: "scanGroupArrived", group: fresh },
    ]);

    expect(buildSessionImportView(state).groups.map((one) => one.path)).toEqual(
      ["/home/fresh", "/home/stale"],
    );
  });
});

describe("buildSessionImportSubmission", () => {
  it("emits one selection per ticked candidate in scan order, with a titles map that includes the firstPrompt fallback", () => {
    const a1 = candidate({ nativeSessionId: "a1", title: "Fix login bug" });
    const a2 = candidate({
      nativeSessionId: "a2",
      title: null,
      firstPrompt: "add dark mode toggle",
    });
    const groupA = group(folderLocation("/repo/a"), [a1, a2]);
    const b1 = candidate({ nativeSessionId: "b1", title: "Refactor auth" });
    const groupB = group(folderLocation("/repo/b"), [b1]);

    let state = applyActions([
      { kind: "scanGroupArrived", group: groupA },
      { kind: "scanGroupArrived", group: groupB },
    ]);
    // Deselect b1 so the submission proves it only carries ticked candidates.
    state = sessionImportWizardReducer(state, {
      kind: "sessionToggled",
      selectionKey: sessionImportSelectionKey("claude", "b1"),
    });

    const submission = buildSessionImportSubmission(state);

    expect(submission.selections).toEqual([
      { harness: "claude", nativeSessionId: "a1" },
      { harness: "claude", nativeSessionId: "a2" },
    ]);
    expect(
      submission.titles.get(sessionImportSelectionKey("claude", "a1")),
    ).toBe("Fix login bug");
    expect(
      submission.titles.get(sessionImportSelectionKey("claude", "a2")),
    ).toBe("add dark mode toggle");
  });
});

describe("groupSessionImportFailures", () => {
  it("buckets failed outcomes by reason, ignores non-failed outcomes, and falls back to the raw id when no title is known", () => {
    const knownKey = sessionImportSelectionKey("claude", "s1");
    const titles = new Map<string, string>([[knownKey, "Fix login bug"]]);

    const failedOutcomeA: SessionImportOutcome = {
      kind: "failed",
      reason: "source_unreadable",
      detail: "disk error",
    };
    const failedOutcomeB: SessionImportOutcome = {
      kind: "failed",
      reason: "source_unreadable",
      detail: "permission denied",
    };
    const importedOutcome: SessionImportOutcome = {
      kind: "imported",
      epicId: "epic-1",
      chatId: "chat-1",
    };
    const skippedOutcome: SessionImportOutcome = {
      kind: "skipped_already_imported",
      epicId: "epic-2",
      chatId: "chat-2",
    };

    const outcomes: ReadonlyArray<SessionImportOutcomeEntry> = [
      {
        selectionKey: knownKey,
        nativeSessionId: "s1",
        outcome: failedOutcomeA,
      },
      {
        selectionKey: sessionImportSelectionKey("claude", "s2"),
        nativeSessionId: "s2",
        outcome: failedOutcomeB,
      },
      {
        selectionKey: sessionImportSelectionKey("codex", "s3"),
        nativeSessionId: "s3",
        outcome: importedOutcome,
      },
      {
        selectionKey: sessionImportSelectionKey("codex", "s4"),
        nativeSessionId: "s4",
        outcome: skippedOutcome,
      },
    ];

    const groups = groupSessionImportFailures(outcomes, titles);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.reason).toBe("source_unreadable");
    expect(groups[0]?.label).toBe("Could not be read");
    expect(groups[0]?.entries).toEqual([
      { selectionKey: knownKey, title: "Fix login bug", detail: "disk error" },
      {
        selectionKey: sessionImportSelectionKey("claude", "s2"),
        title: "s2",
        detail: "permission denied",
      },
    ]);
  });

  // The order failures arrive in is the order sessions happened to be worked
  // on, which is not a fact about the failures. Two identical runs must leave
  // the same summary.
  it("stacks the groups in the failure reasons' canonical order, not in arrival order", () => {
    const outcomes: ReadonlyArray<SessionImportOutcomeEntry> = [
      failureEntry("s1", "internal_error", "boom"),
      failureEntry("s2", "workspace_bind_failed", "no folder"),
      failureEntry("s3", "source_unreadable", "disk error"),
      failureEntry("s4", "source_empty", "no messages"),
    ];

    const groups = groupSessionImportFailures(outcomes, new Map());

    expect(groups.map((entry) => entry.reason)).toEqual([
      "source_unreadable",
      "workspace_bind_failed",
      "internal_error",
      "source_empty",
    ]);
  });
});

function failureEntry(
  nativeSessionId: string,
  reason: SessionImportFailureReason,
  detail: string,
): SessionImportOutcomeEntry {
  return {
    selectionKey: sessionImportSelectionKey("claude", nativeSessionId),
    nativeSessionId,
    outcome: { kind: "failed", reason, detail },
  };
}

describe("sessionImportNotImportedLine", () => {
  it("names the cause when every failure shares one", () => {
    const groups = groupSessionImportFailures(
      [
        failureEntry("s1", "source_empty", ""),
        failureEntry("s2", "source_empty", ""),
      ],
      new Map(),
    );
    expect(sessionImportNotImportedLine(groups)).toBe(
      "Not imported: 2 sessions with no messages",
    );
  });

  it("keeps the line plain when the causes are mixed, and singular for one session", () => {
    const mixed = groupSessionImportFailures(
      [
        failureEntry("s1", "source_empty", ""),
        failureEntry("s2", "source_unreadable", "disk error"),
      ],
      new Map(),
    );
    expect(sessionImportNotImportedLine(mixed)).toBe(
      "Not imported: 2 sessions",
    );
    const one = groupSessionImportFailures(
      [failureEntry("s1", "source_unreadable", "disk error")],
      new Map(),
    );
    expect(sessionImportNotImportedLine(one)).toBe(
      "Not imported: 1 session that could not be read",
    );
  });
});

describe("sessionImportFailureDetailVaries", () => {
  it("keeps the per-session detail only where it carries more than the heading", () => {
    expect(sessionImportFailureDetailVaries("source_unreadable")).toBe(true);
    expect(sessionImportFailureDetailVaries("internal_error")).toBe(true);
    expect(sessionImportFailureDetailVaries("source_empty")).toBe(false);
    expect(sessionImportFailureDetailVaries("workspace_bind_failed")).toBe(
      false,
    );
  });
});

describe("SESSION_IMPORT_SCAN_WINDOW_OPTIONS", () => {
  it("leads with a 24-hour option ahead of the default 7-day window", () => {
    expect(SESSION_IMPORT_SCAN_WINDOW_OPTIONS[0]).toEqual({
      window: 1,
      label: "Last 24 hours",
    });
    expect(
      SESSION_IMPORT_SCAN_WINDOW_OPTIONS.map((option) => option.window),
    ).toEqual([1, 7, 14, 30, null]);
  });

  it("labels the 24-hour window", () => {
    expect(sessionImportScanWindowLabel(1)).toBe("Last 24 hours");
  });
});

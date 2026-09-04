import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  SessionImportCandidate,
  SessionImportFailureReason,
  SessionImportGroup,
  SessionImportGroupLocation,
  SessionImportSelection,
} from "@traycer/protocol/host/session-import/candidate";
import type { SessionImportScanTotals } from "@traycer/protocol/host/session-import/scan";
import type { SessionImportOutcome } from "@traycer/protocol/host/session-import/run";
import type { SessionImportProviderFailure } from "@traycer-clients/shared/host-transport/session-import-scan-client";
import {
  guiHarnessIdToProviderId,
  providerDisplayName,
  sortGuiHarnessesByProviderOrder,
} from "@/lib/provider-ordering";

/**
 * The wizard's whole state model, kept pure and away from the stream plumbing
 * and the markup.
 *
 * Two things make this worth its own module. Groups ARRIVE - the scan streams
 * one repo folder at a time - so "everything is pre-selected" is not a thing
 * the component can compute once from a finished list; it is a rule the
 * reducer applies to each group as it lands, without disturbing the choices
 * the user has already made about the groups that landed before it. And the
 * rendered shape (provider pills counting a whole scan, a folder header with a
 * tri-state checkbox over rows that may be searched out from under it) is a
 * projection of that state, not a copy of it.
 */

/** `(harness, nativeSessionId)` is the import's identity everywhere. */
export function sessionImportSelectionKey(
  harness: GuiHarnessId,
  nativeSessionId: string,
): string {
  return `${harness}:${nativeSessionId}`;
}

export function sessionImportGroupKey(
  location: SessionImportGroupLocation,
): string {
  return `${location.kind}:${location.path}`;
}

export type SessionImportScanPhase = "scanning" | "complete" | "failed";

/**
 * The scan's recency bound, in days; `null` scans everything. A bound is the
 * cheap path end to end - the host skips old sessions on their own timestamps
 * before reading anything - so it is part of the scan request, never a
 * client-side filter over a full scan.
 */
export type SessionImportScanWindow = 1 | 7 | 14 | 30 | null;

/** A week: recent enough to be "what I'm working on", the act's premise. */
export const SESSION_IMPORT_DEFAULT_SCAN_WINDOW: SessionImportScanWindow = 7;

export const SESSION_IMPORT_SCAN_WINDOW_OPTIONS: ReadonlyArray<{
  readonly window: SessionImportScanWindow;
  readonly label: string;
}> = [
  { window: 1, label: "Last 24 hours" },
  { window: 7, label: "Last 7 days" },
  { window: 14, label: "Last 2 weeks" },
  { window: 30, label: "Last 30 days" },
  { window: null, label: "All work" },
];

export function sessionImportScanWindowLabel(
  window: SessionImportScanWindow,
): string {
  const option = SESSION_IMPORT_SCAN_WINDOW_OPTIONS.find(
    (candidate) => candidate.window === window,
  );
  return option === undefined ? "All work" : option.label;
}

export interface SessionImportWizardState {
  readonly phase: SessionImportScanPhase;
  /** Groups in arrival order; the projection sorts them for display. */
  readonly groups: ReadonlyArray<SessionImportGroup>;
  readonly providerFailures: ReadonlyArray<SessionImportProviderFailure>;
  readonly totals: SessionImportScanTotals | null;
  /** Non-null only when the scan itself fell over. */
  readonly scanErrorDetail: string | null;
  readonly selected: ReadonlySet<string>;
  readonly expandedGroups: ReadonlySet<string>;
  readonly query: string;
  /**
   * Providers the user has switched OUT of the import. This is scope, not a
   * view filter: a harness in here is hidden from the list AND unticked, so
   * nothing can be imported from a provider whose rows are off screen.
   */
  readonly disabledHarnesses: ReadonlySet<GuiHarnessId>;
  /** How far back the current scan looks; the control the toolbar renders. */
  readonly scanWindow: SessionImportScanWindow;
  /**
   * Every provider the host said the scan covers, from its `started` frame.
   * This is what keeps the pill row STATIC: pills exist from the moment the
   * scan starts and hold through rescans, instead of each provider's pill
   * popping in with its first folder and vanishing on every restart.
   */
  readonly scannedProviders: ReadonlyArray<GuiHarnessId>;
}

export const SESSION_IMPORT_INITIAL_STATE: SessionImportWizardState = {
  phase: "scanning",
  groups: [],
  providerFailures: [],
  totals: null,
  scanErrorDetail: null,
  selected: new Set(),
  expandedGroups: new Set(),
  query: "",
  disabledHarnesses: new Set(),
  scanWindow: SESSION_IMPORT_DEFAULT_SCAN_WINDOW,
  scannedProviders: [],
};

/**
 * Why the scan is starting over. `reconnect` is the transport coming back under
 * a wizard the user is already working in; `fresh` is the wizard (re)opening.
 * The two want opposite things from the selection the user has made so far.
 */
export type SessionImportScanRestartReason = "fresh" | "reconnect";

export type SessionImportWizardAction =
  | {
      readonly kind: "scanRestarted";
      readonly reason: SessionImportScanRestartReason;
    }
  | {
      readonly kind: "scanStarted";
      readonly providers: ReadonlyArray<GuiHarnessId>;
    }
  | { readonly kind: "scanGroupArrived"; readonly group: SessionImportGroup }
  | {
      readonly kind: "scanProviderFailed";
      readonly failure: SessionImportProviderFailure;
    }
  | {
      readonly kind: "scanCompleted";
      readonly totals: SessionImportScanTotals;
    }
  | { readonly kind: "scanFailed"; readonly detail: string }
  | { readonly kind: "sessionToggled"; readonly selectionKey: string }
  | {
      readonly kind: "groupSelectionSet";
      readonly groupKey: string;
      readonly selected: boolean;
    }
  | { readonly kind: "groupExpansionToggled"; readonly groupKey: string }
  | {
      readonly kind: "visibleSelectionSet";
      readonly selectionKeys: ReadonlyArray<string>;
      readonly selected: boolean;
    }
  | { readonly kind: "queryChanged"; readonly query: string }
  | {
      readonly kind: "providerScopeToggled";
      readonly harness: GuiHarnessId;
    }
  | {
      readonly kind: "windowChanged";
      readonly window: SessionImportScanWindow;
    };

export function isImportable(candidate: SessionImportCandidate): boolean {
  return candidate.state.kind === "importable";
}

/**
 * Split in two along the only line that matters here: frames the HOST sends
 * and actions the USER takes. They share a state object but never each other's
 * reasoning, and reading either half whole is worth more than seeing all ten
 * cases in one switch.
 */
export function sessionImportWizardReducer(
  state: SessionImportWizardState,
  action: SessionImportWizardAction,
): SessionImportWizardState {
  switch (action.kind) {
    case "scanRestarted":
    case "scanStarted":
    case "scanGroupArrived":
    case "scanProviderFailed":
    case "scanCompleted":
    case "scanFailed":
      return applyScanFrame(state, action);
    default:
      return applyUserAction(state, action);
  }
}

type SessionImportScanFrameAction = Extract<
  SessionImportWizardAction,
  { readonly kind: `scan${string}` }
>;
type SessionImportUserAction = Exclude<
  SessionImportWizardAction,
  SessionImportScanFrameAction
>;

function applyScanFrame(
  state: SessionImportWizardState,
  action: SessionImportScanFrameAction,
): SessionImportWizardState {
  switch (action.kind) {
    case "scanRestarted": {
      if (action.reason === "reconnect") {
        // The stream dropped and came back over the SAME folders, so the rows
        // the user has been ticking are the rows the host is about to re-send.
        // Nothing below the filters is thrown away - not even the groups:
        // re-delivered ones are ignored by the dedupe in `scanGroupArrived`,
        // which is also what keeps a deliberate UNTICK from being undone by
        // that case's pre-select-on-arrival rule.
        return {
          ...state,
          phase: "scanning",
          totals: null,
          providerFailures: [],
          scanErrorDetail: null,
        };
      }
      // A fresh scan starts clean: last visit's picks may already have been
      // imported. Only what the user narrowed the picker to survives - the
      // scan window included, because a window change is itself what starts
      // most fresh scans. The provider roster survives too: which providers
      // the host scans is not a per-scan fact, and dropping it here is what
      // made the pill row blink empty on every window change.
      return {
        ...SESSION_IMPORT_INITIAL_STATE,
        query: state.query,
        disabledHarnesses: state.disabledHarnesses,
        scanWindow: state.scanWindow,
        scannedProviders: state.scannedProviders,
      };
    }
    case "scanStarted": {
      return { ...state, scannedProviders: action.providers };
    }
    case "scanGroupArrived": {
      const key = sessionImportGroupKey(action.group.location);
      if (
        state.groups.some(
          (group) => sessionImportGroupKey(group.location) === key,
        )
      ) {
        return state;
      }
      // A current host hides already-imported sessions from the scan; an older
      // one still sends them as `already_in_traycer` rows. Discard those here
      // so both hosts produce the same wizard: only what is new to bring over.
      const sessions = action.group.sessions.filter(
        (candidate) => candidate.state.kind !== "already_in_traycer",
      );
      if (sessions.length === 0) return state;
      const group = { ...action.group, sessions };
      // Everything importable arrives pre-selected, missing folders included
      // (spec §5): those still import, just without a workspace. A provider the
      // user has switched out of the import is the one exception - its rows are
      // not on screen, so ticking them would import work the user cannot see.
      const selected = new Set(state.selected);
      for (const candidate of group.sessions) {
        if (!isImportable(candidate)) continue;
        if (state.disabledHarnesses.has(candidate.harness)) continue;
        selected.add(
          sessionImportSelectionKey(
            candidate.harness,
            candidate.nativeSessionId,
          ),
        );
      }
      return {
        ...state,
        groups: [...state.groups, group],
        selected,
      };
    }
    case "scanProviderFailed": {
      // A harness is in exactly one state per scan, so a second failure for it
      // corrects the first rather than adding a second thing to report.
      return {
        ...state,
        providerFailures: [
          ...state.providerFailures.filter(
            (failure) => failure.harness !== action.failure.harness,
          ),
          action.failure,
        ],
      };
    }
    case "scanCompleted": {
      return { ...state, phase: "complete", totals: action.totals };
    }
    case "scanFailed": {
      // A drop after the terminal frame is not a failure - the results the
      // user is looking at are complete and still true.
      if (state.phase === "complete") return state;
      return { ...state, phase: "failed", scanErrorDetail: action.detail };
    }
  }
}

function applyUserAction(
  state: SessionImportWizardState,
  action: SessionImportUserAction,
): SessionImportWizardState {
  switch (action.kind) {
    case "sessionToggled": {
      const selected = new Set(state.selected);
      if (selected.has(action.selectionKey)) {
        selected.delete(action.selectionKey);
      } else {
        selected.add(action.selectionKey);
      }
      return { ...state, selected };
    }
    case "groupSelectionSet": {
      return applyGroupSelectionSet(state, action.groupKey, action.selected);
    }
    case "groupExpansionToggled": {
      const expandedGroups = new Set(state.expandedGroups);
      if (expandedGroups.has(action.groupKey)) {
        expandedGroups.delete(action.groupKey);
      } else {
        expandedGroups.add(action.groupKey);
      }
      return { ...state, expandedGroups };
    }
    case "visibleSelectionSet": {
      const selected = new Set(state.selected);
      for (const key of action.selectionKeys) {
        if (action.selected) selected.add(key);
        else selected.delete(key);
      }
      return { ...state, selected };
    }
    case "queryChanged": {
      return { ...state, query: action.query };
    }
    case "providerScopeToggled": {
      return applyProviderScopeToggle(state, action.harness);
    }
    case "windowChanged": {
      // Only the choice is recorded here; the scan hook watches it and starts
      // the fresh scan, whose `scanRestarted` resets everything else.
      return { ...state, scanWindow: action.window };
    }
  }
}

function applyGroupSelectionSet(
  state: SessionImportWizardState,
  groupKey: string,
  select: boolean,
): SessionImportWizardState {
  const group = state.groups.find(
    (candidate) => sessionImportGroupKey(candidate.location) === groupKey,
  );
  if (group === undefined) return state;
  const selected = new Set(state.selected);
  for (const candidate of group.sessions) {
    if (!isImportable(candidate)) continue;
    if (state.disabledHarnesses.has(candidate.harness)) continue;
    const key = sessionImportSelectionKey(
      candidate.harness,
      candidate.nativeSessionId,
    );
    if (select) selected.add(key);
    else selected.delete(key);
  }
  return { ...state, selected };
}

/**
 * Scope and selection move together, in both directions: switching a provider
 * out unticks everything it contributed, and switching it back in re-ticks what
 * could be imported - the same rule arrival applies, so a pill turned off and
 * on again lands where it started.
 */
function applyProviderScopeToggle(
  state: SessionImportWizardState,
  harness: GuiHarnessId,
): SessionImportWizardState {
  const disabledHarnesses = new Set(state.disabledHarnesses);
  const selected = new Set(state.selected);
  const removing = !disabledHarnesses.has(harness);
  if (removing) disabledHarnesses.add(harness);
  else disabledHarnesses.delete(harness);
  for (const group of state.groups) {
    for (const candidate of group.sessions) {
      if (candidate.harness !== harness) continue;
      if (!isImportable(candidate)) continue;
      const key = sessionImportSelectionKey(
        candidate.harness,
        candidate.nativeSessionId,
      );
      if (removing) selected.delete(key);
      else selected.add(key);
    }
  }
  return { ...state, disabledHarnesses, selected };
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

export interface SessionImportRowView {
  readonly selectionKey: string;
  readonly candidate: SessionImportCandidate;
  readonly title: string;
  readonly selected: boolean;
  readonly selectable: boolean;
  /** Short reason a row is not selectable, e.g. "Unreadable". */
  readonly unavailableLabel: string | null;
  /** The long form, for the row's tooltip. */
  readonly unavailableDetail: string | null;
}

export type SessionImportGroupSelectionState = "none" | "partial" | "all";

/** One provider pill: what the scan found for it, and whether it is in scope. */
export interface SessionImportProviderView {
  readonly harness: GuiHarnessId;
  readonly name: string;
  readonly count: number;
  readonly enabled: boolean;
}

export interface SessionImportGroupView {
  readonly groupKey: string;
  readonly name: string;
  readonly path: string;
  readonly missingFolder: boolean;
  readonly expanded: boolean;
  readonly rows: ReadonlyArray<SessionImportRowView>;
  /** Everything in scope this folder holds, pickable or not. */
  readonly totalCount: number;
  readonly selectableCount: number;
  readonly selectedCount: number;
  readonly selectionState: SessionImportGroupSelectionState;
}

export interface SessionImportWizardView {
  readonly groups: ReadonlyArray<SessionImportGroupView>;
  /** One pill per harness the scan has produced, in the app's provider order. */
  readonly providers: ReadonlyArray<SessionImportProviderView>;
  /** Every session the scan has produced, before scope and search. */
  readonly totalSessions: number;
  /**
   * How many in-scope sessions could ever be ticked. The footer's denominator,
   * because counting rows the user is not allowed to pick makes "3 of 40"
   * read as an unfinished job when it is in fact everything on offer.
   */
  readonly selectableSessions: number;
  /** How many survive scope and search. */
  readonly matchedSessions: number;
  /** Everything ticked - search-hidden rows included - is what submits. */
  readonly selectedCount: number;
  /** Selectable rows currently on screen, for the Select all / Clear action. */
  readonly visibleSelectionKeys: ReadonlyArray<string>;
  /** How many of those are ticked, which is what the action toggles between. */
  readonly visibleSelectedCount: number;
}

const UNTITLED_SESSION = "Untitled session";
const FIRST_PROMPT_PREVIEW_LENGTH = 140;

/** Native title first, then the opening prompt, then a neutral placeholder. */
export function candidateDisplayTitle(
  candidate: SessionImportCandidate,
): string {
  const title = candidate.title?.trim() ?? "";
  if (title.length > 0) return title;
  const prompt = candidate.firstPrompt?.replace(/\s+/g, " ").trim() ?? "";
  if (prompt.length === 0) return UNTITLED_SESSION;
  return prompt.length > FIRST_PROMPT_PREVIEW_LENGTH
    ? `${prompt.slice(0, FIRST_PROMPT_PREVIEW_LENGTH)}…`
    : prompt;
}

/** "Claude Code" / "Codex" - what the user calls the CLI they ran. */
export function harnessDisplayName(harness: GuiHarnessId): string {
  const providerId = guiHarnessIdToProviderId(harness);
  return providerId === null ? harness : providerDisplayName(providerId);
}

/** Last path segment, on either separator; the full path stays on the row. */
export function folderDisplayName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  const last = parts[parts.length - 1] ?? "";
  return last.length > 0 ? last : path;
}

/** The order failure groups render in: what the user can act on first. */
const FAILURE_REASON_ORDER: ReadonlyArray<SessionImportFailureReason> = [
  "source_unreadable",
  "workspace_bind_failed",
  "creation_failed",
  "internal_error",
  "source_empty",
];

/**
 * The cause as a short heading: what the summary's sections are titled, and
 * what a greyed row's tooltip leads with.
 */
export function sessionImportFailureLabel(
  reason: SessionImportFailureReason,
): string {
  switch (reason) {
    case "source_unreadable":
      return "Could not be read";
    case "source_empty":
      return "No messages";
    case "workspace_bind_failed":
      return "No matching folder on this machine";
    case "creation_failed":
      return "Task could not be created";
    case "internal_error":
      return "Unexpected error";
  }
}

/**
 * Whether the host's per-session detail says more than the reason does. For
 * an unreadable file it is the actual error, worth a glance; for an empty
 * session it restates the heading, and a list that repeats one sentence per
 * row is what buried the summary under a wall of text.
 */
export function sessionImportFailureDetailVaries(
  reason: SessionImportFailureReason,
): boolean {
  switch (reason) {
    case "source_unreadable":
    case "creation_failed":
    case "internal_error":
      return true;
    case "source_empty":
    case "workspace_bind_failed":
      return false;
  }
}

/**
 * The one line the summary shows above the details: an outcome first, then
 * the cause when there is exactly one - "Not imported: 6 sessions with no
 * messages". Mixed causes keep the line plain and leave the reasons to the
 * sections underneath.
 */
export function sessionImportNotImportedLine(
  groups: ReadonlyArray<SessionImportFailureGroupView>,
): string {
  const count = groups.reduce(
    (total, group) => total + group.entries.length,
    0,
  );
  const noun = count === 1 ? "session" : "sessions";
  const only = groups.length === 1 ? groups[0] : undefined;
  if (only === undefined) return `Not imported: ${count} ${noun}`;
  return `Not imported: ${count} ${noun} ${failureCause(only.reason)}`;
}

function failureCause(reason: SessionImportFailureReason): string {
  switch (reason) {
    case "source_unreadable":
      return "that could not be read";
    case "source_empty":
      return "with no messages";
    case "workspace_bind_failed":
      return "with no matching folder on this machine";
    case "creation_failed":
      return "whose task could not be created";
    case "internal_error":
      return "that hit an unexpected error";
  }
}

function rowView(
  candidate: SessionImportCandidate,
  selected: ReadonlySet<string>,
): SessionImportRowView {
  const selectionKey = sessionImportSelectionKey(
    candidate.harness,
    candidate.nativeSessionId,
  );
  const title = candidateDisplayTitle(candidate);
  const state = candidate.state;
  // `already_in_traycer` never reaches here: those rows are dropped at
  // arrival (see `scanGroupArrived`), so the only unavailable rows are
  // unreadable ones.
  if (state.kind === "unreadable") {
    return {
      selectionKey,
      candidate,
      title,
      selected: false,
      selectable: false,
      unavailableLabel: "Unreadable",
      unavailableDetail: `${sessionImportFailureLabel(state.reason)}: ${state.detail}`,
    };
  }
  return {
    selectionKey,
    candidate,
    title,
    selected: selected.has(selectionKey),
    selectable: true,
    unavailableLabel: null,
    unavailableDetail: null,
  };
}

function matchesQuery(
  candidate: SessionImportCandidate,
  path: string,
  needle: string,
): boolean {
  if (needle.length === 0) return true;
  return (
    candidateDisplayTitle(candidate).toLowerCase().includes(needle) ||
    path.toLowerCase().includes(needle)
  );
}

/**
 * The pill row: every provider the host's scan covers, plus any the scan has
 * produced work for or the user has switched off. The roster comes from the
 * scan's `started` frame so the row is complete before the first folder lands
 * and identical after every rescan - pills that popped in per result read as
 * flicker. A switched-off harness keeps its pill even when a rescan found
 * nothing for it - the unlit pill is the only thing on screen that explains
 * why those rows are missing, and the only way back.
 */
function providerViewsFor(
  state: SessionImportWizardState,
): ReadonlyArray<SessionImportProviderView> {
  const counts = new Map<GuiHarnessId, number>();
  for (const harness of state.scannedProviders) counts.set(harness, 0);
  for (const harness of state.disabledHarnesses) counts.set(harness, 0);
  for (const group of state.groups) {
    for (const candidate of group.sessions) {
      counts.set(candidate.harness, (counts.get(candidate.harness) ?? 0) + 1);
    }
  }
  // Map order is whatever order the host reported sessions in, which would
  // reshuffle the pills as the scan streams. The app's one harness order
  // settles it; it keys on `id`, hence the hop.
  return sortGuiHarnessesByProviderOrder(
    [...counts].map(([harness, count]) => ({ id: harness, count })),
  ).map((entry) => ({
    harness: entry.id,
    name: harnessDisplayName(entry.id),
    count: entry.count,
    enabled: !state.disabledHarnesses.has(entry.id),
  }));
}

export function selectionStateFor(
  selectableCount: number,
  selectedCount: number,
): SessionImportGroupSelectionState {
  if (selectableCount === 0 || selectedCount === 0) return "none";
  return selectedCount === selectableCount ? "all" : "partial";
}

/**
 * Projects state into what the list renders.
 *
 * The counts on a group header describe the whole IN-SCOPE group, not the
 * searched slice: the header's checkbox toggles exactly those rows (that is the
 * only way to clear a folder without expanding it), so a header claiming "2"
 * while ticking 40 would be lying about its own control. Scope is a different
 * matter - a provider the user switched off is not part of this import at all,
 * so it leaves the counts as well as the list.
 */
export function buildSessionImportView(
  state: SessionImportWizardState,
): SessionImportWizardView {
  const needle = state.query.trim().toLowerCase();
  const sortable: Array<{
    readonly view: SessionImportGroupView;
    /** Repos first, then loose folders, then folders gone from disk. */
    readonly tier: number;
    readonly count: number;
    readonly latest: number;
  }> = [];
  const visibleSelectionKeys: string[] = [];
  let totalSessions = 0;
  let selectableSessions = 0;
  let matchedSessions = 0;
  let visibleSelectedCount = 0;

  for (const group of state.groups) {
    const path = group.location.path;
    totalSessions += group.sessions.length;

    const inScope = group.sessions.filter(
      (candidate) => !state.disabledHarnesses.has(candidate.harness),
    );
    const selectable = inScope.filter(isImportable);
    selectableSessions += selectable.length;

    const matching = inScope.filter((candidate) =>
      matchesQuery(candidate, path, needle),
    );
    matchedSessions += matching.length;
    if (matching.length === 0) continue;

    const rows = matching.map((candidate) =>
      rowView(candidate, state.selected),
    );
    for (const row of rows) {
      if (!row.selectable) continue;
      visibleSelectionKeys.push(row.selectionKey);
      if (row.selected) visibleSelectedCount += 1;
    }

    const selectedCount = selectable.filter((candidate) =>
      state.selected.has(
        sessionImportSelectionKey(candidate.harness, candidate.nativeSessionId),
      ),
    ).length;

    const missingFolder = group.location.kind === "missing_folder";
    sortable.push({
      view: {
        groupKey: sessionImportGroupKey(group.location),
        name: folderDisplayName(path),
        path,
        missingFolder,
        expanded: state.expandedGroups.has(
          sessionImportGroupKey(group.location),
        ),
        rows,
        totalCount: inScope.length,
        selectableCount: selectable.length,
        selectedCount,
        selectionState: selectionStateFor(selectable.length, selectedCount),
      },
      tier: groupSortTier(missingFolder, group.gitBacked),
      count: inScope.length,
      latest: Math.max(0, ...inScope.map((candidate) => candidate.updatedAt)),
    });
  }

  // Repos over loose folders over missing ones; the busiest folder first
  // within a tier, because repeated work is what the user came back for.
  // Recency breaks ties so two one-session folders keep a stable, sensible
  // order.
  sortable.sort(
    (left, right) =>
      left.tier - right.tier ||
      right.count - left.count ||
      right.latest - left.latest,
  );

  return {
    groups: sortable.map((entry) => entry.view),
    providers: providerViewsFor(state),
    totalSessions,
    selectableSessions,
    matchedSessions,
    selectedCount: state.selected.size,
    visibleSelectionKeys,
    visibleSelectedCount,
  };
}

/** Repos sort above loose folders, which sort above missing ones. */
function groupSortTier(missingFolder: boolean, gitBacked: boolean): number {
  if (missingFolder) return 2;
  return gitBacked ? 0 : 1;
}

export interface SessionImportFailureEntryView {
  readonly selectionKey: string;
  readonly title: string;
  readonly detail: string;
}

export interface SessionImportFailureGroupView {
  readonly reason: SessionImportFailureReason;
  /** The cause as the section's heading. */
  readonly label: string;
  readonly entries: ReadonlyArray<SessionImportFailureEntryView>;
}

/**
 * Groups a finished run's failures by cause, because that is how a person acts
 * on them: "four sessions could not be read" is one problem with four
 * instances, not four problems. The closed reason enum is what makes the
 * grouping meaningful; `detail` is the per-session half and stays on the row,
 * behind the group's expand toggle.
 */
export interface SessionImportOutcomeEntry {
  readonly selectionKey: string;
  readonly nativeSessionId: string;
  readonly outcome: SessionImportOutcome;
}

export function groupSessionImportFailures(
  outcomes: Iterable<SessionImportOutcomeEntry>,
  titles: ReadonlyMap<string, string>,
): ReadonlyArray<SessionImportFailureGroupView> {
  const byReason = new Map<
    SessionImportFailureReason,
    SessionImportFailureEntryView[]
  >();
  for (const entry of outcomes) {
    const outcome = entry.outcome;
    if (outcome.kind !== "failed") continue;
    const bucket = byReason.get(outcome.reason) ?? [];
    bucket.push({
      selectionKey: entry.selectionKey,
      title: titles.get(entry.selectionKey) ?? entry.nativeSessionId,
      detail: outcome.detail,
    });
    byReason.set(outcome.reason, bucket);
  }
  // Sorted, because Map order here is the order the run happened to fail in:
  // two identical runs would otherwise stack the same groups differently.
  return [...byReason]
    .toSorted(
      ([left], [right]) =>
        FAILURE_REASON_ORDER.indexOf(left) -
        FAILURE_REASON_ORDER.indexOf(right),
    )
    .map(([reason, entries]) => ({
      reason,
      label: sessionImportFailureLabel(reason),
      entries,
    }));
}

/**
 * The wizard submits every ticked session, in the order the scan produced
 * them, plus the display titles the progress and summary views need - the
 * `progress` frame names a session by id only, and nothing else in the client
 * can turn that back into something a person recognises.
 */
export interface SessionImportSubmission {
  readonly selections: ReadonlyArray<SessionImportSelection>;
  readonly titles: ReadonlyMap<string, string>;
}

export function buildSessionImportSubmission(
  state: SessionImportWizardState,
): SessionImportSubmission {
  const selections: SessionImportSelection[] = [];
  const titles = new Map<string, string>();
  for (const group of state.groups) {
    for (const candidate of group.sessions) {
      const key = sessionImportSelectionKey(
        candidate.harness,
        candidate.nativeSessionId,
      );
      if (!state.selected.has(key)) continue;
      selections.push({
        harness: candidate.harness,
        nativeSessionId: candidate.nativeSessionId,
      });
      titles.set(key, candidateDisplayTitle(candidate));
    }
  }
  return { selections, titles };
}

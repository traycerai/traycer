import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  SessionImportCandidate,
  SessionImportGroup,
} from "@traycer/protocol/host/session-import/candidate";
import {
  candidateDisplayTitle,
  folderDisplayName,
  harnessDisplayName,
  selectionStateFor,
  sessionImportFailureLabel,
  sessionImportGroupViewKey,
  sessionImportSelectionKey,
  SESSION_IMPORT_DELETED_FOLDERS_NAME,
  type SessionImportGroupSelectionState,
  type SessionImportGroupView,
  type SessionImportRowView,
  type SessionImportWizardState,
} from "@/components/session-import/session-import-model";
import { sortGuiHarnessesByProviderOrder } from "@/lib/provider-ordering";

/**
 * The welcome modal's page-2 projection: the SAME scan state the wizard
 * reduces, re-cut provider → folder → session instead of folder → session.
 *
 * Nothing here is a second reducer. Every control on the page dispatches an
 * existing wizard action; what this module adds is the key space that makes
 * that work. A folder's rendered group on this page is scoped to ONE
 * provider, so its key carries the harness ({@link welcomeGroupKey}) - the
 * expansion set accepts any string, and the folder checkbox dispatches
 * `visibleSelectionSet` over that group's own keys rather than
 * `groupSelectionSet`, which would tick every provider's rows in the folder.
 *
 * Deliberately narrower than the wizard's view: no search, no provider
 * scope pills, no Show-imported switch. Rows already in Traycer are hidden
 * outright - on a first run they are a re-run of the modal after an import,
 * and "nothing importable" is the honest answer then.
 */

/** A folder group's key on this page: the harness first, then the wizard's view key. */
export function welcomeGroupKey(
  harness: GuiHarnessId,
  viewKey: string,
): string {
  return `${harness}|${viewKey}`;
}

/** The selection keys a folder header's checkbox governs on this page. */
export function groupImportableKeys(
  group: SessionImportGroupView,
): ReadonlyArray<string> {
  return group.rows
    .filter((row) => row.selectable)
    .map((row) => row.selectionKey);
}

export interface WelcomeProviderSection {
  readonly harness: GuiHarnessId;
  readonly name: string;
  /** This provider's rows only, folder by folder, repos → loose → deleted. */
  readonly groups: ReadonlyArray<SessionImportGroupView>;
  /** Every importable selection key under this provider. */
  readonly importableKeys: ReadonlyArray<string>;
  readonly selectableCount: number;
  readonly selectedCount: number;
  readonly selectionState: SessionImportGroupSelectionState;
  /** The reader's failure detail, when this provider's scan fell over. */
  readonly failure: string | null;
}

export interface WelcomeSessionsView {
  /**
   * One per harness the scan covers, produced rows for, or failed on - in
   * the app's provider order, so a section never moves as folders stream in.
   */
  readonly sections: ReadonlyArray<WelcomeProviderSection>;
  /** Ticked importable keys. There is no search, so this is what submits. */
  readonly selectedCount: number;
  readonly selectableCount: number;
  /** Rows on screen: importable and unreadable alike. */
  readonly totalSessions: number;
}

/**
 * What page 2 puts on screen, in the order the page tests them: a run to
 * watch instead of start, a host that cannot scan, nothing to show yet, a
 * scan that settled with nothing to tick, or the list. The modal's header
 * reads the same answer, so the copy above the page can never describe a
 * list that is not there.
 */
export type WelcomeSessionsBranch =
  | "already-running"
  | "unsupported"
  | "waiting"
  | "empty"
  | "list";

export function welcomeSessionsBranch(input: {
  readonly alreadyRunning: boolean;
  readonly support: StreamMethodSupport;
  readonly phase: SessionImportWizardState["phase"];
  readonly view: WelcomeSessionsView;
}): WelcomeSessionsBranch {
  const { alreadyRunning, support, phase, view } = input;
  if (alreadyRunning) return "already-running";
  if (support === "unsupported") return "unsupported";
  // Support still being negotiated, or a scan that has not produced its
  // first row.
  if (
    support === "unknown" ||
    (phase === "scanning" && view.totalSessions === 0)
  ) {
    return "waiting";
  }
  // Settled with nothing to tick: every row was unreadable or already in
  // Traycer, every reader failed, or the window was simply too short.
  if (phase !== "scanning" && view.selectableCount === 0) return "empty";
  return "list";
}

/** One provider's slice of one scan group, before it becomes a rendered group. */
interface ProviderFolderBucket {
  readonly viewKey: string;
  readonly missingFolder: boolean;
  readonly path: string;
  readonly gitBacked: boolean;
  /** Scan groups folded in, by path - more than one only for Deleted Folders. */
  readonly folders: Set<string>;
  /** Each row with the folder it ran in - the folders differ under Deleted Folders. */
  readonly candidates: Array<{
    readonly candidate: SessionImportCandidate;
    readonly folderPath: string;
  }>;
}

export function buildWelcomeSessionsView(
  state: SessionImportWizardState,
): WelcomeSessionsView {
  // Sections exist for every provider the host said it would scan, so the
  // page shows what was looked at even when nothing was found for it.
  const harnesses = new Set<GuiHarnessId>(state.scannedProviders);
  for (const failure of state.providerFailures) harnesses.add(failure.harness);
  const buckets = new Map<GuiHarnessId, Map<string, ProviderFolderBucket>>();

  for (const group of state.groups) {
    for (const candidate of group.sessions) {
      if (!isShown(state, candidate)) continue;
      harnesses.add(candidate.harness);
      const bucket = bucketFor(buckets, candidate.harness, group);
      bucket.candidates.push({ candidate, folderPath: group.location.path });
      bucket.folders.add(group.location.path);
    }
  }

  const sections = sortGuiHarnessesByProviderOrder(
    [...harnesses].map((harness) => ({ id: harness })),
  ).map(({ id: harness }) =>
    sectionFor(state, harness, buckets.get(harness) ?? new Map()),
  );

  let selectedCount = 0;
  let selectableCount = 0;
  let totalSessions = 0;
  for (const section of sections) {
    selectedCount += section.selectedCount;
    selectableCount += section.selectableCount;
    for (const group of section.groups) totalSessions += group.totalCount;
  }
  return { sections, selectedCount, selectableCount, totalSessions };
}

/**
 * Rows already in Traycer never show here (there is no Show-imported switch
 * to reveal them), and a provider the reducer has scoped out contributes
 * nothing - the page never dispatches that toggle, but the projection agrees
 * with the reducer's eligibility rule regardless.
 */
function isShown(
  state: SessionImportWizardState,
  candidate: SessionImportCandidate,
): boolean {
  return (
    candidate.state.kind !== "already_in_traycer" &&
    !state.disabledHarnesses.has(candidate.harness)
  );
}

function bucketFor(
  buckets: Map<GuiHarnessId, Map<string, ProviderFolderBucket>>,
  harness: GuiHarnessId,
  group: SessionImportGroup,
): ProviderFolderBucket {
  let byFolder = buckets.get(harness);
  if (byFolder === undefined) {
    byFolder = new Map();
    buckets.set(harness, byFolder);
  }
  const viewKey = sessionImportGroupViewKey(group.location);
  let bucket = byFolder.get(viewKey);
  if (bucket === undefined) {
    bucket = {
      viewKey,
      missingFolder: group.location.kind === "missing_folder",
      path: group.location.path,
      gitBacked: group.gitBacked,
      folders: new Set(),
      candidates: [],
    };
    byFolder.set(viewKey, bucket);
  }
  return bucket;
}

function sectionFor(
  state: SessionImportWizardState,
  harness: GuiHarnessId,
  byFolder: ReadonlyMap<string, ProviderFolderBucket>,
): WelcomeProviderSection {
  const sortable = [...byFolder.values()].map((bucket) => {
    const groupKey = welcomeGroupKey(harness, bucket.viewKey);
    const rows = bucket.candidates.map((entry) =>
      rowFor(entry.candidate, entry.folderPath, state.selected),
    );
    // Deleted folders interleave rows from several checkouts, so that group
    // keeps the list's own order - newest first - rather than arrival order.
    if (bucket.missingFolder) {
      rows.sort(
        (left, right) => right.candidate.updatedAt - left.candidate.updatedAt,
      );
    }
    const selectableCount = rows.filter((row) => row.selectable).length;
    const selectedCount = rows.filter((row) => row.selected).length;
    return {
      view: {
        groupKey,
        name: bucket.missingFolder
          ? SESSION_IMPORT_DELETED_FOLDERS_NAME
          : folderDisplayName(bucket.path),
        path: bucket.missingFolder
          ? deletedFoldersSubtitle(bucket.folders.size)
          : bucket.path,
        missingFolder: bucket.missingFolder,
        expanded: state.expandedGroups.has(groupKey),
        rows,
        totalCount: rows.length,
        selectableCount,
        selectedCount,
        selectionState: selectionStateFor(selectableCount, selectedCount),
      } satisfies SessionImportGroupView,
      tier: groupSortTier(bucket.missingFolder, bucket.gitBacked),
      count: rows.length,
      latest: Math.max(
        0,
        ...bucket.candidates.map((entry) => entry.candidate.updatedAt),
      ),
    };
  });
  // The wizard's order: repos over loose folders over deleted ones, the
  // busiest first within a tier, recency breaking ties.
  sortable.sort(
    (left, right) =>
      left.tier - right.tier ||
      right.count - left.count ||
      right.latest - left.latest,
  );
  const groups = sortable.map((entry) => entry.view);
  const importableKeys = groups.flatMap(groupImportableKeys);
  const selectedCount = importableKeys.filter((key) =>
    state.selected.has(key),
  ).length;
  const failure =
    state.providerFailures.find((entry) => entry.harness === harness)?.detail ??
    null;
  return {
    harness,
    name: harnessDisplayName(harness),
    groups,
    importableKeys,
    selectableCount: importableKeys.length,
    selectedCount,
    selectionState: selectionStateFor(importableKeys.length, selectedCount),
    failure,
  };
}

/**
 * The wizard's row shape for the two states this page shows. Imported rows
 * never reach here, so there is no third branch.
 */
function rowFor(
  candidate: SessionImportCandidate,
  folderPath: string,
  selected: ReadonlySet<string>,
): SessionImportRowView {
  const selectionKey = sessionImportSelectionKey(
    candidate.harness,
    candidate.nativeSessionId,
  );
  const title = candidateDisplayTitle(candidate);
  const state = candidate.state;
  if (state.kind === "unreadable") {
    return {
      selectionKey,
      candidate,
      title,
      folderPath,
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
    folderPath,
    selected: selected.has(selectionKey),
    selectable: true,
    unavailableLabel: null,
    unavailableDetail: null,
  };
}

/** Repos sort above loose folders, which sort above the deleted ones. */
function groupSortTier(missingFolder: boolean, gitBacked: boolean): number {
  if (missingFolder) return 2;
  return gitBacked ? 0 : 1;
}

function deletedFoldersSubtitle(folders: number): string {
  const noun = folders === 1 ? "folder" : "folders";
  return `${folders.toLocaleString()} ${noun} no longer on this machine`;
}

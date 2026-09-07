import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useIsMutating } from "@tanstack/react-query";
import { workspaceMutationKeys } from "@/lib/query-keys";
import { DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { HostSection, WorkspaceHostSwitcher } from "./host-section";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import {
  findHostOption,
  unavailableHostOption,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import { NO_HOST_OPTION_REFUSALS } from "@/components/settings/host-scope/host-option-model";
import { activeRunNoticeFor } from "./active-run-notice";
import type { PreparedWorkspaceFolder } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  RepoBranchPrefixState,
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeBindingOwnerKind,
  WorktreeBranch,
  WorktreeIntent,
  WorktreeFolderIntent,
  WorktreeWorkspaceSummaryV15,
} from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useComposerSurfaceHostPin } from "@/hooks/host/use-composer-surface-host-pin";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useWorktreeListByWorkspacePathsForClient } from "@/hooks/worktree/use-worktree-list-by-workspace-paths-query";
import {
  useWorktreeWorkspacesRefresh,
  type WorktreeWorkspacesRefresh,
} from "@/hooks/worktree/use-worktree-workspaces-refresh";
import { useWorktreeSetEntryModeForClient } from "@/hooks/worktree/use-worktree-set-entry-mode-mutation";
import { useWorktreeImportForClient } from "@/hooks/worktree/use-worktree-import-mutation";
import { useWorktreeCreateForClient } from "@/hooks/worktree/use-worktree-create-mutation";
import { worktreeCreateEntries } from "@/lib/worktree/worktree-create-request";
import {
  useWorkspaceBindingRemoveEntryForClient,
  usePendingRemoveBindingEntryPaths,
} from "@/hooks/workspace/use-workspace-binding-remove-entry-mutation";
import { useWorkspaceBindingAddFolderForClient } from "@/hooks/workspace/use-workspace-binding-add-folder-mutation";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useResolvedWorkspaceFolders } from "@/hooks/workspace/use-resolved-workspace-folders-query";
import type { ResolvedFolder } from "@/lib/workspace/resolved-folder";
import {
  preparedWorkspaceFolderToWorkspaceFolderInfo,
  useWorkspaceFolderActionsForClient,
} from "@/hooks/workspace/use-workspace-folder-actions";
import { useWorkspaceRecordRecentWorkspace } from "@/hooks/workspace/use-workspace-record-recent-workspace-mutation";
import {
  useLandingDraftStore,
  type LandingDraftWorkspaceSnapshot,
} from "@/stores/home/landing-draft-store";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";
import { locateReplaceBoundFolder } from "./locate-replace-bound-folder";
import {
  useLocateAndReplaceWorkspaceFolder,
  usePickAndAddWorkspaceFolders,
} from "./use-pick-and-add-folders";
import {
  readStagedWorktreeIntent,
  stagedWorktreeIntentIsSuspended,
  stagedWorktreeIntentRevision,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import {
  selectRememberedEpicIntent,
  selectWorktreeIntentMemoryBucket,
  useWorktreeIntentMemoryStore,
} from "@/stores/worktree/worktree-intent-memory-store";
import {
  useHomeWorkspaceSource,
  type HomeWorkspaceSource,
} from "./use-home-workspace-source";
import { PrimaryChangeLiveRegion } from "./primary-change-live-region";
import { usePrimaryChangeAnnouncement } from "./use-primary-change-announcement";
import {
  applySeedIntentOverride,
  defaultFolderIntent,
  rememberedNeedsBranchValidation,
  seedEntryForFolder,
  type SeedFolderContext,
  type SeedIntentOverride,
} from "@/lib/worktree/worktree-intent-seeding";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import {
  buildDefaultBranchByPath,
  regenerateSingleWorkspaceBranchName,
  EMPTY_DEFAULT_BRANCH,
  type DefaultBranchDescriptor,
} from "@/lib/worktree/default-branch-name";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { bindingEntryToFolderIntent } from "@/lib/worktree/binding-to-intent";
import {
  WorktreeScriptsDialog,
  type WorktreeScriptsContext,
  type WorktreeScriptsTarget,
} from "@/components/home/worktree/worktree-scripts-dialog";
import {
  hostWorkspaceControlsScopeHostId,
  hostWorkspaceControlsScopeRefusals,
  type HostWorkspaceControlsHostScope,
} from "./host-workspace-controls-scope";
import { computeInEpicFolderMode } from "./compute-in-epic-folder-mode";
import {
  type AddFolderHandler,
  WorkspaceFolderRows,
} from "./workspace-folder-rows";
import { effectiveMissingWorktreePaths } from "@/lib/composer/workspace-composer-availability";
import { WorkspaceFolderSummaryControl } from "./workspace-folder-summary-control";
import type { WorkspaceRunItem, WorkspaceRunMode } from "./workspace-run-item";
import {
  locationSelectionChanges,
  workspaceRunBranchLabel,
} from "./workspace-run-item";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { applyWorktreeCreateResult } from "@/lib/worktree/apply-worktree-create-result";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { trackUserInitiatedWorktreeWrite } from "@/lib/worktree/user-worktree-analytics";
import { droppedRunDirectoriesFromDraft } from "@/lib/worktree/owner-teardown-snapshot";
import {
  failuresByHolderKey,
  runGuiComposedTeardown,
} from "@/lib/worktree/gui-composed-teardown";
import { isWorktreeRebindBlocked } from "@/lib/worktree/is-worktree-rebind-blocked";
import {
  worktreeCommitCaptureIsStale,
  type WorktreeCommitCapture,
} from "@/lib/worktree/worktree-commit-capture";
import { useOwnerTeardownSnapshot } from "@/hooks/worktree/use-owner-teardown-snapshot";
import { useManagedCommandStop } from "@/hooks/managed-command/use-managed-command-lifecycle-mutations";
import { useAgentStop } from "@/hooks/agent/use-stop-agent-mutation";
import {
  TeardownCommitDialog,
  type TeardownCommitChoice,
} from "@/components/worktree/teardown-commit-dialog";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { useRecentWorkspaces } from "./use-recent-workspaces";
import { RecentWorkspacesSection } from "./recent-workspaces-section";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
/** `home` swaps the bound directory; `chat` forks the chat on switch (chats are host-bound for life, so
 * "switching" means forking onto the picked machine. */
type BoundOwnerSurface = {
  readonly kind: "chat" | "terminal-agent";
  readonly hostId: string;
  readonly epicId: string;
  readonly tabId: string;
  readonly ownerId: string;
  readonly binding: WorktreeBinding | null;
  readonly isOwnerActive: boolean;
  // Drives only the disabled-remove tooltip wording - `isOwnerActive` still decides whether removal is disabled
  // at all (a live background process could still be touching the folder either way).
  readonly hasActiveTurn: boolean;
  readonly ownerLabel: string;
  /** Chat-only display overlay for a worktree intent already consumed by an outstanding send. It must never feed
   * dispatch or commit capture; the chat session remains the owner of this intent's lifecycle. */
  readonly inFlightWorktreeIntent: WorktreeIntent | null;
  // Drives the per-folder "missing" indicator on the chip so both owner kinds surface it the same way - the host
  // send / prepareLaunch reject is the actual run gate; this is the proactive visual.
  readonly missingWorktreePaths: readonly string[];
  // Lets the chip distinguish "still loading" (spinner) from "resolved with no folders" (a folderless epic /
  // degraded host - a real terminal state, not an indefinite spinner).
  readonly bindingResolved: boolean;
  readonly onBindingCommitted:
    | ((changedWorkspacePaths: ReadonlyArray<string>) => void)
    | null;
  /** `null` for surfaces that cannot fork at all (terminal agents), whose host section is locked. */
  readonly onForkOnHost: ((targetHostId: string) => void) | null;
};

const EMPTY_BINDING_ENTRIES: ReadonlyArray<WorktreeBindingEntry> = [];
// Stable identity for "the query has not answered yet", so the summaries array can be threaded straight into
// memos and the refresh hook without a fresh `[]` per render invalidating every one of them.
const EMPTY_WORKSPACE_SUMMARIES: ReadonlyArray<WorktreeWorkspaceSummaryV15> =
  [];

/** Git details are inferred from the entry; the row shows a loading affordance (`metadataPending`) while the
 * real query is in flight, so this guess is never presented as disk truth. */
function workspaceSummaryFromBindingEntry(
  entry: WorktreeBindingEntry,
): WorktreeWorkspaceSummaryV15 {
  const worktrees =
    entry.worktreePath === null
      ? []
      : [
          {
            worktreePath: entry.worktreePath,
            branch: entry.branch,
            head: null,
            isMain: false,
            isLocked: false,
          },
        ];
  return {
    workspacePath: entry.workspacePath,
    isGitRepo: entry.mode === "worktree" || entry.repoIdentifier !== null,
    repoIdentifier: entry.repoIdentifier,
    mainBranch: entry.mode === "local" ? entry.branch : null,
    worktrees,
    scripts: null,
    repoBranchPrefix: { status: "absent" },
    resolvedAt: null,
    presence: "present",
  };
}

/** First open (never resolved) keeps the unresolved fallback so git/non-git is not guessed. */
function lastResolvedWorkspaceSummary(
  live: WorktreeWorkspaceSummaryV15 | undefined,
  remembered: WorktreeWorkspaceSummaryV15 | undefined,
  fallback: WorktreeWorkspaceSummaryV15,
): WorktreeWorkspaceSummaryV15 {
  if (live !== undefined && live.resolvedAt !== null) return live;
  if (remembered !== undefined) return remembered;
  return live ?? fallback;
}

function rememberResolvedSummaries(
  prev: ReadonlyMap<string, WorktreeWorkspaceSummaryV15>,
  liveByPath: ReadonlyMap<string, WorktreeWorkspaceSummaryV15>,
  bindingEntries: ReadonlyArray<WorktreeBindingEntry>,
): ReadonlyMap<string, WorktreeWorkspaceSummaryV15> {
  const bound = new Set(bindingEntries.map((entry) => entry.workspacePath));
  let changed = false;
  const next = new Map<string, WorktreeWorkspaceSummaryV15>();
  for (const [path, summary] of prev) {
    if (!bound.has(path)) {
      changed = true;
      continue;
    }
    next.set(path, summary);
  }
  for (const [path, live] of liveByPath) {
    if (!bound.has(path) || live.resolvedAt === null) continue;
    const prior = next.get(path);
    if (prior !== undefined && prior.resolvedAt === live.resolvedAt) {
      continue;
    }
    next.set(path, live);
    changed = true;
  }
  return changed ? next : prev;
}

export type HostWorkspaceSelectorSurface =
  | { readonly kind: "home"; readonly draftId: string | null }
  | BoundOwnerSurface;

interface HostWorkspaceSelectorProps {
  readonly surface: HostWorkspaceSelectorSurface;
  readonly disabled: boolean;
}

export function HostWorkspaceSelector(props: HostWorkspaceSelectorProps) {
  const directoryList = useHostDirectoryList();
  const activeHostId = useAddressableHostId();
  const directoryEntries = directoryList.data ?? [];
  const activeEntry =
    directoryEntries.find((entry) => entry.hostId === activeHostId) ?? null;
  const hostLabel = activeEntry?.label ?? "Local";
  const ownerHostId =
    props.surface.kind === "home" ? null : props.surface.hostId;
  const ownerHostEntry =
    ownerHostId === null
      ? null
      : (directoryEntries.find((entry) => entry.hostId === ownerHostId) ??
        null);
  const ownerHostClient = useHostClientFor(ownerHostEntry);
  // When that host is not in the directory (unreachable / not yet discovered), do not fall back to the active
  // host's label.
  const inEpicHostLabel =
    ownerHostEntry?.label ??
    (directoryList.data === undefined ? hostLabel : "Unavailable");

  if (props.surface.kind === "home") {
    return (
      <HomeSurface draftId={props.surface.draftId} disabled={props.disabled} />
    );
  }
  return (
    <InEpicSurface
      surface={props.surface}
      hostLabel={inEpicHostLabel}
      activeHostId={props.surface.hostId}
      hostClient={ownerHostClient}
    />
  );
}

interface HomeSurfaceProps {
  readonly draftId: string | null;
  readonly disabled: boolean;
}

function HomeSurface(props: HomeSurfaceProps) {
  // Must be the same host `ActiveHostWorkspaceControls` resolves for an "active" scope below - the staged slot
  // and the folder rows it stages into have to agree on which machine they describe.
  const landingHostId = useComposerSurfaceHostPin().resolvedHostId;
  const stagingKey = useMemo<WorktreeStagingKey>(
    () => ({
      surface: "landing",
      hostId: landingHostId,
      draftId: props.draftId,
    }),
    [landingHostId, props.draftId],
  );
  return (
    <ActiveHostWorkspaceControls
      stagingKey={stagingKey}
      layout="inline"
      workspaceSeed={null}
      seedIntent={null}
      seedIntentOverride={null}
      hostScope={{ kind: "active" }}
      disabled={props.disabled}
    />
  );
}

/** Host-only dropdown + Workspace rail/panel folder picker, bound to a staging key and to whichever host its
 * `hostScope` names. effective` and follows the effective host only until the user names one. */
type ActiveHostWorkspaceControlsProps = {
  readonly stagingKey: WorktreeStagingKey;
  readonly workspaceSeed: LandingDraftWorkspaceSnapshot | null;
  /** The source conversation's intent for seeding the folder rows (top precedence in the picker's seeding). */
  readonly seedIntent: WorktreeIntent | null;
  /** Per-folder transform applied on top of `seedIntent` when seeding: force every seeded folder to a new
   * worktree carrying the working tree ("A/B Fork"). */
  readonly seedIntentOverride: SeedIntentOverride | null;
  // "inline" (landing composer): folder rows with the host chip pushed to the far right of row 1.
  readonly layout: "inline" | "stacked";
  readonly hostScope: HostWorkspaceControlsHostScope;
  readonly disabled: boolean;
};

export function ActiveHostWorkspaceControls(
  props: ActiveHostWorkspaceControlsProps,
) {
  const directoryList = useHostDirectoryList();
  const disabled = props.disabled;
  const directoryEntries = directoryList.data ?? [];
  // The composer is placement, and placement is a per-surface pin - not the app-wide selection, which is
  // Settings ▸ Activate's alone now.
  const composerPin = useComposerSurfaceHostPin();
  const scopeHostId = hostWorkspaceControlsScopeHostId(props.hostScope);
  const activeHostId = scopeHostId ?? composerPin.resolvedHostId;
  const activeEntry =
    directoryEntries.find((entry) => entry.hostId === activeHostId) ?? null;
  // "Local" is the neutral pre-directory default, and it is only honest while this surface is following: a pin
  // naming a host the directory does not carry is a real unavailable state, not a slow first paint.
  const hostLabel =
    activeEntry?.label ??
    (scopeHostId === null && !composerPin.isPinned ? "Local" : "Unavailable");
  // `honoredSelection`, not `selection`: a deposed pin still names the dead host in `selection` (sticky return),
  // but must not read through it - the chip auto-follows, and the rows must describe the machine the chip shows.
  const pinResolvedHostClient = useHostClientForHostId(
    composerPin.honoredSelection,
  );
  const activeHostClient =
    props.hostScope.kind === "active"
      ? pinResolvedHostClient
      : props.hostScope.hostClient;
  // It resolves out of the same merged list, and only falls back to a stand-in row when the list has never heard
  // of it.
  const hostOptions = useHostOptions();
  const listedHostOption = findHostOption(hostOptions.hosts, activeHostId);
  const selectedHostOption =
    activeHostId === null
      ? null
      : (listedHostOption ?? unavailableHostOption(activeHostId, hostLabel));
  const visibleHostOptions = hostPickerOptionsForScope(
    props.hostScope,
    selectedHostOption,
    listedHostOption,
    hostOptions.hosts,
  );
  const homeWorkspaceSource = useHomeWorkspaceSource(
    props.stagingKey,
    props.workspaceSeed,
    // The scope-correct host: the fixed host when pinned, else the app-wide active one - the same resolution every
    // other host-derived read in this component uses, so the folder bucket can never disagree with them.
    activeHostId,
  );
  const workspaceSource = useMemo<HomeWorkspaceSource>(
    () =>
      disabled
        ? {
            ...homeWorkspaceSource,
            addResolvedFolders: () => undefined,
            removeFolder: () => ({
              primaryChanged: false,
              newPrimaryName: null,
            }),
            setPrimaryFolder: () => undefined,
            stageEntry: () => undefined,
          }
        : homeWorkspaceSource,
    [disabled, homeWorkspaceSource],
  );
  // Resolve repo-identifier → path against the scope-correct host: this composer's pinned (or followed) host,
  // the source agent's fixed host in the terminal-agent fork dialog (else paths resolve on the wrong machine).
  const resolved = useResolvedWorkspaceFolders(
    workspaceSource.source,
    activeHostClient,
    activeHostId,
  );
  const refusalByHostId = hostWorkspaceControlsScopeRefusals(props.hostScope);
  // A surface-level blocker: every row but the named one goes inert, and none of them says why, because the
  // reason is not about them.
  const unselectableExceptHostId =
    props.hostScope.kind === "selected"
      ? props.hostScope.unselectableExceptHostId
      : null;
  const handleSelectHost = (hostId: string): void => {
    if (disabled) return;
    if (props.hostScope.kind === "fixed") return;
    // A `selected` scope owns the choice itself - routing a dialog-local
    // target through any app/window-wide seam is the bug this scope removes.
    if (props.hostScope.kind === "selected") {
      props.hostScope.onSelect(hostId);
      return;
    }
    // Before this called `binding.directory.selectById(hostId)` - moving the whole app to place one chat, which is
    // the defect the surface-pin model exists to end.
    if (
      (hostId !== activeHostId || composerPin.selection !== hostId) &&
      props.stagingKey.surface === "landing" &&
      props.stagingKey.draftId !== null
    ) {
      useLandingDraftStore
        .getState()
        .restoreDraftWorkspaceForHost(props.stagingKey.draftId, hostId);
    }
    if (composerPin.selection !== hostId) {
      composerPin.setSelection(hostId);
    }
  };

  if (props.layout === "stacked") {
    // Host picker as a flat file-tree-style list (own header), with the folder rows in their own "Workspaces"
    // section below - no trailing chip.
    return (
      <div className="flex w-full max-w-full min-w-0 flex-col gap-3 [--fc-opacity:1] [--fc-text:var(--color-foreground)]">
        <HostSection
          hosts={visibleHostOptions}
          activeHostId={activeHostId}
          onSelect={handleSelectHost}
          refusalByHostId={refusalByHostId}
          inertExceptHostId={unselectableExceptHostId}
          // A fixed scope cannot change hosts - `handleSelectHost` returns early there.
          disabled={disabled || props.hostScope.kind === "fixed"}
          isLoading={hostOptions.isLoading}
          listsFailed={hostOptions.listsFailed}
          onRetryLists={hostOptions.retryLists}
          // `pin`, not `bind`: since a pick here writes this composer's surface pin and never rebinds the window. (The
          // two intents gate rows identically; only `view` differs.)
          intent="pin"
        />
        <section
          aria-label="Workspaces"
          data-testid="host-workspace-selector-folders-section"
          className="w-full max-w-full min-w-0"
        >
          <DropdownMenuLabel className="px-1 text-ui-xs font-medium uppercase tracking-wide text-muted-foreground/70">
            Workspaces
          </DropdownMenuLabel>
          <HomeWorkspaceRows
            workspaceSource={workspaceSource}
            resolvedFolders={resolved.folders}
            activeHostClient={activeHostClient}
            activeHostId={activeHostId}
            hostLabel={hostLabel}
            stagingKey={props.stagingKey}
            seedIntent={props.seedIntent}
            seedIntentOverride={props.seedIntentOverride}
            restingMode="rows"
            hostSlot={null}
            disabled={disabled}
          />
        </section>
      </div>
    );
  }

  // Landing rests as host picker + compact summary chip, matching the in-epic
  // composer. Detailed folder rows still live in the popover/modal stack.
  const deviceSelect = (
    <WorkspaceHostSwitcher
      hosts={visibleHostOptions}
      activeHostId={activeHostId}
      onSelect={handleSelectHost}
      intent="pin"
      refusalByHostId={refusalByHostId}
      inertExceptHostId={unselectableExceptHostId}
      disabled={disabled || props.hostScope.kind === "fixed"}
      isLoading={hostOptions.isLoading}
      listsFailed={hostOptions.listsFailed}
      onRetryLists={hostOptions.retryLists}
      surface="inline"
    />
  );
  return (
    <HomeWorkspaceRows
      workspaceSource={workspaceSource}
      resolvedFolders={resolved.folders}
      activeHostClient={activeHostClient}
      activeHostId={activeHostId}
      hostLabel={hostLabel}
      stagingKey={props.stagingKey}
      seedIntent={props.seedIntent}
      seedIntentOverride={props.seedIntentOverride}
      restingMode="summary"
      hostSlot={deviceSelect}
      disabled={disabled}
    />
  );
}

function hostPickerOptionsForScope(
  scope: HostWorkspaceControlsHostScope,
  selectedHostOption: HostScopeOption | null,
  listedHostOption: HostScopeOption | null,
  hosts: readonly HostScopeOption[],
): readonly HostScopeOption[] {
  if (scope.kind === "fixed") {
    if (selectedHostOption === null) return [];
    return [selectedHostOption];
  }
  if (selectedHostOption !== null && listedHostOption === null) {
    return [selectedHostOption, ...hosts];
  }
  return hosts;
}

function HomeWorkspaceRows(props: {
  readonly workspaceSource: HomeWorkspaceSource;
  readonly resolvedFolders: ReadonlyArray<ResolvedFolder>;
  readonly activeHostClient: HostClient<HostRpcRegistry> | null;
  /** The original reason no longer holds: `HostClient.bind` rebound in place, so the active-scope client was one
   * object for the app's lifetime and a memo keyed on it alone would pin the first host's answer. */
  readonly activeHostId: string | null;
  readonly hostLabel: string;
  readonly stagingKey: WorktreeStagingKey;
  /** The source conversation's intent - top precedence when seeding folders (the fork dialog, and creating a new
   * GUI/terminal agent from the latest conversation). */
  readonly seedIntent: WorktreeIntent | null;
  // Per-folder transform on top of `seedIntent` (A/B Fork → new worktree
  // carrying the working tree; null = verbatim). See `SeedIntentOverride`.
  readonly seedIntentOverride: SeedIntentOverride | null;
  readonly restingMode: "rows" | "summary";
  readonly hostSlot: ReactNode;
  readonly disabled: boolean;
}) {
  const {
    workspaceSource,
    resolvedFolders,
    activeHostClient,
    stagingKey,
    seedIntent,
    seedIntentOverride,
  } = props;
  // Both maps are stable references (the bucket is the stored object, or the shared empty one), so subscribing
  // to them does not churn renders.
  const rememberFolderIntent = useWorktreeIntentMemoryStore(
    (state) => state.setFolderIntent,
  );
  const rowsHostId = props.activeHostId;
  const setFolderIntent = useCallback(
    (intent: WorktreeFolderIntent, updatedAt: number): void => {
      rememberFolderIntent(rowsHostId, intent, updatedAt);
    },
    [rememberFolderIntent, rowsHostId],
  );
  const folderIntentByPath = useWorktreeIntentMemoryStore(
    useCallback(
      (state) =>
        selectWorktreeIntentMemoryBucket(state, rowsHostId).folderIntentByPath,
      [rowsHostId],
    ),
  );
  const legacyFolderIntentByPath = useWorktreeIntentMemoryStore(
    (state) => state.legacyFolderIntentByPath,
  );
  const resolvedPrimaryPath = useMemo(
    () =>
      resolvePrimaryPath(
        resolvedFolders.map((entry) => entry.path),
        workspaceSource.primaryPath,
      ),
    [resolvedFolders, workspaceSource.primaryPath],
  );
  // Polite live-region announcement for a primary change - either an explicit "Make primary" click or the
  // deterministic reassignment when removing the current primary.
  const { announcement: primaryAnnouncement, announcePrimaryChange } =
    usePrimaryChangeAnnouncement();
  const addFolderPending =
    useIsMutating({ mutationKey: workspaceMutationKeys.prepareFolders() }) > 0;
  const pickAndAddFolders = usePickAndAddWorkspaceFolders(
    activeHostClient,
    workspaceSource,
  );
  // Locate on an absent row must replace the dead path - add-only left it blocking readiness until the user
  // manually removed it.
  const locateAndReplaceFolder = useLocateAndReplaceWorkspaceFolder(
    activeHostClient,
    workspaceSource,
  );
  const activatePreparedRecentFolders = useCallback(
    (
      folders: ReadonlyArray<PreparedWorkspaceFolder>,
      hostId: string,
    ): Promise<ReadonlyArray<string>> => {
      workspaceSource.addResolvedFolders(
        folders.map((folder) =>
          preparedWorkspaceFolderToWorkspaceFolderInfo(folder, hostId),
        ),
      );
      return Promise.resolve(folders.map((folder) => folder.workspacePath));
    },
    [workspaceSource],
  );
  const recentWorkspaces = useRecentWorkspaces({
    client: activeHostClient,
    hostId: props.activeHostId,
    activePaths: workspaceSource.folders,
    activatePreparedFolders: activatePreparedRecentFolders,
    disabled: props.disabled,
    surface: stagingKey.surface,
  });
  const queryableFolderPaths = useMemo<ReadonlyArray<string>>(
    () => [...new Set(resolvedFolders.map((entry) => entry.path))],
    [resolvedFolders],
  );
  const summariesQuery = useWorktreeListByWorkspacePathsForClient(
    activeHostClient,
    {
      workspacePaths: queryableFolderPaths,
      enabled: true,
    },
  );
  const summaries =
    summariesQuery.data?.workspaces ?? EMPTY_WORKSPACE_SUMMARIES;
  // Adjacent to the query ON purpose: it writes its forced response into that query's cache entry, and the path
  // list is part of the key.
  const summariesRefresh = useWorktreeWorkspacesRefresh({
    client: activeHostClient,
    workspacePaths: queryableFolderPaths,
    summaries,
  });
  // It never resets, so a surface that switches hosts in place - or has folders added while open - would keep
  // the first target's answer and never heal the new one.
  const rowsIntentTarget = useRef<string | null>(null);
  const rowsResting = props.restingMode === "rows";
  const canRefreshSummaries = summariesRefresh.canRefresh;
  const refreshSummaries = summariesRefresh.refresh;
  // The active-scope client rebinds in place, so its identity survives a host swap: a memo keyed on the client
  // would keep returning the previous host's key, and this surface.
  const rowsIntentKey = useMemo(
    () => JSON.stringify([props.activeHostId, queryableFolderPaths]),
    [props.activeHostId, queryableFolderPaths],
  );
  useEffect(() => {
    if (!rowsResting || !canRefreshSummaries) return;
    if (rowsIntentTarget.current === rowsIntentKey) return;
    rowsIntentTarget.current = rowsIntentKey;
    // The rows keep rendering the cached view meanwhile, so this costs no blank frame; the hook toasts its own
    // failure, so the rejection is already reported by the time it lands here.
    void refreshSummaries().catch(() => {
      if (rowsIntentTarget.current === rowsIntentKey) {
        rowsIntentTarget.current = null;
      }
    });
  }, [canRefreshSummaries, refreshSummaries, rowsIntentKey, rowsResting]);
  const summariesByPath = useMemo<
    ReadonlyMap<string, WorktreeWorkspaceSummaryV15>
  >(() => {
    const map = new Map<string, WorktreeWorkspaceSummaryV15>();
    for (const ws of summaries) {
      map.set(ws.workspacePath, ws);
    }
    return map;
  }, [summaries]);
  const setSuspendedWorkspacePaths = useWorktreeIntentStagingStore(
    (state) => state.setSuspendedWorkspacePaths,
  );
  const unresolvedMetadataPaths = useMemo(
    () =>
      queryableFolderPaths.filter((path) => {
        const summary = summariesByPath.get(path);
        return summary === undefined || summary.resolvedAt === null;
      }),
    [queryableFolderPaths, summariesByPath],
  );
  useLayoutEffect(() => {
    if (props.disabled) return;
    setSuspendedWorkspacePaths(stagingKey, unresolvedMetadataPaths);
  }, [
    props.disabled,
    setSuspendedWorkspacePaths,
    stagingKey,
    unresolvedMetadataPaths,
  ]);
  const gitSummaries = useMemo<ReadonlyArray<WorktreeWorkspaceSummaryV15>>(
    () =>
      resolvedFolders.flatMap((entry) => {
        const summary = summaryForResolvedFolder(entry, summariesByPath);
        return summary !== null &&
          summary.resolvedAt !== null &&
          summary.isGitRepo
          ? [summary]
          : [];
      }),
    [resolvedFolders, summariesByPath],
  );
  const worktreeBranchPrefix = useSettingsStore((s) => s.worktreeBranchPrefix);
  const defaultBranchByPath = useMemo(
    () =>
      buildDefaultBranchByPath(
        gitSummaries,
        gitSummaries.length > 1,
        worktreeBranchPrefix,
      ),
    [gitSummaries, worktreeBranchPrefix],
  );
  // A folder the user already touched this session is never overwritten.
  const seedStageEntry = workspaceSource.stageEntry;
  // Subscribed (not an imperative read) so the effect re-runs when persisted staging rehydrates after auth.
  const seedCapturedIntent = workspaceSource.capturedIntent;
  const seedStagingKey = stagingKey;
  const seedEpicId =
    seedStagingKey.surface === "owner" ||
    seedStagingKey.surface === "new-conversation"
      ? seedStagingKey.epicId
      : null;
  // `getEpicIntent` returns the stored intent reference, stable until a write, so this does not churn renders.
  const epicIntent = useWorktreeIntentMemoryStore(
    useCallback(
      (state) =>
        seedEpicId === null
          ? null
          : selectRememberedEpicIntent(state, rowsHostId, seedEpicId),
      [rowsHostId, seedEpicId],
    ),
  );

  const rememberedFor = useCallback(
    (workspacePath: string): WorktreeFolderIntent | null => {
      // The host's own bucket first, then the frozen pre-host-scoping fallback - the same per-key precedence
      // `selectRememberedFolderIntent` applies (inlined here so both maps stay reactive subscriptions).
      if (Object.hasOwn(folderIntentByPath, workspacePath)) {
        return folderIntentByPath[workspacePath].intent;
      }
      return Object.hasOwn(legacyFolderIntentByPath, workspacePath)
        ? legacyFolderIntentByPath[workspacePath].intent
        : null;
    },
    [folderIntentByPath, legacyFolderIntentByPath],
  );
  // The per-epic entry for a folder, if any.
  const epicEntryFor = useCallback(
    (workspacePath: string): WorktreeFolderIntent | null =>
      epicIntent?.entries.find((e) => e.workspacePath === workspacePath) ??
      null,
    [epicIntent],
  );

  // A remembered existing-branch checkout (or a fork from a non-working-tree source) can only be validated
  // against the full branch list, fetched lazily here for exactly those folders - none in the common case.
  const branchValidationPaths = useMemo<ReadonlyArray<string>>(
    () =>
      gitSummaries.flatMap((summary) => {
        // A seeded folder is staged verbatim and never branch-validated, so it
        // needs no branch fetch.
        const seeded =
          seedIntent?.entries.some(
            (entry) => entry.workspacePath === summary.workspacePath,
          ) ?? false;
        if (seeded) return [];
        return rememberedNeedsBranchValidation(
          epicEntryFor(summary.workspacePath) ??
            rememberedFor(summary.workspacePath),
          branchForSummary(summary),
        )
          ? [summary.workspacePath]
          : [];
      }),
    [gitSummaries, rememberedFor, epicEntryFor, seedIntent],
  );
  const branchValidationQueries = useHostQueries<
    HostRpcRegistry,
    "worktree.listBranches"
  >({
    client: activeHostClient,
    cacheKeyIdentity: undefined,
    requests: branchValidationPaths.map((workspacePath) => ({
      method: "worktree.listBranches",
      params: { workspacePath, includeRemote: true },
    })),
    options: { enabled: true },
  });

  const branchesByValidationPath = useMemo<
    ReadonlyMap<string, ReadonlyArray<WorktreeBranch> | null>
  >(() => {
    const map = new Map<string, ReadonlyArray<WorktreeBranch> | null>();
    branchValidationPaths.forEach((workspacePath, index) => {
      map.set(
        workspacePath,
        branchValidationQueries[index]?.data?.branches ?? null,
      );
    });
    return map;
  }, [branchValidationPaths, branchValidationQueries]);

  useEffect(() => {
    if (gitSummaries.length === 0) return;
    const staged = seedCapturedIntent;
    gitSummaries.forEach((summary) => {
      const alreadyStaged =
        staged?.entries.some(
          (entry) => entry.workspacePath === summary.workspacePath,
        ) ?? false;
      if (alreadyStaged) return;
      const currentBranch = branchForSummary(summary);
      const folder: SeedFolderContext = {
        workspacePath: summary.workspacePath,
        repoIdentifier: summary.repoIdentifier,
        // After a reload restores a draft whose explicit primary is not the first git summary (empty staging slot), an
        // order-derived seed here would silently re-mark the first summary primary and contradict the badge.
        isPrimary: summary.workspacePath === resolvedPrimaryPath,
        isGitRepo: summary.isGitRepo,
        currentBranch,
        defaultNewBranchName: (
          defaultBranchByPath[summary.workspacePath] ?? EMPTY_DEFAULT_BRANCH
        ).name,
        summary,
      };
      // A fork surface may override the seed's per-folder disposition (Cross Question → local, A/B Fork → new
      // worktree carrying the working tree); the overridden entry stays top-precedence like the verbatim seed.
      const seedEntry = applySeedIntentOverride({
        override: seedIntentOverride,
        seedEntry:
          seedIntent?.entries.find(
            (entry) => entry.workspacePath === summary.workspacePath,
          ) ?? null,
        folder,
      });
      const epicEntry = epicEntryFor(summary.workspacePath);
      const remembered = rememberedFor(summary.workspacePath);
      // A seed (the source conversation's live binding) is authoritative and staged verbatim, so it short-circuits
      // the memory/default tiers and their branch-validation wait below.
      const needsBranches =
        seedEntry === null &&
        rememberedNeedsBranchValidation(epicEntry ?? remembered, currentBranch);
      const branches = needsBranches
        ? (branchesByValidationPath.get(summary.workspacePath) ?? null)
        : [];
      // Wait for the branch list before resolving a branch-dependent memory so a
      // valid remembered choice isn't dropped to the default on a missing list.
      if (needsBranches && branches === null) return;
      const entry = seedEntryForFolder({
        seedFolderIntent: seedEntry,
        epicIntentEntry: epicEntry,
        rememberedFolderIntent: remembered,
        branches,
        folder,
        alreadyStaged: false,
      });
      if (entry !== null) seedStageEntry(entry);
    });
  }, [
    epicEntryFor,
    seedStageEntry,
    seedCapturedIntent,
    gitSummaries,
    defaultBranchByPath,
    rememberedFor,
    resolvedPrimaryPath,
    branchesByValidationPath,
    seedIntent,
    seedIntentOverride,
  ]);

  const baseItems = useMemo<ReadonlyArray<WorkspaceRunItem>>(
    () =>
      resolvedFolders.map((entry) =>
        workspaceRunItemForResolvedFolder({
          entry,
          activeHostClient,
          announcePrimaryChange,
          defaultBranchByPath,
          hostLabel: props.hostLabel,
          isFetchingSummaries: summariesQuery.isFetching,
          summariesFailed: summariesQuery.isError,
          // Path-scoped: Locate must replace THIS absent entry, not merely
          // append a new folder next to the dead one.
          onLocate: () => {
            void locateAndReplaceFolder(entry.path);
          },
          resolvedPrimaryPath,
          setFolderIntent,
          summariesByPath,
          workspaceSource,
        }),
      ),
    [
      announcePrimaryChange,
      defaultBranchByPath,
      locateAndReplaceFolder,
      activeHostClient,
      props.hostLabel,
      resolvedFolders,
      resolvedPrimaryPath,
      workspaceSource,
      setFolderIntent,
      summariesByPath,
      summariesQuery.isFetching,
      summariesQuery.isError,
    ],
  );
  const {
    moveToRecent: moveWorkspaceToRecent,
    movingPath: recentWorkspacesMovingPath,
    supported: recentWorkspacesSupported,
  } = recentWorkspaces;
  const items = useMemo<ReadonlyArray<WorkspaceRunItem>>(
    () =>
      baseItems.map((item) => {
        if (!recentWorkspacesSupported || item.onRemove === null) return item;
        const removeFromActive = item.onRemove;
        return {
          ...item,
          removePending:
            item.removePending ||
            recentWorkspacesMovingPath === item.displayPath,
          onRemove: () => {
            void moveWorkspaceToRecent(item.displayPath).then((moved) => {
              if (moved) removeFromActive();
            });
          },
        };
      }),
    [
      baseItems,
      moveWorkspaceToRecent,
      recentWorkspacesMovingPath,
      recentWorkspacesSupported,
    ],
  );
  const recentWorkspacesSection = recentWorkspaces.supported ? (
    <RecentWorkspacesSection
      entries={recentWorkspaces.entries}
      activeCount={workspaceSource.folders.length}
      pendingPath={recentWorkspaces.pendingPath}
      failedPaths={recentWorkspaces.failedPaths}
      onAdd={recentWorkspaces.add}
      onLocate={recentWorkspaces.locate}
      onForget={recentWorkspaces.forget}
    />
  ) : null;

  // Landing is pre-epic: no owner/binding, `epicId: ""` (the host resolver is authn-only for the empty epic).
  const [scriptsTargetPath, setScriptsTargetPath] = useState<string | null>(
    null,
  );
  const handleEditEnvironment = useCallback(
    (path: string): void => {
      if (props.disabled) return;
      // Keep the picker open: the scripts modal stacks on top of it, so closing
      // the modal returns to the still-open picker.
      Analytics.getInstance().track(AnalyticsEvent.SetupScriptsOpened, {
        source: "direct_ui",
      });
      setScriptsTargetPath(path);
    },
    [props.disabled],
  );
  const addFolders = useCallback(async (): Promise<boolean> => {
    if (props.disabled) return false;
    return pickAndAddFolders();
  }, [pickAndAddFolders, props.disabled]);
  const scriptsTarget = useMemo<WorktreeScriptsTarget | null>(() => {
    if (scriptsTargetPath === null) return null;
    const summary = summariesByPath.get(scriptsTargetPath);
    if (summary === undefined) return null;
    return { workspacePath: scriptsTargetPath, summary };
  }, [scriptsTargetPath, summariesByPath]);
  const regenerateBranchNameForWorkspace = useCallback(
    (
      path: string,
      freshRepoBranchPrefix: RepoBranchPrefixState,
      suffix: string,
    ): string | null =>
      regenerateSingleWorkspaceBranchName({
        workspaces: gitSummaries,
        globalBranchPrefix: worktreeBranchPrefix,
        workspacePath: path,
        freshRepoBranchPrefix,
        suffix,
      }),
    [gitSummaries, worktreeBranchPrefix],
  );
  const scriptsContext = useMemo<WorktreeScriptsContext>(
    () => ({
      epicId: "",
      ownerId: null,
      ownerKind: null,
      binding: null,
      stagingKey,
      hostClient: activeHostClient,
      regenerateBranchNameForWorkspace,
    }),
    [stagingKey, activeHostClient, regenerateBranchNameForWorkspace],
  );

  return (
    <>
      <PrimaryChangeLiveRegion announcement={primaryAnnouncement} />
      {props.restingMode === "summary" ? (
        <HomeWorkspaceSummaryControl
          items={items}
          hostSlot={props.hostSlot}
          addFolderPending={addFolderPending}
          onAddFolder={addFolders}
          onEditEnvironment={handleEditEnvironment}
          refresh={summariesRefresh}
          disabled={props.disabled}
          recentWorkspaces={recentWorkspacesSection}
          recentWorkspaceCount={recentWorkspaces.entries.length}
          moveToRecent={recentWorkspaces.supported}
        />
      ) : (
        <WorkspaceFolderRows
          items={items}
          trailingSlot={null}
          addFolderPending={addFolderPending}
          addFolderDisabled={props.disabled}
          addFolderDisabledReason={null}
          onAddFolder={addFolders}
          // Landing has no live PTY to resume: edits apply inline, no Update.
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          discardDisabled={false}
          onEditEnvironment={handleEditEnvironment}
          readOnly={false}
          // Rendered inline in the fork / add-node dialogs, never inside a
          // popover, so nested branch/source dropdowns portal to the body.
          nestedInPopover={false}
          // Home folder list is a synchronous local draft, never an async binding snapshot - an empty list is a genuine
          // "no folders linked yet", so the row shows the add affordance rather than an indefinite spinner.
          bindingResolved
          recentWorkspaces={recentWorkspacesSection}
          moveToRecent={recentWorkspaces.supported}
        />
      )}
      <WorktreeScriptsDialog
        open={scriptsTarget !== null}
        target={scriptsTarget}
        context={scriptsContext}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setScriptsTargetPath(null);
        }}
      />
    </>
  );
}

function HomeWorkspaceSummaryControl(props: {
  readonly items: ReadonlyArray<WorkspaceRunItem>;
  readonly hostSlot: ReactNode;
  readonly addFolderPending: boolean;
  readonly onAddFolder: AddFolderHandler;
  readonly onEditEnvironment: (workspacePath: string) => void;
  readonly refresh: WorktreeWorkspacesRefresh;
  readonly disabled: boolean;
  readonly recentWorkspaces: ReactNode;
  readonly recentWorkspaceCount: number;
  readonly moveToRecent: boolean;
}) {
  return (
    <div
      className="flex w-full max-w-full min-w-0 flex-nowrap items-center gap-2 overflow-hidden"
      data-testid="home-workspace-summary-control"
    >
      {props.hostSlot === null ? null : (
        <div className="w-fit min-w-0 flex-[0_1_auto] max-w-[min(50%,50vw)] overflow-hidden">
          {props.hostSlot}
        </div>
      )}
      <div className="min-w-0 flex-[1_1_auto] max-w-[min(100%,34rem)] overflow-hidden">
        <WorkspaceFolderSummaryControl
          items={props.items}
          readOnly={false}
          bindingResolved
          addFolderPending={props.addFolderPending}
          addFolderDisabled={props.disabled}
          addFolderDisabledReason={null}
          onAddFolder={props.onAddFolder}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          discardDisabled={false}
          onEditEnvironment={props.onEditEnvironment}
          refresh={props.refresh}
          popoverTestId="home-workspace-rows-popover"
          popoverSide="top"
          recentWorkspaces={props.recentWorkspaces}
          recentWorkspaceCount={props.recentWorkspaceCount}
          moveToRecent={props.moveToRecent}
        />
      </div>
    </div>
  );
}

type UnresolvedWorkspaceFolder = Extract<
  ResolvedFolder,
  { readonly kind: "unresolved" }
>;

function workspaceRunItemForResolvedFolder(input: {
  readonly entry: ResolvedFolder;
  readonly activeHostClient: HostClient<HostRpcRegistry> | null;
  readonly announcePrimaryChange: (folderName: string) => void;
  readonly defaultBranchByPath: Readonly<
    Record<string, DefaultBranchDescriptor>
  >;
  readonly hostLabel: string;
  readonly isFetchingSummaries: boolean;
  /** The summaries read rejected - distinct from "answered with nothing". */
  readonly summariesFailed: boolean;
  readonly onLocate: () => void;
  readonly resolvedPrimaryPath: string | null;
  readonly setFolderIntent: (
    intent: WorktreeFolderIntent,
    timestamp: number,
  ) => void;
  readonly summariesByPath: ReadonlyMap<string, WorktreeWorkspaceSummaryV15>;
  readonly workspaceSource: HomeWorkspaceSource;
}): WorkspaceRunItem {
  const summary = summaryForResolvedFolder(input.entry, input.summariesByPath);
  // Presence is per-(host, path) display state from the listing - never stored in the draft.
  const absentItem = workspaceRunItemForAbsentSummary({
    entry: input.entry,
    summary,
    hostLabel: input.hostLabel,
    resolvedPrimaryPath: input.resolvedPrimaryPath,
    onLocate: input.onLocate,
    announcePrimaryChange: input.announcePrimaryChange,
    workspaceSource: input.workspaceSource,
  });
  if (absentItem !== null) return absentItem;
  if (input.entry.kind === "unresolved") {
    const unresolvedItem = workspaceRunItemForUnresolvedFolder({
      activeHostClient: input.activeHostClient,
      announcePrimaryChange: input.announcePrimaryChange,
      entry: input.entry,
      hostLabel: input.hostLabel,
      isFetchingSummaries: input.isFetchingSummaries,
      summariesFailed: input.summariesFailed,
      onLocate: input.onLocate,
      resolvedPrimaryPath: input.resolvedPrimaryPath,
      summary,
      workspaceSource: input.workspaceSource,
    });
    if (unresolvedItem !== null) return unresolvedItem;
  }

  const capturedEntryForPath = currentCapturedEntry(
    input.workspaceSource.capturedIntent,
    input.entry.path,
  );
  const metadataResolved = summary !== null && summary.resolvedAt !== null;
  const isGitRepo = metadataResolved && summary.isGitRepo;
  const capturedEntry = supportedCapturedEntryForSummary(
    capturedEntryForPath,
    isGitRepo,
  );
  const mode = deriveHomeRowMode(capturedEntry, isGitRepo);
  const branchDefault =
    input.defaultBranchByPath[input.entry.path] ?? EMPTY_DEFAULT_BRANCH;
  const defaultNewBranchName = branchDefault.name;
  const currentBranch = branchForSummary(summary);
  const branchLabel = workspaceRunBranchLabel({
    mode,
    currentBranch,
    currentIntent: capturedEntry,
    diskWorktrees: summary?.worktrees.filter((w) => !w.isMain) ?? [],
  });
  // The resolver (backed by the explicit `primaryPath` field) is the single source of truth for which row is
  // primary.
  const isPrimary = input.entry.path === input.resolvedPrimaryPath;
  const emit = (intent: WorktreeFolderIntent): void => {
    input.workspaceSource.stageEntry(intent);
    input.setFolderIntent(intent, Date.now());
  };

  return {
    key: input.entry.path,
    displayName: input.entry.name,
    displayPath: input.entry.path,
    unresolved: false,
    metadataPending:
      (summary === null && input.isFetchingSummaries) ||
      (summary !== null && summary.resolvedAt === null),
    missing: false,
    isGitRepo,
    mode,
    branchLabel,
    summary,
    currentIntent: capturedEntry,
    defaultNewBranchName,
    branchPrefixWarning: branchDefault.warning,
    repoIdentifier:
      summary?.repoIdentifier ?? repoIdentifierForResolvedFolder(input.entry),
    isPrimary,
    canChangePrimary: true,
    makePrimaryDisabled: false,
    makePrimaryDisabledReason: null,
    hostClient: input.activeHostClient,
    modeDisabled: false,
    modeDisabledReason: null,
    removeDisabled: false,
    removeDisabledReason: null,
    removePending: false,
    onEmit: emit,
    onSelectMode: (nextMode) => {
      emitRowMode({
        currentBranch,
        currentIntent: capturedEntry,
        defaultNewBranchName,
        emit,
        isGitRepo,
        isPrimary,
        mode,
        nextMode,
        repoIdentifier: summary?.repoIdentifier ?? null,
        workspacePath: input.entry.path,
      });
    },
    onLocate: null,
    onMakePrimary: () => {
      input.workspaceSource.setPrimaryFolder(input.entry.path);
      input.announcePrimaryChange(input.entry.name);
    },
    onRemove: () => {
      const transition = input.workspaceSource.removeFolder(input.entry.path);
      if (transition.primaryChanged && transition.newPrimaryName !== null) {
        input.announcePrimaryChange(transition.newPrimaryName);
      }
    },
  };
}

/** Resolved absence on the wire (`presence: "absent"` with a real `resolvedAt`) is definitive not-available. */
function workspaceRunItemForAbsentSummary(input: {
  readonly entry: ResolvedFolder;
  readonly summary: WorktreeWorkspaceSummaryV15 | null;
  readonly hostLabel: string;
  readonly resolvedPrimaryPath: string | null;
  readonly onLocate: () => void;
  readonly announcePrimaryChange: (folderName: string) => void;
  readonly workspaceSource: HomeWorkspaceSource;
}): WorkspaceRunItem | null {
  if (input.summary === null) return null;
  if (input.summary.presence !== "absent") return null;
  if (input.summary.resolvedAt === null) return null;
  const isPrimary = input.entry.path === input.resolvedPrimaryPath;
  return unresolvedWorkspaceRunItem({
    path: input.entry.path,
    name: input.entry.name,
    repoIdentifier: repoIdentifierForResolvedFolder(input.entry),
    hostLabel: input.hostLabel,
    isPrimary,
    onLocate: input.onLocate,
    onMakePrimary: () => {
      input.workspaceSource.setPrimaryFolder(input.entry.path);
      input.announcePrimaryChange(input.entry.name);
    },
    onRemove: () => {
      const transition = input.workspaceSource.removeFolder(input.entry.path);
      if (transition.primaryChanged && transition.newPrimaryName !== null) {
        input.announcePrimaryChange(transition.newPrimaryName);
      }
    },
  });
}

function workspaceRunItemForUnresolvedFolder(input: {
  readonly activeHostClient: HostClient<HostRpcRegistry> | null;
  readonly announcePrimaryChange: (folderName: string) => void;
  readonly entry: UnresolvedWorkspaceFolder;
  readonly hostLabel: string;
  readonly isFetchingSummaries: boolean;
  /** The summaries read rejected - distinct from "answered with nothing". */
  readonly summariesFailed: boolean;
  readonly onLocate: () => void;
  readonly resolvedPrimaryPath: string | null;
  readonly summary: WorktreeWorkspaceSummaryV15 | null;
  readonly workspaceSource: HomeWorkspaceSource;
}): WorkspaceRunItem | null {
  // Only the no-summary case stays here - pending while the listing is in flight, else the not-available row.
  if (input.summary !== null) return null;
  const isPrimary = input.entry.path === input.resolvedPrimaryPath;
  const onRemove = (): void => {
    const transition = input.workspaceSource.removeFolder(input.entry.path);
    if (transition.primaryChanged && transition.newPrimaryName !== null) {
      input.announcePrimaryChange(transition.newPrimaryName);
    }
  };
  if (input.isFetchingSummaries) {
    return pendingWorkspaceRunItem({
      path: input.entry.path,
      name: input.entry.name,
      repoIdentifier: input.entry.repoIdentifier,
      hostClient: input.activeHostClient,
      isPrimary,
      onRemove,
    });
  }
  return unresolvedWorkspaceRunItem({
    path: input.entry.path,
    name: input.entry.name,
    repoIdentifier: input.entry.repoIdentifier,
    hostLabel: input.hostLabel,
    isPrimary,
    // Both leave `summary === null` with `isFetching` false, so without this the row offered to replace the folder
    // on the strength of a metadata request that never got an answer.
    onLocate: input.summariesFailed ? null : input.onLocate,
    onMakePrimary: () => {
      input.workspaceSource.setPrimaryFolder(input.entry.path);
      input.announcePrimaryChange(input.entry.name);
    },
    onRemove,
  });
}

function currentCapturedEntry(
  capturedIntent: WorktreeIntent | null,
  workspacePath: string,
): WorktreeFolderIntent | null {
  return (
    capturedIntent?.entries.find(
      (intentEntry) => intentEntry.workspacePath === workspacePath,
    ) ?? null
  );
}

function supportedCapturedEntryForSummary(
  capturedEntry: WorktreeFolderIntent | null,
  isGitRepo: boolean,
): WorktreeFolderIntent | null {
  if (isGitRepo) return capturedEntry;
  return capturedEntry?.kind === "local" ? capturedEntry : null;
}

/** `onSelectMode` body shared by the home and in-Epic rows, extracted so the surrounding
 * `workspaceRunItems`/item-building callbacks stay under the ESLint complexity cap. */
function emitRowMode(input: {
  readonly currentBranch: string | null;
  readonly currentIntent: WorktreeFolderIntent | null;
  readonly defaultNewBranchName: string;
  readonly emit: (intent: WorktreeFolderIntent) => void;
  readonly isGitRepo: boolean;
  readonly isPrimary: boolean;
  readonly mode: WorkspaceRunMode;
  readonly nextMode: WorkspaceRunMode;
  readonly repoIdentifier: WorktreeWorkspaceSummaryV15["repoIdentifier"];
  readonly workspacePath: string;
}): void {
  if (
    !locationSelectionChanges(input.nextMode, input.currentIntent, input.mode)
  ) {
    return;
  }
  if (input.nextMode === "local") {
    input.emit({
      kind: "local",
      workspacePath: input.workspacePath,
      repoIdentifier: input.repoIdentifier,
      isPrimary: input.isPrimary,
    });
    return;
  }
  input.emit(
    defaultFolderIntent({
      workspacePath: input.workspacePath,
      repoIdentifier: input.repoIdentifier,
      isPrimary: input.isPrimary,
      isGitRepo: input.isGitRepo,
      currentBranch: input.currentBranch,
      defaultNewBranchName: input.defaultNewBranchName,
    }),
  );
}

function removeDisabledReasonFor(
  isOwnerActive: boolean,
  activeRunNotice: string,
): string | null {
  if (isOwnerActive) return activeRunNotice;
  return null;
}

/** Pending is a spinner on the chip only - it must not disable selection. */
function isRowMetadataPending(
  metadataPending: boolean,
  resolvedAt: number | null,
): boolean {
  return metadataPending || resolvedAt === null;
}

/** The path is where the chat actually runs - the adopted worktree for worktree mode, the folder for local -
 * not the source folder. */
function unresolvedWorkspaceRunItem(input: {
  readonly path: string;
  readonly name: string;
  readonly repoIdentifier: WorktreeWorkspaceSummaryV15["repoIdentifier"];
  readonly hostLabel: string;
  readonly isPrimary: boolean;
  /** A failed `worktree.listByWorkspacePaths` leaves the same empty summary a real `presence: "absent"` does, and
   * acting on that would talk the user into replacing a folder that is very likely still there. */
  readonly onLocate: (() => void) | null;
  readonly onMakePrimary: () => void;
  readonly onRemove: () => void;
}): WorkspaceRunItem {
  // Copy is true for both "path gone" and "path is a regular file" - the host conflates those into `presence:
  // "absent"`.
  const notAvailableLabel = `Not available on ${input.hostLabel}`;
  return {
    key: input.path,
    displayName: input.name,
    displayPath: input.path,
    unresolved: true,
    metadataPending: false,
    // "Not available on <host>" is a distinct state from the
    // binding-missing-on-disk signal.
    missing: false,
    isGitRepo: false,
    mode: "local",
    branchLabel: notAvailableLabel,
    summary: null,
    currentIntent: null,
    defaultNewBranchName: "",
    branchPrefixWarning: null,
    repoIdentifier: input.repoIdentifier,
    isPrimary: input.isPrimary,
    canChangePrimary: true,
    makePrimaryDisabled: true,
    makePrimaryDisabledReason: "Resolve this folder to make it primary",
    hostClient: null,
    modeDisabled: true,
    modeDisabledReason: notAvailableLabel,
    removeDisabled: false,
    removeDisabledReason: null,
    removePending: false,
    onSelectMode: () => undefined,
    onEmit: () => undefined,
    onLocate: input.onLocate,
    onMakePrimary: input.onMakePrimary,
    onRemove: input.onRemove,
  };
}

function pendingWorkspaceRunItem(input: {
  readonly path: string;
  readonly name: string;
  readonly repoIdentifier: WorktreeWorkspaceSummaryV15["repoIdentifier"];
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly isPrimary: boolean;
  readonly onRemove: () => void;
}): WorkspaceRunItem {
  return {
    key: input.path,
    displayName: input.name,
    displayPath: input.path,
    unresolved: false,
    metadataPending: true,
    missing: false,
    isGitRepo: false,
    mode: "local",
    branchLabel: "Loading",
    summary: null,
    currentIntent: null,
    defaultNewBranchName: "",
    branchPrefixWarning: null,
    repoIdentifier: input.repoIdentifier,
    isPrimary: input.isPrimary,
    canChangePrimary: true,
    makePrimaryDisabled: true,
    makePrimaryDisabledReason: "Loading folder metadata",
    hostClient: input.hostClient,
    modeDisabled: true,
    modeDisabledReason: "Loading folder metadata",
    removeDisabled: false,
    removeDisabledReason: null,
    removePending: false,
    onSelectMode: () => undefined,
    onEmit: () => undefined,
    onLocate: null,
    onMakePrimary: () => undefined,
    onRemove: input.onRemove,
  };
}

function summaryForResolvedFolder(
  entry: ResolvedFolder,
  summariesByPath: ReadonlyMap<string, WorktreeWorkspaceSummaryV15>,
): WorktreeWorkspaceSummaryV15 | null {
  const summary = summariesByPath.get(entry.path) ?? null;
  if (summary === null) return null;
  const repoIdentifier = repoIdentifierForResolvedFolder(entry);
  if (repoIdentifier === null) return summary;
  return { ...summary, repoIdentifier };
}

function repoIdentifierForResolvedFolder(
  entry: ResolvedFolder,
): WorktreeWorkspaceSummaryV15["repoIdentifier"] {
  return entry.kind === "local-only" ? null : entry.repoIdentifier;
}

function branchForSummary(
  summary: WorktreeWorkspaceSummaryV15 | null,
): string | null {
  if (summary === null) return null;
  const mainEntry = summary.worktrees.find((w) => w.isMain) ?? null;
  return mainEntry?.branch ?? summary.mainBranch ?? null;
}

// Terminal-agent add/remove can commit to the binding before the explicit "Update" resumes the PTY.
type FolderEditorState = {
  readonly dirtyPathsSinceResume: ReadonlySet<string>;
  readonly pendingRemovedPaths: ReadonlySet<string>;
};
type FolderEditorAction =
  | {
      readonly type: "markDirty";
      readonly workspacePaths: ReadonlyArray<string>;
    }
  | { readonly type: "stageRemoval"; readonly workspacePath: string }
  | { readonly type: "unstageRemoval"; readonly workspacePath: string }
  | { readonly type: "discardStaged" }
  | { readonly type: "resumed" };
function folderEditorReducer(
  state: FolderEditorState,
  action: FolderEditorAction,
): FolderEditorState {
  switch (action.type) {
    case "markDirty": {
      if (action.workspacePaths.length === 0) return state;
      const next = new Set([
        ...state.dirtyPathsSinceResume,
        ...action.workspacePaths,
      ]);
      return next.size === state.dirtyPathsSinceResume.size
        ? state
        : { ...state, dirtyPathsSinceResume: next };
    }
    case "stageRemoval": {
      if (state.pendingRemovedPaths.has(action.workspacePath)) return state;
      return {
        ...state,
        pendingRemovedPaths: new Set([
          ...state.pendingRemovedPaths,
          action.workspacePath,
        ]),
      };
    }
    case "unstageRemoval": {
      if (!state.pendingRemovedPaths.has(action.workspacePath)) return state;
      const next = new Set(state.pendingRemovedPaths);
      next.delete(action.workspacePath);
      return { ...state, pendingRemovedPaths: next };
    }
    case "discardStaged":
      // Terminal add/remove commits the binding immediately and marks dirty without resume.
      if (state.pendingRemovedPaths.size === 0) return state;
      return {
        ...state,
        pendingRemovedPaths: new Set<string>(),
      };
    case "resumed":
      return {
        dirtyPathsSinceResume: new Set<string>(),
        pendingRemovedPaths: new Set<string>(),
      };
  }
}
interface InEpicSurfaceProps {
  readonly surface: BoundOwnerSurface;
  readonly hostLabel: string;
  readonly activeHostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
}

// eslint-disable-next-line complexity
// Coordinates host-bound folder metadata, staged worktree edits, add/remove
function InEpicSurface(props: InEpicSurfaceProps) {
  const { surface } = props;
  const hostOptions = useHostOptions();
  const pickerHosts =
    props.activeHostId === null ||
    findHostOption(hostOptions.hosts, props.activeHostId) !== null
      ? hostOptions.hosts
      : [
          unavailableHostOption(props.activeHostId, props.hostLabel),
          ...hostOptions.hosts,
        ];
  const [editor, dispatchEditor] = useReducer(folderEditorReducer, {
    dirtyPathsSinceResume: new Set<string>(),
    pendingRemovedPaths: new Set<string>(),
  });
  const ownerKind: WorktreeBindingOwnerKind =
    surface.kind === "chat" ? "chat" : "terminal-agent";
  const setEntryModeMutation = useWorktreeSetEntryModeForClient(
    props.hostClient,
  );
  const importMutation = useWorktreeImportForClient(props.hostClient);
  const worktreeCreateMutation = useWorktreeCreateForClient(props.hostClient, [
    "WORKTREE_REBIND_BLOCKED",
  ]);
  const worktreeCreatePending = worktreeCreateMutation.isPending;
  const snapshotOwnerTeardown = useOwnerTeardownSnapshot({
    epicId: surface.epicId,
    hostId: surface.hostId,
    ownerKind,
    ownerId: surface.ownerId,
    ownerLabel: surface.ownerLabel,
    hasActiveTurn: surface.hasActiveTurn,
    ptyLive: surface.kind === "terminal-agent" && surface.isOwnerActive,
  });
  const stopManagedCommand = useManagedCommandStop();
  const stopAgent = useAgentStop();
  const [teardownDialog, setTeardownDialog] = useState<{
    readonly choice: TeardownCommitChoice;
    readonly holders: readonly WorktreeBusyHolder[];
    readonly capture: WorktreeCommitCapture;
    readonly failures: Readonly<Record<string, string>>;
    readonly restoreRemovalOnDismiss: string | null;
    readonly restoreDraftOnDismiss: WorktreeFolderIntent | null;
    readonly refusalReason?: string;
  } | null>(null);
  const [teardownCommitPending, setTeardownCommitPending] = useState(false);
  const [commitRunPending, setCommitRunPending] = useState(false);
  const teardownRunIdRef = useRef(0);
  const removeBindingEntryMutation = useWorkspaceBindingRemoveEntryForClient(
    props.hostClient,
  );
  const addFolderMutation = useWorkspaceBindingAddFolderForClient(
    props.hostClient,
  );
  const addBindingFolder = addFolderMutation.mutateAsync;
  const recordRecentWorkspace = useWorkspaceRecordRecentWorkspace({
    client: props.hostClient,
  }).mutate;
  const pendingRemovePaths = usePendingRemoveBindingEntryPaths({
    epicId: surface.epicId,
    ownerId: surface.ownerId,
    ownerKind,
  });
  const folderActions = useWorkspaceFolderActionsForClient(props.hostClient);
  const bindingEntries = surface.binding?.entries ?? EMPTY_BINDING_ENTRIES;
  // Anti-revert - render this owner's binding entries only; never an epic-wide base set. Do not reintroduce an
  // epic-wide source or merge here.
  const bindingWorkspacePaths = useMemo(
    () =>
      Array.from(new Set(bindingEntries.map((entry) => entry.workspacePath))),
    [bindingEntries],
  );
  const metadataQuery = useWorktreeListByWorkspacePathsForClient(
    props.hostClient,
    { workspacePaths: bindingWorkspacePaths, enabled: true },
  );
  const metadataSummaries =
    metadataQuery.data?.workspaces ?? EMPTY_WORKSPACE_SUMMARIES;
  // Adjacent to the query ON purpose - see the landing surface's copy: the forced response is written into that
  // query's cache entry, whose key includes this exact path list.
  const summariesRefresh = useWorktreeWorkspacesRefresh({
    client: props.hostClient,
    workspacePaths: bindingWorkspacePaths,
    summaries: metadataSummaries,
  });
  const summariesByPath = useMemo(
    () => new Map(metadataSummaries.map((ws) => [ws.workspacePath, ws])),
    [metadataSummaries],
  );
  /** Listing reads are served from the host's cache, so an unresolved row (`resolvedAt === null`) carries schema
   * defaults rather than disk truth. */
  const resolvedSummariesByPath = useMemo(
    () =>
      new Map([...summariesByPath].filter(([, ws]) => ws.resolvedAt !== null)),
    [summariesByPath],
  );
  // `isLoading` (not `isPending`): a disabled query - empty binding, so no paths to fetch - is `isPending` in v5
  // but never actually loading, so guard on the active first fetch only.
  const metadataPending = props.hostClient !== null && metadataQuery.isLoading;
  const [lastResolvedByPath, setLastResolvedByPath] = useState<
    ReadonlyMap<string, WorktreeWorkspaceSummaryV15>
  >(() => new Map());
  const rememberedByPath = rememberResolvedSummaries(
    lastResolvedByPath,
    summariesByPath,
    bindingEntries,
  );
  if (rememberedByPath !== lastResolvedByPath) {
    setLastResolvedByPath(rememberedByPath);
  }
  const workspaces = useMemo<ReadonlyArray<WorktreeWorkspaceSummaryV15>>(
    () =>
      bindingEntries.map((entry) =>
        lastResolvedWorkspaceSummary(
          summariesByPath.get(entry.workspacePath),
          rememberedByPath.get(entry.workspacePath),
          workspaceSummaryFromBindingEntry(entry),
        ),
      ),
    [bindingEntries, rememberedByPath, summariesByPath],
  );

  // In-epic surfaces address their bound owner host (`props.activeHostId` is `surface.hostId` there), which is
  // also the host whose remembered defaults this picker may read and write.
  const ownerHostId = props.activeHostId;
  const rememberFolderIntent = useWorktreeIntentMemoryStore(
    (state) => state.setFolderIntent,
  );
  const setFolderIntent = useCallback(
    (intent: WorktreeFolderIntent, updatedAt: number): void => {
      rememberFolderIntent(ownerHostId, intent, updatedAt);
    },
    [ownerHostId, rememberFolderIntent],
  );
  const readFolderIntent = useWorktreeIntentMemoryStore(
    (state) => state.getFolderIntent,
  );
  const getFolderIntent = useCallback(
    (workspacePath: string): WorktreeFolderIntent | null =>
      readFolderIntent(ownerHostId, workspacePath),
    [ownerHostId, readFolderIntent],
  );

  // Mid-chat "Create new worktree" / existing-branch checkout stages the worktree instead of creating it now.
  const stageWorktreeIntent = useWorktreeIntentStagingStore(
    (s) => s.stageIntent,
  );
  const unstageWorktreeEntry = useWorktreeIntentStagingStore(
    (s) => s.unstageEntry,
  );
  const clearStagedWorktreeIntent = useWorktreeIntentStagingStore(
    (s) => s.clear,
  );
  const releaseIntentForDispatch = useWorktreeIntentStagingStore(
    (s) => s.releaseIntentForDispatch,
  );
  const stagedKey = useMemo<WorktreeStagingKey>(
    () => ({
      surface: "owner",
      hostId: ownerHostId,
      epicId: surface.epicId,
      ownerKind,
      ownerId: surface.ownerId,
    }),
    [ownerHostId, surface.epicId, ownerKind, surface.ownerId],
  );
  const stagedIntent = useWorktreeIntentStagingStore(
    (s) => s.intentByKey[worktreeStagingKeyString(stagedKey)],
  );
  // Once send consumes that choice, the chat session keeps its captured copy visible until the existing
  // pending/accepted action lifecycle retires it.
  const setSuspendedWorkspacePaths = useWorktreeIntentStagingStore(
    (state) => state.setSuspendedWorkspacePaths,
  );
  const unresolvedMetadataPaths = useMemo(
    () =>
      bindingWorkspacePaths.filter((path) => {
        const summary = summariesByPath.get(path);
        return summary === undefined || summary.resolvedAt === null;
      }),
    [bindingWorkspacePaths, summariesByPath],
  );
  useLayoutEffect(() => {
    setSuspendedWorkspacePaths(stagedKey, unresolvedMetadataPaths);
  }, [setSuspendedWorkspacePaths, stagedKey, unresolvedMetadataPaths]);
  const stagedEntryByPath = useMemo(() => {
    const map = new Map<string, WorktreeFolderIntent>();
    if (stagedIntent === undefined) return map;
    for (const entry of stagedIntent.entries) {
      map.set(entry.workspacePath, entry);
    }
    return map;
  }, [stagedIntent]);
  const visibleEntryByPath = useMemo(() => {
    const map = new Map<string, WorktreeFolderIntent>();
    for (const entry of surface.inFlightWorktreeIntent?.entries ?? []) {
      map.set(entry.workspacePath, entry);
    }
    // A live re-pick supersedes only its own folder. The remainder of a multi-folder dispatched intent stays
    // visible until that dispatch resolves; dispatch capture itself continues reading stagedIntent only.
    for (const entry of stagedIntent?.entries ?? []) {
      map.set(entry.workspacePath, entry);
    }
    return map;
  }, [stagedIntent, surface.inFlightWorktreeIntent]);
  const pendingBranchByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of visibleEntryByPath.values()) {
      if (entry.kind === "worktree" && entry.branch.name.length > 0) {
        map.set(entry.workspacePath, entry.branch.name);
      }
    }
    return map;
  }, [visibleEntryByPath]);
  const gitWorkspaces = useMemo(
    () => workspaces.filter((ws) => ws.resolvedAt !== null && ws.isGitRepo),
    [workspaces],
  );
  const worktreeBranchPrefix = useSettingsStore((s) => s.worktreeBranchPrefix);
  const defaultBranchByPath = useMemo(
    () =>
      buildDefaultBranchByPath(
        gitWorkspaces,
        gitWorkspaces.length > 1,
        worktreeBranchPrefix,
      ),
    [gitWorkspaces, worktreeBranchPrefix],
  );
  const onBindingCommitted = surface.onBindingCommitted;
  const handleBindingCommitted = useCallback(
    (changedWorkspacePaths: ReadonlyArray<string>): void => {
      if (onBindingCommitted === null) return;
      onBindingCommitted(changedWorkspacePaths);
    },
    [onBindingCommitted],
  );

  // Held in a ref (written by the add handler, read only by the effect below - never rendered) so it doesn't fan
  // out renders.
  const pendingDefaultPathsRef = useRef(new Set<string>());

  // Reads the live staged intent at click time so it never applies a stale closure.
  const hasStagedFolderChanges =
    stagedIntent !== undefined && stagedIntent.entries.length > 0;
  const changedWorkspacePathsSinceResume = useMemo<ReadonlySet<string>>(() => {
    if (
      stagedEntryByPath.size === 0 &&
      editor.dirtyPathsSinceResume.size === 0
    ) {
      return editor.dirtyPathsSinceResume;
    }
    return new Set([
      ...editor.dirtyPathsSinceResume,
      ...stagedEntryByPath.keys(),
    ]);
  }, [editor.dirtyPathsSinceResume, stagedEntryByPath]);
  const visibleMissingWorktreePaths = effectiveMissingWorktreePaths(
    surface.missingWorktreePaths,
    changedWorkspacePathsSinceResume,
  );
  const readLiveCommitCapture = useCallback((): WorktreeCommitCapture => {
    const draft = readStagedWorktreeIntent(stagedKey);
    const removedWorkspacePaths = [...editor.pendingRemovedPaths];
    const snapshot = snapshotOwnerTeardown(
      droppedRunDirectoriesFromDraft({
        binding: surface.binding,
        draft,
        removedWorkspacePaths,
      }),
    );
    return {
      draft,
      revision: stagedWorktreeIntentRevision(stagedKey),
      binding: surface.binding,
      removedWorkspacePaths,
      stopTargets: snapshot.stopTargets,
    };
  }, [
    editor.pendingRemovedPaths,
    snapshotOwnerTeardown,
    stagedKey,
    surface.binding,
  ]);
  const applyStagedFoldersAndResume = useCallback(
    (
      capture: WorktreeCommitCapture,
      isCancelled: () => boolean = () => false,
    ): void => {
      const settleRun = (): void => {
        setCommitRunPending(false);
      };
      if (isCancelled()) {
        settleRun();
        return;
      }
      if (
        capture.draft !== null &&
        stagedWorktreeIntentIsSuspended(stagedKey)
      ) {
        settleRun();
        return;
      }
      const stagedEntries = capture.draft?.entries ?? [];
      const removedWorkspacePaths = capture.removedWorkspacePaths;
      // Keep Update enabled, but don't resume until those pending defaults either stage or resolve as no-op.
      if (pendingDefaultPathsRef.current.size > 0) {
        settleRun();
        return;
      }
      if (
        stagedEntries.length === 0 &&
        editor.dirtyPathsSinceResume.size === 0 &&
        removedWorkspacePaths.length === 0
      ) {
        settleRun();
        return;
      }
      setCommitRunPending(true);
      const changedWorkspacePaths = Array.from(
        new Set([
          ...editor.dirtyPathsSinceResume,
          ...stagedEntries.map((entry) => entry.workspacePath),
          ...removedWorkspacePaths,
        ]),
      );
      const committedRemovalPaths: string[] = [];
      const finishAndResume = (): void => {
        // Cancellation may suppress further staged intent from this run, never
        // the acknowledgment of a host mutation that already committed.
        if (capture.draft !== null) {
          releaseIntentForDispatch(stagedKey, capture.revision);
        }
        if (!isCancelled()) {
          dispatchEditor({ type: "resumed" });
          handleBindingCommitted(changedWorkspacePaths);
          return;
        }
        const committed = Array.from(
          new Set([
            ...committedRemovalPaths,
            ...stagedEntries.map((entry) => entry.workspacePath),
          ]),
        );
        if (committed.length > 0) {
          handleBindingCommitted(committed);
        }
      };
      const createThenResume = (): void => {
        if (isCancelled()) {
          if (committedRemovalPaths.length > 0) {
            handleBindingCommitted(committedRemovalPaths);
          }
          settleRun();
          return;
        }
        if (stagedEntries.length === 0) {
          finishAndResume();
          settleRun();
          return;
        }
        void worktreeCreateMutation
          .mutateAsync({
            epicId: surface.epicId,
            ownerId: surface.ownerId,
            ownerKind,
            entries: worktreeCreateEntries(stagedEntries),
          })
          .then((result) => {
            applyWorktreeCreateResult({
              stagedEntries,
              changedWorkspacePaths,
              perEntry: result.perEntry,
              actions: {
                finishAndResume,
                unstageEntry: (workspacePath) =>
                  unstageWorktreeEntry(stagedKey, workspacePath),
                commitPaths: handleBindingCommitted,
                showPartialFailure: (message) =>
                  reportableErrorToast(message, undefined, {
                    title: "Workspace update incomplete",
                    message: null,
                    code: null,
                    source: "Worktree update",
                  }),
              },
            });
            trackUserInitiatedWorktreeWrite(stagedEntries, result);
            settleRun();
          })
          .catch((error: unknown) => {
            settleRun();
            if (isCancelled()) return;
            if (!isWorktreeRebindBlocked(error)) return;
            const live = readLiveCommitCapture();
            const dropped = droppedRunDirectoriesFromDraft({
              binding: live.binding,
              draft: live.draft,
              removedWorkspacePaths: live.removedWorkspacePaths,
            });
            const blocked = snapshotOwnerTeardown(dropped);
            setTeardownDialog({
              choice: "blocked",
              holders: blocked.holders,
              capture: { ...live, stopTargets: blocked.stopTargets },
              failures: {},
              restoreRemovalOnDismiss: null,
              restoreDraftOnDismiss: null,
            });
          });
      };
      if (removedWorkspacePaths.length === 0) {
        createThenResume();
        return;
      }
      void removedWorkspacePaths
        .reduce(
          (prior, workspacePath) =>
            prior.then(() => {
              if (isCancelled()) return;
              return removeBindingEntryMutation
                .mutateAsync({
                  epicId: surface.epicId,
                  ownerId: surface.ownerId,
                  ownerKind,
                  workspacePath,
                })
                .then(() => {
                  pendingDefaultPathsRef.current.delete(workspacePath);
                  unstageWorktreeEntry(stagedKey, workspacePath);
                  committedRemovalPaths.push(workspacePath);
                });
            }),
          Promise.resolve(),
        )
        .then(() => {
          if (isCancelled()) {
            if (committedRemovalPaths.length > 0) {
              handleBindingCommitted(committedRemovalPaths);
            }
            settleRun();
            return;
          }
          createThenResume();
        })
        .catch((error: unknown) => {
          if (committedRemovalPaths.length > 0) {
            handleBindingCommitted(committedRemovalPaths);
            for (const path of committedRemovalPaths) {
              dispatchEditor({ type: "unstageRemoval", workspacePath: path });
            }
          }
          settleRun();
          if (isCancelled()) return;
          if (committedRemovalPaths.length >= removedWorkspacePaths.length) {
            return;
          }
          const failedPath =
            removedWorkspacePaths[committedRemovalPaths.length];
          reportableErrorToast(
            folderRemovalFailureMessage(failedPath, error),
            undefined,
            {
              title: "Workspace update incomplete",
              message: null,
              code: null,
              source: "Worktree update",
            },
          );
        });
    },
    [
      editor.dirtyPathsSinceResume,
      worktreeCreateMutation,
      removeBindingEntryMutation,
      readLiveCommitCapture,
      surface.epicId,
      surface.ownerId,
      ownerKind,
      stagedKey,
      releaseIntentForDispatch,
      unstageWorktreeEntry,
      handleBindingCommitted,
      snapshotOwnerTeardown,
    ],
  );
  const requestStagedFolderCommit = useCallback((): void => {
    const capture = readLiveCommitCapture();
    const snapshot = snapshotOwnerTeardown(
      droppedRunDirectoriesFromDraft({
        binding: capture.binding,
        draft: capture.draft,
        removedWorkspacePaths: capture.removedWorkspacePaths,
      }),
    );
    if (snapshot.holders.length === 0) {
      const runId = ++teardownRunIdRef.current;
      applyStagedFoldersAndResume(
        capture,
        () => teardownRunIdRef.current !== runId,
      );
      return;
    }
    setTeardownDialog({
      choice: "commit",
      holders: snapshot.holders,
      capture: { ...capture, stopTargets: snapshot.stopTargets },
      failures: {},
      restoreRemovalOnDismiss: null,
      restoreDraftOnDismiss: null,
    });
  }, [
    applyStagedFoldersAndResume,
    readLiveCommitCapture,
    snapshotOwnerTeardown,
  ]);
  // Terminal-agent add/remove commit to the binding but deliberately do not resume - only the explicit "Update"
  // does.
  const markBindingDirtyWithoutResume = useCallback(
    (workspacePaths: ReadonlyArray<string>): void => {
      dispatchEditor({ type: "markDirty", workspacePaths });
    },
    [],
  );
  const stageFolderRemoval = useCallback(
    (workspacePath: string): void => {
      pendingDefaultPathsRef.current.delete(workspacePath);
      unstageWorktreeEntry(stagedKey, workspacePath);
      dispatchEditor({ type: "stageRemoval", workspacePath });
    },
    [stagedKey, unstageWorktreeEntry],
  );
  const discardStagedFolders = useCallback((): void => {
    // Same per-run token as Cancel: an in-flight captured create must not
    // apply/resurrect the choice the user just abandoned.
    teardownRunIdRef.current += 1;
    setTeardownCommitPending(false);
    setTeardownDialog(null);
    clearStagedWorktreeIntent(stagedKey);
    dispatchEditor({ type: "discardStaged" });
  }, [clearStagedWorktreeIntent, stagedKey]);
  // Phase-1 GUI-composed teardown: stop disclosed owner-scoped holders (managed-command stop, agent.stop) before
  // removeBindingEntry / worktree.create.
  const confirmImmediateCommit = useCallback(async (): Promise<void> => {
    const dialog = teardownDialog;
    if (dialog === null || teardownCommitPending) return;
    const live = readLiveCommitCapture();
    if (
      dialog.choice !== "remove" &&
      worktreeCommitCaptureIsStale(dialog.capture, live)
    ) {
      setTeardownDialog(null);
      requestStagedFolderCommit();
      return;
    }
    const refusal = stagedCommitRefusalReason({
      capture: dialog.capture,
      stagedKey,
      pendingDefaultPathCount: pendingDefaultPathsRef.current.size,
      dirtyPathCount: editor.dirtyPathsSinceResume.size,
    });
    if (refusal !== null) {
      setTeardownDialog({ ...dialog, refusalReason: refusal });
      return;
    }
    const runId = ++teardownRunIdRef.current;
    setTeardownCommitPending(true);
    setCommitRunPending(true);
    const isCancelled = (): boolean => teardownRunIdRef.current !== runId;
    const failures = await runGuiComposedTeardown({
      stopTargets: dialog.capture.stopTargets,
      stopShell: (commandId) =>
        stopManagedCommand.mutateAsync({
          hostId: surface.hostId,
          epicId: surface.epicId,
          commandId,
        }),
      stopTurn: () =>
        stopAgent.mutateAsync({
          epicId: surface.epicId,
          agentId: surface.ownerId,
          cascade: false,
        }),
      isCancelled,
    });
    if (isCancelled()) {
      setCommitRunPending(false);
      return;
    }
    setTeardownCommitPending(false);
    if (failures.length > 0) {
      setCommitRunPending(false);
      setTeardownDialog({
        ...dialog,
        failures: failuresByHolderKey(failures),
      });
      return;
    }
    setTeardownDialog(null);
    applyStagedFoldersAndResume(dialog.capture, isCancelled);
  }, [
    applyStagedFoldersAndResume,
    readLiveCommitCapture,
    requestStagedFolderCommit,
    stopAgent,
    stopManagedCommand,
    surface.epicId,
    surface.hostId,
    surface.ownerId,
    teardownCommitPending,
    teardownDialog,
    stagedKey,
    editor.dirtyPathsSinceResume,
  ]);
  const removeFolderNow = useCallback(
    (workspacePath: string): void => {
      removeBindingEntryMutation.mutate(
        {
          epicId: surface.epicId,
          ownerId: surface.ownerId,
          ownerKind,
          workspacePath,
        },
        {
          onSuccess: () => {
            pendingDefaultPathsRef.current.delete(workspacePath);
            unstageWorktreeEntry(stagedKey, workspacePath);
            if (surface.kind === "terminal-agent") {
              markBindingDirtyWithoutResume([workspacePath]);
              return;
            }
            handleBindingCommitted([workspacePath]);
          },
        },
      );
    },
    [
      handleBindingCommitted,
      markBindingDirtyWithoutResume,
      ownerKind,
      removeBindingEntryMutation,
      stagedKey,
      surface.epicId,
      surface.kind,
      surface.ownerId,
      unstageWorktreeEntry,
    ],
  );
  const requestChatFolderRemoval = useCallback(
    (workspacePath: string): void => {
      const snapshot = snapshotOwnerTeardown(
        droppedRunDirectoriesFromDraft({
          binding: surface.binding,
          draft: null,
          removedWorkspacePaths: [workspacePath],
        }),
      );
      if (snapshot.holders.length === 0) {
        removeFolderNow(workspacePath);
        return;
      }
      const priorDraft = stagedEntryByPath.get(workspacePath) ?? null;
      stageFolderRemoval(workspacePath);
      setTeardownDialog({
        choice: "remove",
        holders: snapshot.holders,
        capture: {
          draft: null,
          revision: stagedWorktreeIntentRevision(stagedKey),
          binding: surface.binding,
          removedWorkspacePaths: [workspacePath],
          stopTargets: snapshot.stopTargets,
        },
        failures: {},
        restoreRemovalOnDismiss: workspacePath,
        restoreDraftOnDismiss: priorDraft,
      });
    },
    [
      removeFolderNow,
      snapshotOwnerTeardown,
      stageFolderRemoval,
      stagedEntryByPath,
      stagedKey,
      surface.binding,
    ],
  );
  useEffect(() => {
    const pending = pendingDefaultPathsRef.current;
    if (pending.size === 0) return;
    for (const path of [...pending]) {
      const summary = resolvedSummariesByPath.get(path) ?? null;
      if (summary === null) continue; // unresolved or not loaded yet - wait
      pending.delete(path);
      if (!summary.isGitRepo) continue;
      if (stagedEntryByPath.has(path)) continue;
      const bindingEntry = findBindingEntry(surface.binding, path);
      if (bindingEntry?.mode === "worktree") continue;
      if (getFolderIntent(path)?.kind === "local") continue;
      const intent = defaultFolderIntent({
        workspacePath: path,
        repoIdentifier: summary.repoIdentifier,
        isPrimary: bindingEntry?.isPrimary ?? false,
        isGitRepo: true,
        currentBranch: branchForSummary(summary),
        defaultNewBranchName: (
          defaultBranchByPath[path] ?? EMPTY_DEFAULT_BRANCH
        ).name,
      });
      if (intent.kind === "worktree") {
        // Stage the new git folder's default worktree for both owner kinds.
        stageWorktreeIntent(stagedKey, { entries: [intent] });
      }
    }
  }, [
    resolvedSummariesByPath,
    stagedEntryByPath,
    surface.binding,
    getFolderIntent,
    defaultBranchByPath,
    stageWorktreeIntent,
    stagedKey,
  ]);

  // Chats are host-bound for life (clone-not-migrate), so picking another host here means forking onto it: the
  // owning tile opens its fork dialog anchored at the chat's latest completed turn.
  const handleSelectHostForChat = (hostId: string): void => {
    if (hostId === props.activeHostId) return;
    if (surface.onForkOnHost === null) return;
    surface.onForkOnHost(hostId);
  };

  const activeRunNotice = activeRunNoticeFor(
    surface.kind,
    surface.hasActiveTurn,
  );
  const activeRunLocksBinding =
    surface.kind === "chat" && surface.isOwnerActive;
  const activeRunLocksBindingRef = useRef(activeRunLocksBinding);
  useLayoutEffect(() => {
    activeRunLocksBindingRef.current = activeRunLocksBinding;
  }, [activeRunLocksBinding]);

  const activatePreparedFoldersForOwner = useCallback(
    async (
      folders: ReadonlyArray<PreparedWorkspaceFolder>,
    ): Promise<ReadonlyArray<string>> => {
      const activePaths = new Set(bindingWorkspacePaths);
      const activatedPaths: string[] = [];
      const addedPaths: string[] = [];
      for (const folder of folders) {
        if (surface.kind === "chat" && activeRunLocksBindingRef.current) break;
        if (activePaths.has(folder.workspacePath)) {
          activatedPaths.push(folder.workspacePath);
          continue;
        }
        // oxlint-disable-next-line react-doctor/async-await-in-loop -- sequential is required: concurrent setEntryMode writes race on the single owner-binding row and lose folders.
        const added = await addBindingFolder({
          epicId: surface.epicId,
          ownerId: surface.ownerId,
          ownerKind,
          workspacePath: folder.workspacePath,
        })
          .then(() => true)
          .catch(() => false);
        if (!added) continue;
        pendingDefaultPathsRef.current.add(folder.workspacePath);
        activatedPaths.push(folder.workspacePath);
        addedPaths.push(folder.workspacePath);
      }
      if (addedPaths.length === 0) return activatedPaths;
      if (surface.kind === "terminal-agent") {
        markBindingDirtyWithoutResume(addedPaths);
      } else {
        handleBindingCommitted(addedPaths);
      }
      return activatedPaths;
    },
    [
      addBindingFolder,
      bindingWorkspacePaths,
      handleBindingCommitted,
      markBindingDirtyWithoutResume,
      ownerKind,
      surface.epicId,
      surface.kind,
      surface.ownerId,
    ],
  );

  // Free functions (not useCallback) matching HEAD: they close over render locals and are only invoked from
  // event handlers / item onLocate, never listed as memo deps that would thrash the items array.
  const addFoldersToOwnerBinding = async (): Promise<boolean> => {
    const result = await folderActions.pickAndPrepareFolders(false);
    if (result === null) return false;
    const activatedPaths = await activatePreparedFoldersForOwner(
      result.folders,
    );
    if (surface.kind === "chat") {
      for (const path of activatedPaths) {
        recordRecentWorkspace({
          path,
          bumpRecency: true,
          failureFeedback: "silent",
        });
      }
    }
    return activatedPaths.length > 0;
  };

  // One folder intent from the unified picker maps to the existing in-Epic semantics.
  const emitForFolder = useCallback(
    (ws: WorktreeWorkspaceSummaryV15) =>
      (intent: WorktreeFolderIntent): void => {
        if (ws.resolvedAt === null) return;
        if (intent.kind !== "local") {
          Analytics.getInstance().track(AnalyticsEvent.WorktreeSelected, {
            source: "direct_ui",
          });
        }
        // Persist the per-folder choice immediately (not at send) so it survives
        // a reload and seeds future adds of this folder.
        setFolderIntent(intent, Date.now());
        if (surface.kind === "terminal-agent" || surface.isOwnerActive) {
          // Draft: no host write.
          stageWorktreeIntent(stagedKey, { entries: [intent] });
          return;
        }
        if (intent.kind === "local") {
          unstageWorktreeEntry(stagedKey, ws.workspacePath);
          setEntryModeMutation.mutate(
            {
              epicId: surface.epicId,
              ownerId: surface.ownerId,
              ownerKind,
              workspacePath: ws.workspacePath,
            },
            { onSuccess: () => handleBindingCommitted([ws.workspacePath]) },
          );
          return;
        }
        if (intent.kind === "import") {
          unstageWorktreeEntry(stagedKey, ws.workspacePath);
          // Preserve the folder's current primary status instead of forcing it primary: adopting a worktree on a
          // secondary folder must not silently move the agent's primary run directory to that folder.
          const boundEntry = findBindingEntry(
            surface.binding,
            ws.workspacePath,
          );
          importMutation.mutate(
            {
              epicId: surface.epicId,
              ownerId: surface.ownerId,
              ownerKind,
              entries: [
                {
                  workspacePath: ws.workspacePath,
                  worktreePath: intent.worktreePath,
                  repoIdentifier: ws.repoIdentifier,
                  isPrimary: boundEntry?.isPrimary ?? true,
                },
              ],
            },
            {
              onSuccess: (result) => {
                handleBindingCommitted([ws.workspacePath]);
                trackUserInitiatedWorktreeWrite([intent], result);
              },
            },
          );
          return;
        }
        stageWorktreeIntent(stagedKey, { entries: [intent] });
      },
    [
      handleBindingCommitted,
      importMutation,
      ownerKind,
      setEntryModeMutation,
      setFolderIntent,
      stagedKey,
      stageWorktreeIntent,
      surface.binding,
      surface.epicId,
      surface.isOwnerActive,
      surface.kind,
      surface.ownerId,
      unstageWorktreeEntry,
    ],
  );

  // Everything a row needs before the `WorkspaceRunItem` is assembled, pulled out of the `.map` callback below
  // so that callback's own ESLint complexity count only has to cover assembling the item.
  const deriveInEpicRowState = useCallback(
    (ws: WorktreeWorkspaceSummaryV15) => {
      const entry = findBindingEntry(surface.binding, ws.workspacePath);
      const pendingNewBranch =
        pendingBranchByPath.get(ws.workspacePath) ?? null;
      const { mode: currentMode, label: modeLabel } = computeInEpicFolderMode({
        boundMode: entry?.mode ?? null,
        boundBranch: entry?.branch ?? null,
        pendingNewBranch,
      });
      const removePending = pendingRemovePaths.has(ws.workspacePath);
      const isPrimary = entry?.isPrimary ?? true;
      const stagedEntry = stagedEntryByPath.get(ws.workspacePath) ?? null;
      const visibleEntry = visibleEntryByPath.get(ws.workspacePath) ?? null;
      const currentIntent =
        visibleEntry ??
        bindingEntryToFolderIntent(entry, ws.repoIdentifier, isPrimary);
      const branchDefault =
        defaultBranchByPath[ws.workspacePath] ?? EMPTY_DEFAULT_BRANCH;
      const defaultNewBranchName = branchDefault.name;
      const branchPrefixWarning = branchDefault.warning;
      const currentBranch = branchForSummary(ws);
      const otherWorktrees = ws.worktrees.filter((w) => !w.isMain);
      const liveResolvedAt =
        summariesByPath.get(ws.workspacePath)?.resolvedAt ?? ws.resolvedAt;
      const rowMetadataPending = isRowMetadataPending(
        metadataPending,
        liveResolvedAt,
      );
      const rowIsGitRepo = ws.resolvedAt !== null && ws.isGitRepo;
      const branchLabel = workspaceRunBranchLabel({
        mode: currentMode,
        currentBranch,
        currentIntent,
        diskWorktrees: otherWorktrees,
      });
      return {
        currentMode,
        modeLabel,
        removePending,
        isPrimary,
        currentIntent,
        defaultNewBranchName,
        branchPrefixWarning,
        currentBranch,
        rowMetadataPending,
        rowIsGitRepo,
        branchLabel,
        stagedEntry,
        emit: emitForFolder(ws),
      };
    },
    [
      defaultBranchByPath,
      emitForFolder,
      metadataPending,
      pendingBranchByPath,
      pendingRemovePaths,
      stagedEntryByPath,
      summariesByPath,
      surface.binding,
      visibleEntryByPath,
    ],
  );

  const workspaceRunItems = useMemo<ReadonlyArray<WorkspaceRunItem>>(
    () =>
      workspaces
        .filter((ws) => !editor.pendingRemovedPaths.has(ws.workspacePath))
        .map((ws) => {
          const {
            currentMode,
            modeLabel,
            removePending,
            isPrimary,
            currentIntent,
            defaultNewBranchName,
            branchPrefixWarning,
            currentBranch,
            rowMetadataPending,
            rowIsGitRepo,
            branchLabel,
            stagedEntry,
            emit,
          } = deriveInEpicRowState(ws);
          // Presence is per-(host, path) display state - never stored on the binding. An absent path is not a non-git
          // folder; Locate REPLACes the dead path with a picked one (add-only left it blocking).
          if (ws.presence === "absent" && ws.resolvedAt !== null) {
            const base = unresolvedWorkspaceRunItem({
              path: ws.workspacePath,
              name: workspaceFolderName(ws.workspacePath),
              repoIdentifier: ws.repoIdentifier,
              hostLabel: props.hostLabel,
              isPrimary,
              onLocate: () => undefined,
              onMakePrimary: () => undefined,
              onRemove: () => undefined,
            });
            return {
              ...base,
              // Bound owner rows have no set-primary RPC.
              canChangePrimary: false,
              // An absent row is still a bound row: Locate adds and removes binding entries exactly like the normal
              // controls, so it takes the same active-run lock.
              removeDisabled: activeRunLocksBinding || removePending,
              removeDisabledReason: removeDisabledReasonFor(
                activeRunLocksBinding,
                activeRunNotice,
              ),
              onLocate: activeRunLocksBinding
                ? null
                : () => {
                    // Locate REPLACes only after ≥1 distinct add succeeds - never delete-first (empty pick / all-adds-fail would
                    // drop the entry).
                    void (async (): Promise<void> => {
                      const result =
                        await folderActions.pickAndPrepareFolders(false);
                      const outcome = await locateReplaceBoundFolder({
                        absentPath: ws.workspacePath,
                        pick: result,
                        add: async (workspacePath) => {
                          try {
                            await addFolderMutation.mutateAsync({
                              epicId: surface.epicId,
                              ownerId: surface.ownerId,
                              ownerKind,
                              workspacePath,
                            });
                            pendingDefaultPathsRef.current.add(workspacePath);
                            return true;
                          } catch {
                            return false;
                          }
                        },
                        remove: async (workspacePath) => {
                          try {
                            await removeBindingEntryMutation.mutateAsync({
                              epicId: surface.epicId,
                              ownerId: surface.ownerId,
                              ownerKind,
                              workspacePath,
                            });
                            pendingDefaultPathsRef.current.delete(
                              workspacePath,
                            );
                            unstageWorktreeEntry(stagedKey, workspacePath);
                            return true;
                          } catch {
                            return false;
                          }
                        },
                      });
                      if (
                        outcome.kind !== "replaced" &&
                        outcome.kind !== "replaced-stale-entry"
                      ) {
                        return;
                      }
                      // A retained path is still bound, so it is not "touched" by a commit that did not move it - the absent row
                      // stays put and stays retryable.
                      const touchedPaths =
                        outcome.kind === "replaced"
                          ? [outcome.removedPath, ...outcome.addedPaths]
                          : [...outcome.addedPaths];
                      if (surface.kind === "terminal-agent") {
                        markBindingDirtyWithoutResume(touchedPaths);
                      } else {
                        handleBindingCommitted(touchedPaths);
                      }
                    })();
                  },
              onRemove: () => {
                if (activeRunLocksBinding || removePending) return;
                if (surface.kind === "terminal-agent") {
                  stageFolderRemoval(ws.workspacePath);
                  return;
                }
                requestChatFolderRemoval(ws.workspacePath);
              },
            };
          }
          return {
            key: ws.workspacePath,
            displayName: workspaceFolderName(ws.workspacePath),
            displayPath: ws.workspacePath,
            unresolved: false,
            metadataPending: rowMetadataPending,
            missing: visibleMissingWorktreePaths.includes(ws.workspacePath),
            isGitRepo: rowIsGitRepo,
            mode: currentMode,
            branchLabel:
              currentMode === "local"
                ? (currentBranch ?? modeLabel)
                : branchLabel,
            summary: ws,
            currentIntent,
            defaultNewBranchName,
            branchPrefixWarning,
            repoIdentifier: ws.repoIdentifier,
            isPrimary,
            // Bound owner rows (chat / terminal-agent) have no atomic set-primary RPC yet.
            canChangePrimary: false,
            makePrimaryDisabled: false,
            makePrimaryDisabledReason: null,
            hostClient: props.hostClient,
            // Snapshot fetch (isLoading / unresolved cache defaults) must never gate selection - the draft picker's first
            // principle. Binding-derived mode/branch stay editable; the chip spinner is the only in-flight affordance.
            modeDisabled: false,
            modeDisabledReason: null,
            hasStagedIntent: stagedEntry !== null,
            // No last-folder guard - see the absent-row branch above.
            removeDisabled: activeRunLocksBinding || removePending,
            removeDisabledReason: removeDisabledReasonFor(
              activeRunLocksBinding,
              activeRunNotice,
            ),
            removePending,
            onEmit: emit,
            onMakePrimary: () => undefined,
            onSelectMode: (nextMode) => {
              emitRowMode({
                currentBranch,
                currentIntent,
                defaultNewBranchName,
                emit,
                isGitRepo: rowIsGitRepo,
                isPrimary,
                mode: currentMode,
                nextMode,
                repoIdentifier: ws.repoIdentifier,
                workspacePath: ws.workspacePath,
              });
            },
            onLocate: null,
            onRemove: () => {
              if (removePending) return;
              if (surface.kind === "terminal-agent") {
                stageFolderRemoval(ws.workspacePath);
                return;
              }
              requestChatFolderRemoval(ws.workspacePath);
            },
          };
        }),
    [
      activeRunNotice,
      activeRunLocksBinding,
      addFolderMutation,
      deriveInEpicRowState,
      folderActions,
      editor.pendingRemovedPaths,
      handleBindingCommitted,
      markBindingDirtyWithoutResume,
      requestChatFolderRemoval,
      stageFolderRemoval,
      stagedKey,
      unstageWorktreeEntry,
      props.hostClient,
      props.hostLabel,
      removeBindingEntryMutation,
      surface.epicId,
      surface.kind,
      surface.ownerId,
      ownerKind,
      visibleMissingWorktreePaths,
      workspaces,
    ],
  );

  const recentWorkspaces = useRecentWorkspaces({
    client: props.hostClient,
    hostId: props.activeHostId,
    activePaths: bindingWorkspacePaths,
    activatePreparedFolders: activatePreparedFoldersForOwner,
    disabled:
      surface.kind !== "chat" ||
      activeRunLocksBinding ||
      !surface.bindingResolved,
    surface: stagedKey.surface,
  });
  const {
    moveToRecent: moveBoundWorkspaceToRecent,
    movingPath: recentWorkspacesMovingPath,
    supported: recentWorkspacesSupported,
  } = recentWorkspaces;
  const recentAwareWorkspaceRunItems = useMemo<ReadonlyArray<WorkspaceRunItem>>(
    () =>
      workspaceRunItems.map((item) => {
        if (!recentWorkspacesSupported || item.onRemove === null) return item;
        const removeFromBinding = item.onRemove;
        return {
          ...item,
          removePending:
            item.removePending ||
            recentWorkspacesMovingPath === item.displayPath,
          onRemove: () => {
            if (activeRunLocksBindingRef.current) return;
            void moveBoundWorkspaceToRecent(item.displayPath).then((moved) => {
              if (moved && !activeRunLocksBindingRef.current) {
                removeFromBinding();
              }
            });
          },
        };
      }),
    [
      moveBoundWorkspaceToRecent,
      recentWorkspacesMovingPath,
      recentWorkspacesSupported,
      workspaceRunItems,
    ],
  );
  const recentWorkspacesSection = recentWorkspacesSupported ? (
    <RecentWorkspacesSection
      entries={recentWorkspaces.entries}
      activeCount={bindingWorkspacePaths.length}
      pendingPath={recentWorkspaces.pendingPath}
      failedPaths={recentWorkspaces.failedPaths}
      onAdd={recentWorkspaces.add}
      onLocate={recentWorkspaces.locate}
      onForget={recentWorkspaces.forget}
    />
  ) : null;

  // Setup/teardown editor, hosted here so it outlives the popover.
  const [scriptsTargetPath, setScriptsTargetPath] = useState<string | null>(
    null,
  );
  const handleEditEnvironment = useCallback((path: string): void => {
    // Keep the picker open: the scripts modal stacks on top of it.
    Analytics.getInstance().track(AnalyticsEvent.SetupScriptsOpened, {
      source: "direct_ui",
    });
    setScriptsTargetPath(path);
  }, []);
  const scriptsTarget = useMemo<WorktreeScriptsTarget | null>(() => {
    if (scriptsTargetPath === null) return null;
    const summary = summariesByPath.get(scriptsTargetPath);
    if (summary === undefined) return null;
    return { workspacePath: scriptsTargetPath, summary };
  }, [scriptsTargetPath, summariesByPath]);
  const regenerateBranchNameForWorkspace = useCallback(
    (
      path: string,
      freshRepoBranchPrefix: RepoBranchPrefixState,
      suffix: string,
    ): string | null =>
      regenerateSingleWorkspaceBranchName({
        workspaces: gitWorkspaces,
        globalBranchPrefix: worktreeBranchPrefix,
        workspacePath: path,
        freshRepoBranchPrefix,
        suffix,
      }),
    [gitWorkspaces, worktreeBranchPrefix],
  );
  const scriptsContext = useMemo<WorktreeScriptsContext>(
    () => ({
      epicId: surface.epicId,
      ownerId: surface.ownerId,
      ownerKind,
      binding: surface.binding,
      stagingKey: stagedKey,
      hostClient: props.hostClient,
      regenerateBranchNameForWorkspace,
    }),
    [
      surface.epicId,
      surface.ownerId,
      surface.binding,
      ownerKind,
      stagedKey,
      props.hostClient,
      regenerateBranchNameForWorkspace,
    ],
  );

  // Edits never resume on their own (add/remove commit to the binding, location/ branch edits stage).
  const readOnly = false;
  const hostSwitcher = (
    <WorkspaceHostSwitcher
      hosts={pickerHosts}
      activeHostId={props.activeHostId}
      onSelect={handleSelectHostForChat}
      intent="pin"
      refusalByHostId={NO_HOST_OPTION_REFUSALS}
      inertExceptHostId={null}
      disabled={surface.kind === "terminal-agent"}
      isLoading={hostOptions.isLoading}
      listsFailed={hostOptions.listsFailed}
      onRetryLists={hostOptions.retryLists}
      surface="inline"
      keepFocusableWhenDisabled={surface.kind === "terminal-agent"}
    />
  );
  const hostSwitcherSlot = (
    <span className="flex w-full min-w-0">{hostSwitcher}</span>
  );

  return (
    <>
      <div className="flex w-full max-w-full min-w-0 flex-nowrap items-center gap-2 overflow-hidden">
        <div className="w-fit min-w-0 flex-[0_1_auto] max-w-[min(50%,50vw)] overflow-hidden">
          <TooltipWrapper
            label={
              surface.kind === "terminal-agent"
                ? "Terminal host is fixed"
                : undefined
            }
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            {hostSwitcherSlot}
          </TooltipWrapper>
        </div>
        <div className="min-w-0 flex-[1_1_auto] max-w-[min(100%,34rem)] overflow-hidden">
          <WorkspaceFolderSummaryControl
            items={recentAwareWorkspaceRunItems}
            readOnly={readOnly}
            bindingResolved={surface.bindingResolved}
            addFolderPending={
              folderActions.isPreparing ||
              addFolderMutation.isPending ||
              worktreeCreatePending
            }
            addFolderDisabled={activeRunLocksBinding}
            addFolderDisabledReason={
              activeRunLocksBinding ? activeRunNotice : null
            }
            onAddFolder={addFoldersToOwnerBinding}
            onUpdate={
              surface.kind === "terminal-agent"
                ? requestStagedFolderCommit
                : null
            }
            draftPending={
              hasStagedFolderChanges || editor.pendingRemovedPaths.size > 0
            }
            updateEnabled={
              hasStagedFolderChanges ||
              editor.dirtyPathsSinceResume.size > 0 ||
              editor.pendingRemovedPaths.size > 0
            }
            updatePending={worktreeCreatePending || commitRunPending}
            onDiscardStaged={discardStagedFolders}
            discardDisabled={commitRunPending || teardownCommitPending}
            onEditEnvironment={handleEditEnvironment}
            refresh={summariesRefresh}
            popoverTestId="workspace-rows-popover"
            recentWorkspaces={recentWorkspacesSection}
            recentWorkspaceCount={recentWorkspaces.entries.length}
            moveToRecent={recentWorkspacesSupported}
            // The terminal-agent toolbar is anchored at the top of its tile, so the editor must open downward into the
            // terminal body (plenty of room).
            popoverSide={surface.kind === "terminal-agent" ? "bottom" : "top"}
          />
        </div>
      </div>
      <WorktreeScriptsDialog
        open={scriptsTarget !== null}
        target={scriptsTarget}
        context={scriptsContext}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setScriptsTargetPath(null);
        }}
      />
      <TeardownCommitDialog
        open={teardownDialog !== null}
        choice={teardownDialog?.choice ?? null}
        holders={teardownDialog?.holders ?? []}
        failures={teardownDialog?.failures}
        immediatePending={teardownCommitPending}
        refusalReason={teardownDialog?.refusalReason}
        deferContext={surface.kind === "terminal-agent" ? "update" : "message"}
        onImmediate={() => {
          void confirmImmediateCommit();
        }}
        onDefer={() => {
          teardownRunIdRef.current += 1;
          setTeardownCommitPending(false);
          setCommitRunPending(false);
          const restore = teardownDialog?.restoreRemovalOnDismiss;
          if (restore !== null && restore !== undefined) {
            dispatchEditor({
              type: "unstageRemoval",
              workspacePath: restore,
            });
          }
          const restoreDraft = teardownDialog?.restoreDraftOnDismiss;
          if (restoreDraft !== null && restoreDraft !== undefined) {
            stageWorktreeIntent(stagedKey, { entries: [restoreDraft] });
          }
          setTeardownDialog(null);
        }}
        onDismiss={() => {
          teardownRunIdRef.current += 1;
          setTeardownCommitPending(false);
          setCommitRunPending(false);
          const restore = teardownDialog?.restoreRemovalOnDismiss;
          if (restore !== null && restore !== undefined) {
            dispatchEditor({
              type: "unstageRemoval",
              workspacePath: restore,
            });
          }
          const restoreDraft = teardownDialog?.restoreDraftOnDismiss;
          if (restoreDraft !== null && restoreDraft !== undefined) {
            stageWorktreeIntent(stagedKey, { entries: [restoreDraft] });
          }
          setTeardownDialog(null);
        }}
      />
    </>
  );
}

// No staged pick yet (`capturedEntry === null`): a git folder reflects the default (new worktree); a non-git
// folder can only be Local.
function folderRemovalFailureMessage(
  workspacePath: string,
  error: unknown,
): string {
  const folder = workspaceFolderName(workspacePath);
  const hostMessage =
    error instanceof Error && error.message.length > 0 ? error.message : null;
  const detail = hostMessage === null ? "" : ` (${hostMessage})`;
  return `Couldn't update "${folder}"${detail}. The change is still staged - press Update to retry.`;
}

function stagedCommitRefusalReason(input: {
  readonly capture: WorktreeCommitCapture;
  readonly stagedKey: WorktreeStagingKey;
  readonly pendingDefaultPathCount: number;
  readonly dirtyPathCount: number;
}): string | null {
  if (
    input.capture.draft !== null &&
    stagedWorktreeIntentIsSuspended(input.stagedKey)
  ) {
    return "This folder change is waiting on unresolved workspace setup.";
  }
  if (input.pendingDefaultPathCount > 0) {
    return "Wait for folder setup to finish before updating.";
  }
  const stagedEntries = input.capture.draft?.entries ?? [];
  if (
    stagedEntries.length === 0 &&
    input.dirtyPathCount === 0 &&
    input.capture.removedWorkspacePaths.length === 0
  ) {
    return "Nothing to apply.";
  }
  return null;
}

function deriveHomeRowMode(
  capturedEntry: WorktreeFolderIntent | null,
  isGitRepo: boolean,
): "local" | "worktree" {
  if (capturedEntry === null) {
    return isGitRepo ? "worktree" : "local";
  }
  return capturedEntry.kind === "local" ? "local" : "worktree";
}

function findBindingEntry(
  binding: WorktreeBinding | null,
  workspacePath: string,
): WorktreeBindingEntry | null {
  if (binding === null) return null;
  return (
    binding.entries.find((entry) => entry.workspacePath === workspacePath) ??
    null
  );
}

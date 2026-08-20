import { hostSelectRowRefused } from "./host-select-row-refused";
import { useRemoteSessionPollReadiness } from "@/hooks/agent/use-host-reachability";
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
import { HostSection } from "./host-section";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import {
  findHostOption,
  unavailableHostOption,
} from "@/components/settings/host-scope/host-scope-model";
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
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { useComposerSurfaceHostPin } from "@/hooks/host/use-composer-surface-host-pin";
import { useRefreshHostDirectoryOnOpen } from "@/hooks/host/use-refresh-host-directory-on-open";
import { useRemoteHostsPlanRestricted } from "@/hooks/host/use-remote-hosts-plan-gate";
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
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";
import { locateReplaceBoundFolder } from "./locate-replace-bound-folder";
import {
  useLocateAndReplaceWorkspaceFolder,
  usePickAndAddWorkspaceFolders,
} from "./use-pick-and-add-folders";
import {
  readStagedWorktreeIntent,
  stagedWorktreeIntentIsSuspended,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  hostWorkspaceControlsScopeHostId,
  hostWorkspaceControlsScopeRefusals,
  type HostWorkspaceControlsHostScope,
} from "./host-workspace-controls-scope";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
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
import { settingsHostOptionLabel } from "@/components/settings/panels/settings-host-labels";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { trackUserInitiatedWorktreeWrite } from "@/lib/worktree/user-worktree-analytics";
import { useRecentWorkspaces } from "./use-recent-workspaces";
import { RecentWorkspacesSection } from "./recent-workspaces-section";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
/**
 *
 *
 *
 *
 *
 *
 *
 * `home` swaps the bound directory; `chat` forks the chat on switch (chats
 * are host-bound for life, so "switching" means forking onto the picked
 * machine — the owning tile opens the fork dialog via `onForkOnHost`);
 * `terminal-agent` locks the host section because a PTY can't migrate, but
 * its folder binding can be edited; the owning tile restarts the PTY after a
 * committed binding write.
 *
 * For the file-tree panel see `FileTreeWorkspacePicker` (display-only
 * picker keyed by `[epicId, hostId]`); it does not share this surface
 * union because it has no owner binding to coordinate.
 */
type BoundOwnerSurface = {
  readonly kind: "chat" | "terminal-agent";
  readonly hostId: string;
  readonly epicId: string;
  readonly tabId: string;
  readonly ownerId: string;
  readonly binding: WorktreeBinding | null;
  readonly isOwnerActive: boolean;
  // Narrower than `isOwnerActive`: is the owner active specifically because
  // of a genuinely running/activating turn, as opposed to visible background
  // work (Bash `run_in_background` / a subagent / Monitor) outliving an
  // already-completed turn? Drives ONLY the disabled-remove tooltip wording -
  // `isOwnerActive` still decides whether removal is disabled at all (a live
  // background process could still be touching the folder either way).
  readonly hasActiveTurn: boolean;
  // The `workspacePath`s whose bound directory is gone on disk (host-computed,
  // delivered on the chat snapshot / `worktreeStateChanged` for chat and on
  // `worktree.getBinding` for terminal-agents). Drives the per-folder "missing"
  // indicator on the chip so BOTH owner kinds surface it the same way — the
  // host send / prepareLaunch reject is the actual run gate; this is the
  // proactive visual.
  readonly missingWorktreePaths: readonly string[];
  // Whether the owner's binding has been resolved yet (chat snapshot received /
  // `worktree.getBinding` settled). Lets the chip distinguish "still loading"
  // (spinner) from "resolved with no folders" (a folderless epic / degraded
  // host — a real terminal state, not an indefinite spinner).
  readonly bindingResolved: boolean;
  readonly onBindingCommitted:
    ((changedWorkspacePaths: ReadonlyArray<string>) => void) | null;
  /**
   * Chat-only: the owning tile's handler for the host picker's "switch host"
   * gesture. Chats are host-bound for life (clone-not-migrate), so switching
   * means forking — the tile opens its fork dialog anchored at the chat's
   * latest completed turn, preselected on `targetHostId`, or explains why it
   * can't yet (turn still running / no reply to fork). `null` for surfaces
   * that cannot fork at all (terminal agents), whose host section is locked.
   */
  readonly onForkOnHost: ((targetHostId: string) => void) | null;
};

const EMPTY_BINDING_ENTRIES: ReadonlyArray<WorktreeBindingEntry> = [];
// Stable identity for "the query has not answered yet", so the summaries array
// can be threaded straight into memos and the refresh hook without a fresh
// `[]` per render invalidating every one of them.
const EMPTY_WORKSPACE_SUMMARIES: ReadonlyArray<WorktreeWorkspaceSummaryV15> =
  [];

/**
 * Binding-entry → `WorktreeWorkspaceSummaryV15` fallback, rendered for a row until
 * `worktree.listByWorkspacePaths` returns the authoritative disk metadata. Git
 * details are inferred from the entry; the row shows a loading affordance
 * (`metadataPending`) while the real query is in flight, so this guess is never
 * presented as disk truth. (Moved here from the deleted `merge-owner-workspaces`
 * — the picker no longer merges an epic-wide base set.)
 *
 * `presence: "present"` with `resolvedAt: null` matches the wire rule for an
 * unverifiable path: keep the pending affordance, never invent an absence.
 */
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

export type HostWorkspaceSelectorSurface =
  | { readonly kind: "home"; readonly draftId: string | null }
  | BoundOwnerSurface;

interface HostWorkspaceSelectorProps {
  readonly surface: HostWorkspaceSelectorSurface;
  /** A draft create owns the snapshot until it settles. */
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
  // In-epic surfaces address their bound owner host. When that host is not
  // in the directory (unreachable / not yet discovered), do NOT fall back to
  // the active host's label - that would label the chip with one host while
  // every worktree operation runs against the (null) owner client. Show the
  // bound host's own label, or an explicit unavailable state once the
  // directory has loaded (during the initial load `hostLabel` is the neutral
  // "Local" default, not a specific active-host name).
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
      directoryEntries={directoryEntries}
    />
  );
}

interface HomeSurfaceProps {
  readonly draftId: string | null;
  readonly disabled: boolean;
}

function HomeSurface(props: HomeSurfaceProps) {
  // Must be the SAME host `ActiveHostWorkspaceControls` resolves for an
  // "active" scope below - the staged slot and the folder rows it stages into
  // have to agree on which machine they describe. That resolution is the
  // composer surface pin (pin ?? effective), so read the same primitive.
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

/**
 * Host-only dropdown + Workspace rail/panel folder picker, bound to a staging
 * key and to whichever host its `hostScope` names. Shared by every surface
 * that picks (but has not yet created) a chat/agent's host + folders +
 * worktree intent: the landing composer, the terminal-agent launcher submenu,
 * and the fork-chat dialog. Writes the per-folder choices to the staging store
 * under `stagingKey`; the launch/send handler reads them back from the same
 * key.
 *
 * Two host scopes, and the name is now historical: `fixed` addresses a
 * caller-supplied host with an inert picker, and what used to be the "active"
 * scope is the composer's window-keyed SURFACE PIN (selection model §2), which
 * resolves to `pin ?? effective` and follows the effective host only until the
 * user names one. Neither scope writes the app-wide selection any more.
 */
type ActiveHostWorkspaceControlsProps = {
  readonly stagingKey: WorktreeStagingKey;
  readonly workspaceSeed: LandingDraftWorkspaceSnapshot | null;
  /**
   * The source conversation's intent for seeding the folder rows (top
   * precedence in the picker's seeding). `null` on the landing composer, and on
   * the fork dialog (which pre-stages its intent into `stagingKey` directly).
   * Supplied by the terminal-agent launcher so a new agent opens on the same
   * workspace as the latest conversation - the same value GUI chat creation
   * passes straight into `createChat`.
   */
  readonly seedIntent: WorktreeIntent | null;
  /**
   * Per-folder transform applied on top of `seedIntent` when seeding: force
   * every seeded folder to a new worktree carrying the working tree ("A/B
   * Fork"). `null` stages the seed verbatim (the Cross Question fork's "same
   * working copy" semantics).
   */
  readonly seedIntentOverride: SeedIntentOverride | null;
  // "inline" (landing composer): folder rows with the host chip pushed to the
  // far right of row 1. "stacked" (fork dialog, terminal-agent launcher): a
  // file-tree-style Host list above a Workspaces section, no trailing chip.
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
  // The composer is PLACEMENT, and placement is a per-surface pin (redesign
  // P1.2, selection model §2/§54) - not the app-wide selection, which is
  // Settings ▸ Activate's alone now. A scope that NAMES a host (`fixed`, or
  // #1227's dialog-local `selected`) wins outright; the follow arm resolves
  // the composer's own pin - `pin ?? effective` - and the picker below writes
  // the pin. Nothing here moves the window.
  const composerPin = useComposerSurfaceHostPin();
  const scopeHostId = hostWorkspaceControlsScopeHostId(props.hostScope);
  const activeHostId = scopeHostId ?? composerPin.resolvedHostId;
  const activeEntry =
    directoryEntries.find((entry) => entry.hostId === activeHostId) ?? null;
  // "Local" is the neutral pre-directory default, and it is only honest while
  // this surface is FOLLOWING: a pin naming a host the directory does not
  // carry is a real unavailable state (D6), not a slow first paint.
  const hostLabel =
    activeEntry?.label ??
    (scopeHostId === null && !composerPin.isPinned ? "Local" : "Unavailable");
  // `pin.selection`, NOT `pin.resolvedHostId`: a FOLLOWING surface must keep
  // using the app-wide bound client (which the authority bridge holds on the
  // effective host) rather than a transient requester, so nothing about the
  // unpinned path changes. Only a pin resolves its own host's requester - and
  // that is what stops a pinned composer from sending to the machine the
  // window happens to be bound to.
  // `honoredSelection`, not `selection`: a deposed pin still NAMES the dead
  // host in `selection` (sticky return), but must not READ through it - the
  // chip auto-follows, and the rows must describe the machine the chip shows
  // (the same F3 rule `use-composer-placement.ts` applies).
  const pinResolvedHostClient = useHostClientForHostId(
    composerPin.honoredSelection,
  );
  const activeHostClient =
    props.hostScope.kind === "active"
      ? pinResolvedHostClient
      : props.hostScope.hostClient;
  // The picker's rows come from the merged host list, not from the directory
  // this component reads for the chip label: a host the account owns but this
  // client cannot dial belongs in the list (named, with its reason, inert),
  // where before it was simply absent here and present in Settings.
  //
  // A FIXED scope is pinned to one machine — the source agent's — so the list
  // is that host alone. It resolves out of the same merged list, and only falls
  // back to a stand-in row when the list has never heard of it.
  const hostOptions = useHostOptions();
  const fixedHostOption =
    props.hostScope.kind === "fixed"
      ? (findHostOption(hostOptions.hosts, props.hostScope.hostId) ??
        unavailableHostOption(props.hostScope.hostId, hostLabel))
      : null;
  const visibleHostOptions =
    fixedHostOption === null ? hostOptions.hosts : [fixedHostOption];
  const homeWorkspaceSource = useHomeWorkspaceSource(
    props.stagingKey,
    props.workspaceSeed,
    // The scope-correct host: the FIXED host when pinned, else the app-wide
    // active one - the same resolution every other host-derived read in this
    // component uses, so the folder bucket can never disagree with them.
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
  // Resolve repo-identifier → path against the scope-correct host: this
  // composer's pinned (or followed) host, the source agent's FIXED host in the
  // terminal-agent fork dialog (else paths resolve on the wrong machine).
  const resolved = useResolvedWorkspaceFolders(
    workspaceSource.source,
    activeHostClient,
    activeHostId,
  );
  const refusalByHostId = hostWorkspaceControlsScopeRefusals(props.hostScope);
  // A surface-level blocker: every row but the named one goes inert, and none
  // of them says why, because the reason is not about them. The surface owns
  // that sentence.
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
    // Writes THIS surface's pin and nothing else. Before P1.2 this called
    // `binding.directory.selectById(hostId)` - moving the whole app to place
    // one chat, which is the defect the surface-pin model exists to end.
    composerPin.setSelection(hostId);
  };

  if (props.layout === "stacked") {
    // Host picker as a flat file-tree-style list (own header), with the
    // folder rows in their own "Workspaces" section below — no trailing chip.
    // `--fc-text` brightens location labels to match the panel's other sections;
    // identity, branch values, icons, and actions retain their semantic hierarchy.
    return (
      <div className="flex w-full max-w-full min-w-0 flex-col gap-3 [--fc-opacity:1] [--fc-text:var(--color-foreground)]">
        <HostSection
          hosts={visibleHostOptions}
          activeHostId={activeHostId}
          onSelect={handleSelectHost}
          refusalByHostId={refusalByHostId}
          inertExceptHostId={unselectableExceptHostId}
          // A FIXED scope cannot change hosts — `handleSelectHost` returns
          // early there. Saying so on the row instead of swallowing the click
          // is the same rule the section already applies to a busy submission:
          // a row that accepts a click and does nothing reads as broken. A
          // SELECTED scope is the opposite case: the rows are live, they just
          // write to the caller's state instead of the directory.
          disabled={disabled || props.hostScope.kind === "fixed"}
          isLoading={hostOptions.isLoading}
          listsFailed={hostOptions.listsFailed}
          onRetryLists={hostOptions.retryLists}
          // `pin`, not `bind`: since P1.2 a pick here writes this composer's
          // surface pin and never rebinds the window. (The two intents gate
          // rows identically; only `view` differs.)
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
  const hostSelectConfig = hostOnlySelectConfig(
    props.hostScope,
    directoryEntries,
  );
  const deviceSelect = (
    <HostOnlySelect
      hostLabel={hostLabel}
      entries={hostSelectConfig.entries}
      activeHostId={activeHostId}
      mode={hostSelectConfig.mode}
      onSelect={handleSelectHost}
      loading={false}
      disabled={disabled}
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

function hostOnlySelectConfig(
  scope: HostWorkspaceControlsHostScope,
  directoryEntries: ReadonlyArray<HostDirectoryEntry>,
): {
  readonly entries: ReadonlyArray<HostDirectoryEntry>;
  readonly mode: "editable" | "locked";
} {
  if (scope.kind !== "fixed") {
    return { entries: directoryEntries, mode: "editable" };
  }
  return {
    entries: directoryEntries.filter((entry) => entry.hostId === scope.hostId),
    mode: "locked",
  };
}

function HomeWorkspaceRows(props: {
  readonly workspaceSource: HomeWorkspaceSource;
  readonly resolvedFolders: ReadonlyArray<ResolvedFolder>;
  readonly activeHostClient: HostClient<HostRpcRegistry> | null;
  /**
   * Passed separately from the client. The original reason no longer holds:
   * `HostClient.bind()` rebound in place, so the active-scope client was ONE
   * object for the app's lifetime and a memo keyed on it alone would pin the
   * first host's answer. P4.2 deleted that - the app-wide client is now a
   * requester rebuilt when the effective host changes, so it does move. The
   * id stays an explicit input because it is also non-null in states where
   * the client is null. See `rowsIntentKey`.
   */
  readonly activeHostId: string | null;
  /** Display label for the selected host — used in absent-path row copy. */
  readonly hostLabel: string;
  readonly stagingKey: WorktreeStagingKey;
  /**
   * The source conversation's intent - top precedence when seeding folders (the
   * fork dialog, and creating a new GUI/terminal agent from the latest
   * conversation). `null` on the blank landing composer, where the generic
   * per-epic / per-folder memory / default seeding applies instead.
   */
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
  // Remembered defaults are host-local, so every read and write here is bound
  // to the surface's target host. Both maps are stable references (the bucket
  // is the stored object, or the shared empty one), so subscribing to them
  // does not churn renders.
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
  // The single resolved primary every row / the collapsed chip / the launch
  // boundary agrees on - re-derived from the CURRENT resolved folder set so a
  // stale/removed `primaryPath` always falls back to the first remaining
  // folder without a separate write.
  const resolvedPrimaryPath = useMemo(
    () =>
      resolvePrimaryPath(
        resolvedFolders.map((entry) => entry.path),
        workspaceSource.primaryPath,
      ),
    [resolvedFolders, workspaceSource.primaryPath],
  );
  // Polite live-region announcement for a primary change - either an
  // explicit "Make primary" click or the deterministic reassignment when
  // removing the current primary. Sequence-keyed so consecutive identical
  // messages (duplicate folder basenames) both announce.
  const { announcement: primaryAnnouncement, announcePrimaryChange } =
    usePrimaryChangeAnnouncement();
  const addFolderPending =
    useIsMutating({ mutationKey: workspaceMutationKeys.prepareFolders() }) > 0;
  const pickAndAddFolders = usePickAndAddWorkspaceFolders(
    activeHostClient,
    workspaceSource,
  );
  // Locate on an absent row must REPLACE the dead path — add-only left it
  // blocking readiness until the user manually removed it.
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
  // Adjacent to the query ON PURPOSE: it writes its forced response into that
  // query's cache entry, and the path list is part of the key - so both must
  // read the same `queryableFolderPaths`, not two independently derived lists.
  const summariesRefresh = useWorktreeWorkspacesRefresh({
    client: activeHostClient,
    workspacePaths: queryableFolderPaths,
    summaries,
  });
  // MOUNT is the intent edge for the rows arm.
  //
  // The summary arm gets its forced re-derive from the picker popover's
  // `onOpenChange`. The rows arm has no open/close of its own - it renders
  // inline in the fork-chat dialog, the terminal-agent fork dialog and the
  // add-node launcher, each a Radix `Dialog`/`DropdownMenu` with no
  // `forceMount`, so it unmounts on close and mounts fresh on every open.
  // Without this, those surfaces render `forceRefresh: false` branch metadata
  // with no user recovery at all when the host's watcher cannot see a checkout
  // (network mount, container boundary, LRU eviction, failed arm). They need no
  // Refresh button of their own: close-and-reopen is the recovery, and with
  // this edge wired it is a real re-derive rather than another cache-only read.
  //
  // Latched per TARGET, not per mount, and released on failure.
  //
  // A bare boolean would be wrong in both directions. It never resets, so a
  // surface that switches hosts in place - or has folders added while open -
  // would keep the first target's answer and never heal the new one. And
  // because `canRefresh` only asserts a non-null client and a non-empty path
  // list, the active scope's always-present default client makes it true even
  // against an unbound or unreachable host: that attempt fails, toasts, and a
  // latch set before the request would spend the surface's only chance before
  // any recovery was possible.
  const rowsIntentTarget = useRef<string | null>(null);
  const rowsResting = props.restingMode === "rows";
  const canRefreshSummaries = summariesRefresh.canRefresh;
  const refreshSummaries = summariesRefresh.refresh;
  // Keyed on the REACTIVE host id, not on `activeHostClient.getActiveHostId()`.
  // The active-scope client rebinds in place, so its identity survives a host
  // swap: a memo keyed on the client would keep returning the previous host's
  // key, and this surface - which unmounts on close and has no Refresh button
  // of its own - would spend its one intent edge on the host the user just left.
  // `JSON.stringify`, not a space-joined string: folder paths routinely contain
  // spaces, and joining on one loses the boundaries - `["/a b", "/c"]` and
  // `["/a", "/b c"]` collapse to the same key, so moving between those two
  // scopes would read as "same target" and skip the re-derive.
  const rowsIntentKey = useMemo(
    () => JSON.stringify([props.activeHostId, queryableFolderPaths]),
    [props.activeHostId, queryableFolderPaths],
  );
  useEffect(() => {
    if (!rowsResting || !canRefreshSummaries) return;
    if (rowsIntentTarget.current === rowsIntentKey) return;
    rowsIntentTarget.current = rowsIntentKey;
    // The rows keep rendering the cached view meanwhile, so this costs no blank
    // frame; the hook toasts its own failure, so the rejection is already
    // reported by the time it lands here. Releasing the latch on failure lets
    // the next move of target or readiness try again, without spinning: this
    // effect only runs when one of its deps actually changes.
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
  // Seed every freshly-added git folder by precedence: per-epic memory >
  // per-folder memory (validated against disk) > default new worktree off the
  // working tree. A folder the user already touched this session is never
  // overwritten. The per-chat binding outranks all of this and is applied live
  // by the in-Epic surface, not here.
  const seedStageEntry = workspaceSource.stageEntry;
  // Subscribed (not an imperative read) so the effect re-runs when persisted
  // staging rehydrates after auth - otherwise a rehydrate that replaces the map
  // would drop just-seeded defaults for folders that weren't persisted.
  const seedCapturedIntent = workspaceSource.capturedIntent;
  const seedStagingKey = stagingKey;
  const seedEpicId =
    seedStagingKey.surface === "owner" ||
    seedStagingKey.surface === "new-conversation"
      ? seedStagingKey.epicId
      : null;
  // Reactive so branch-validation fetching + seeding re-run when the per-epic
  // memory changes. `getEpicIntent` returns the stored intent reference, stable
  // until a write, so this does not churn renders.
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
      // The host's own bucket first, then the frozen pre-host-scoping
      // fallback - the same per-key precedence `selectRememberedFolderIntent`
      // applies (inlined here so both maps stay reactive subscriptions).
      if (Object.hasOwn(folderIntentByPath, workspacePath)) {
        return folderIntentByPath[workspacePath].intent;
      }
      return Object.hasOwn(legacyFolderIntentByPath, workspacePath)
        ? legacyFolderIntentByPath[workspacePath].intent
        : null;
    },
    [folderIntentByPath, legacyFolderIntentByPath],
  );
  // The per-epic entry for a folder, if any. Outranks per-folder memory in both
  // the branch-validation fetch list and the seed, so a remembered epic pick is
  // validated (and its branches fetched) the same way.
  const epicEntryFor = useCallback(
    (workspacePath: string): WorktreeFolderIntent | null =>
      epicIntent?.entries.find((e) => e.workspacePath === workspacePath) ??
      null,
    [epicIntent],
  );

  // A remembered existing-branch checkout (or a fork from a non-working-tree
  // source) can only be validated against the full branch list, fetched lazily
  // here for exactly those folders - none in the common case.
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
        // Stamped from the explicit resolved primary - never from array/
        // git-summary position. After a reload restores a draft whose
        // explicit primary is NOT the first git summary (empty staging
        // slot), an order-derived seed here would silently re-mark the first
        // summary primary and contradict the badge.
        isPrimary: summary.workspacePath === resolvedPrimaryPath,
        isGitRepo: summary.isGitRepo,
        currentBranch,
        defaultNewBranchName: (
          defaultBranchByPath[summary.workspacePath] ?? EMPTY_DEFAULT_BRANCH
        ).name,
        summary,
      };
      // A fork surface may override the seed's per-folder disposition (Cross
      // Question → local, A/B Fork → new worktree carrying the working tree);
      // the overridden entry stays top-precedence like the verbatim seed.
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
      // A seed (the source conversation's live binding) is authoritative and
      // staged verbatim, so it short-circuits the memory/default tiers AND their
      // branch-validation wait below.
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

  // Setup/teardown editor is hosted here (not inside the popover) so it outlives
  // the popover closing. Landing is pre-epic: no owner/binding, `epicId: ""`
  // (the host resolver is authn-only for the empty epic).
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
          onEditEnvironment={handleEditEnvironment}
          readOnly={false}
          // Rendered inline in the fork / add-node dialogs, never inside a
          // popover, so nested branch/source dropdowns portal to the body.
          nestedInPopover={false}
          // Home folder list is a synchronous local draft, never an async binding
          // snapshot — an empty list is a genuine "no folders linked yet", so the
          // row shows the add affordance rather than an indefinite spinner.
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
      className="inline-flex max-w-full min-w-0 flex-nowrap items-center gap-2 overflow-hidden"
      data-testid="home-workspace-summary-control"
    >
      {props.hostSlot === null ? null : (
        <div className="min-w-0 flex-[0_1_10rem] max-w-[min(34%,10rem)] overflow-hidden">
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

function HostOnlySelect(props: {
  readonly hostLabel: string;
  readonly entries: ReadonlyArray<HostDirectoryEntry>;
  readonly activeHostId: string | null;
  readonly mode: "editable" | "fork-on-switch" | "locked";
  readonly onSelect: (hostId: string) => void;
  readonly loading: boolean;
  readonly disabled: boolean;
}) {
  const binding = useHostBinding();
  const directory = binding === null ? null : binding.directory;
  const [open, setOpen] = useState<boolean>(false);
  const remoteRestricted = useRemoteHostsPlanRestricted();
  useRefreshHostDirectoryOnOpen(open, directory);
  const options = hostSelectOptions(
    props.entries,
    props.activeHostId,
    props.hostLabel,
  );
  // Two reasons to go inert, but only one of them explains itself: `locked`
  // means this surface can never switch host, while `props.disabled` is a
  // transient draft-create settle. Labelling the second "Terminal host is
  // fixed" would tell an editable composer's user their host is permanent.
  const lockedToFixedHost = props.mode === "locked";
  const disabled = lockedToFixedHost || props.disabled;
  return (
    <Select
      open={open}
      onOpenChange={setOpen}
      value={props.activeHostId ?? undefined}
      onValueChange={props.onSelect}
      disabled={disabled}
    >
      <TooltipWrapper
        label={lockedToFixedHost ? "Terminal host is fixed" : undefined}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        {/* `flex w-full min-w-0`, NOT `inline-flex`: the trigger below is
            `w-full`, and a shrink-to-fit guard would make that resolve against
            the guard rather than the selector's cell, collapsing the control. */}
        <span className="flex w-full min-w-0">
          <SelectTrigger
            size="sm"
            aria-label="Host"
            data-testid="composer-host-trigger"
            className="h-7 w-full min-w-0 max-w-full justify-start gap-1.5 overflow-hidden border-transparent bg-transparent px-1.5 text-ui-sm text-muted-foreground opacity-70 transition-[background-color,opacity] hover:bg-accent/50 hover:opacity-100 focus-visible:opacity-100 disabled:opacity-70 data-[state=open]:rounded-b-none dark:bg-transparent dark:hover:bg-accent/50 *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:flex-1 *:data-[slot=select-value]:overflow-hidden *:data-[slot=select-value]:truncate"
          >
            <SelectValue placeholder={props.hostLabel} />
            {props.loading ? (
              <AgentSpinningDots
                className="text-current/70"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
          </SelectTrigger>
        </span>
      </TooltipWrapper>
      <SelectContent
        data-testid="composer-host-popover"
        sideOffset={0}
        className="data-[side=bottom]:translate-y-0 data-[side=bottom]:rounded-t-none data-[side=top]:translate-y-0 data-[side=top]:rounded-b-none"
      >
        {options.map((host) => (
          <HostSelectRow
            key={host.hostId}
            host={host}
            remoteRestricted={remoteRestricted}
            locked={props.mode === "locked"}
          />
        ))}
      </SelectContent>
    </Select>
  );
}

function HostSelectRow(props: {
  readonly host: HostDirectoryEntry;
  readonly remoteRestricted: boolean;
  readonly locked: boolean;
}) {
  // Subscribed, not read: the refusal predicate is ready-session-aware, and
  // the session cache is pull-only - a readiness flip changes no directory
  // value, so a row that read `hasReadyRemoteSession` at render time would
  // keep its refusal answer until some unrelated directory emit. The poll
  // subscription is what lets a row grey out when its backing session dies
  // (and re-enable on the converse) while the popover is open.
  const hasReadySession = useRemoteSessionPollReadiness(props.host.hostId);
  return (
    <SelectItem
      value={props.host.hostId}
      disabled={
        props.locked ||
        // Not `status === "unavailable"`, and not the raw
        // `hostUnavailability` verdict either: the refusal is asked
        // through the SAME ready-session-aware predicate the activation
        // path dials through, so a fuse-window `offline` (recovery dial
        // permitted) or an offline verdict this client holds a ready
        // live session against stays selectable - see
        // `hostSelectRowRefused` for the full derivation.
        hostSelectRowRefused(
          props.host,
          props.remoteRestricted,
          hasReadySession,
        )
      }
    >
      <HostSelectOptionContent
        host={props.host}
        remoteRestricted={props.remoteRestricted}
      />
    </SelectItem>
  );
}

function HostSelectOptionContent(props: {
  readonly host: HostDirectoryEntry;
  readonly remoteRestricted: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate">
        {settingsHostOptionLabel(props.host)}
      </span>
      {props.host.kind === "local" ? (
        <Badge
          variant="outline"
          className="shrink-0 border-border/70 bg-background/60 text-muted-foreground [[data-slot=select-trigger]_&]:hidden"
          data-testid={`composer-host-local-chip-${props.host.hostId}`}
        >
          Local
        </Badge>
      ) : null}
      {props.remoteRestricted && props.host.kind === "remote" ? (
        <Badge
          variant="outline"
          className="shrink-0 border-border/70 bg-background/60 text-muted-foreground [[data-slot=select-trigger]_&]:hidden"
          data-testid={`composer-host-paid-plan-chip-${props.host.hostId}`}
        >
          Paid plan
        </Badge>
      ) : null}
    </span>
  );
}

function hostSelectOptions(
  entries: ReadonlyArray<HostDirectoryEntry>,
  activeHostId: string | null,
  hostLabel: string,
): ReadonlyArray<HostDirectoryEntry> {
  if (
    activeHostId === null ||
    entries.some((entry) => entry.hostId === activeHostId)
  ) {
    return entries;
  }
  // Same fabricated-row rule as `fixedUnavailableHostEntry`: no route exists to
  // ask about, so the coarse bit is written directly rather than derived.
  return [
    {
      hostId: activeHostId,
      label: hostLabel,
      kind: "local",
      websocketUrl: null,
      version: null,
      transportDialability: "not-dialable",
    },
    ...entries,
  ];
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
  /** The summaries read REJECTED - distinct from "answered with nothing". */
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
  // Presence is per-(host, path) display state from the listing — never stored
  // in the draft. An absent path is not a non-git folder: the NON_GIT tooltip
  // is reserved for genuinely-present non-repo directories. Require
  // `resolvedAt !== null` too — the wire schema does not enforce the
  // cross-field invariant, and `{absent, resolvedAt:null}` must stay pending.
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
  // The resolver (backed by the explicit `primaryPath` field) is the single
  // source of truth for which row is primary - NOT the captured intent's own
  // `isPrimary` bit (which can go stale between an explicit switch and the
  // next launch-boundary canonicalization) and NOT array/git-summary order.
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
    modeDisabled: !metadataResolved,
    modeDisabledReason: metadataResolved
      ? null
      : "Waiting for the host to verify this folder.",
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

/**
 * Resolved absence on the wire (`presence: "absent"` with a real `resolvedAt`)
 * is definitive not-available. Unresolved absence (`resolvedAt: null`) falls
 * through to the pending path instead.
 */
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
  /** The summaries read REJECTED - distinct from "answered with nothing". */
  readonly summariesFailed: boolean;
  readonly onLocate: () => void;
  readonly resolvedPrimaryPath: string | null;
  readonly summary: WorktreeWorkspaceSummaryV15 | null;
  readonly workspaceSource: HomeWorkspaceSource;
}): WorkspaceRunItem | null {
  // A summary that landed (present non-git, or present git) falls through to
  // the normal row builder. Only the no-summary case stays here — pending
  // while the listing is in flight, else the not-available row.
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
    // A FAILED summaries read is not a confirmed absence. Both leave
    // `summary === null` with `isFetching` false, so without this the row
    // offered to replace the folder on the strength of a metadata request
    // that never got an answer. Removing stays available - it acts on the
    // binding the user can see - but replacing waits for the host to say
    // `presence: "absent"` out loud.
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

/**
 * `onSelectMode` body shared by the home and in-Epic rows, extracted so the
 * surrounding `workspaceRunItems`/item-building callbacks stay under the
 * ESLint complexity cap - this branching (no-op-reselect guard, local vs
 * worktree) is local to one row's mode switch, not the item-building loop
 * around it. Callers derive their own `repoIdentifier`/`isGitRepo` (and any
 * unresolved guard, like the in-Epic caller's `resolvedAt === null` check)
 * since the two surfaces source those facts differently.
 */
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

/**
 * A row's facts are pending while the listing query's first fetch is in
 * flight, and also once it lands but the host has not resolved that row yet
 * (`resolvedAt === null` - cache-served schema defaults, not disk truth).
 */
function isRowMetadataPending(
  metadataPending: boolean,
  resolvedAt: number | null,
): boolean {
  return metadataPending || resolvedAt === null;
}

/**
 * An unresolved row (`resolvedAt === null`) is served from cache before the
 * host has verified it, so mode switching stays disabled until the facts the
 * switch depends on land.
 */
function modeDisabledReasonFor(
  isOwnerActive: boolean,
  activeRunNotice: string,
  metadataPending: boolean,
): string | null {
  if (isOwnerActive) return activeRunNotice;
  if (metadataPending) return "Waiting for the host to verify this folder.";
  return null;
}

/**
 * Hover preview of every linked folder, themed like the standard tooltip:
 * `repo · branch` over the full path (left-truncated so the tail stays
 * readable), with a copy-path button to the right of the path. The path is
 * where the chat actually runs — the adopted worktree for worktree mode, the
 * folder for local — not the source folder.
 */
function unresolvedWorkspaceRunItem(input: {
  readonly path: string;
  readonly name: string;
  readonly repoIdentifier: WorktreeWorkspaceSummaryV15["repoIdentifier"];
  readonly hostLabel: string;
  readonly isPrimary: boolean;
  /**
   * `null` withholds the replace affordance.
   *
   * Locate REPLACES this entry, so offering it demands a confirmed absence.
   * A failed `worktree.listByWorkspacePaths` leaves the same empty summary a
   * real `presence: "absent"` does, and acting on that would talk the user
   * into replacing a folder that is very likely still there.
   */
  readonly onLocate: (() => void) | null;
  readonly onMakePrimary: () => void;
  readonly onRemove: () => void;
}): WorkspaceRunItem {
  // Copy is true for both "path gone" and "path is a regular file" — the
  // host conflates those into `presence: "absent"`. Locate re-points at a
  // usable directory on this host either way.
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

// Terminal-agent add/remove can commit to the binding before the explicit
// "Update" resumes the PTY. Keep that dirty bit outside the summary popover
// state because `development` now owns the overlay in
// `WorkspaceFolderSummaryControl`.
type FolderEditorState = {
  readonly dirtyPathsSinceResume: ReadonlySet<string>;
};
type FolderEditorAction =
  | {
      readonly type: "markDirty";
      readonly workspacePaths: ReadonlyArray<string>;
    }
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
        : { dirtyPathsSinceResume: next };
    }
    case "resumed":
      return { dirtyPathsSinceResume: new Set<string>() };
  }
}
interface InEpicSurfaceProps {
  readonly surface: BoundOwnerSurface;
  readonly hostLabel: string;
  readonly activeHostId: string | null;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly directoryEntries: ReadonlyArray<HostDirectoryEntry>;
}

// Coordinates host-bound folder metadata, staged worktree edits, add/remove
// mutations, and terminal resume state in one owner-scoped surface.
// eslint-disable-next-line complexity
function InEpicSurface(props: InEpicSurfaceProps) {
  const { surface } = props;
  const [editor, dispatchEditor] = useReducer(folderEditorReducer, {
    dirtyPathsSinceResume: new Set<string>(),
  });
  const ownerKind: WorktreeBindingOwnerKind =
    surface.kind === "chat" ? "chat" : "terminal-agent";
  const setEntryModeMutation = useWorktreeSetEntryModeForClient(
    props.hostClient,
  );
  const importMutation = useWorktreeImportForClient(props.hostClient);
  const worktreeCreateMutation = useWorktreeCreateForClient(props.hostClient);
  const createWorktree = worktreeCreateMutation.mutate;
  const worktreeCreatePending = worktreeCreateMutation.isPending;
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
  // ANTI-REVERT — render THIS owner's binding entries ONLY; never an epic-wide
  // base set. Basing the picker on an epic-wide source made each chat show every
  // sibling chat's folders. T2's host seam guarantees every chat / terminal-
  // agent always has a non-empty, owner-scoped binding, so rendering it directly
  // is now both correct AND leak-free. Do NOT reintroduce an epic-wide source
  // or merge here.
  //
  // Disk metadata (isGitRepo / branch / sibling worktrees / scripts) is fetched
  // per binding path via `worktree.listByWorkspacePaths`; until it resolves, each
  // row falls back to a binding-derived summary and shows a loading affordance
  // (`metadataPending`) so a guessed value never renders as disk truth.
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
  // Adjacent to the query ON PURPOSE - see the landing surface's copy: the
  // forced response is written into that query's cache entry, whose key
  // includes this exact path list.
  const summariesRefresh = useWorktreeWorkspacesRefresh({
    client: props.hostClient,
    workspacePaths: bindingWorkspacePaths,
    summaries: metadataSummaries,
  });
  const summariesByPath = useMemo(
    () => new Map(metadataSummaries.map((ws) => [ws.workspacePath, ws])),
    [metadataSummaries],
  );
  /**
   * Rows the host has actually resolved. Listing reads are served from the
   * host's cache, so an unresolved row (`resolvedAt === null`) carries schema
   * defaults rather than disk truth - seeding a default worktree intent from
   * one would stage a decision made on a guess. Unresolved rows stay out of
   * this view entirely and re-enter once the host resolves them.
   */
  const resolvedSummariesByPath = useMemo(
    () =>
      new Map([...summariesByPath].filter(([, ws]) => ws.resolvedAt !== null)),
    [summariesByPath],
  );
  // `isLoading` (not `isPending`): a disabled query — empty binding, so no paths
  // to fetch — is `isPending` in v5 but never actually loading, so guard on the
  // active first fetch only.
  const metadataPending = props.hostClient !== null && metadataQuery.isLoading;
  const workspaces = useMemo<ReadonlyArray<WorktreeWorkspaceSummaryV15>>(
    () =>
      bindingEntries.map(
        (entry) =>
          summariesByPath.get(entry.workspacePath) ??
          workspaceSummaryFromBindingEntry(entry),
      ),
    [bindingEntries, summariesByPath],
  );

  // In-epic surfaces address their bound owner host (`props.activeHostId` is
  // `surface.hostId` there), which is also the host whose remembered defaults
  // this picker may read and write.
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

  // Mid-chat "Create new worktree" / existing-branch checkout stages the
  // worktree instead of creating it now; the chat's next message send carries
  // the intent and the host creates it at turn-start (mirrors the landing
  // page). The staged branch shows on the folder row until then.
  const stageWorktreeIntent = useWorktreeIntentStagingStore(
    (s) => s.stageIntent,
  );
  const unstageWorktreeEntry = useWorktreeIntentStagingStore(
    (s) => s.unstageEntry,
  );
  const clearStagedWorktreeIntent = useWorktreeIntentStagingStore(
    (s) => s.clear,
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
  const pendingBranchByPath = useMemo(() => {
    const map = new Map<string, string>();
    if (stagedIntent === undefined) return map;
    for (const entry of stagedIntent.entries) {
      if (entry.kind === "worktree" && entry.branch.name.length > 0) {
        map.set(entry.workspacePath, entry.branch.name);
      }
    }
    return map;
  }, [stagedIntent]);
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

  // Folders added to this owner this session, awaiting their default seed. Held
  // in a ref (written by the add handler, read only by the effect below - never
  // rendered) so it doesn't fan out renders. Each is defaulted to a new worktree
  // off the working tree (or the user's remembered choice, unless that is Local)
  // once its disk metadata resolves, then dropped - so a later adjustment is
  // never re-clobbered. Established binding folders are untouched (binding wins).
  const pendingDefaultPathsRef = useRef(new Set<string>());

  // Terminal-agent "Update": apply every staged folder edit to the binding in a
  // single worktree.create (resolveIntent merges per-folder), then resume the
  // PTY once against the new binding. Edits accumulate locally as the user picks
  // them (see `emitForFolder`); this is the one commit + resume, so changing
  // several folders restarts the terminal a single time. Reads the live staged
  // intent at click time so it never applies a stale closure.
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
  const applyStagedFoldersAndResume = useCallback((): void => {
    if (stagedWorktreeIntentIsSuspended(stagedKey)) return;
    const staged = readStagedWorktreeIntent(stagedKey);
    const stagedEntries = staged?.entries ?? [];
    // A just-added git folder may still be waiting for metadata so the default
    // new-worktree seed can be staged. Keep Update enabled, but don't resume
    // until those pending defaults either stage or resolve as no-op.
    if (pendingDefaultPathsRef.current.size > 0) return;
    // Defensive: the button is already gated on the same condition, but guard
    // against an empty apply (nothing staged AND no committed add/remove).
    if (stagedEntries.length === 0 && editor.dirtyPathsSinceResume.size === 0) {
      return;
    }
    const changedWorkspacePaths = Array.from(
      new Set([
        ...editor.dirtyPathsSinceResume,
        ...stagedEntries.map((entry) => entry.workspacePath),
      ]),
    );
    const finishAndResume = (): void => {
      clearStagedWorktreeIntent(stagedKey);
      // Closes the popover AND clears dirty in one update.
      dispatchEditor({ type: "resumed" });
      handleBindingCommitted(changedWorkspacePaths);
    };
    // Only add/remove happened — already committed to the binding, so there is
    // nothing to create; just resume the PTY against the updated binding.
    if (stagedEntries.length === 0) {
      finishAndResume();
      return;
    }
    createWorktree(
      {
        epicId: surface.epicId,
        ownerId: surface.ownerId,
        ownerKind,
        entries: worktreeCreateEntries(stagedEntries),
      },
      {
        onSuccess: (result) => {
          // The RPC resolves per-entry: on a mixed outcome the failed
          // folders keep their staged intent (popover stays open) so Update
          // can re-apply just the failed subset, while the succeeded folders
          // commit + unstage normally. The commit signal for the successes
          // still fires - the host already applied them to the binding, and
          // a live terminal surface must re-sync its PTY to that partially
          // updated binding rather than keep running against stale folders.
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
          // Telemetry runs strictly after the product work; it is an
          // observer and never part of the mutation chain (and it already
          // gates each event on per-entry success).
          trackUserInitiatedWorktreeWrite(stagedEntries, result);
        },
      },
    );
  }, [
    editor.dirtyPathsSinceResume,
    createWorktree,
    surface.epicId,
    surface.ownerId,
    ownerKind,
    stagedKey,
    clearStagedWorktreeIntent,
    unstageWorktreeEntry,
    handleBindingCommitted,
  ]);
  // Terminal-agent add/remove commit to the binding but deliberately do NOT
  // resume — only the explicit "Update" does. Mark the binding dirty so
  // "Update" stays enabled until that resume.
  const markBindingDirtyWithoutResume = useCallback(
    (workspacePaths: ReadonlyArray<string>): void => {
      dispatchEditor({ type: "markDirty", workspacePaths });
    },
    [],
  );
  // Closing the picker without Update discards the staged (un-applied) edits so
  // the rows revert to the live binding. Terminal-agent only: chat staged
  // worktree intents ride the next message send and must survive the popover.
  // A committed add/remove (`editor.dirtyPathsSinceResume`) is intentionally NOT
  // discarded here — it is already in the binding and can only be cleared by a
  // resume, so "Update" must stay available after a close-without-apply.
  const discardStagedFoldersOnClose = useCallback((): void => {
    clearStagedWorktreeIntent(stagedKey);
  }, [clearStagedWorktreeIntent, stagedKey]);

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
        // Stage the new git folder's default worktree for BOTH owner kinds.
        // Terminal-agent no longer auto-creates + resumes here — the explicit
        // "Update" applies the staged set and resumes once (the add itself
        // already marked the binding dirty, so "Update" is enabled even before
        // this seeds).
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

  // `fork-on-switch` mode (and therefore this handler) is only offered for a
  // chat surface - see the `HostWorkspaceSelector` render below. Chats are
  // host-bound for life (clone-not-migrate), so picking another host here
  // means forking onto it: the owning tile opens its fork dialog anchored at
  // the chat's latest completed turn, preselected on the picked host, or says
  // why it can't yet (turn still running / nothing to fork).
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

  // Free functions (not useCallback) matching HEAD: they close over render
  // locals and are only invoked from event handlers / item onLocate, never
  // listed as memo deps that would thrash the items array.
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

  // One folder intent from the unified picker maps to the existing in-Epic
  // semantics. For CHATS: Local / adopting an existing on-disk worktree apply
  // immediately (and supersede any staged create); creating or checking out a
  // branch into a fresh worktree defers to the next message send. For TERMINAL
  // AGENTS: every edit (Local / import / new worktree) is staged locally and
  // applied together on the explicit "Update" — no edit resumes the PTY on its
  // own.
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
        if (surface.kind === "terminal-agent") {
          // Live terminal agent: stage every location/branch edit locally - no
          // host write and no PTY restart yet. The explicit "Update" button
          // applies the staged intent set via worktree.create and resumes the
          // PTY once, so changing several folders is a single resume rather than
          // one restart per edit. Closing the picker without Update discards the
          // staged edits. `stageIntent` merges by workspacePath, so re-picking a
          // folder replaces its prior staged choice.
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
          // Preserve the folder's current primary status instead of forcing it
          // primary: adopting a worktree on a SECONDARY folder must not silently
          // move the agent's primary run directory to that folder. A folder with
          // no binding row yet defaults to primary (single-folder / first add).
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
      surface.kind,
      surface.ownerId,
      unstageWorktreeEntry,
    ],
  );

  // Everything a row needs BEFORE the `WorkspaceRunItem` is assembled,
  // pulled out of the `.map()` callback below so that callback's own
  // ESLint complexity count only has to cover assembling the item, not also
  // deriving mode/intent/branch facts (the pattern the landing surface's
  // standalone `workspaceRunItemForResolvedFolder` already follows).
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
      const currentIntent =
        stagedEntry ??
        bindingEntryToFolderIntent(entry, ws.repoIdentifier, isPrimary);
      const branchDefault =
        defaultBranchByPath[ws.workspacePath] ?? EMPTY_DEFAULT_BRANCH;
      const defaultNewBranchName = branchDefault.name;
      const branchPrefixWarning = branchDefault.warning;
      const currentBranch = branchForSummary(ws);
      const otherWorktrees = ws.worktrees.filter((w) => !w.isMain);
      const rowMetadataPending = isRowMetadataPending(
        metadataPending,
        ws.resolvedAt,
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
      surface.binding,
    ],
  );

  const workspaceRunItems = useMemo<ReadonlyArray<WorkspaceRunItem>>(
    () =>
      workspaces.map((ws) => {
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
          emit,
        } = deriveInEpicRowState(ws);
        // Presence is per-(host, path) display state — never stored on the
        // binding. An absent path is not a non-git folder; Locate REPLACes
        // the dead path with a picked one (add-only left it blocking).
        // Handlers that close over pendingDefaultPathsRef are attached AFTER
        // unresolvedWorkspaceRunItem returns — passing them as arguments is
        // flagged by react-hooks/refs as "ref access during render".
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
            // An absent row is still a BOUND row: Locate adds and removes
            // binding entries exactly like the normal controls, so it takes
            // the same active-run lock. Without this the one row that mutates
            // the binding hardest stayed live while an owner turn was running,
            // and `unresolvedWorkspaceRunItem`'s `removeDisabled: false` came
            // through the spread untouched. The lock clears with the turn and
            // the row is retryable again - nothing about it is one-shot.
            removeDisabled: activeRunLocksBinding || removePending,
            removeDisabledReason: removeDisabledReasonFor(
              activeRunLocksBinding,
              activeRunNotice,
            ),
            onLocate: activeRunLocksBinding
              ? null
              : () => {
                  // Locate REPLACes only after ≥1 DISTINCT add succeeds — never
                  // delete-first (empty pick / all-adds-fail would drop the entry).
                  // Cancel and zero-success leave the binding untouched.
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
                          pendingDefaultPathsRef.current.delete(workspacePath);
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
                    // A retained path is still bound, so it is not "touched" by a
                    // commit that did not move it - the absent row stays put and
                    // stays retryable. The adds are real either way.
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
              removeBindingEntryMutation.mutate(
                {
                  epicId: surface.epicId,
                  ownerId: surface.ownerId,
                  ownerKind,
                  workspacePath: ws.workspacePath,
                },
                {
                  onSuccess: () => {
                    pendingDefaultPathsRef.current.delete(ws.workspacePath);
                    unstageWorktreeEntry(stagedKey, ws.workspacePath);
                    if (surface.kind === "terminal-agent") {
                      markBindingDirtyWithoutResume([ws.workspacePath]);
                      return;
                    }
                    handleBindingCommitted([ws.workspacePath]);
                  },
                },
              );
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
          // Bound owner rows (chat / terminal-agent) have no atomic
          // set-primary RPC yet - the badge renders read-only here; switching
          // stays scoped to not-yet-created pickers (landing, fork dialogs,
          // the new-conversation modal, the terminal-agent launcher).
          canChangePrimary: false,
          makePrimaryDisabled: false,
          makePrimaryDisabledReason: null,
          hostClient: props.hostClient,
          modeDisabled: activeRunLocksBinding || rowMetadataPending,
          modeDisabledReason: modeDisabledReasonFor(
            activeRunLocksBinding,
            activeRunNotice,
            rowMetadataPending,
          ),
          removeDisabled: activeRunLocksBinding || removePending,
          removeDisabledReason: removeDisabledReasonFor(
            activeRunLocksBinding,
            activeRunNotice,
          ),
          removePending,
          onEmit: emit,
          onMakePrimary: () => undefined,
          onSelectMode: (nextMode) => {
            // Unresolved rows (`resolvedAt === null`) have no verified git
            // facts yet - the mode switch itself is disabled for them
            // (`modeDisabled` above), but guard here too since this closure
            // outlives that render.
            if (ws.resolvedAt === null) return;
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
            removeBindingEntryMutation.mutate(
              {
                epicId: surface.epicId,
                ownerId: surface.ownerId,
                ownerKind,
                workspacePath: ws.workspacePath,
              },
              {
                // Terminal-agent: remove from the binding but don't resume —
                // only "Update" does. Chat: no PTY to resume (no-op callback).
                onSuccess: () => {
                  // A folder removed before its metadata resolved has nothing
                  // to seed - its summary never arrives, so left in place the
                  // path would pin the pending-defaults guard and block
                  // Update's resume forever.
                  pendingDefaultPathsRef.current.delete(ws.workspacePath);
                  // And if metadata DID resolve first, the seeding effect may
                  // already have staged a default worktree intent for this
                  // path - unstage it, or the next Update would call
                  // worktree.create for a folder no longer in the binding.
                  unstageWorktreeEntry(stagedKey, ws.workspacePath);
                  if (surface.kind === "terminal-agent") {
                    markBindingDirtyWithoutResume([ws.workspacePath]);
                    return;
                  }
                  handleBindingCommitted([ws.workspacePath]);
                },
              },
            );
          },
        };
      }),
    [
      activeRunNotice,
      activeRunLocksBinding,
      addFolderMutation,
      deriveInEpicRowState,
      folderActions,
      handleBindingCommitted,
      markBindingDirtyWithoutResume,
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

  // Setup/teardown editor, hosted here so it outlives the popover. In-epic
  // surfaces carry the real owner + live binding, so an edit can target a bound
  // worktree's own env file (or stage onto the next worktree).
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

  // Terminal agents keep the host fixed, but folder binding edits are allowed.
  // Edits never resume on their own (add/remove commit to the binding, location/
  // branch edits stage); the explicit "Update" applies the staged set and tells
  // the owning tile to restart the PTY once against the updated binding.
  const readOnly = false;

  return (
    <>
      <div className="inline-flex max-w-full min-w-0 flex-nowrap items-center gap-2 overflow-hidden">
        <div className="min-w-0 flex-[0_1_10rem] max-w-[min(34%,10rem)] overflow-hidden">
          <HostOnlySelect
            hostLabel={props.hostLabel}
            entries={props.directoryEntries}
            activeHostId={props.activeHostId}
            mode={surface.kind === "chat" ? "fork-on-switch" : "locked"}
            onSelect={handleSelectHostForChat}
            loading={metadataPending}
            disabled={false}
          />
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
                ? applyStagedFoldersAndResume
                : null
            }
            updateEnabled={
              hasStagedFolderChanges || editor.dirtyPathsSinceResume.size > 0
            }
            updatePending={worktreeCreatePending}
            onDiscardStaged={
              surface.kind === "terminal-agent"
                ? discardStagedFoldersOnClose
                : null
            }
            onEditEnvironment={handleEditEnvironment}
            refresh={summariesRefresh}
            popoverTestId="workspace-rows-popover"
            recentWorkspaces={recentWorkspacesSection}
            recentWorkspaceCount={recentWorkspaces.entries.length}
            moveToRecent={recentWorkspacesSupported}
            // The terminal-agent toolbar is anchored at the TOP of its tile, so the
            // editor must open DOWNWARD into the terminal body (plenty of room).
            // Opening upward (chat's default, where the composer is bottom-anchored)
            // collapses against the top of the viewport on a maximized tile and
            // turns into a cramped scroll once several folders are listed.
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
    </>
  );
}

// No staged pick yet (`capturedEntry === null`): a git folder reflects the
// default (new worktree); a non-git folder can only be Local. The seeding effect
// stages a pick shortly after mount, so this is the transient pre-seed state. A
// supported staged entry's own kind wins.
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

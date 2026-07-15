import {
  useCallback,
  useEffect,
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
import { activeRunNoticeFor } from "./active-run-notice";
import type {
  WorktreeBinding,
  WorktreeBindingEntry,
  WorktreeBindingOwnerKind,
  WorktreeBranch,
  WorktreeIntent,
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  useHostBinding,
  useHostClient,
  type HostRpcRegistry,
} from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useWorktreeListByWorkspacePathsForClient } from "@/hooks/worktree/use-worktree-list-by-workspace-paths-query";
import { useWorktreeSetEntryModeForClient } from "@/hooks/worktree/use-worktree-set-entry-mode-mutation";
import { useWorktreeImportForClient } from "@/hooks/worktree/use-worktree-import-mutation";
import { useWorktreeCreateForClient } from "@/hooks/worktree/use-worktree-create-mutation";
import {
  useWorkspaceBindingRemoveEntryForClient,
  usePendingRemoveBindingEntryPaths,
} from "@/hooks/workspace/use-workspace-binding-remove-entry-mutation";
import { useWorkspaceBindingAddFolderForClient } from "@/hooks/workspace/use-workspace-binding-add-folder-mutation";
import { useEpicCreateChat } from "@/hooks/epic/use-epic-chat-mutations";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useResolvedWorkspaceFolders } from "@/hooks/workspace/use-resolved-workspace-folders-query";
import type { ResolvedFolder } from "@/lib/workspace/resolved-folder";
import { useWorkspaceFolderActionsForClient } from "@/hooks/workspace/use-workspace-folder-actions";
import type { LandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";
import { usePickAndAddWorkspaceFolders } from "./use-pick-and-add-folders";
import {
  readStagedWorktreeIntent,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
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
import { buildDefaultBranchByPath } from "@/lib/worktree/default-branch-name";
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
import type { HostWorkspaceControlsHostScope } from "./host-workspace-controls-scope";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cloneChatOnHostSwitch } from "@/lib/commands/actions/clone-chat-on-host-switch";
import { CloneOnHostSwitchDialog } from "./clone-on-host-switch-dialog";
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
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { useChatById } from "@/lib/epic-selectors";
import { toast } from "sonner";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { trackUserInitiatedWorktreeWrite } from "@/lib/worktree/user-worktree-analytics";

/**
 *
 *
 *
 *
 *
 *
 *
 * `home` swaps the bound directory; `chat` clones the chat on switch;
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
};

const EMPTY_BINDING_ENTRIES: ReadonlyArray<WorktreeBindingEntry> = [];

/**
 * Binding-entry → `WorktreeWorkspaceSummary` fallback, rendered for a row until
 * `worktree.listByWorkspacePaths` returns the authoritative disk metadata. Git
 * details are inferred from the entry; the row shows a loading affordance
 * (`metadataPending`) while the real query is in flight, so this guess is never
 * presented as disk truth. (Moved here from the deleted `merge-owner-workspaces`
 * — the picker no longer merges an epic-wide base set.)
 */
function workspaceSummaryFromBindingEntry(
  entry: WorktreeBindingEntry,
): WorktreeWorkspaceSummary {
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
  };
}

export type HostWorkspaceSelectorSurface =
  | { readonly kind: "home"; readonly draftId: string | null }
  | BoundOwnerSurface;

interface HostWorkspaceSelectorProps {
  readonly surface: HostWorkspaceSelectorSurface;
}

export function HostWorkspaceSelector(props: HostWorkspaceSelectorProps) {
  const directoryList = useHostDirectoryList();
  const activeHostId = useReactiveActiveHostId();
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
    return <HomeSurface draftId={props.surface.draftId} />;
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
}

function HomeSurface(props: HomeSurfaceProps) {
  const stagingKey = useMemo<WorktreeStagingKey>(
    () => ({ surface: "landing", draftId: props.draftId }),
    [props.draftId],
  );
  return (
    <ActiveHostWorkspaceControls
      stagingKey={stagingKey}
      layout="inline"
      workspaceSeed={null}
      seedIntent={null}
      seedIntentOverride={null}
      hostScope={{ kind: "active" }}
    />
  );
}

/**
 * Host-only dropdown + Workspace rail/panel folder picker, bound to the
 * ACTIVE host and a staging key. Shared by every surface that picks (but has
 * not yet created) a chat/agent's host + folders + worktree intent: the
 * landing composer, the terminal-agent launcher submenu, and the fork-chat
 * dialog. Writes the per-folder choices to the staging store under
 * `stagingKey`; the launch/send handler reads them back from the same key.
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
};

export function ActiveHostWorkspaceControls(
  props: ActiveHostWorkspaceControlsProps,
) {
  const directoryList = useHostDirectoryList();
  const directoryEntries = directoryList.data ?? [];
  const reactiveActiveHostId = useReactiveActiveHostId();
  const activeHostId =
    props.hostScope.kind === "fixed"
      ? props.hostScope.hostId
      : reactiveActiveHostId;
  const activeEntry =
    directoryEntries.find((entry) => entry.hostId === activeHostId) ?? null;
  const hostLabel =
    activeEntry?.label ??
    (props.hostScope.kind === "fixed" ? "Unavailable" : "Local");
  const binding = useHostBinding();
  const defaultHostClient = useHostClient();
  const activeHostClient =
    props.hostScope.kind === "fixed"
      ? props.hostScope.hostClient
      : defaultHostClient;
  const visibleHostEntries =
    props.hostScope.kind === "fixed"
      ? [
          activeEntry ??
            fixedUnavailableHostEntry(props.hostScope.hostId, hostLabel),
        ]
      : directoryEntries;
  const workspaceSource = useHomeWorkspaceSource(
    props.stagingKey,
    props.workspaceSeed,
  );
  // Resolve repo-identifier → path against the scope-correct host: the
  // default host in active scope, the source agent's FIXED host in the
  // terminal-agent fork dialog (else paths resolve on the wrong machine).
  const resolved = useResolvedWorkspaceFolders(
    workspaceSource.source,
    activeHostClient,
  );
  const handleSelectHost = (hostId: string): void => {
    if (props.hostScope.kind === "fixed") return;
    if (binding === null) return;
    binding.directory.selectById(hostId);
  };

  if (props.layout === "stacked") {
    // Host picker as a flat file-tree-style list (own header), with the
    // folder rows in their own "Workspaces" section below — no trailing chip.
    // `--fc-text` brightens location labels to match the panel's other sections;
    // identity, branch values, icons, and actions retain their semantic hierarchy.
    return (
      <div className="flex w-full max-w-full min-w-0 flex-col gap-3 [--fc-opacity:1] [--fc-text:var(--color-foreground)]">
        <HostSection
          entries={visibleHostEntries}
          activeHostId={activeHostId}
          onSelect={handleSelectHost}
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
            stagingKey={props.stagingKey}
            seedIntent={props.seedIntent}
            seedIntentOverride={props.seedIntentOverride}
            restingMode="rows"
            hostSlot={null}
          />
        </section>
      </div>
    );
  }

  // Landing rests as host picker + compact summary chip, matching the in-epic
  // composer. Detailed folder rows still live in the popover/modal stack.
  const deviceSelect = (
    <HostOnlySelect
      hostLabel={hostLabel}
      entries={directoryEntries}
      activeHostId={activeHostId}
      mode="editable"
      onSelect={handleSelectHost}
      loading={false}
    />
  );
  return (
    <HomeWorkspaceRows
      workspaceSource={workspaceSource}
      resolvedFolders={resolved.folders}
      activeHostClient={activeHostClient}
      stagingKey={props.stagingKey}
      seedIntent={props.seedIntent}
      seedIntentOverride={props.seedIntentOverride}
      restingMode="summary"
      hostSlot={deviceSelect}
    />
  );
}

function fixedUnavailableHostEntry(
  hostId: string,
  hostLabel: string,
): HostDirectoryEntry {
  return {
    hostId,
    label: hostLabel,
    kind: "local",
    websocketUrl: null,
    version: null,
    status: "unavailable",
  };
}

function HomeWorkspaceRows(props: {
  readonly workspaceSource: HomeWorkspaceSource;
  readonly resolvedFolders: ReadonlyArray<ResolvedFolder>;
  readonly activeHostClient: HostClient<HostRpcRegistry> | null;
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
}) {
  const {
    workspaceSource,
    resolvedFolders,
    activeHostClient,
    stagingKey,
    seedIntent,
    seedIntentOverride,
  } = props;
  const setFolderIntent = useWorktreeIntentMemoryStore(
    (state) => state.setFolderIntent,
  );
  const folderIntentByPath = useWorktreeIntentMemoryStore(
    (state) => state.folderIntentByPath,
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
  const summariesByPath = useMemo<
    ReadonlyMap<string, WorktreeWorkspaceSummary>
  >(() => {
    const map = new Map<string, WorktreeWorkspaceSummary>();
    for (const ws of summariesQuery.data?.workspaces ?? []) {
      map.set(ws.workspacePath, ws);
    }
    return map;
  }, [summariesQuery.data]);
  const gitSummaries = useMemo<ReadonlyArray<WorktreeWorkspaceSummary>>(
    () =>
      resolvedFolders.flatMap((entry) => {
        const summary = summaryForResolvedFolder(entry, summariesByPath);
        return summary !== null && summary.isGitRepo ? [summary] : [];
      }),
    [resolvedFolders, summariesByPath],
  );
  const defaultBranchByPath = useMemo(
    () => buildDefaultBranchByPath(gitSummaries, gitSummaries.length > 1),
    [gitSummaries],
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
      (state) => (seedEpicId === null ? null : state.getEpicIntent(seedEpicId)),
      [seedEpicId],
    ),
  );

  const rememberedFor = useCallback(
    (workspacePath: string): WorktreeFolderIntent | null =>
      Object.hasOwn(folderIntentByPath, workspacePath)
        ? folderIntentByPath[workspacePath].intent
        : null,
    [folderIntentByPath],
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
        defaultNewBranchName: defaultBranchByPath[summary.workspacePath] ?? "",
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

  const items = useMemo<ReadonlyArray<WorkspaceRunItem>>(
    () =>
      resolvedFolders.map((entry) =>
        workspaceRunItemForResolvedFolder({
          entry,
          activeHostClient,
          announcePrimaryChange,
          defaultBranchByPath,
          isFetchingSummaries: summariesQuery.isFetching,
          onLocate: () => {
            void pickAndAddFolders();
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
      pickAndAddFolders,
      activeHostClient,
      resolvedFolders,
      resolvedPrimaryPath,
      workspaceSource,
      setFolderIntent,
      summariesByPath,
      summariesQuery.isFetching,
    ],
  );

  // Setup/teardown editor is hosted here (not inside the popover) so it outlives
  // the popover closing. Landing is pre-epic: no owner/binding, `epicId: ""`
  // (the host resolver is authn-only for the empty epic).
  const [scriptsTargetPath, setScriptsTargetPath] = useState<string | null>(
    null,
  );
  const handleEditEnvironment = useCallback((path: string): void => {
    // Keep the picker open: the scripts modal stacks on top of it, so closing
    // the modal returns to the still-open picker.
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
  const scriptsContext = useMemo<WorktreeScriptsContext>(
    () => ({
      epicId: "",
      ownerId: null,
      ownerKind: null,
      binding: null,
      stagingKey,
      hostClient: activeHostClient,
    }),
    [stagingKey, activeHostClient],
  );

  return (
    <>
      <PrimaryChangeLiveRegion announcement={primaryAnnouncement} />
      {props.restingMode === "summary" ? (
        <HomeWorkspaceSummaryControl
          items={items}
          hostSlot={props.hostSlot}
          addFolderPending={addFolderPending}
          onAddFolder={pickAndAddFolders}
          onEditEnvironment={handleEditEnvironment}
        />
      ) : (
        <WorkspaceFolderRows
          items={items}
          trailingSlot={null}
          addFolderPending={addFolderPending}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={pickAndAddFolders}
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
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={props.onAddFolder}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={props.onEditEnvironment}
          popoverTestId="home-workspace-rows-popover"
          popoverSide="top"
        />
      </div>
    </div>
  );
}

function HostOnlySelect(props: {
  readonly hostLabel: string;
  readonly entries: ReadonlyArray<HostDirectoryEntry>;
  readonly activeHostId: string | null;
  readonly mode: "editable" | "clone-on-switch" | "locked";
  readonly onSelect: (hostId: string) => void;
  readonly loading: boolean;
}) {
  const options = hostSelectOptions(
    props.entries,
    props.activeHostId,
    props.hostLabel,
  );
  const disabled = props.mode === "locked";
  return (
    <Select
      value={props.activeHostId ?? undefined}
      onValueChange={props.onSelect}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        aria-label="Host"
        title={disabled ? "Terminal host is fixed" : undefined}
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
      <SelectContent
        data-testid="composer-host-popover"
        sideOffset={0}
        className="data-[side=bottom]:translate-y-0 data-[side=bottom]:rounded-t-none data-[side=top]:translate-y-0 data-[side=top]:rounded-b-none"
      >
        {options.map((host) => (
          <SelectItem
            key={host.hostId}
            value={host.hostId}
            disabled={props.mode === "locked" || host.status === "unavailable"}
          >
            {hostOptionLabel(host)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  return [
    {
      hostId: activeHostId,
      label: hostLabel,
      kind: "local",
      websocketUrl: null,
      version: null,
      status: "unavailable",
    },
    ...entries,
  ];
}

function hostOptionLabel(host: HostDirectoryEntry): string {
  const label = host.label.length > 0 ? host.label : host.hostId;
  return host.status === "unavailable" ? `${label} (offline)` : label;
}

type UnresolvedWorkspaceFolder = Extract<
  ResolvedFolder,
  { readonly kind: "unresolved" }
>;

function workspaceRunItemForResolvedFolder(input: {
  readonly entry: ResolvedFolder;
  readonly activeHostClient: HostClient<HostRpcRegistry> | null;
  readonly announcePrimaryChange: (folderName: string) => void;
  readonly defaultBranchByPath: Readonly<Record<string, string>>;
  readonly isFetchingSummaries: boolean;
  readonly onLocate: () => void;
  readonly resolvedPrimaryPath: string | null;
  readonly setFolderIntent: (
    intent: WorktreeFolderIntent,
    timestamp: number,
  ) => void;
  readonly summariesByPath: ReadonlyMap<string, WorktreeWorkspaceSummary>;
  readonly workspaceSource: HomeWorkspaceSource;
}): WorkspaceRunItem {
  const summary = summaryForResolvedFolder(input.entry, input.summariesByPath);
  if (input.entry.kind === "unresolved") {
    const unresolvedItem = workspaceRunItemForUnresolvedFolder({
      activeHostClient: input.activeHostClient,
      announcePrimaryChange: input.announcePrimaryChange,
      entry: input.entry,
      isFetchingSummaries: input.isFetchingSummaries,
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
  const isGitRepo = summary?.isGitRepo ?? false;
  const capturedEntry = supportedCapturedEntryForSummary(
    capturedEntryForPath,
    isGitRepo,
  );
  const mode = deriveHomeRowMode(capturedEntry, isGitRepo);
  const defaultNewBranchName =
    input.defaultBranchByPath[input.entry.path] ?? "";
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
    metadataPending: summary === null && input.isFetchingSummaries,
    missing: false,
    isGitRepo,
    mode,
    branchLabel,
    summary,
    currentIntent: capturedEntry,
    defaultNewBranchName,
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
      emitHomeRowMode({
        currentBranch,
        currentIntent: capturedEntry,
        defaultNewBranchName,
        emit,
        isPrimary,
        mode,
        nextMode,
        summary,
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

function workspaceRunItemForUnresolvedFolder(input: {
  readonly activeHostClient: HostClient<HostRpcRegistry> | null;
  readonly announcePrimaryChange: (folderName: string) => void;
  readonly entry: UnresolvedWorkspaceFolder;
  readonly isFetchingSummaries: boolean;
  readonly onLocate: () => void;
  readonly resolvedPrimaryPath: string | null;
  readonly summary: WorktreeWorkspaceSummary | null;
  readonly workspaceSource: HomeWorkspaceSource;
}): WorkspaceRunItem | null {
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
    isPrimary,
    onLocate: input.onLocate,
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

function emitHomeRowMode(input: {
  readonly currentBranch: string | null;
  readonly currentIntent: WorktreeFolderIntent | null;
  readonly defaultNewBranchName: string;
  readonly emit: (intent: WorktreeFolderIntent) => void;
  readonly isPrimary: boolean;
  readonly mode: WorkspaceRunMode;
  readonly nextMode: WorkspaceRunMode;
  readonly summary: WorktreeWorkspaceSummary | null;
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
      repoIdentifier: input.summary?.repoIdentifier ?? null,
      isPrimary: input.isPrimary,
    });
    return;
  }
  input.emit(
    defaultFolderIntent({
      workspacePath: input.workspacePath,
      repoIdentifier: input.summary?.repoIdentifier ?? null,
      isPrimary: input.isPrimary,
      isGitRepo: input.summary?.isGitRepo ?? false,
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
 * Hover preview of every linked folder, themed like the standard tooltip:
 * `repo · branch` over the full path (left-truncated so the tail stays
 * readable), with a copy-path button to the right of the path. The path is
 * where the chat actually runs — the adopted worktree for worktree mode, the
 * folder for local — not the source folder.
 */
function unresolvedWorkspaceRunItem(input: {
  readonly path: string;
  readonly name: string;
  readonly repoIdentifier: WorktreeWorkspaceSummary["repoIdentifier"];
  readonly isPrimary: boolean;
  readonly onLocate: () => void;
  readonly onMakePrimary: () => void;
  readonly onRemove: () => void;
}): WorkspaceRunItem {
  return {
    key: input.path,
    displayName: input.name,
    displayPath: input.path,
    unresolved: true,
    metadataPending: false,
    // "Unavailable" (remote / unreachable host) is a distinct state from the
    // binding-missing-on-disk signal.
    missing: false,
    isGitRepo: false,
    mode: "local",
    branchLabel: "Unavailable",
    summary: null,
    currentIntent: null,
    defaultNewBranchName: "",
    repoIdentifier: input.repoIdentifier,
    isPrimary: input.isPrimary,
    canChangePrimary: true,
    makePrimaryDisabled: true,
    makePrimaryDisabledReason: "Resolve this folder to make it primary",
    hostClient: null,
    modeDisabled: true,
    modeDisabledReason: "Folder not on this host",
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
  readonly repoIdentifier: WorktreeWorkspaceSummary["repoIdentifier"];
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
  summariesByPath: ReadonlyMap<string, WorktreeWorkspaceSummary>,
): WorktreeWorkspaceSummary | null {
  const summary = summariesByPath.get(entry.path) ?? null;
  if (summary === null) return null;
  const repoIdentifier = repoIdentifierForResolvedFolder(entry);
  if (repoIdentifier === null) return summary;
  return { ...summary, repoIdentifier };
}

function repoIdentifierForResolvedFolder(
  entry: ResolvedFolder,
): WorktreeWorkspaceSummary["repoIdentifier"] {
  return entry.kind === "local-only" ? null : entry.repoIdentifier;
}

function branchForSummary(
  summary: WorktreeWorkspaceSummary | null,
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
  const binding = useHostBinding();
  const sourceChatRecord = useChatById(
    surface.kind === "chat" ? surface.ownerId : null,
  );
  const navigateNestedFocus = useEpicNestedFocusNavigation();
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
  const pendingRemovePaths = usePendingRemoveBindingEntryPaths({
    epicId: surface.epicId,
    ownerId: surface.ownerId,
    ownerKind,
  });
  const createChat = useEpicCreateChat();
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
  const summariesByPath = useMemo(
    () =>
      new Map(
        (metadataQuery.data?.workspaces ?? []).map((ws) => [
          ws.workspacePath,
          ws,
        ]),
      ),
    [metadataQuery.data],
  );
  // `isLoading` (not `isPending`): a disabled query — empty binding, so no paths
  // to fetch — is `isPending` in v5 but never actually loading, so guard on the
  // active first fetch only.
  const metadataPending = props.hostClient !== null && metadataQuery.isLoading;
  const workspaces = useMemo<ReadonlyArray<WorktreeWorkspaceSummary>>(
    () =>
      bindingEntries.map(
        (entry) =>
          summariesByPath.get(entry.workspacePath) ??
          workspaceSummaryFromBindingEntry(entry),
      ),
    [bindingEntries, summariesByPath],
  );

  const [pendingCloneHostId, setPendingCloneHostId] = useState<string | null>(
    null,
  );
  const setFolderIntent = useWorktreeIntentMemoryStore(
    (state) => state.setFolderIntent,
  );
  const getFolderIntent = useWorktreeIntentMemoryStore(
    (state) => state.getFolderIntent,
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
      epicId: surface.epicId,
      ownerKind,
      ownerId: surface.ownerId,
    }),
    [surface.epicId, ownerKind, surface.ownerId],
  );
  const stagedIntent = useWorktreeIntentStagingStore(
    (s) => s.intentByKey[worktreeStagingKeyString(stagedKey)],
  );
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
    () => workspaces.filter((ws) => ws.isGitRepo),
    [workspaces],
  );
  const defaultBranchByPath = useMemo(
    () => buildDefaultBranchByPath(gitWorkspaces, gitWorkspaces.length > 1),
    [gitWorkspaces],
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
  const pendingDefaultPathsRef = useRef<Set<string> | null>(null);
  const pendingDefaultPaths = (pendingDefaultPathsRef.current ??= new Set());

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
    const staged = readStagedWorktreeIntent(stagedKey);
    const stagedEntries = staged?.entries ?? [];
    // A just-added git folder may still be waiting for metadata so the default
    // new-worktree seed can be staged. Keep Update enabled, but don't resume
    // until those pending defaults either stage or resolve as no-op.
    if ((pendingDefaultPathsRef.current?.size ?? 0) > 0) return;
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
        entries: [...stagedEntries],
      },
      {
        onSuccess: (result) => {
          finishAndResume();
          // Telemetry runs strictly after the product work; it is an
          // observer and never part of the mutation chain.
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
    if (pending === null || pending.size === 0) return;
    for (const path of [...pending]) {
      const summary = summariesByPath.get(path) ?? null;
      if (summary === null) continue; // metadata not loaded yet - wait
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
        defaultNewBranchName: defaultBranchByPath[path] ?? "",
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
    summariesByPath,
    stagedEntryByPath,
    surface.binding,
    getFolderIntent,
    defaultBranchByPath,
    stageWorktreeIntent,
    stagedKey,
  ]);

  const handleSelectHostForChat = (hostId: string): void => {
    if (hostId === props.activeHostId) return;
    setPendingCloneHostId(hostId);
  };

  // Cancel the in-flight clone (its post-success projection subscription
  // + 30s timeout) on unmount so a host swap mid-wait doesn't leak.
  // Each new clone supersedes the previous in-flight one.
  const cloneCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const cloneCancel = cloneCancelRef;
    return () => {
      if (cloneCancel.current !== null) {
        cloneCancel.current();
        cloneCancel.current = null;
      }
    };
  }, []);

  const handleConfirmClone = (): void => {
    if (pendingCloneHostId === null || binding === null) return;
    if (cloneCancelRef.current !== null) cloneCancelRef.current();
    cloneCancelRef.current = cloneChatOnHostSwitch({
      epicId: surface.epicId,
      tabId: surface.tabId,
      sourceHostId: surface.hostId,
      targetHostId: pendingCloneHostId,
      directory: binding.directory,
      sourceSettings: sourceChatRecord?.settings ?? null,
      globalClient: binding.hostClient,
      onProfileFallbackToAmbient: () => {
        toast(
          "Continuing on the Terminal account - your profile isn't available on this host.",
        );
      },
      navigateNestedFocus,
      createChat: (request, callbacks) => {
        createChat.mutate(request, {
          onSuccess: callbacks.onSuccess,
        });
      },
    });
    setPendingCloneHostId(null);
  };

  const cloneTargetEntry =
    pendingCloneHostId === null
      ? null
      : (props.directoryEntries.find(
          (entry) => entry.hostId === pendingCloneHostId,
        ) ?? null);

  const activeRunNotice = activeRunNoticeFor(
    surface.kind,
    surface.hasActiveTurn,
  );
  const activeRunLocksBinding =
    surface.kind === "chat" && surface.isOwnerActive;

  const addFoldersToOwnerBinding = async (): Promise<boolean> => {
    const result = await folderActions.pickAndPrepareFolders();
    if (result === null) return false;
    const addedWorkspacePaths: string[] = [];
    // Add each picked folder independently and sequentially: the binding is a
    // single read-modify-write row, so parallel writes would clobber one
    // another - but one folder failing must not abort the rest (the add
    // mutation's onError already surfaces a per-folder toast).
    for (const folder of result.folders) {
      // oxlint-disable-next-line react-doctor/async-await-in-loop -- sequential is required: concurrent setEntryMode writes race on the single owner-binding row and lose folders.
      const ok = await addFolderMutation
        .mutateAsync({
          epicId: surface.epicId,
          ownerId: surface.ownerId,
          ownerKind,
          workspacePath: folder.workspacePath,
        })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        pendingDefaultPaths.add(folder.workspacePath);
        addedWorkspacePaths.push(folder.workspacePath);
      }
    }
    if (addedWorkspacePaths.length === 0) return false;
    // The folders are in the binding now, but adding never resumes the PTY —
    // the explicit "Update" does. Mark dirty so "Update" is enabled (a non-git
    // add stages nothing). Chat has no PTY to resume (no-op callback).
    if (surface.kind === "terminal-agent") {
      markBindingDirtyWithoutResume(addedWorkspacePaths);
    } else {
      handleBindingCommitted(addedWorkspacePaths);
    }
    return true;
  };

  // One folder intent from the unified picker maps to the existing in-Epic
  // semantics. For CHATS: Local / adopting an existing on-disk worktree apply
  // immediately (and supersede any staged create); creating or checking out a
  // branch into a fresh worktree defers to the next message send. For TERMINAL
  // AGENTS: every edit (Local / import / new worktree) is staged locally and
  // applied together on the explicit "Update" — no edit resumes the PTY on its
  // own.
  const emitForFolder = useCallback(
    (ws: WorktreeWorkspaceSummary) =>
      (intent: WorktreeFolderIntent): void => {
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

  const workspaceRunItems = useMemo<ReadonlyArray<WorkspaceRunItem>>(
    () =>
      workspaces.map((ws) => {
        const entry = findBindingEntry(surface.binding, ws.workspacePath);
        const pendingNewBranch =
          pendingBranchByPath.get(ws.workspacePath) ?? null;
        const { mode: currentMode, label: modeLabel } = computeInEpicFolderMode(
          {
            boundMode: entry?.mode ?? null,
            boundBranch: entry?.branch ?? null,
            pendingNewBranch,
          },
        );
        const removePending = pendingRemovePaths.has(ws.workspacePath);
        const isPrimary = entry?.isPrimary ?? true;
        const stagedEntry = stagedEntryByPath.get(ws.workspacePath) ?? null;
        const currentIntent =
          stagedEntry ??
          bindingEntryToFolderIntent(entry, ws.repoIdentifier, isPrimary);
        const defaultNewBranchName =
          defaultBranchByPath[ws.workspacePath] ?? "";
        const currentBranch = branchForSummary(ws);
        const otherWorktrees = ws.worktrees.filter((w) => !w.isMain);
        const branchLabel = workspaceRunBranchLabel({
          mode: currentMode,
          currentBranch,
          currentIntent,
          diskWorktrees: otherWorktrees,
        });
        const emit = emitForFolder(ws);
        return {
          key: ws.workspacePath,
          displayName: workspaceFolderName(ws.workspacePath),
          displayPath: ws.workspacePath,
          unresolved: false,
          metadataPending,
          missing: visibleMissingWorktreePaths.includes(ws.workspacePath),
          isGitRepo: ws.isGitRepo,
          mode: currentMode,
          branchLabel:
            currentMode === "local"
              ? (currentBranch ?? modeLabel)
              : branchLabel,
          summary: ws,
          currentIntent,
          defaultNewBranchName,
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
          modeDisabled: activeRunLocksBinding,
          modeDisabledReason: activeRunLocksBinding ? activeRunNotice : null,
          removeDisabled: activeRunLocksBinding || removePending,
          removeDisabledReason: removeDisabledReasonFor(
            activeRunLocksBinding,
            activeRunNotice,
          ),
          removePending,
          onEmit: emit,
          onMakePrimary: () => undefined,
          onSelectMode: (nextMode) => {
            if (!locationSelectionChanges(nextMode, currentIntent, currentMode))
              return;
            if (nextMode === "local") {
              emit({
                kind: "local",
                workspacePath: ws.workspacePath,
                repoIdentifier: ws.repoIdentifier,
                isPrimary,
              });
              return;
            }
            emit(
              defaultFolderIntent({
                workspacePath: ws.workspacePath,
                repoIdentifier: ws.repoIdentifier,
                isPrimary,
                isGitRepo: true,
                currentBranch,
                defaultNewBranchName,
              }),
            );
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
      defaultBranchByPath,
      emitForFolder,
      handleBindingCommitted,
      markBindingDirtyWithoutResume,
      pendingBranchByPath,
      pendingRemovePaths,
      props.hostClient,
      removeBindingEntryMutation,
      stagedEntryByPath,
      metadataPending,
      surface.binding,
      surface.epicId,
      surface.kind,
      surface.ownerId,
      ownerKind,
      visibleMissingWorktreePaths,
      workspaces,
    ],
  );

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
  const scriptsContext = useMemo<WorktreeScriptsContext>(
    () => ({
      epicId: surface.epicId,
      ownerId: surface.ownerId,
      ownerKind,
      binding: surface.binding,
      stagingKey: stagedKey,
      hostClient: props.hostClient,
    }),
    [
      surface.epicId,
      surface.ownerId,
      surface.binding,
      ownerKind,
      stagedKey,
      props.hostClient,
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
            mode={surface.kind === "chat" ? "clone-on-switch" : "locked"}
            onSelect={handleSelectHostForChat}
            loading={metadataPending}
          />
        </div>
        <div className="min-w-0 flex-[1_1_auto] max-w-[min(100%,34rem)] overflow-hidden">
          <WorkspaceFolderSummaryControl
            items={workspaceRunItems}
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
            popoverTestId="workspace-rows-popover"
            // The terminal-agent toolbar is anchored at the TOP of its tile, so the
            // editor must open DOWNWARD into the terminal body (plenty of room).
            // Opening upward (chat's default, where the composer is bottom-anchored)
            // collapses against the top of the viewport on a maximized tile and
            // turns into a cramped scroll once several folders are listed.
            popoverSide={surface.kind === "terminal-agent" ? "bottom" : "top"}
          />
        </div>
      </div>
      <CloneOnHostSwitchDialog
        open={pendingCloneHostId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingCloneHostId(null);
        }}
        targetHostLabel={cloneTargetEntry?.label ?? "this host"}
        onConfirm={handleConfirmClone}
      />
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

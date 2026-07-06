import {
  useCallback,
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type Fuse from "fuse.js";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { ChevronDown, Search, TriangleAlert, X } from "lucide-react";
import type {
  GitChangedFile,
  GitChangedFileV11,
  GitListChangedFilesResponseV11,
  RepoMode,
  RepoState,
} from "@traycer/protocol/host";
import type { GitListChangedFilesSubscriptionResult } from "@/hooks/git/use-git-list-changed-files-subscription";
import type { GitListChangedFilesWithSubmodulesResult } from "@/hooks/git/use-git-list-changed-files-with-submodules";
import type { GitPanelSelectedRepo } from "@/stores/epics/git-panel-store";
import type { GitDiffBundleGroup } from "@/stores/epics/canvas/types";
import {
  buildGitModuleGroups,
  type GitModuleGroup,
  type GitModuleParentReferenceStatus,
} from "@/lib/git/git-repo-tree";
import {
  createGitChangedFileSearchIndex,
  filterGitChangedFiles,
} from "@/lib/git/git-changed-file-search";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { FileList } from "./file-list";
import { RepoStateBanner } from "./repo-state-banner";
import { DiffLoadingSkeleton } from "./diff-loading-skeleton";
import { NoChangesInWorktree } from "./empty-states/no-changes-in-worktree";
import { NoMatchingFiles } from "./empty-states/no-matching-files";
import { SubscriptionErrorState } from "./empty-states/subscription-error-state";
import { SubmoduleUnavailable } from "./empty-states/submodule-unavailable";
import { GitErrorBlock } from "./git-error-block";
import type { GitDiffSectionCollapseController } from "./git-diff-section";

const GIT_MODULE_SEARCH_DEBOUNCE_MS = 150;
const GIT_SECTION_STICKY_TOP_NONE = "0px";

type GitSectionStickyStyle = CSSProperties & {
  readonly "--git-section-sticky-top": string;
};

export interface SelectedRepoChangesProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly selected: GitPanelSelectedRepo;
  readonly rootLabel: string;
  readonly subscription: GitListChangedFilesSubscriptionResult;
  readonly snapshot: GitListChangedFilesWithSubmodulesResult;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}

interface WorkspaceModuleSource {
  readonly rootFiles: ReadonlyArray<GitChangedFileV11>;
  readonly rootBranch: string | null;
  readonly rootHeadSha: string | null;
  readonly rootRepoState: RepoState | null;
  readonly rootRepoMode: RepoMode | null;
  readonly submodules: GitListChangedFilesResponseV11["submodules"];
  readonly hasLanded: boolean;
  readonly lastUpdatedAtMs: number | null;
}

interface SubscriptionModuleSourceInput {
  readonly data: GitListChangedFilesSubscriptionResult["data"];
  readonly repoState: RepoState | null;
  readonly repoMode: RepoMode | null;
  readonly updatedAtMs: number | null;
}

interface GitModuleSearchCopy {
  readonly placeholder: string;
  readonly ariaLabel: string;
}

function withNullGitlinks(
  files: ReadonlyArray<GitChangedFile>,
): ReadonlyArray<GitChangedFileV11> {
  return files.map((file) => ({ ...file, gitlink: null }));
}

function resolveWorkspaceModuleSource(
  subscription: SubscriptionModuleSourceInput,
  snapshotData: GitListChangedFilesResponseV11 | null,
): WorkspaceModuleSource {
  if (snapshotData !== null) {
    return {
      rootFiles: snapshotData.files,
      rootBranch: snapshotData.branch,
      rootHeadSha: snapshotData.headSha,
      rootRepoState: snapshotData.repoState,
      rootRepoMode: snapshotData.repoMode,
      submodules: snapshotData.submodules,
      hasLanded: true,
      lastUpdatedAtMs: subscription.updatedAtMs,
    };
  }
  return {
    rootFiles: withNullGitlinks(subscription.data?.files ?? []),
    rootBranch: subscription.data?.branch ?? null,
    rootHeadSha: subscription.data?.headSha ?? null,
    rootRepoState: subscription.repoState,
    rootRepoMode: subscription.repoMode,
    submodules: [],
    hasLanded: subscription.data !== null,
    lastUpdatedAtMs: subscription.updatedAtMs,
  };
}

function conflictCount(files: ReadonlyArray<GitChangedFile>): number {
  return files.filter((file) => file.stage === "conflicted").length;
}

function moduleIdentifier(module: GitModuleGroup): string {
  return module.kind === "root" ? "root" : (module.parentPath ?? module.label);
}

function moduleGroupTestId(module: GitModuleGroup): string {
  return module.kind === "root"
    ? "git-module-group-root"
    : `git-module-group-submodule-${moduleIdentifier(module)}`;
}

function moduleNoChangesTestId(module: GitModuleGroup): string {
  return module.kind === "root"
    ? "git-module-no-changes-root"
    : `git-module-no-changes-${moduleIdentifier(module)}`;
}

function moduleSectionCollapseKey(
  module: GitModuleGroup,
  group: GitDiffBundleGroup,
): string {
  return `${module.key}:${group}`;
}

function parentReferenceLabel(module: GitModuleGroup): string | null {
  const reference = module.parentReference;
  if (reference === null) return null;
  if (reference.status === "differs") return "pinned commit out of date";
  if (reference.status === "conflicted") return "reference conflict";
  if (reference.status === "unavailable") return "details unavailable";
  return "working tree dirty";
}

function moduleHeaderPath(module: GitModuleGroup): string | null {
  if (module.repoRoot !== null) return module.repoRoot;
  return module.parentPath;
}

function moduleHeaderTooltip(args: {
  readonly module: GitModuleGroup;
  readonly countLabel: string;
  readonly parentLabel: string | null;
}): string {
  const { module, countLabel, parentLabel } = args;
  const path = moduleHeaderPath(module);
  return [
    module.kind === "submodule"
      ? `Submodule: ${module.label}`
      : `Workspace module: ${module.label}`,
    path === null ? null : `Path: ${path}`,
    module.parentPath === null ? null : `Parent path: ${module.parentPath}`,
    `Head: ${module.headLabel}`,
    `Changed files: ${countLabel}`,
    parentLabel === null ? null : `Status: ${parentLabel}`,
    module.parentReference?.summary === undefined
      ? null
      : `Details: ${module.parentReference.summary}`,
    module.unavailable && module.parentReference?.status !== "unavailable"
      ? "Status: unavailable"
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function moduleHeaderAccessibleName(args: {
  readonly module: GitModuleGroup;
  readonly countLabel: string;
  readonly parentLabel: string | null;
}): string {
  const { module, countLabel, parentLabel } = args;
  return [
    module.label,
    module.kind === "submodule" ? "submodule" : null,
    countLabel,
    module.headLabel,
    parentLabel,
    module.unavailable ? "unavailable" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

function moduleHeaderStatusVisible(
  status: GitModuleParentReferenceStatus | null,
  unavailable: boolean,
): boolean {
  return (
    unavailable ||
    status === "differs" ||
    status === "conflicted" ||
    status === "unavailable"
  );
}

function moduleMatchesQuery(
  module: GitModuleGroup,
  searchIndex: Fuse<GitChangedFile> | null,
  query: string,
  normalizedQuery: string,
): boolean {
  if (module.searchText.includes(normalizedQuery)) return true;
  if (searchIndex === null) return false;
  return filterGitChangedFiles(module.files, searchIndex, query).length > 0;
}

function buildModuleSearchIndexes(
  modules: ReadonlyArray<GitModuleGroup>,
): ReadonlyMap<string, Fuse<GitChangedFile>> {
  const indexes = new Map<string, Fuse<GitChangedFile>>();
  modules.forEach((module) => {
    if (module.files.length === 0) return;
    indexes.set(module.key, createGitChangedFileSearchIndex(module.files));
  });
  return indexes;
}

function singleRepoModule(
  modules: ReadonlyArray<GitModuleGroup>,
  hiddenCleanModuleCount: number,
): GitModuleGroup | null {
  if (hiddenCleanModuleCount !== 0 || modules.length !== 1) return null;
  const module = modules[0];
  return module.kind === "root" ? module : null;
}

function gitModuleSearchCopy(
  singleRepo: GitModuleGroup | null,
): GitModuleSearchCopy {
  if (singleRepo === null) {
    return {
      placeholder: "Filter submodules and files...",
      ariaLabel: "Filter submodules and files",
    };
  }
  return {
    placeholder: "Filter files...",
    ariaLabel: "Filter files",
  };
}

function gitModuleSearchVisible(
  modules: ReadonlyArray<GitModuleGroup>,
  singleRepo: GitModuleGroup | null,
): boolean {
  if (singleRepo !== null) return singleRepo.files.length > 0;
  return (
    modules.length > 1 || modules.some((module) => module.files.length > 0)
  );
}

function gitSectionStickyStyle(top: string): GitSectionStickyStyle {
  return { "--git-section-sticky-top": top };
}

function ModuleHeaderTooltipContent(props: { readonly text: string }) {
  return (
    <span className="block whitespace-pre-line text-left leading-5">
      {props.text}
    </span>
  );
}

function allModulesClean(modules: ReadonlyArray<GitModuleGroup>): boolean {
  return modules.length > 0 && modules.every((module) => module.clean);
}

type GitModuleGroupsEmptyState = "clean-workspace" | "no-query-matches";

function gitModuleGroupsNoQueryMatches(props: {
  readonly singleRepo: GitModuleGroup | null;
  readonly queryActive: boolean;
  readonly visibleModuleCount: number;
}): boolean {
  return (
    props.singleRepo === null &&
    props.queryActive &&
    props.visibleModuleCount === 0
  );
}

function gitModuleGroupsEmptyState(props: {
  readonly cleanWorkspace: boolean;
  readonly noQueryMatches: boolean;
}): GitModuleGroupsEmptyState | null {
  if (props.cleanWorkspace) return "clean-workspace";
  if (props.noQueryMatches) return "no-query-matches";
  return null;
}

function GitModuleGroupsEmptyContent(props: {
  readonly state: GitModuleGroupsEmptyState;
  readonly lastUpdatedAtMs: number | null;
  readonly snapshotError: HostRpcError | null;
  readonly searchVisible: boolean;
  readonly searchQuery: string;
  readonly trimmedQuery: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly onSearchChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onClearSearch: () => void;
}): ReactNode {
  if (props.state === "clean-workspace") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {props.snapshotError === null ? null : (
          <GitSnapshotErrorBanner error={props.snapshotError} />
        )}
        <NoChangesInWorktree lastUpdatedAtMs={props.lastUpdatedAtMs} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.snapshotError === null ? null : (
        <GitSnapshotErrorBanner error={props.snapshotError} />
      )}
      {props.searchVisible ? (
        <GitModuleSearch
          searchQuery={props.searchQuery}
          placeholder={props.placeholder}
          ariaLabel={props.ariaLabel}
          onSearchChange={props.onSearchChange}
          onSearchKeyDown={props.onSearchKeyDown}
          onClearSearch={props.onClearSearch}
        />
      ) : null}
      <NoMatchingFiles
        query={props.trimmedQuery}
        onClear={props.onClearSearch}
      />
    </div>
  );
}

export function SelectedRepoChanges(
  props: SelectedRepoChangesProps,
): ReactNode {
  const { subscription, snapshot } = props;
  const source = useMemo(
    () =>
      resolveWorkspaceModuleSource(
        {
          data: subscription.data,
          repoState: subscription.repoState,
          repoMode: subscription.repoMode,
          updatedAtMs: subscription.pollStartedAtMs,
        },
        snapshot.data,
      ),
    [
      subscription.data,
      subscription.repoState,
      subscription.repoMode,
      subscription.pollStartedAtMs,
      snapshot.data,
    ],
  );
  const moduleModel = useMemo(
    () =>
      buildGitModuleGroups({
        root: {
          repoRoot: props.selected.rootRunningDir,
          label: props.rootLabel,
          branch: source.rootBranch,
          headSha: source.rootHeadSha,
          files: source.rootFiles,
          repoState: source.rootRepoState,
          repoMode: source.rootRepoMode,
        },
        submodules: source.submodules,
      }),
    [
      props.rootLabel,
      props.selected.rootRunningDir,
      source.rootBranch,
      source.rootFiles,
      source.rootHeadSha,
      source.rootRepoMode,
      source.rootRepoState,
      source.submodules,
    ],
  );

  if (snapshot.error !== null && snapshot.data === null) {
    return <GitErrorBlock error={snapshot.error} />;
  }
  if (subscription.error !== null && snapshot.data === null) {
    return <SubscriptionErrorState event={subscription.error} />;
  }
  if (!source.hasLanded) {
    return <DiffLoadingSkeleton variant="panel" />;
  }

  return (
    <GitModuleGroupsView
      epicId={props.epicId}
      viewTabId={props.viewTabId}
      hostId={props.selected.hostId}
      modules={moduleModel.modules}
      hiddenCleanModuleCount={moduleModel.hiddenCleanModuleCount}
      lastUpdatedAtMs={source.lastUpdatedAtMs}
      snapshotError={snapshot.error}
      onRefresh={props.onRefresh}
      isRefreshing={props.isRefreshing}
    />
  );
}

function GitModuleGroupsView(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly modules: ReadonlyArray<GitModuleGroup>;
  readonly hiddenCleanModuleCount: number;
  readonly lastUpdatedAtMs: number | null;
  readonly snapshotError: HostRpcError | null;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}): ReactNode {
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [showCleanModules, setShowCleanModules] = useState(false);
  const [expandedByKey, setExpandedByKey] = useState<Record<string, boolean>>(
    {},
  );
  const [sectionCollapsedByKey, setSectionCollapsedByKey] = useState<
    Record<string, boolean>
  >({});
  const moduleGroupsRef = useRef<HTMLDivElement | null>(null);
  const moduleHeaderByKeyRef = useRef<Map<string, HTMLButtonElement> | null>(
    null,
  );
  if (moduleHeaderByKeyRef.current === null) {
    moduleHeaderByKeyRef.current = new Map();
  }
  const moduleHeaderByKey = moduleHeaderByKeyRef.current;
  const pendingScrollAnchorRef = useRef<{
    readonly moduleKey: string;
    readonly top: number;
  } | null>(null);
  const debounceTimerRef = useRef<number | null>(null);

  const clearPendingDebounce = useCallback(() => {
    if (debounceTimerRef.current === null) return;
    window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
  }, []);

  const handleSearchChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setSearchQuery(next);
      clearPendingDebounce();
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        setAppliedQuery(next);
      }, GIT_MODULE_SEARCH_DEBOUNCE_MS);
    },
    [clearPendingDebounce],
  );

  const handleClearSearch = useCallback(() => {
    clearPendingDebounce();
    setSearchQuery("");
    setAppliedQuery("");
  }, [clearPendingDebounce]);

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      handleClearSearch();
      event.currentTarget.blur();
    },
    [handleClearSearch],
  );

  const handleToggleCleanModules = useCallback(() => {
    setShowCleanModules((current) => !current);
  }, []);

  const rememberModuleScrollAnchor = useCallback(
    (moduleKey: string) => {
      const container = moduleGroupsRef.current;
      const header = moduleHeaderByKey.get(moduleKey) ?? null;
      if (container === null || header === null) return;
      const containerRect = container.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      pendingScrollAnchorRef.current = {
        moduleKey,
        top: headerRect.top - containerRect.top,
      };
    },
    [moduleHeaderByKey],
  );

  const toggleModule = useCallback(
    (module: GitModuleGroup) => {
      rememberModuleScrollAnchor(module.key);
      setExpandedByKey((current) => ({
        ...current,
        [module.key]: !(current[module.key] ?? module.defaultExpanded),
      }));
    },
    [rememberModuleScrollAnchor],
  );
  const toggleModuleSection = useCallback(
    (module: GitModuleGroup, group: GitDiffBundleGroup) => {
      const key = moduleSectionCollapseKey(module, group);
      setSectionCollapsedByKey((current) => ({
        ...current,
        [key]: !(current[key] ?? false),
      }));
    },
    [],
  );
  const registerModuleHeader = useCallback(
    (moduleKey: string, element: HTMLButtonElement | null) => {
      if (element === null) {
        moduleHeaderByKey.delete(moduleKey);
        return;
      }
      moduleHeaderByKey.set(moduleKey, element);
    },
    [moduleHeaderByKey],
  );

  useEffect(() => clearPendingDebounce, [clearPendingDebounce]);
  useLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    if (anchor === null) return;
    pendingScrollAnchorRef.current = null;
    const container = moduleGroupsRef.current;
    const header = moduleHeaderByKey.get(anchor.moduleKey) ?? null;
    if (container === null || header === null) return;
    const containerRect = container.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const nextTop = headerRect.top - containerRect.top;
    container.scrollTop += nextTop - anchor.top;
  });

  const trimmedQuery = appliedQuery.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();
  const queryActive = normalizedQuery.length > 0;
  const singleRepo = singleRepoModule(
    props.modules,
    props.hiddenCleanModuleCount,
  );
  const searchCopy = gitModuleSearchCopy(singleRepo);
  const moduleSearchIndexes = useMemo(
    () => buildModuleSearchIndexes(props.modules),
    [props.modules],
  );

  const queryMatchByKey = useMemo(() => {
    if (singleRepo !== null || !queryActive) return new Map<string, boolean>();
    return new Map(
      props.modules.map((module) => [
        module.key,
        moduleMatchesQuery(
          module,
          moduleSearchIndexes.get(module.key) ?? null,
          appliedQuery,
          normalizedQuery,
        ),
      ]),
    );
  }, [
    appliedQuery,
    moduleSearchIndexes,
    normalizedQuery,
    props.modules,
    queryActive,
    singleRepo,
  ]);

  const visibleModules = useMemo(() => {
    if (singleRepo !== null) return [];
    if (queryActive) {
      return props.modules.filter(
        (module) => queryMatchByKey.get(module.key) === true,
      );
    }
    return props.modules.filter(
      (module) => module.kind === "root" || !module.clean || showCleanModules,
    );
  }, [
    props.modules,
    queryActive,
    queryMatchByKey,
    showCleanModules,
    singleRepo,
  ]);

  const searchVisible = gitModuleSearchVisible(props.modules, singleRepo);
  const cleanWorkspace = !queryActive && allModulesClean(props.modules);
  const noQueryMatches = gitModuleGroupsNoQueryMatches({
    singleRepo,
    queryActive,
    visibleModuleCount: visibleModules.length,
  });
  const emptyState = gitModuleGroupsEmptyState({
    cleanWorkspace,
    noQueryMatches,
  });

  if (emptyState !== null) {
    return (
      <GitModuleGroupsEmptyContent
        state={emptyState}
        lastUpdatedAtMs={props.lastUpdatedAtMs}
        snapshotError={props.snapshotError}
        searchVisible={searchVisible}
        searchQuery={searchQuery}
        trimmedQuery={trimmedQuery}
        placeholder={searchCopy.placeholder}
        ariaLabel={searchCopy.ariaLabel}
        onSearchChange={handleSearchChange}
        onSearchKeyDown={handleSearchKeyDown}
        onClearSearch={handleClearSearch}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.snapshotError === null ? null : (
        <GitSnapshotErrorBanner error={props.snapshotError} />
      )}
      {searchVisible ? (
        <GitModuleSearch
          searchQuery={searchQuery}
          placeholder={searchCopy.placeholder}
          ariaLabel={searchCopy.ariaLabel}
          onSearchChange={handleSearchChange}
          onSearchKeyDown={handleSearchKeyDown}
          onClearSearch={handleClearSearch}
        />
      ) : null}
      {singleRepo !== null ? (
        <SingleRepoChangesView
          epicId={props.epicId}
          viewTabId={props.viewTabId}
          hostId={props.hostId}
          module={singleRepo}
          query={appliedQuery}
          lastUpdatedAtMs={props.lastUpdatedAtMs}
          sectionCollapsedByKey={sectionCollapsedByKey}
          onToggleModuleSection={toggleModuleSection}
          onClearQuery={handleClearSearch}
          onRefresh={props.onRefresh}
          isRefreshing={props.isRefreshing}
        />
      ) : (
        <div
          ref={moduleGroupsRef}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1"
          data-testid="git-module-groups"
        >
          {visibleModules.map((module) => {
            const matchedByQuery =
              queryActive && queryMatchByKey.get(module.key) === true;
            const expanded = matchedByQuery
              ? true
              : (expandedByKey[module.key] ?? module.defaultExpanded);
            const moduleMatchesHeader =
              queryActive && module.searchText.includes(normalizedQuery);
            return (
              <GitModuleGroupView
                key={module.key}
                epicId={props.epicId}
                viewTabId={props.viewTabId}
                hostId={props.hostId}
                module={module}
                expanded={expanded}
                query={moduleMatchesHeader ? "" : appliedQuery}
                lastUpdatedAtMs={props.lastUpdatedAtMs}
                onToggle={toggleModule}
                onHeaderRef={registerModuleHeader}
                sectionCollapsedByKey={sectionCollapsedByKey}
                onToggleModuleSection={toggleModuleSection}
                onClearQuery={handleClearSearch}
                onRefresh={props.onRefresh}
                isRefreshing={props.isRefreshing}
              />
            );
          })}
          {!queryActive && props.hiddenCleanModuleCount > 0 ? (
            <div className="px-2 pt-1">
              <button
                type="button"
                onClick={handleToggleCleanModules}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2 py-1.5",
                  "text-left text-ui-xs text-muted-foreground transition-colors hover:bg-muted/30",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                data-testid="git-clean-modules-affordance"
              >
                <span>
                  {showCleanModules ? "Hide" : "Show"}{" "}
                  {props.hiddenCleanModuleCount} clean{" "}
                  {props.hiddenCleanModuleCount === 1
                    ? "submodule"
                    : "submodules"}
                </span>
                <span aria-hidden>{showCleanModules ? "−" : "+"}</span>
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function GitSnapshotErrorBanner(props: { readonly error: HostRpcError }) {
  return (
    <div
      role="alert"
      className="mx-2 mt-1.5 flex shrink-0 items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-ui-xs text-warning-foreground"
      data-testid="git-snapshot-error-banner"
    >
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        {props.error.message || "Could not refresh git changes"}
      </span>
    </div>
  );
}

function GitModuleSearch(props: {
  readonly searchQuery: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly onSearchChange: (event: ChangeEvent<HTMLInputElement>) => void;
  readonly onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onClearSearch: () => void;
}): ReactNode {
  return (
    <div className="shrink-0 bg-background/50 px-2 py-1.5">
      <InputGroup className="h-7 border-transparent bg-muted/25 shadow-none focus-within:bg-muted/35">
        <InputGroupAddon align="inline-start">
          <Search className="size-3.5" aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="text"
          value={props.searchQuery}
          onChange={props.onSearchChange}
          onKeyDown={props.onSearchKeyDown}
          placeholder={props.placeholder}
          aria-label={props.ariaLabel}
          className="text-ui-sm"
        />
        {props.searchQuery.length > 0 ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              onClick={props.onClearSearch}
              aria-label="Clear filter"
            >
              <X className="size-3.5" aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </div>
  );
}

function SingleRepoChangesView(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly module: GitModuleGroup;
  readonly query: string;
  readonly lastUpdatedAtMs: number | null;
  readonly sectionCollapsedByKey: Readonly<Record<string, boolean>>;
  readonly onToggleModuleSection: (
    module: GitModuleGroup,
    group: GitDiffBundleGroup,
  ) => void;
  readonly onClearQuery: () => void;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}): ReactNode {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1"
      data-testid="git-single-repo-changes"
    >
      <GitModuleBody
        epicId={props.epicId}
        viewTabId={props.viewTabId}
        hostId={props.hostId}
        module={props.module}
        query={props.query}
        lastUpdatedAtMs={props.lastUpdatedAtMs}
        sectionCollapsedByKey={props.sectionCollapsedByKey}
        onToggleModuleSection={props.onToggleModuleSection}
        onClearQuery={props.onClearQuery}
        onRefresh={props.onRefresh}
        isRefreshing={props.isRefreshing}
      />
    </div>
  );
}

function GitModuleGroupView(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly module: GitModuleGroup;
  readonly expanded: boolean;
  readonly query: string;
  readonly lastUpdatedAtMs: number | null;
  readonly onToggle: (module: GitModuleGroup) => void;
  readonly onHeaderRef: (
    moduleKey: string,
    element: HTMLButtonElement | null,
  ) => void;
  readonly sectionCollapsedByKey: Readonly<Record<string, boolean>>;
  readonly onToggleModuleSection: (
    module: GitModuleGroup,
    group: GitDiffBundleGroup,
  ) => void;
  readonly onClearQuery: () => void;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}): ReactNode {
  const { module } = props;
  const { onHeaderRef } = props;
  const headerElementRef = useRef<HTMLButtonElement | null>(null);
  const [sectionStickyTop, setSectionStickyTop] = useState(
    GIT_SECTION_STICKY_TOP_NONE,
  );
  const expandedFileBody =
    props.expanded &&
    !module.unavailable &&
    module.repoRoot !== null &&
    module.files.length > 0;
  const updateSectionStickyTop = useCallback(() => {
    const element = headerElementRef.current;
    if (element === null) return;
    const next = `${Math.ceil(element.getBoundingClientRect().height)}px`;
    setSectionStickyTop((current) => (current === next ? current : next));
  }, []);
  const handleHeaderRef = useCallback(
    (moduleKey: string, element: HTMLButtonElement | null) => {
      headerElementRef.current = element;
      onHeaderRef(moduleKey, element);
      updateSectionStickyTop();
    },
    [onHeaderRef, updateSectionStickyTop],
  );
  useLayoutEffect(() => {
    const element = headerElementRef.current;
    if (element === null) return;
    updateSectionStickyTop();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateSectionStickyTop);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateSectionStickyTop]);

  return (
    <section
      className={cn(
        "flex flex-none flex-col border-b border-border/50 last:border-b-0",
        module.kind === "submodule" && "bg-muted/[0.03]",
        module.clean && "opacity-70",
      )}
      data-testid={moduleGroupTestId(module)}
      data-clean={module.clean ? "true" : "false"}
      data-file-body-expanded={expandedFileBody ? "true" : "false"}
    >
      <GitModuleHeader
        module={module}
        expanded={props.expanded}
        onToggle={props.onToggle}
        onHeaderRef={handleHeaderRef}
      />
      {props.expanded ? (
        <div
          className={cn(
            "bg-background/55",
            expandedFileBody && "overflow-visible",
          )}
          style={gitSectionStickyStyle(sectionStickyTop)}
        >
          <GitModuleBody
            epicId={props.epicId}
            viewTabId={props.viewTabId}
            hostId={props.hostId}
            module={module}
            query={props.query}
            lastUpdatedAtMs={props.lastUpdatedAtMs}
            sectionCollapsedByKey={props.sectionCollapsedByKey}
            onToggleModuleSection={props.onToggleModuleSection}
            onClearQuery={props.onClearQuery}
            onRefresh={props.onRefresh}
            isRefreshing={props.isRefreshing}
          />
        </div>
      ) : null}
    </section>
  );
}

function GitModuleHeader(props: {
  readonly module: GitModuleGroup;
  readonly expanded: boolean;
  readonly onToggle: (module: GitModuleGroup) => void;
  readonly onHeaderRef: (
    moduleKey: string,
    element: HTMLButtonElement | null,
  ) => void;
}): ReactNode {
  const { module, onHeaderRef, onToggle } = props;
  const moduleKey = module.key;
  const parentLabel = parentReferenceLabel(module);
  const parentReferenceStatus = module.parentReference?.status ?? null;
  const countLabel = `${module.files.length} ${
    module.files.length === 1 ? "file" : "files"
  }`;
  const showCount = !props.expanded || module.files.length === 0;
  const tooltip = moduleHeaderTooltip({ module, countLabel, parentLabel });
  const path = moduleHeaderPath(module);
  const showStatusIcon = moduleHeaderStatusVisible(
    parentReferenceStatus,
    module.unavailable,
  );
  const setHeaderRef = useCallback(
    (element: HTMLButtonElement | null) => {
      onHeaderRef(moduleKey, element);
    },
    [moduleKey, onHeaderRef],
  );
  return (
    <TooltipWrapper
      label={<ModuleHeaderTooltipContent text={tooltip} />}
      side="right"
      sideOffset={8}
      align="start"
    >
      <button
        ref={setHeaderRef}
        type="button"
        onClick={() => onToggle(module)}
        className={cn(
          "@container group sticky top-0 z-40 flex w-full min-w-0 items-start gap-2 border-b border-border/40 bg-background px-2 py-1.5 text-left transition-colors hover:bg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          module.clean && "text-muted-foreground",
        )}
        aria-expanded={props.expanded}
        aria-label={moduleHeaderAccessibleName({
          module,
          countLabel,
          parentLabel,
        })}
        data-testid={`git-module-header-${moduleIdentifier(module)}`}
      >
        <ChevronDown
          className={cn(
            "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
            !props.expanded && "-rotate-90",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-ui-sm font-semibold text-foreground/90">
              {module.label}
            </span>
            {path === null ? null : (
              <StartTruncatedText className="ml-auto hidden min-w-0 max-w-[45%] shrink text-ui-xs text-muted-foreground @min-[20rem]:block">
                {path}
              </StartTruncatedText>
            )}
            {showCount ? (
              <span
                className="shrink-0 rounded bg-muted/40 px-1.5 py-0.5 text-ui-xs tabular-nums text-muted-foreground"
                data-testid={`git-module-count-${moduleIdentifier(module)}`}
              >
                {countLabel}
              </span>
            ) : (
              <span
                className="sr-only"
                data-testid={`git-module-count-${moduleIdentifier(module)}`}
              >
                {countLabel}
              </span>
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
            {module.kind === "submodule" ? (
              <span className="shrink-0 rounded-sm border border-border/60 bg-muted/30 px-1.5 py-0.5 font-medium">
                submodule
              </span>
            ) : null}
            <span className="min-w-0 truncate">{module.headLabel}</span>
            {showStatusIcon ? (
              <span
                className={parentReferenceStatusClassName(
                  parentReferenceStatus,
                  module.unavailable,
                )}
                data-testid={`git-module-parent-reference-${moduleIdentifier(module)}`}
              >
                <TriangleAlert className="size-3 shrink-0" aria-hidden />
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </TooltipWrapper>
  );
}

function parentReferenceStatusClassName(
  status: GitModuleParentReferenceStatus | null,
  unavailable: boolean,
): string {
  return cn(
    "flex min-w-0 items-center gap-1",
    (unavailable ||
      status === "differs" ||
      status === "conflicted" ||
      status === "unavailable") &&
      "font-medium text-warning",
  );
}

function GitModuleBody(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly module: GitModuleGroup;
  readonly query: string;
  readonly lastUpdatedAtMs: number | null;
  readonly sectionCollapsedByKey: Readonly<Record<string, boolean>>;
  readonly onToggleModuleSection: (
    module: GitModuleGroup,
    group: GitDiffBundleGroup,
  ) => void;
  readonly onClearQuery: () => void;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}): ReactNode {
  const { module, onToggleModuleSection, sectionCollapsedByKey } = props;
  const repoState = module.repoState;
  const banner =
    repoState !== null && repoState.kind !== "clean" ? (
      <RepoStateBanner
        state={repoState}
        repoMode={module.repoMode}
        conflictCount={conflictCount(module.files)}
      />
    ) : null;
  const sectionCollapseController = useMemo<GitDiffSectionCollapseController>(
    () => ({
      collapsed: (group) =>
        sectionCollapsedByKey[moduleSectionCollapseKey(module, group)] ?? false,
      toggle: (group) => onToggleModuleSection(module, group),
    }),
    [module, onToggleModuleSection, sectionCollapsedByKey],
  );
  if (module.unavailable) {
    return (
      <>
        {banner}
        <div className="py-2" data-testid="git-module-unavailable-body">
          <SubmoduleUnavailable
            onRefresh={props.onRefresh}
            isRefreshing={props.isRefreshing}
          />
        </div>
      </>
    );
  }
  if (module.files.length === 0 || module.repoRoot === null) {
    return (
      <>
        {banner}
        <div
          className="px-4 py-3 text-ui-sm text-muted-foreground"
          data-testid={moduleNoChangesTestId(module)}
        >
          No changes
        </div>
      </>
    );
  }
  return (
    <div className="overflow-visible">
      {banner}
      <FileList
        epicId={props.epicId}
        viewTabId={props.viewTabId}
        hostId={props.hostId}
        runningDir={module.repoRoot}
        files={module.files}
        query={props.query}
        onClearQuery={props.onClearQuery}
        hideEmptySections
        sectionCollapseController={sectionCollapseController}
        virtualized={false}
      />
    </div>
  );
}

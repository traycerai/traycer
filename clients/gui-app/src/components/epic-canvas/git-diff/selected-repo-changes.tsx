import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, GitBranch, Search, TriangleAlert, X } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { FileList } from "./file-list";
import { RepoStateBanner } from "./repo-state-banner";
import { DiffLoadingSkeleton } from "./diff-loading-skeleton";
import { NoMatchingFiles } from "./empty-states/no-matching-files";
import { SubscriptionErrorState } from "./empty-states/subscription-error-state";
import { SubmoduleUnavailable } from "./empty-states/submodule-unavailable";
import type { GitDiffSectionCollapseController } from "./git-diff-section";

const GIT_MODULE_SEARCH_DEBOUNCE_MS = 150;

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

function moduleMatchesQuery(
  module: GitModuleGroup,
  query: string,
  normalizedQuery: string,
): boolean {
  if (module.searchText.includes(normalizedQuery)) return true;
  if (module.files.length === 0) return false;
  const searchIndex = createGitChangedFileSearchIndex(module.files);
  return filterGitChangedFiles(module.files, searchIndex, query).length > 0;
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

  if (subscription.error !== null && snapshot.data === null) {
    return <SubscriptionErrorState event={subscription.error} />;
  }
  if (!source.hasLanded) {
    return <DiffLoadingSkeleton variant="panel" />;
  }

  const moduleModel = buildGitModuleGroups({
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
  });

  return (
    <GitModuleGroupsView
      epicId={props.epicId}
      viewTabId={props.viewTabId}
      hostId={props.selected.hostId}
      modules={moduleModel.modules}
      hiddenCleanModuleCount={moduleModel.hiddenCleanModuleCount}
      lastUpdatedAtMs={source.lastUpdatedAtMs}
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

  const queryMatchByKey = useMemo(() => {
    if (!queryActive) return new Map<string, boolean>();
    return new Map(
      props.modules.map((module) => [
        module.key,
        moduleMatchesQuery(module, appliedQuery, normalizedQuery),
      ]),
    );
  }, [appliedQuery, normalizedQuery, props.modules, queryActive]);

  const visibleModules = useMemo(() => {
    if (queryActive) {
      return props.modules.filter(
        (module) => queryMatchByKey.get(module.key) === true,
      );
    }
    return props.modules.filter(
      (module) => module.kind === "root" || !module.clean || showCleanModules,
    );
  }, [props.modules, queryActive, queryMatchByKey, showCleanModules]);

  const searchVisible =
    props.modules.length > 1 ||
    props.modules.some((module) => module.files.length > 0);

  if (queryActive && visibleModules.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {searchVisible ? (
          <GitModuleSearch
            searchQuery={searchQuery}
            onSearchChange={handleSearchChange}
            onSearchKeyDown={handleSearchKeyDown}
            onClearSearch={handleClearSearch}
          />
        ) : null}
        <NoMatchingFiles query={trimmedQuery} onClear={handleClearSearch} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {searchVisible ? (
        <GitModuleSearch
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          onSearchKeyDown={handleSearchKeyDown}
          onClearSearch={handleClearSearch}
        />
      ) : null}
      <div
        ref={moduleGroupsRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1"
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
    </div>
  );
}

function GitModuleSearch(props: {
  readonly searchQuery: string;
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
          placeholder="Filter submodules and files..."
          aria-label="Filter submodules and files"
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
  const repoState = module.repoState;
  const expandedFileBody =
    props.expanded &&
    !module.unavailable &&
    module.repoRoot !== null &&
    module.files.length > 0;
  const banner =
    repoState !== null && repoState.kind !== "clean" ? (
      <RepoStateBanner
        state={repoState}
        repoMode={module.repoMode}
        conflictCount={conflictCount(module.files)}
      />
    ) : null;

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
        onHeaderRef={props.onHeaderRef}
      />
      {props.expanded ? (
        <div
          className={cn(
            "bg-background/55",
            expandedFileBody && "overflow-visible",
          )}
        >
          {banner}
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
  const setHeaderRef = useCallback(
    (element: HTMLButtonElement | null) => {
      onHeaderRef(moduleKey, element);
    },
    [moduleKey, onHeaderRef],
  );
  return (
    <button
      ref={setHeaderRef}
      type="button"
      onClick={() => onToggle(module)}
      className={cn(
        "group sticky top-0 z-20 flex w-full min-w-0 items-start gap-2 bg-background/95 px-2 py-2 text-left backdrop-blur transition-colors hover:bg-muted/25",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        module.clean && "text-muted-foreground",
      )}
      aria-expanded={props.expanded}
      data-testid={`git-module-header-${moduleIdentifier(module)}`}
    >
      <ChevronDown
        className={cn(
          "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
          !props.expanded && "-rotate-90",
        )}
        aria-hidden
      />
      <GitModuleHeaderIcon
        unavailable={module.unavailable}
        parentReferenceStatus={parentReferenceStatus}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-ui-sm font-semibold text-foreground/90">
            {module.label}
          </span>
          {module.kind === "submodule" ? (
            <span className="shrink-0 rounded-sm border border-border/60 bg-muted/30 px-1.5 py-0.5 text-ui-xs font-medium text-muted-foreground">
              submodule
            </span>
          ) : null}
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
        <span className="mt-0.5 block min-w-0 truncate text-ui-xs text-muted-foreground">
          {module.headLabel}
        </span>
        {parentLabel !== null ? (
          <span
            className={parentReferenceStatusClassName(parentReferenceStatus)}
            title={module.parentReference?.summary}
            data-testid={`git-module-parent-reference-${moduleIdentifier(module)}`}
          >
            {parentReferenceStatus === "differs" ||
            parentReferenceStatus === "conflicted" ||
            parentReferenceStatus === "unavailable" ? (
              <TriangleAlert className="size-3 shrink-0" aria-hidden />
            ) : null}
            <span className="min-w-0 truncate">{parentLabel}</span>
          </span>
        ) : null}
        {module.unavailable && parentReferenceStatus !== "unavailable" ? (
          <span className="mt-0.5 block text-ui-xs font-medium text-warning">
            unavailable
          </span>
        ) : null}
      </span>
    </button>
  );
}

function GitModuleHeaderIcon(props: {
  readonly unavailable: boolean;
  readonly parentReferenceStatus: GitModuleParentReferenceStatus | null;
}): ReactNode {
  const showWarning =
    props.unavailable || props.parentReferenceStatus === "conflicted";
  if (showWarning) {
    return (
      <TriangleAlert
        className="mt-0.5 size-3.5 shrink-0 text-warning"
        aria-hidden
      />
    );
  }
  return (
    <GitBranch className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
  );
}

function parentReferenceStatusClassName(
  status: GitModuleParentReferenceStatus | null,
): string {
  return cn(
    "mt-0.5 flex min-w-0 items-center gap-1 text-ui-xs",
    status === "differs" && "font-medium text-warning",
    (status === "conflicted" || status === "unavailable") &&
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
      <div className="py-2" data-testid="git-module-unavailable-body">
        <SubmoduleUnavailable
          onRefresh={props.onRefresh}
          isRefreshing={props.isRefreshing}
        />
      </div>
    );
  }
  if (module.files.length === 0 || module.repoRoot === null) {
    return (
      <div
        className="px-4 py-3 text-ui-sm text-muted-foreground"
        data-testid={moduleNoChangesTestId(module)}
      >
        No changes
      </div>
    );
  }
  return (
    <div className="overflow-visible">
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

import { FilterSection, FilterOption } from "./history-filter-section";
import { OrganizationHistoryFilters } from "@/components/organization/organization-history-controls";
import type { ReactNode } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { MatchModeToggle } from "@/components/home/toolbar/match-mode-toggle";
import type {
  HistoryMatchMode,
  HistoryOwnershipScope,
  HistoryWorkspaceRef,
} from "@/components/home/data/home-page.data";
import {
  dedupSortWorkspaces,
  workspaceKey,
} from "@/components/home/data/home-page.data";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { EpicsFilterTrigger } from "@/components/epics/epics-filter-trigger";
import type { HistoryFacets } from "@/hooks/home/use-history-query";
import type {
  HistorySearchPatch,
  HistorySearchState,
} from "@/lib/history-search";

interface EpicsFilterPopoverProps {
  readonly availableRepos: ReadonlyArray<string>;
  readonly availableWorkspaces: ReadonlyArray<HistoryWorkspaceRef>;
  readonly search: HistorySearchState;
  readonly onSearchChange: (patch: HistorySearchPatch) => void;
  readonly facets: HistoryFacets | undefined;
  /**
   * `false` when the serving host negotiated `epic.listTasks` below @1.3 and
   * would silently discard a host filter. The section still renders any
   * ALREADY-selected host so a deep link can be undone, but offers no new
   * ones - an affordance that cannot do what it says is worse than none.
   */
  readonly chatHostFilterSupported: boolean;
}

interface ChatHostOption {
  readonly hostId: string;
  readonly label: string;
}

const OWNERSHIP_OPTIONS: ReadonlyArray<{
  readonly value: HistoryOwnershipScope;
  readonly label: string;
}> = [
  { value: "mine", label: "Mine" },
  { value: "shared", label: "Shared" },
];

function historyFilterActiveCount(search: HistorySearchState): number {
  return (
    (search.labelNames?.length ?? 0) +
    (search.groupIds?.length ?? 0) +
    (search.includeUngrouped ? 1 : 0) +
    search.ownershipScopes.length +
    search.repos.length +
    search.workspaces.length +
    search.chatHosts.length
  );
}

export function EpicsFilterPopover(props: EpicsFilterPopoverProps): ReactNode {
  const ownershipCounts = new Map(
    props.facets?.ownershipScopes.map((facet) => [facet.value, facet.count]) ??
      [],
  );
  const repoCounts = new Map(
    props.facets?.repos.map((facet) => [facet.label, facet.count]) ?? [],
  );
  const workspaceCounts = new Map(
    props.facets?.workspaces.map((facet) => [
      workspaceKey(facet.workspace),
      facet.count,
    ]) ?? [],
  );
  const repoOptions = Array.from(
    new Set([
      ...props.availableRepos,
      ...(props.facets?.repos.map((facet) => facet.label) ?? []),
      ...props.search.repos,
    ]),
  ).sort((left, right) => left.localeCompare(right));
  const workspaceOptions = dedupSortWorkspaces(
    props.availableWorkspaces,
    props.facets?.workspaces.map((facet) => facet.workspace) ?? [],
    props.search.workspaces,
  );
  const workspacePathCounts = countWorkspacePaths(workspaceOptions);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <EpicsFilterTrigger
          selectedCount={historyFilterActiveCount(props.search)}
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(var(--radix-popover-content-available-height,70vh),32rem)] w-[min(90vw,24rem)] overflow-y-auto"
        data-testid="epics-filter-popover"
      >
        <FilterSection label="Ownership" trailing={null}>
          {OWNERSHIP_OPTIONS.map((option) => (
            <FilterOption
              key={option.value}
              label={option.label}
              truncateLabelFromStart={false}
              count={ownershipCounts.get(option.value)}
              checked={props.search.ownershipScopes.includes(option.value)}
              onToggle={() => {
                props.onSearchChange({
                  ownershipScopes: withToggledValue(
                    props.search.ownershipScopes,
                    option.value,
                  ),
                });
              }}
            />
          ))}
        </FilterSection>
        <OrganizationHistoryFilters
          search={props.search}
          onSearchChange={props.onSearchChange}
        />
        <FilterSection
          label="Repositories"
          trailing={
            props.search.repos.length > 1 ? (
              <MatchModeToggle
                value={props.search.repoMode}
                selectedLabel="repositories"
                onChange={(repoMode) => {
                  props.onSearchChange({ repoMode });
                }}
              />
            ) : null
          }
        >
          {repoOptions.length === 0 ? (
            <p className="px-1 py-1.5 text-ui-xs text-muted-foreground">
              No repositories yet
            </p>
          ) : (
            repoOptions.map((repo) => (
              <FilterOption
                key={repo}
                label={repo}
                truncateLabelFromStart={false}
                count={repoCounts.get(repo)}
                checked={props.search.repos.includes(repo)}
                onToggle={() => {
                  props.onSearchChange({
                    repos: withToggledValue(props.search.repos, repo),
                  });
                }}
              />
            ))
          )}
        </FilterSection>
        <ChatHostFilterSection
          facets={props.facets}
          selected={props.search.chatHosts}
          matchMode={props.search.chatHostMode}
          supported={props.chatHostFilterSupported}
          onSearchChange={props.onSearchChange}
        />
        <FilterSection
          label="Workspaces"
          trailing={
            props.search.workspaces.length > 1 ? (
              <MatchModeToggle
                value={props.search.workspaceMode}
                selectedLabel="workspaces"
                onChange={(workspaceMode) => {
                  props.onSearchChange({ workspaceMode });
                }}
              />
            ) : null
          }
        >
          {workspaceOptions.length === 0 ? (
            <p className="px-1 py-1.5 text-ui-xs text-muted-foreground">
              No workspaces yet
            </p>
          ) : (
            workspaceOptions.map((workspace) => {
              const key = workspaceKey(workspace);
              const label = workspaceOptionLabel(
                workspace,
                workspacePathCounts,
              );
              return (
                <FilterOption
                  key={key}
                  label={label}
                  truncateLabelFromStart
                  count={workspaceCounts.get(key)}
                  checked={props.search.workspaces.some(
                    (selected) => workspaceKey(selected) === key,
                  )}
                  onToggle={() => {
                    props.onSearchChange({
                      workspaces: withToggledWorkspace(
                        props.search.workspaces,
                        workspace,
                      ),
                    });
                  }}
                />
              );
            })
          )}
        </FilterSection>
      </PopoverContent>
    </Popover>
  );
}

function ChatHostFilterSection(props: {
  readonly facets: HistoryFacets | undefined;
  readonly selected: ReadonlyArray<string>;
  readonly matchMode: HistoryMatchMode;
  readonly supported: boolean;
  readonly onSearchChange: (patch: HistorySearchPatch) => void;
}): ReactNode {
  const hostDirectory = useHostDirectoryList();
  const counts = new Map(
    props.facets?.chatHosts?.map((facet) => [facet.hostId, facet.count]) ?? [],
  );
  // A host the peer cannot filter by is not offered, so an unsupported peer
  // contributes no options and only an already-selected host survives - see
  // `buildChatHostOptions`.
  const options = buildChatHostOptions(
    props.supported
      ? (props.facets?.chatHosts?.map((facet) => facet.hostId) ?? [])
      : [],
    props.selected,
    hostDirectory.data ?? [],
  );
  return (
    <FilterSection
      label="Hosts"
      trailing={
        props.selected.length > 1 ? (
          <MatchModeToggle
            value={props.matchMode}
            selectedLabel="hosts"
            onChange={(chatHostMode) => {
              props.onSearchChange({ chatHostMode });
            }}
          />
        ) : null
      }
    >
      <ChatHostFilterOptions
        options={options}
        counts={counts}
        selected={props.selected}
        supported={props.supported}
        onSearchChange={props.onSearchChange}
      />
    </FilterSection>
  );
}

function ChatHostFilterOptions(props: {
  readonly options: ReadonlyArray<ChatHostOption>;
  readonly counts: ReadonlyMap<string, number>;
  readonly selected: ReadonlyArray<string>;
  readonly supported: boolean;
  readonly onSearchChange: (patch: HistorySearchPatch) => void;
}): ReactNode {
  if (props.options.length > 0) {
    return props.options.map((option) => (
      <FilterOption
        key={option.hostId}
        label={option.label}
        truncateLabelFromStart={false}
        count={props.counts.get(option.hostId)}
        checked={props.selected.includes(option.hostId)}
        onToggle={() => {
          props.onSearchChange({
            chatHosts: withToggledValue(props.selected, option.hostId),
          });
        }}
      />
    ));
  }
  return (
    <p className="px-1 py-1.5 text-ui-xs text-muted-foreground">
      {props.supported
        ? "No hosts yet"
        : "This host is too old to filter by host"}
    </p>
  );
}

function withToggledValue<T extends string>(
  values: ReadonlyArray<T>,
  value: T,
): ReadonlyArray<T> {
  return values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];
}

function withToggledWorkspace(
  values: ReadonlyArray<HistoryWorkspaceRef>,
  value: HistoryWorkspaceRef,
): ReadonlyArray<HistoryWorkspaceRef> {
  const valueKey = workspaceKey(value);
  return values.some((current) => workspaceKey(current) === valueKey)
    ? values.filter((current) => workspaceKey(current) !== valueKey)
    : [...values, value];
}

/**
 * The host rows, ordered by display name.
 *
 * The facet is the source of WHICH hosts to offer - only hosts that actually
 * own chats in the caller's tasks - and the directory supplies the name. The
 * two sets deliberately do not have to agree: a host the directory no longer
 * knows (deregistered, or another machine of the user's that this one has
 * never seen) still owns chats in past tasks, so it stays selectable under its
 * raw id rather than vanishing from a filter that would still match rows.
 *
 * Selected ids are unioned in for the same reason a repo/workspace selection
 * is: a filter narrow enough to zero out its own facet must still render its
 * checkbox, or it cannot be unchecked.
 */
function buildChatHostOptions(
  facetHostIds: ReadonlyArray<string>,
  selectedHostIds: ReadonlyArray<string>,
  directory: ReadonlyArray<HostDirectoryEntry>,
): ReadonlyArray<ChatHostOption> {
  const labelsByHostId = new Map(
    directory.map((entry) => [entry.hostId, entry.label]),
  );
  const hostIds = new Set([...facetHostIds, ...selectedHostIds]);
  return Array.from(hostIds)
    .map((hostId) => ({
      hostId,
      label: labelsByHostId.get(hostId) ?? hostId,
    }))
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.hostId.localeCompare(right.hostId),
    );
}

function countWorkspacePaths(
  workspaces: ReadonlyArray<HistoryWorkspaceRef>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  workspaces.forEach((workspace) => {
    counts.set(
      workspace.workspacePath,
      (counts.get(workspace.workspacePath) ?? 0) + 1,
    );
  });
  return counts;
}

function workspaceOptionLabel(
  workspace: HistoryWorkspaceRef,
  workspacePathCounts: ReadonlyMap<string, number>,
): string {
  if ((workspacePathCounts.get(workspace.workspacePath) ?? 0) <= 1) {
    return workspace.workspacePath;
  }

  // Workspace filter identity is host-scoped; matching paths on different
  // hosts must remain separate filters while rendering distinct labels.
  return `${workspace.workspacePath} (${workspace.hostId})`;
}

import { useHostQuery } from "@/hooks/host/use-host-query";
import { MoreHorizontal, Tag } from "lucide-react";
import {
  useOrganization,
  organizationPreflight,
} from "@/hooks/organization/organization-context";
import { LIST_CLOUD_TASKS_REQUEST } from "@/lib/cloud-epic-tasks-query";
import type {
  HistorySearchPatch,
  HistorySearchState,
} from "@/lib/history-search";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MatchModeToggle } from "@/components/home/toolbar/match-mode-toggle";
import {
  FilterSection,
  FilterOption,
} from "@/components/epics/history-filter-section";

export function OrganizationHistoryOverflow() {
  const organization = useOrganization();
  if (!organization?.supported) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="History options">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={() => organization.openDialog({ kind: "manage-labels" })}
        >
          <Tag />
          Manage Labels
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function OrganizationHistoryFilters(props: {
  readonly search: HistorySearchState;
  readonly onSearchChange: (patch: HistorySearchPatch) => void;
}) {
  const organization = useOrganization();
  if (!organization?.supported) return null;
  return (
    <>
      <LabelHistoryFilters {...props} />
      <GroupHistoryFilters {...props} />
    </>
  );
}
function toggled(values: readonly string[], value: string) {
  return values.includes(value)
    ? values.filter((v) => v !== value)
    : [...values, value];
}
type OrganizationFilterProps = {
  readonly search: HistorySearchState;
  readonly onSearchChange: (patch: HistorySearchPatch) => void;
};
function LabelHistoryFilters(props: OrganizationFilterProps) {
  const organization = useOrganization();
  const client = organization?.client ?? null;
  const facets = useHostQuery({
    client,
    method: "organization.history",
    params: { ...LIST_CLOUD_TASKS_REQUEST, limit: 1, filters: null },
    cacheKeyIdentity: [organization?.userId ?? null],
    preflight: organizationPreflight(
      client,
      organization?.userId ?? null,
      "organization.history",
    ),
    options: { enabled: organization?.supported === true, staleTime: 30_000 },
  });
  const selectedLabels = props.search.labelNames ?? [];
  const selectedLabelSet = new Set(selectedLabels);
  const labelNames = [
    ...new Set([
      ...(facets.data?.organizationFacets?.labelNames ?? []),
      ...selectedLabels,
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return (
    <FilterSection
      label="Labels"
      trailing={
        selectedLabels.length > 1 ? (
          <MatchModeToggle
            value={props.search.labelMode ?? "any"}
            selectedLabel="labels"
            onChange={(labelMode) => props.onSearchChange({ labelMode })}
          />
        ) : null
      }
    >
      <div className="max-h-44 overflow-y-auto">
        {labelNames.map((name) => (
          <FilterOption
            key={name}
            label={name}
            truncateLabelFromStart={false}
            count={undefined}
            checked={selectedLabelSet.has(name)}
            onToggle={() =>
              props.onSearchChange({
                labelNames: toggled(selectedLabels, name),
              })
            }
          />
        ))}
        <LabelFilterStatus
          pending={facets.isPending}
          failed={facets.isError}
          empty={labelNames.length === 0}
        />
      </div>
    </FilterSection>
  );
}
function GroupHistoryFilters(props: OrganizationFilterProps) {
  const organization = useOrganization();
  const selectedGroups = props.search.groupIds ?? [];
  const selectedGroupSet = new Set(selectedGroups);
  return (
    <FilterSection label="Groups" trailing={null}>
      <div className="max-h-44 overflow-y-auto">
        <FilterOption
          label="No group"
          truncateLabelFromStart={false}
          count={undefined}
          checked={props.search.includeUngrouped ?? false}
          onToggle={() =>
            props.onSearchChange({
              includeUngrouped: !props.search.includeUngrouped,
            })
          }
        />
        {organization?.view?.groups.groups.map((group) => (
          <FilterOption
            key={group.groupId}
            label={group.name}
            truncateLabelFromStart={false}
            count={undefined}
            checked={selectedGroupSet.has(group.groupId)}
            onToggle={() =>
              props.onSearchChange({
                groupIds: toggled(selectedGroups, group.groupId),
              })
            }
          />
        ))}
      </div>
    </FilterSection>
  );
}

function LabelFilterStatus(props: {
  readonly pending: boolean;
  readonly failed: boolean;
  readonly empty: boolean;
}) {
  let message: string | null = null;
  if (props.pending) message = "Loading labels…";
  else if (props.failed)
    message = "Labels couldn't be loaded. Reopen to retry.";
  else if (props.empty) message = "No labels yet";
  if (message === null) return null;
  return (
    <p className="px-1 py-1.5 text-ui-xs text-muted-foreground">{message}</p>
  );
}

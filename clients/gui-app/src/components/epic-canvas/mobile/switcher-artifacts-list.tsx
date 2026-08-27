import { useCallback, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  SwitcherListHeader,
  SwitcherListRow,
} from "@/components/epic-canvas/mobile/switcher-list-row";
import { SwitcherRowActions } from "@/components/epic-canvas/mobile/switcher-row-actions";
import { SwitcherNewArtifactMenu } from "@/components/epic-canvas/mobile/switcher-create-actions";
import { useSwitcherActivate } from "@/components/epic-canvas/mobile/use-switcher-activate";
import { useNarrowedSwitcherRecords } from "@/components/epic-canvas/mobile/switcher-record-order";
import { SwitcherArtifactsViewMenu } from "@/components/epic-canvas/mobile/switcher-view-menu";
import { SwitcherSearchField } from "@/components/epic-canvas/mobile/switcher-search-field";
import { useArtifactSearchAvailable } from "@/components/epic-canvas/sidebar/artifact-search-availability";
import {
  deriveArtifactSearchStatusMessage,
  useArtifactSearchResults,
  type ArtifactSearchResults,
} from "@/components/epic-canvas/sidebar/use-artifact-search-results";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  ARTIFACT_FILTER_EMPTY_DESCRIPTION,
  FILTERED_EMPTY_TITLE,
  useArtifactFilterMatchIds,
} from "@/components/epic-canvas/sidebar/epic-sidebar-panel-filters";
import {
  useArtifactFilter,
  useArtifactSort,
  type ArtifactFilter,
} from "@/stores/epics/left-panel-store";
import {
  useEpicArtifactRecords,
  useEpicPermissionRole,
  type EpicTreeRecord,
} from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import {
  computeDescendantCounts,
  formatCascadeSummary,
} from "@/lib/epic-tree-cascade";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import { FileText, Search, SearchX } from "lucide-react";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import {
  STATUS_DOT_CLASSES,
  computeArtifactNodeStatusDot,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import { useIsActiveEpicArtifact } from "@/stores/epics/canvas/canvas-selectors";
import {
  isOpenableEpicNodeKind,
  makeOpenableNodeRef,
} from "@/stores/epics/canvas/types";
import { cn } from "@/lib/utils";

/**
 * Matches the sidebar's own search debounce: long enough that a typed word is
 * one request rather than five, short enough that the list does not feel stuck.
 */
const SEARCH_DEBOUNCE_MS = 200;

interface SwitcherListProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * Artifacts category: spec / ticket / story / review as a flat list over the
 * shared `useEpicArtifactRecords()` projection (everything that is not a chat or
 * terminal-agent). Reuses the desktop status-dot helpers; no tree rendering.
 */
export function SwitcherArtifactsList(props: SwitcherListProps) {
  const { epicId, tabId, onClose } = props;
  const records = useEpicArtifactRecords();
  const filtered = useMemo(
    () =>
      records.filter(
        (record) => record.type !== "chat" && record.type !== "terminal-agent",
      ),
    [records],
  );
  const artifactFilter = useArtifactFilter(epicId);
  const artifacts = useNarrowedSwitcherRecords(
    filtered,
    useArtifactFilterMatchIds(epicId),
    useArtifactSort(epicId),
  );
  const canMutate = isEditableRole(useEpicPermissionRole());
  // Query state is the sheet's, not the store's - see the Agents list for why a
  // query must not outlive a sheet that closes on the first tap.
  const [searchQuery, setSearchQuery] = useState("");
  // The same gate the sidebar's affordance uses: emptiness, not size. An epic
  // with no artifacts has nothing to match, so offering to search it is a dead
  // end - and the category's own "No artifacts yet." already says so.
  const searchAvailable = useArtifactSearchAvailable();
  const debouncedQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);
  const search = useArtifactSearchResults({ epicId, debouncedQuery });
  // Hits are the host's, ordered by its ranking; the rows are this list's own.
  // A hit the projection cannot resolve is stale in the on-disk mirror, and the
  // switcher has no row to offer for it - unlike the sidebar, which lists it and
  // reports the staleness when tapped. Dropping it keeps every row openable.
  const recordById = useMemo(
    () => new Map(records.map((record) => [record.id, record])),
    [records],
  );
  const hitRecords = useMemo(
    () =>
      search.results.flatMap((hit) => {
        const record = recordById.get(hit.artifactId);
        return record === undefined ? [] : [record];
      }),
    [search.results, recordById],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SwitcherListHeader
        // Gated exactly as the sidebar's affordance is: withheld only on an epic
        // with nothing to match, never rendered as a dead control.
        search={
          searchAvailable ? (
            <SwitcherSearchField
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder="Search artifacts…"
              label="Search artifacts"
              clearLabel="Clear artifact search"
              testIdPrefix="switcher-artifacts-search"
            />
          ) : null
        }
        action={
          canMutate ? (
            <SwitcherNewArtifactMenu
              epicId={epicId}
              tabId={tabId}
              onClose={onClose}
            />
          ) : null
        }
        viewMenu={<SwitcherArtifactsViewMenu epicId={epicId} />}
      />
      {search.searchActive ? (
        <SwitcherArtifactSearchResults
          search={search}
          hitRecords={hitRecords}
          records={records}
          epicId={epicId}
          tabId={tabId}
          onClose={onClose}
        />
      ) : (
        <SwitcherArtifactBrowseList
          artifacts={artifacts}
          hasAnyArtifacts={filtered.length > 0}
          filter={artifactFilter}
          records={records}
          epicId={epicId}
          tabId={tabId}
          onClose={onClose}
        />
      )}
    </div>
  );
}

/**
 * The category's ordinary list: every artifact surviving the facet filters, in
 * the epic's sort order. Search replaces this wholesale rather than narrowing
 * it, because the host ranks its own hits and that ranking is the answer.
 */
function SwitcherArtifactBrowseList(props: {
  readonly artifacts: ReadonlyArray<EpicTreeRecord>;
  readonly hasAnyArtifacts: boolean;
  readonly filter: ArtifactFilter;
  readonly records: ReadonlyArray<EpicTreeRecord>;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { artifacts, records, epicId, tabId, onClose } = props;
  if (artifacts.length === 0) {
    return (
      <SwitcherArtifactsEmpty
        hasAnyArtifacts={props.hasAnyArtifacts}
        filter={props.filter}
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain p-1 pb-safe-bottom">
      {artifacts.map((record) => (
        <SwitcherArtifactRow
          key={record.id}
          record={record}
          records={records}
          epicId={epicId}
          tabId={tabId}
          onClose={onClose}
        />
      ))}
    </div>
  );
}

/**
 * The host's ranked hits, as switcher rows.
 *
 * The phone needs none of the sidebar's tree-hiding machinery: this list IS the
 * results surface, so a search simply renders different rows into it. What it
 * does owe the user is the sidebar's honesty about WHY there are no rows - an
 * old host that cannot answer, a mirror that is not built yet, and a failure are
 * three different situations and only one of them means "no matches".
 */
function SwitcherArtifactSearchResults(props: {
  readonly search: ArtifactSearchResults;
  readonly hitRecords: ReadonlyArray<EpicTreeRecord>;
  readonly records: ReadonlyArray<EpicTreeRecord>;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { search, hitRecords } = props;
  const status = deriveArtifactSearchStatusMessage({
    searchActive: search.searchActive,
    isUnsupported: search.isUnsupported,
    isError: search.isError,
    response: search.response,
    resultCount: hitRecords.length,
    staleActive: false,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      <SwitcherArtifactSearchBody {...props} />
    </div>
  );
}

function SwitcherArtifactSearchBody(props: {
  readonly search: ArtifactSearchResults;
  readonly hitRecords: ReadonlyArray<EpicTreeRecord>;
  readonly records: ReadonlyArray<EpicTreeRecord>;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { search, hitRecords, records, epicId, tabId, onClose } = props;
  if (search.isUnsupported) {
    return (
      <SidebarPanelEmptyState
        icon={SearchX}
        title="Search isn't available on this host."
        description="Update this device's Traycer host to search artifacts."
        testId="epic-artifact-search-unsupported"
      />
    );
  }
  if (search.isError) {
    return (
      <div
        className="flex flex-col items-center gap-2 px-6 py-8 text-center"
        data-testid="switcher-artifacts-search-error"
      >
        <p className="text-ui-sm text-muted-foreground">
          Artifact search failed.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={search.refetch}
          data-testid="switcher-artifacts-search-retry"
        >
          Retry
        </Button>
      </div>
    );
  }
  // No response yet is the FIRST load for this query, not a quiet failure. The
  // status line above already announces it, so the spinner is decorative.
  if (search.response === null) {
    return (
      <div
        aria-hidden
        className="flex min-h-24 flex-1 items-center justify-center py-8"
      >
        <AgentSpinningDots
          className="size-4 text-muted-foreground"
          testId="switcher-artifacts-search-loading"
          variant="dots2"
        />
      </div>
    );
  }
  if (search.response.outcome === "mirror-unavailable") {
    return (
      <SidebarPanelEmptyState
        icon={Search}
        title="Artifact search isn't ready yet."
        description="This Epic's artifacts are still syncing to this device."
        testId="epic-artifact-search-mirror-unavailable"
      />
    );
  }
  if (hitRecords.length === 0) {
    return (
      <SidebarPanelEmptyState
        icon={FileText}
        title="No artifacts match your search."
        description={
          search.response.truncated
            ? "More results exist beyond the search limit - refine your query."
            : null
        }
        testId="epic-artifact-search-empty"
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain p-1 pb-safe-bottom">
      {hitRecords.map((record) => (
        <SwitcherArtifactRow
          key={record.id}
          record={record}
          records={records}
          epicId={epicId}
          tabId={tabId}
          onClose={onClose}
        />
      ))}
    </div>
  );
}

/**
 * Desktop's own artifact empty states, mounted rather than restated - same
 * component, icons, wording and test ids as the sidebar's artifact panel.
 */
function SwitcherArtifactsEmpty(props: {
  readonly hasAnyArtifacts: boolean;
  readonly filter: ArtifactFilter;
}) {
  if (!props.hasAnyArtifacts) {
    return (
      <SidebarPanelEmptyState
        icon={FileText}
        title="No artifacts yet."
        description={null}
        testId="epic-artifact-sidebar-empty"
      />
    );
  }
  return (
    <SidebarPanelEmptyState
      icon={FileText}
      title={FILTERED_EMPTY_TITLE}
      description={ARTIFACT_FILTER_EMPTY_DESCRIPTION}
      testId="epic-artifact-sidebar-filter-empty"
    />
  );
}

function SwitcherArtifactRow(props: {
  readonly record: EpicTreeRecord;
  readonly records: ReadonlyArray<EpicTreeRecord>;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { record, records, epicId, tabId, onClose } = props;
  const activate = useSwitcherActivate(epicId, tabId, onClose);
  const isActive = useIsActiveEpicArtifact(tabId, record.id);

  const onSelect = useCallback(() => {
    const type = record.type;
    if (!isOpenableEpicNodeKind(type)) return;
    activate(() =>
      makeOpenableNodeRef({
        id: record.id,
        instanceId: uuidv4(),
        type,
        name: record.name,
        hostId: record.hostId,
      }),
    );
  }, [activate, record]);

  const cascadeSummary = formatCascadeSummary(
    computeDescendantCounts(records, record.id),
  );

  return (
    <SwitcherListRow
      icon={<SwitcherArtifactIcon type={record.type} status={record.status} />}
      label={record.name}
      secondaryLabel={null}
      badge={null}
      active={isActive}
      onSelect={onSelect}
      selectTestId={`switcher-artifact-row-${record.id}`}
      actions={
        <SwitcherRowActions
          epicId={epicId}
          tabId={tabId}
          kind="artifact"
          nodeId={record.id}
          name={record.name}
          cascadeSummary={cascadeSummary}
        />
      }
    />
  );
}

function SwitcherArtifactIcon(props: {
  readonly type: EpicTreeRecord["type"];
  readonly status: number | null;
}) {
  const { type, status } = props;
  const Icon = EPIC_NODE_ICONS[type];
  const showDot = computeArtifactNodeStatusDot(type, status);
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <Icon aria-hidden className="size-4 text-muted-foreground" />
      {showDot && status !== null ? (
        <span
          aria-hidden
          className={cn(
            "absolute -right-1 -bottom-1 size-1.5 rounded-full ring-1 ring-popover",
            STATUS_DOT_CLASSES[status],
          )}
        />
      ) : null}
    </span>
  );
}

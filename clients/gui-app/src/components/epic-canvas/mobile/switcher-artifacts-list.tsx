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
import {
  buildSwitcherArtifactTree,
  type SwitcherTreeNode,
} from "@/components/epic-canvas/mobile/switcher-artifact-tree";
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
  INDENT_PX,
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
 * Artifacts category: spec / ticket / story / review over the shared
 * `useEpicArtifactRecords()` projection (everything that is not a chat or
 * terminal-agent). Reuses the desktop status-dot helpers, the desktop indent
 * step and the desktop tree's roles, so a nested artifact reads as nested here
 * exactly as it does in the sidebar and in the Agents category beside it -
 * which mounts the desktop chat tree outright.
 *
 * What this surface does NOT take from the sidebar is collapsing. Every node is
 * always drawn, so there is no chevron column - which is also why the sidebar's
 * indent-guide rails are absent: `TreeGroupGuide` is positioned against the
 * parent's chevron, and a rail here would descend from nothing.
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
 * the epic's sort order, each child grouped under whichever of its ancestors
 * survived with it. Search replaces this wholesale rather than narrowing it,
 * because the host ranks its own hits and that ranking is the answer.
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
  const roots = useMemo(
    () => buildSwitcherArtifactTree(artifacts),
    [artifacts],
  );
  if (roots.length === 0) {
    return (
      <SwitcherArtifactsEmpty
        hasAnyArtifacts={props.hasAnyArtifacts}
        filter={props.filter}
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain p-1 pb-safe-bottom">
      {/* The desktop artifact tree's roles, for the same reason it carries
          them: indentation is a sighted reader's only cue, and a screen
          reader that is handed a flat run of buttons is told nothing at all
          about what contains what. Level comes from the nesting itself
          (`role="group"`), exactly as it does on the sidebar. */}
      <ul role="tree" aria-label="Epic artifacts tree" className="space-y-0.5">
        {roots.map((node) => (
          <SwitcherArtifactNode
            key={node.record.id}
            node={node}
            depth={0}
            records={records}
            epicId={epicId}
            tabId={tabId}
            onClose={onClose}
          />
        ))}
      </ul>
    </div>
  );
}

function SwitcherArtifactNode(props: {
  readonly node: SwitcherTreeNode;
  readonly depth: number;
  readonly records: ReadonlyArray<EpicTreeRecord>;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { node, depth, records, epicId, tabId, onClose } = props;
  const isActive = useIsActiveEpicArtifact(tabId, node.record.id);
  return (
    // A tree that never collapses still owes its branches an expansion state:
    // with none, a parent is announced as a leaf and the group under it reads
    // as unrelated. Leaves omit the attribute entirely - that omission is what
    // marks them as leaves, so it must not be `false`.
    <li
      role="treeitem"
      aria-selected={isActive}
      aria-expanded={node.children.length > 0 ? true : undefined}
    >
      <SwitcherArtifactRow
        record={node.record}
        depth={depth}
        active={isActive}
        records={records}
        epicId={epicId}
        tabId={tabId}
        onClose={onClose}
      />
      {node.children.length === 0 ? null : (
        <ul role="group" className="mt-0.5 space-y-0.5">
          {node.children.map((child) => (
            <SwitcherArtifactNode
              key={child.record.id}
              node={child}
              depth={depth + 1}
              records={records}
              epicId={epicId}
              tabId={tabId}
              onClose={onClose}
            />
          ))}
        </ul>
      )}
    </li>
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
      {/* Hits stay flat at depth 0, and carry no tree roles. They are a
          ranking, not a tree: indenting one under another would claim a
          containment the host's ordering never asserted, and the parent it
          looked nested under may not even be a hit. */}
      {hitRecords.map((record) => (
        <SwitcherArtifactSearchRow
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

/**
 * One artifact row, indented by its depth in the list's own tree.
 *
 * The indent is the sidebar's `INDENT_PX` step rather than a mobile-only scale,
 * so a tree the user reads on the phone steps at the same rate as the one they
 * read on the desktop. It is padding on a wrapper, not on the row, which keeps
 * the row itself the shared `SwitcherListRow` every other category renders -
 * indentation narrows the row, and cannot shorten it below its 44px minimum.
 */
function SwitcherArtifactRow(props: {
  readonly record: EpicTreeRecord;
  readonly depth: number;
  readonly active: boolean;
  readonly records: ReadonlyArray<EpicTreeRecord>;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { record, depth, active, records, epicId, tabId, onClose } = props;
  const activate = useSwitcherActivate(epicId, tabId, onClose);

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
    // `min-w-0` for the same reason the row's own levels carry it: this wrapper
    // is one more level between the scroll container and the truncating label,
    // and one level that may not shrink below its content re-inflates the row.
    <div
      className="min-w-0"
      data-depth={depth}
      data-testid={`switcher-artifact-node-${record.id}`}
      style={{ paddingLeft: `${depth * INDENT_PX}px` }}
    >
      <SwitcherListRow
        icon={
          <SwitcherArtifactIcon type={record.type} status={record.status} />
        }
        label={record.name}
        secondaryLabel={null}
        badge={null}
        active={active}
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
    </div>
  );
}

/**
 * A ranked hit. Same row, no tree membership: it reads its own active state
 * because there is no enclosing `treeitem` to have read it already.
 */
function SwitcherArtifactSearchRow(props: {
  readonly record: EpicTreeRecord;
  readonly records: ReadonlyArray<EpicTreeRecord>;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const isActive = useIsActiveEpicArtifact(props.tabId, props.record.id);
  return <SwitcherArtifactRow {...props} depth={0} active={isActive} />;
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

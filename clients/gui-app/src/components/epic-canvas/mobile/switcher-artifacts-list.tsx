import { useCallback, useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  SwitcherListEmpty,
  SwitcherListHeader,
  SwitcherListRow,
} from "@/components/epic-canvas/mobile/switcher-list-row";
import { SwitcherRowActions } from "@/components/epic-canvas/mobile/switcher-row-actions";
import { SwitcherNewArtifactMenu } from "@/components/epic-canvas/mobile/switcher-create-actions";
import { useSwitcherActivate } from "@/components/epic-canvas/mobile/use-switcher-activate";
import { useNarrowedSwitcherRecords } from "@/components/epic-canvas/mobile/switcher-record-order";
import { SwitcherArtifactsViewMenu } from "@/components/epic-canvas/mobile/switcher-view-menu";
import {
  ARTIFACT_FILTER_EMPTY_DESCRIPTION,
  FILTERED_EMPTY_TITLE,
  useArtifactFilterMatchIds,
} from "@/components/epic-canvas/sidebar/epic-sidebar-panel-filters";
import {
  isArtifactFilterActive,
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SwitcherListHeader
        // No search field: the sidebar's artifact search is not a narrowing of
        // this list but a separate ranked-results surface, host-side over
        // artifact BODIES as well as titles. A title-only filter here would
        // silently answer a different question than the sidebar does for the
        // same query, so the affordance waits for the results surface.
        search={null}
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
      {artifacts.length === 0 ? (
        <SwitcherArtifactsEmpty filter={artifactFilter} />
      ) : (
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
      )}
    </div>
  );
}

/**
 * Why the list is empty, in the sidebar's own words. An epic narrowed to
 * nothing must not read as an epic with nothing in it - the two states look
 * identical and only one of them is the user's own doing.
 */
function SwitcherArtifactsEmpty(props: { readonly filter: ArtifactFilter }) {
  if (isArtifactFilterActive(props.filter)) {
    return (
      <SwitcherListEmpty
        message={FILTERED_EMPTY_TITLE}
        description={ARTIFACT_FILTER_EMPTY_DESCRIPTION}
      />
    );
  }
  return <SwitcherListEmpty message="No artifacts yet." description={null} />;
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
    activate(record.id, () =>
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

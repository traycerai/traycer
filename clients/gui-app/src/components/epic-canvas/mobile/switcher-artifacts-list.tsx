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
import { useOrderedSwitcherRecords } from "@/components/epic-canvas/mobile/switcher-record-order";
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
  STATUS_LABELS,
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
        (record) =>
          record.type !== "chat" && record.type !== "terminal-agent",
      ),
    [records],
  );
  const artifacts = useOrderedSwitcherRecords(filtered);
  const canMutate = isEditableRole(useEpicPermissionRole());

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SwitcherListHeader
        action={
          canMutate ? (
            <SwitcherNewArtifactMenu
              epicId={epicId}
              tabId={tabId}
              onClose={onClose}
            />
          ) : null
        }
      />
      {artifacts.length === 0 ? (
        <SwitcherListEmpty message="No artifacts yet." />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain p-1 pb-[env(safe-area-inset-bottom)]">
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
          className={cn(
            "absolute -right-1 -bottom-1 size-1.5 rounded-full ring-1 ring-popover",
            STATUS_DOT_CLASSES[status],
          )}
          title={STATUS_LABELS[status]}
        />
      ) : null}
    </span>
  );
}

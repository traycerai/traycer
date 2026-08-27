import { useCallback, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { SwitcherAgentIcon } from "@/components/epic-canvas/mobile/switcher-agent-icon";
import {
  SwitcherListEmpty,
  SwitcherListHeader,
  SwitcherListRow,
} from "@/components/epic-canvas/mobile/switcher-list-row";
import { SwitcherRowActions } from "@/components/epic-canvas/mobile/switcher-row-actions";
import { SwitcherNewChatRow } from "@/components/epic-canvas/mobile/switcher-create-actions";
import { useSwitcherActivate } from "@/components/epic-canvas/mobile/use-switcher-activate";
import { useNarrowedSwitcherRecords } from "@/components/epic-canvas/mobile/switcher-record-order";
import { SwitcherAgentsViewMenu } from "@/components/epic-canvas/mobile/switcher-view-menu";
import { SwitcherSearchField } from "@/components/epic-canvas/mobile/switcher-search-field";
import {
  chatFilterEmptyStateDescription,
  FILTERED_EMPTY_TITLE,
  useChatFilterMatchIds,
} from "@/components/epic-canvas/sidebar/epic-sidebar-panel-filters";
import {
  chatSearchMatchIds,
  intersectMatchIds,
} from "@/components/epic-canvas/sidebar/chat-search-fuzzy";
import { CHATS_TREE_FILTER } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import {
  isChatFilterActive,
  useChatFilter,
  useChatSort,
  type ChatFilter,
} from "@/stores/epics/left-panel-store";
import {
  useEpicArtifactRecords,
  useEpicNodeHostId,
  useEpicPermissionRole,
  useEpicTreeIndex,
  type EpicTreeRecord,
} from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import {
  computeDescendantCounts,
  formatCascadeSummary,
} from "@/lib/epic-tree-cascade";
import { useIsActiveEpicArtifact } from "@/stores/epics/canvas/canvas-selectors";
import {
  isOpenableEpicNodeKind,
  makeOpenableNodeRef,
} from "@/stores/epics/canvas/types";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";

interface SwitcherListProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * Agents category: GUI chats and TUI agents interleaved in one flat list
 * (decision: interleaved, flat, no gui/tui filter v1) over the shared
 * `useEpicArtifactRecords()` projection - no duplicated data path and none of
 * the desktop tree's dnd / indentation / hover machinery.
 */
export function SwitcherAgentsList(props: SwitcherListProps) {
  const { epicId, tabId, onClose } = props;
  const records = useEpicArtifactRecords();
  const filtered = useMemo(
    () =>
      records.filter(
        (record) => record.type === "chat" || record.type === "terminal-agent",
      ),
    [records],
  );
  const chatFilter = useChatFilter(epicId);
  // Query state is the sheet's, not the store's. The sidebar persists its query
  // per tab because its panel stays on screen across everything the user does;
  // this sheet is dismissed the moment a row is tapped, so a query outliving it
  // would greet the next open with a narrowed list and no memory of why.
  const [searchQuery, setSearchQuery] = useState("");
  const tree = useEpicTreeIndex();
  const searchMatchIds = useMemo(
    () =>
      chatSearchMatchIds({
        query: searchQuery,
        nodeById: tree.nodeById,
        treeFilter: CHATS_TREE_FILTER,
      }),
    [searchQuery, tree],
  );
  // Intersect the two narrowings as MATCHES. Neither is ancestor-expanded here
  // and neither needs to be: the list is flat.
  const narrowedMatchIds = intersectMatchIds(
    useChatFilterMatchIds(epicId),
    searchMatchIds,
  );
  const agents = useNarrowedSwitcherRecords(
    filtered,
    narrowedMatchIds,
    useChatSort(epicId),
  );
  const canMutate = isEditableRole(useEpicPermissionRole());
  // Sorted for a stable query key: the list itself re-sorts by recency on every
  // turn, and an order-sensitive key would refetch each time without the set
  // having changed.
  const indicatorChatIds = useMemo(
    () => filtered.map((record) => record.id).sort(),
    [filtered],
  );
  // The rows' status glyphs read notification state out of this context. Mobile
  // had no provider at all, so every host/cloud-derived flag resolved against
  // the empty default and a failed or waiting agent read as plain idle. Scoped
  // to the EPIC SESSION host for the same reason the desktop chat tree is: these
  // agents are this session's, `chatId` is host-minted, and the app-wide active
  // host would answer about agents it does not own.
  const epicSessionHostId = useEpicSessionHostId();
  const indicators = useNotificationIndicators({
    hostId: epicSessionHostId,
    epicIds: [],
    chatIds: indicatorChatIds,
    enabled: indicatorChatIds.length > 0,
  });

  return (
    <NotificationIndicatorsProvider indicators={indicators}>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Create stays a row inside the list below, so the header carries only
            search and the view menu - unlike Artifacts, whose create is a
            header "+". */}
        <SwitcherListHeader
          search={
            <SwitcherSearchField
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder="Search agents"
              testId="switcher-agents-search"
            />
          }
          action={null}
          viewMenu={<SwitcherAgentsViewMenu epicId={epicId} />}
        />
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain p-1 pb-safe-bottom">
          {/* Editor-gated: a viewer's create is server-rejected, so an ungated
              row would only lead to a dead end. Inside the scroll region and
              above the items, so it is the first thing in the list either way. */}
          {canMutate ? (
            <SwitcherNewChatRow
              epicId={epicId}
              tabId={tabId}
              onClose={onClose}
            />
          ) : null}
          {agents.length === 0 ? (
            <SwitcherAgentsEmpty
              searchActive={searchQuery.trim().length > 0}
              filter={chatFilter}
            />
          ) : (
            agents.map((record) => (
              <SwitcherAgentRow
                key={record.id}
                record={record}
                records={records}
                epicId={epicId}
                tabId={tabId}
                onClose={onClose}
              />
            ))
          )}
        </div>
      </div>
    </NotificationIndicatorsProvider>
  );
}

/**
 * Why the list is empty, in the sidebar's own words.
 *
 * A search that matched nothing is reported as a search failure even when a
 * filter is also on, and only mentions the filter as a possible second cause:
 * blaming the filter for a query that matches nothing would send the user to
 * the wrong control. With no query, an active filter is named outright, and
 * only an epic with neither gets the "nothing here yet" reading.
 */
function SwitcherAgentsEmpty(props: {
  readonly searchActive: boolean;
  readonly filter: ChatFilter;
}) {
  const filterActive = isChatFilterActive(props.filter);
  if (props.searchActive) {
    return (
      <SwitcherListEmpty
        message="No agents match your search."
        description={
          filterActive
            ? "The current filters may also be hiding matches."
            : null
        }
      />
    );
  }
  if (filterActive) {
    return (
      <SwitcherListEmpty
        message={FILTERED_EMPTY_TITLE}
        description={chatFilterEmptyStateDescription(props.filter)}
      />
    );
  }
  return <SwitcherListEmpty message="No agents yet." description={null} />;
}

function SwitcherAgentRow(props: {
  readonly record: EpicTreeRecord;
  readonly records: ReadonlyArray<EpicTreeRecord>;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { record, records, epicId, tabId, onClose } = props;
  const activate = useSwitcherActivate(epicId, tabId, onClose);
  const isActive = useIsActiveEpicArtifact(tabId, record.id);
  const agentType: "chat" | "terminal-agent" =
    record.type === "terminal-agent" ? "terminal-agent" : "chat";

  // The host the opened tile BINDS TO, and a tab's host binding is for life -
  // so this has to be the row's owner, exactly as the desktop row resolves it
  // (`openHostId = useEpicNodeHostId(nodeId) ?? activeHostId`). `record.hostId`
  // alone is not that host: `recordForChat` stamps chat rows with the app-wide
  // ACTIVE host, so a retained epic tab bound to host A would permanently open
  // an A-owned chat against host B once the user switched hosts, and ask the
  // wrong machine for the transcript forever after.
  //
  // The fallback covers a legacy chat carrying no projected host, and is the
  // active host by construction - that is precisely what `recordForChat`
  // stamped - reusing the value already in hand rather than re-subscribing the
  // row to `useAddressableHostId()`. It differs from the desktop row only
  // in the no-active-host degenerate case, where this yields the records'
  // `UNKNOWN_HOST_PLACEHOLDER` and the sidebar its own "unknown-host" literal;
  // neither is dialable. TUI rows are unaffected either way - both sides of
  // the `??` read the same projection field for them.
  const ownerHostId = useEpicNodeHostId(record.id);
  const openHostId = ownerHostId ?? record.hostId;

  const onSelect = useCallback(() => {
    const type = record.type;
    if (!isOpenableEpicNodeKind(type)) return;
    activate(() =>
      makeOpenableNodeRef({
        id: record.id,
        instanceId: uuidv4(),
        type,
        name: record.name,
        hostId: openHostId,
      }),
    );
  }, [activate, record, openHostId]);

  const cascadeSummary = formatCascadeSummary(
    computeDescendantCounts(records, record.id),
  );

  return (
    <SwitcherListRow
      icon={
        // No host prop: the icon resolves the row's owner host itself, from the
        // same selector `openHostId` above uses. `record.hostId` is the ACTIVE
        // host for chat rows and is never the right answer for either.
        <SwitcherAgentIcon
          epicId={epicId}
          nodeId={record.id}
          type={agentType}
        />
      }
      label={record.name}
      secondaryLabel={null}
      badge={null}
      active={isActive}
      onSelect={onSelect}
      selectTestId={`switcher-agent-row-${record.id}`}
      actions={
        <SwitcherRowActions
          epicId={epicId}
          tabId={tabId}
          kind={agentType}
          nodeId={record.id}
          name={record.name}
          cascadeSummary={cascadeSummary}
        />
      }
    />
  );
}

import { useRef, useState, type ReactNode } from "react";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { EpicSidebarCloudChatRow } from "@/components/epic-canvas/sidebar/epic-sidebar-cloud-chat-row";
import { ChatTreeVirtualList } from "@/components/epic-canvas/sidebar/chat-tree-virtual-list";
import { useChatTreeRowModel } from "@/components/epic-canvas/sidebar/use-chat-tree-row-model";
import type {
  ChatTreePendingRootInput,
  ChatTreeRow,
} from "@/components/epic-canvas/sidebar/chat-tree-rows";
import type { UnifiedChatEntry } from "@/lib/chats/unified-chat-list";
import { leafCloudEntry } from "@/components/epic-canvas/sidebar/__tests__/cloud-chat-tree-entries";
import type { EpicTreeIndex } from "@/lib/epic-selectors";

/**
 * Cloud rows as the chat tree draws them: through its row model and virtual
 * list, each row inside the list's `treeitem`, which carries the row's level,
 * position, expansion and selection.
 *
 * A test file using it mocks `@tanstack/react-virtual` with the layout
 * stand-in in `@/__tests__/chat-tree-virtual-layout`, since jsdom lays nothing
 * out.
 */

const NO_PENDING: readonly ChatTreePendingRootInput[] = [];
const NO_LOCAL_TREE: EpicTreeIndex = {
  rootIds: [],
  childrenByParent: {},
  nodeById: {},
};
const ANY_TYPE = (): boolean => true;
const NOTHING_EXPANDED: ReadonlySet<string> = new Set();
/** A cloud row that leaves fades out, as the panel has it. */
const NO_ROW_GONE = (): boolean => false;

interface CloudChatTreeProps {
  readonly listEntries: readonly UnifiedChatEntry[];
  readonly tabId: string;
  readonly expandedIds: ReadonlySet<string>;
  readonly toggleExpanded: (id: string) => void;
}

export function CloudChatTree(props: CloudChatTreeProps): ReactNode {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );
  const regionRef = useRef<HTMLDivElement>(null);
  const model = useChatTreeRowModel({
    listEntries: props.listEntries,
    pendingRoots: NO_PENDING,
    tree: NO_LOCAL_TREE,
    expandedIds: props.expandedIds,
    visibleIds: null,
    treeFilter: ANY_TYPE,
    comparator: null,
    clock: null,
  });
  const renderRow = (row: ChatTreeRow): ReactNode =>
    row.kind === "cloud" ? (
      <EpicSidebarCloudChatRow
        chat={row.chat}
        hasChildren={row.hasChildren}
        expanded={row.expanded}
        expansionId={row.expansionId}
        onToggleExpanded={props.toggleExpanded}
        tabId={props.tabId}
        depth={row.depth}
        selectionMode={false}
      />
    ) : null;
  return (
    <div ref={regionRef}>
      <div ref={setScrollElement}>
        <ChatTreeVirtualList
          model={model}
          tabId={props.tabId}
          scrollElement={scrollElement}
          regionRef={regionRef}
          renderRow={renderRow}
          isRowGone={NO_ROW_GONE}
        />
      </div>
    </div>
  );
}

/** One leaf cloud row for `chat`, drawn as the tree draws it. */
export function SingleCloudChatTree(props: {
  readonly chat: CloudChatSummary;
  readonly tabId: string;
}): ReactNode {
  const [listEntries] = useState(() => [leafCloudEntry(props.chat)]);
  return (
    <CloudChatTree
      listEntries={listEntries}
      tabId={props.tabId}
      expandedIds={NOTHING_EXPANDED}
      toggleExpanded={() => undefined}
    />
  );
}

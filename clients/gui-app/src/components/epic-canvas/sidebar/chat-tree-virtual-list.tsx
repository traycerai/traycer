import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  defaultRangeExtractor,
  measureElement as measureRenderedElement,
  useVirtualizer,
  type Range,
} from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import { useIsActiveEpicArtifact } from "@/stores/epics/canvas/store";
import { useCloudChatRowActive } from "@/components/epic-canvas/sidebar/use-cloud-chat-row-active";
import { TreeGroupGuide } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-guide";
import type {
  ChatTreeCloudRow,
  ChatTreeLocalRow,
  ChatTreeRow,
  ChatTreeRowModel,
} from "@/components/epic-canvas/sidebar/chat-tree-rows";
import {
  createVirtualRowPinStore,
  usePinnedRowKeys,
  VirtualRowPinContext,
  withPinnedIndexes,
} from "@/components/epic-canvas/sidebar/virtual-row-pins";
import { useChatTreeListEffects } from "@/components/epic-canvas/sidebar/use-chat-tree-list-effects";
import {
  ChatTreeVirtualContext,
  useChatTreeVirtual,
  type ChatTreeVirtualApi,
  type ChatTreeVirtualizer,
} from "@/components/epic-canvas/sidebar/chat-tree-virtual-context";

/** A row's floor (`min-h-7`) - the height of every single-line row. */
const ROW_ESTIMATE_PX = 28;
/** The gap `space-y-0.5` put before every row but the first of its group. */
const ROW_GAP_PX = 2;
const ROW_OVERSCAN = 10;

function rowEstimate(row: ChatTreeRow): number {
  return ROW_ESTIMATE_PX + (row.posInSet > 1 ? ROW_GAP_PX : 0);
}

/**
 * A row's rendered height - except while its tab is hidden.
 *
 * A retained tab that is not showing is `display: none`, so every row in it
 * measures 0px. Taken at face value that collapses the list: offsets shrink,
 * the scroll is corrected against the collapse, and the tab comes back
 * somewhere else. No row is ever 0px tall while it is shown (`min-h-7`), so a
 * 0 keeps the height the row last had.
 */
function measureRow(
  element: HTMLLIElement,
  entry: ResizeObserverEntry | undefined,
  instance: ChatTreeVirtualizer,
): number {
  const size = measureRenderedElement(element, entry, instance);
  if (size > 0) return size;
  const kept = instance.measurementsCache.at(
    instance.indexFromElement(element),
  );
  return kept === undefined ? size : kept.size;
}

/** The distance from the scroller's content top to the list's top. */
function useListScrollMargin(
  scroller: HTMLDivElement | null,
  listRef: RefObject<HTMLUListElement | null>,
): number {
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (scroller === null || list === null) return;
    const measure = (): void => {
      const next =
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      setMargin((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller, listRef]);
  return margin;
}

export interface ChatTreeVirtualListProps {
  readonly model: ChatTreeRowModel;
  readonly tabId: string;
  /**
   * The panel's scroller, an ancestor of the list. It comes as the element,
   * set from a callback ref, rather than as a ref: an ancestor's ref is
   * attached only after the list's own layout effects have run, so the
   * virtualizer reading a ref there finds no scroller and draws no rows.
   */
  readonly scrollElement: HTMLDivElement | null;
  readonly regionRef: RefObject<HTMLDivElement | null>;
  /**
   * The row's own content. Called with the row only, never with its offset,
   * so the element it returns - a memoised row - re-renders when the row's
   * facts change and not when the window moves it.
   */
  readonly renderRow: (row: ChatTreeRow) => ReactNode;
}

/**
 * The chat tree, drawn as a window of its flat rows inside the panel's
 * scroller.
 *
 * Each row is an absolutely placed `<li role="treeitem">` at its offset,
 * carrying what the nesting used to imply: its level and position for a screen
 * reader, the gap `space-y-0.5` put above it, and the indent rails of the
 * groups it sits in. The row component inside it is the same one the
 * recursive tree drew.
 */
export function ChatTreeVirtualList(props: ChatTreeVirtualListProps) {
  const { model, tabId, scrollElement, regionRef, renderRow } = props;
  const { rows, indexByKey } = model;
  const [pinStore] = useState(createVirtualRowPinStore);
  const pinnedKeys = usePinnedRowKeys(pinStore);
  const listRef = useRef<HTMLUListElement>(null);
  const scrollMargin = useListScrollMargin(scrollElement, listRef);
  const rangeExtractor = useCallback(
    (range: Range) =>
      withPinnedIndexes(defaultRangeExtractor(range), pinnedKeys, indexByKey),
    [pinnedKeys, indexByKey],
  );
  // Measurements are read here on each render, never passed through memoized
  // children - the same arrangement as the canvas layers tree.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: (index) => rowEstimate(rows[index]),
    getItemKey: (index) => rows[index].key,
    overscan: ROW_OVERSCAN,
    scrollMargin,
    rangeExtractor,
    measureElement: measureRow,
  });
  const items = virtualizer.getVirtualItems();
  const rangeVersion = items.map((item) => item.key).join("\n");
  const measureVersion = items
    .map((item) => `${item.start}:${item.size}`)
    .join(",");
  const indexOfNodeId = useCallback(
    (nodeId: string) => rows.findIndex((row) => row.nodeId === nodeId),
    [rows],
  );
  const api = useMemo<ChatTreeVirtualApi>(
    () => ({
      virtualizer,
      model,
      scrollElement: () => scrollElement,
      regionElement: () => regionRef.current,
      indexOfNodeId,
      scrollToIndex: (index, align) => {
        virtualizer.scrollToIndex(index, { align });
      },
      rangeVersion,
      measureVersion,
    }),
    [
      virtualizer,
      model,
      scrollElement,
      regionRef,
      indexOfNodeId,
      rangeVersion,
      measureVersion,
    ],
  );
  return (
    <ChatTreeVirtualContext.Provider value={api}>
      <VirtualRowPinContext.Provider value={pinStore}>
        <ChatTreeListEffects />
        <ul
          ref={listRef}
          role="tree"
          aria-label="Epic agents tree"
          // The number of rows the tree draws - every row a branch shows,
          // none a collapsed branch hides - whether or not the window has
          // them mounted.
          data-chat-tree-row-count={rows.length}
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((item) => (
            <ChatTreeVirtualItem
              key={item.key}
              row={rows[item.index]}
              index={item.index}
              top={item.start - scrollMargin}
              measure={virtualizer.measureElement}
              tabId={tabId}
              renderRow={renderRow}
            />
          ))}
        </ul>
      </VirtualRowPinContext.Provider>
    </ChatTreeVirtualContext.Provider>
  );
}

/** Runs the effects seam with the live API, as its own leaf. */
function ChatTreeListEffects(): null {
  useChatTreeListEffects(useChatTreeVirtual());
  return null;
}

interface ChatTreeVirtualItemProps {
  readonly row: ChatTreeRow;
  readonly index: number;
  readonly top: number;
  readonly measure: (element: HTMLLIElement | null) => void;
  readonly tabId: string;
  readonly renderRow: (row: ChatTreeRow) => ReactNode;
}

const ChatTreeVirtualItem = memo(function ChatTreeVirtualItem(
  props: ChatTreeVirtualItemProps,
) {
  switch (props.row.kind) {
    case "local":
      return <LocalTreeItem {...props} row={props.row} />;
    case "cloud":
      return <CloudTreeItem {...props} row={props.row} />;
    case "pending":
      return <ChatTreeItemShell {...props} selected={false} />;
  }
});

function LocalTreeItem(
  props: ChatTreeVirtualItemProps & { readonly row: ChatTreeLocalRow },
) {
  const selected = useIsActiveEpicArtifact(props.tabId, props.row.nodeId);
  return <ChatTreeItemShell {...props} selected={selected} />;
}

function CloudTreeItem(
  props: ChatTreeVirtualItemProps & { readonly row: ChatTreeCloudRow },
) {
  const selected = useCloudChatRowActive(props.tabId, props.row.chat);
  return <ChatTreeItemShell {...props} selected={selected} />;
}

function ChatTreeItemShell(
  props: ChatTreeVirtualItemProps & { readonly selected: boolean },
) {
  const { row, index, top, measure, renderRow, selected } = props;
  const guideDepths: number[] = [];
  for (let depth = 0; depth < row.depth; depth += 1) guideDepths.push(depth);
  return (
    <li
      ref={measure}
      data-index={index}
      data-row-key={row.key}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-selected={selected}
      // Absent on a leaf: an absent `aria-expanded` is what tells a screen
      // reader the row hides nothing.
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      className={cn("absolute left-0 w-full", row.posInSet > 1 && "pt-0.5")}
      style={{ top }}
    >
      {guideDepths.map((depth) => (
        <TreeGroupGuide key={depth} parentDepth={depth} />
      ))}
      {renderRow(row)}
    </li>
  );
}

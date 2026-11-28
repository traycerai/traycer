import {
  Fragment,
  memo,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ContextType,
  type ReactNode,
  type RefObject,
} from "react";
import {
  defaultRangeExtractor,
  measureElement as measureRenderedElement,
  useVirtualizer,
  type Range,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { AnimatePresence, LayoutGroupContext, m } from "motion/react";
import { OverlayAnchorHoldContext } from "@/components/ui/overlay-anchor-hold";
import { useReducedMotion } from "@/lib/animation/status-animation-clock";
import { cn } from "@/lib/utils";
import { useIsActiveEpicArtifact } from "@/stores/epics/canvas/store";
import { useCloudChatRowActive } from "@/components/epic-canvas/sidebar/use-cloud-chat-row-active";
import {
  TREE_GUIDE_CLASS,
  treeGuideLeft,
  useTreeRowMotion,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import {
  subtreeEnds,
  type ChatTreeCloudRow,
  type ChatTreeLocalRow,
  type ChatTreeRow,
  type ChatTreeRowModel,
} from "@/components/epic-canvas/sidebar/chat-tree-rows";
import {
  createVirtualRowPinStore,
  usePinnedRowKeys,
  VirtualRowPinContext,
  withPinnedIndexes,
  type VirtualRowPinStore,
} from "@/components/epic-canvas/sidebar/virtual-row-pins";
import { useChatTreeRowPresence } from "@/components/epic-canvas/sidebar/use-chat-tree-row-presence";
import { useChatTreeListEffects } from "@/components/epic-canvas/sidebar/use-chat-tree-list-effects";
import { ChatTreeDragSupport } from "@/components/epic-canvas/sidebar/chat-tree-drag-support";
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

function visibleNeighborIndex(
  items: readonly VirtualItem[],
  departing: ReadonlyMap<string, unknown>,
  index: number,
  viewport: { readonly top: number; readonly bottom: number },
): number | undefined {
  let before: number | undefined;
  for (const item of items) {
    if (
      item.end <= viewport.top ||
      item.start >= viewport.bottom ||
      departing.has(String(item.key))
    ) {
      continue;
    }
    if (item.index >= index) return item.index;
    before = item.index;
  }
  return before;
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
  /**
   * Whether a row that left the model left the task with it (its node is
   * gone), so it goes at once rather than fading out where it stood.
   */
  readonly isRowGone: (row: ChatTreeRow) => boolean;
}

/**
 * The chat tree, drawn as a window of its flat rows inside the panel's
 * scroller.
 *
 * Each row is an absolutely placed `<li role="treeitem">` at its offset,
 * carrying what the nesting used to imply: its level and position for a screen
 * reader, and the gap `space-y-0.5` put above it. The row component inside it
 * is the same one the recursive tree drew. Each open group's indent rail is
 * drawn beside the rows; see `ChatTreeGroupRail`.
 */
export function ChatTreeVirtualList(props: ChatTreeVirtualListProps) {
  const { tabId, scrollElement, regionRef, renderRow, isRowGone } = props;
  const { model, departing, motionStamp, completeExit } =
    useChatTreeRowPresence(props.model, isRowGone, !useReducedMotion());
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
  const ends = useMemo(() => subtreeEnds(rows), [rows]);
  const rails = groupRails(
    items.map((item) => item.index),
    {
      rows,
      indexByKey,
      ends,
      measurements: virtualizer.measurementsCache,
      scrollMargin,
    },
  );
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || departing.size === 0) return;
    const activeRow = list.ownerDocument.activeElement?.closest<HTMLElement>(
      "li[data-row-key][data-departing]",
    );
    if (activeRow?.parentElement === list) {
      const key = activeRow.dataset.rowKey;
      const index = key === undefined ? undefined : indexByKey.get(key);
      if (index !== undefined) {
        const top = virtualizer.scrollOffset ?? 0;
        const closest = visibleNeighborIndex(items, departing, index, {
          top,
          bottom: top + (virtualizer.scrollRect?.height ?? 0),
        });
        const target =
          closest === undefined
            ? null
            : list.querySelector<HTMLElement>(
                'li[data-index="' + String(closest) + '"]',
              );
        (target ?? list).focus({ preventScroll: true });
      }
    }
    // Move any focus first, so the browser does not drop it to the body.
    for (const shell of list.querySelectorAll(":scope > li[data-departing]")) {
      shell.setAttribute("inert", "");
      shell.setAttribute("aria-hidden", "true");
    }
  }, [departing, indexByKey, items, virtualizer]);
  // A fading row the window does not draw has no fade to finish.
  useLayoutEffect(() => {
    if (departing.size === 0) return;
    const drawn = new Set(items.map((item) => String(item.key)));
    for (const key of departing.keys()) {
      if (!drawn.has(key)) completeExit(key);
    }
  });
  const rangeVersion = items.map((item) => item.key).join("\n");
  const measureVersion = items
    .map((item) => JSON.stringify([item.key, item.start, item.size]))
    .join(",");
  const indexOfNodeId = useCallback(
    (nodeId: string) =>
      rows.findIndex((row) => row.nodeId === nodeId && !departing.has(row.key)),
    [departing, rows],
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
        <ChatTreeListEffects tabId={tabId} />
        <ChatTreeDragSupport tabId={tabId} />
        <ul
          ref={listRef}
          role="tree"
          tabIndex={-1}
          aria-label="Epic agents tree"
          // The number of rows the tree draws - every row a branch shows,
          // none a collapsed branch hides - whether or not the window has
          // them mounted. A row still fading out is no longer one of them.
          data-chat-tree-row-count={props.model.rows.length}
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {rails.map((rail) => (
            <ChatTreeGroupRail
              key={rail.owner.key}
              rail={rail}
              departing={departing.has(rail.owner.key)}
              motionStamp={motionStamp(rail.owner)}
            />
          ))}
          {items.map((item) => (
            <ChatTreeVirtualItem
              key={item.key}
              row={rows[item.index]}
              index={item.index}
              top={item.start - scrollMargin}
              measure={virtualizer.measureElement}
              tabId={tabId}
              renderRow={renderRow}
              departing={departing.has(rows[item.index].key)}
              motionStamp={motionStamp(rows[item.index])}
              onExitComplete={completeExit}
              pinStore={pinStore}
            />
          ))}
        </ul>
      </VirtualRowPinContext.Provider>
    </ChatTreeVirtualContext.Provider>
  );
}

/** Runs the effects seam with the live API, as its own leaf. */
function ChatTreeListEffects(props: { readonly tabId: string }): null {
  useChatTreeListEffects(useChatTreeVirtual(), props.tabId);
  return null;
}

interface ChatTreeVirtualItemProps {
  readonly row: ChatTreeRow;
  readonly index: number;
  readonly top: number;
  readonly measure: (element: HTMLLIElement | null) => void;
  readonly tabId: string;
  readonly renderRow: (row: ChatTreeRow) => ReactNode;
  /** Fading out where it stood; see `useChatTreeRowPresence`. */
  readonly departing: boolean;
  /** Changes in the render where this row may slide to a new place. */
  readonly motionStamp: number;
  readonly onExitComplete: (key: string) => void;
  readonly pinStore: VirtualRowPinStore;
}

type LayoutGroup = ContextType<typeof LayoutGroupContext>;

/**
 * A copy of the surrounding layout group, made again for each new stamp.
 * Motion re-measures a layout element whenever its layout group context
 * changes, so a new copy makes the row's element slide from where it was
 * drawn to where this render places it; under an unchanged copy the row is set
 * down at its new offset, as a measurement correction or a scroll must be.
 */
function layoutGroupForStamp(parent: LayoutGroup, stamp: number): LayoutGroup {
  void stamp;
  return { ...parent };
}

/** Where an open group's indent rail is drawn, in the list's coordinates. */
interface GroupRail {
  /** The row whose children the group holds. */
  readonly owner: ChatTreeRow;
  readonly top: number;
  readonly height: number;
}

/**
 * The rails of every group a drawn row sits in. A group's `<ul>` began under
 * its parent's row and ended with its last descendant, and its rail spanned
 * it: the rail stopped 2px short of the end, where `space-y-0.5`'s margin met
 * the rail's absolute span.
 */
interface RailLayout {
  readonly rows: readonly ChatTreeRow[];
  readonly indexByKey: ReadonlyMap<string, number>;
  /** Each row's last descendant's index; see `subtreeEnds`. */
  readonly ends: readonly number[];
  readonly measurements: readonly { readonly end: number }[];
  readonly scrollMargin: number;
}

function groupRails(
  drawnIndexes: readonly number[],
  layout: RailLayout,
): GroupRail[] {
  const { rows, indexByKey, ends, measurements, scrollMargin } = layout;
  const owners = new Set<number>();
  for (const drawn of drawnIndexes) {
    let parentKey = rows[drawn].parentKey;
    while (parentKey !== null) {
      const owner = indexByKey.get(parentKey);
      if (owner === undefined || owners.has(owner)) break;
      owners.add(owner);
      parentKey = rows[owner].parentKey;
    }
  }
  const rails: GroupRail[] = [];
  for (const owner of [...owners].sort((a, b) => a - b)) {
    const ownerBox = measurements.at(owner);
    const lastBox = measurements.at(ends[owner]);
    if (ownerBox === undefined || lastBox === undefined) continue;
    const top = ownerBox.end - scrollMargin;
    rails.push({
      owner: rows[owner],
      top,
      height: Math.max(0, lastBox.end - scrollMargin - ROW_GAP_PX - top),
    });
  }
  return rails;
}

/**
 * An open group's indent rail. The recursive tree drew it inside the group,
 * inside its parent row's motion element, so it moves and fades with that
 * row: it slides when the row slides, fades out when the row fades out, and
 * its length is set at once, as the group's own height was.
 */
function ChatTreeGroupRail(props: {
  readonly rail: GroupRail;
  readonly departing: boolean;
  readonly motionStamp: number;
}) {
  const { rail, departing, motionStamp } = props;
  const parentLayoutGroup = use(LayoutGroupContext);
  const layoutGroup = useMemo(
    () => layoutGroupForStamp(parentLayoutGroup, motionStamp),
    [parentLayoutGroup, motionStamp],
  );
  const motion = useTreeRowMotion();
  return (
    <LayoutGroupContext.Provider value={layoutGroup}>
      <AnimatePresence initial={false} presenceAffectsLayout={false}>
        {departing ? null : (
          <m.span
            key="rail"
            aria-hidden
            data-tree-guide-for={rail.owner.key}
            layout={motion.layout}
            exit={motion.exit}
            transition={motion.transition}
            className={TREE_GUIDE_CLASS}
            style={{
              left: treeGuideLeft(rail.owner.depth),
              top: rail.top,
              height: rail.height,
            }}
          />
        )}
      </AnimatePresence>
    </LayoutGroupContext.Provider>
  );
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
  const {
    row,
    index,
    top,
    measure,
    renderRow,
    selected,
    departing,
    motionStamp,
    onExitComplete,
    pinStore,
  } = props;
  const parentLayoutGroup = use(LayoutGroupContext);
  const layoutGroup = useMemo(
    () => layoutGroupForStamp(parentLayoutGroup, motionStamp),
    [parentLayoutGroup, motionStamp],
  );
  const holdRow = useCallback(() => pinStore.pin(row.key), [pinStore, row.key]);
  const shellRef = useRef<HTMLLIElement>(null);
  const bindShell = useCallback(
    (shell: HTMLLIElement | null) => {
      shellRef.current = shell;
      measure(shell);
    },
    [measure],
  );
  useLayoutEffect(() => {
    if (departing) return;
    shellRef.current?.removeAttribute("inert");
    shellRef.current?.removeAttribute("aria-hidden");
  }, [departing]);
  return (
    <li
      ref={bindShell}
      data-index={index}
      data-row-key={row.key}
      data-departing={departing ? "" : undefined}
      role={departing ? undefined : "treeitem"}
      tabIndex={-1}
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
      <LayoutGroupContext.Provider value={layoutGroup}>
        <OverlayAnchorHoldContext.Provider value={holdRow}>
          {/* The row's own presence, so its exit runs where it stood. It
            never marks the row for a re-measure (`presenceAffectsLayout`):
            the stamp above decides when a row slides. */}
          <AnimatePresence
            initial={false}
            presenceAffectsLayout={false}
            onExitComplete={() => {
              onExitComplete(row.key);
            }}
          >
            {departing ? null : <Fragment key="row">{renderRow(row)}</Fragment>}
          </AnimatePresence>
        </OverlayAnchorHoldContext.Provider>
      </LayoutGroupContext.Provider>
    </li>
  );
}

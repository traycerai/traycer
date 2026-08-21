import { useCallback, useRef, useState, type ReactNode } from "react";
import { ArrowDown, RefreshCwIcon } from "lucide-react";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import {
  EpicsListChatHostFilterUnsupported,
  EpicsListEmpty,
  EpicsListError,
  EpicsListFilteredEmpty,
  EpicsListFilteringLoading,
  EpicsListLoading,
  EpicsListShowMore,
} from "@/components/epics/epics-list-shared";
import { MobileHistoryRow } from "@/components/epics/mobile/mobile-history-row";
import {
  PULL_INDICATOR_REST_PX,
  usePullToRefresh,
} from "@/components/epics/mobile/use-pull-to-refresh";
import { cn } from "@/lib/utils";

/** Matches the row settle, so the surface and its rows share one motion. */
const SETTLE_CLASS = "transition-transform duration-[220ms]";

export interface MobileHistoryListProps {
  readonly error: Error | null;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly hasActiveFilters: boolean;
  readonly chatHostFilterUnsupported: boolean;
  readonly items: ReadonlyArray<HistoryItem>;
  readonly onRetry: () => void;
  readonly selectionMode: boolean;
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggleSelection: (id: string) => void;
  readonly onRequestDelete: (ids: ReadonlyArray<string>) => void;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly onLoadMore: () => void;
  readonly onOpenItem: (item: HistoryItem) => void;
  readonly onRefresh: () => Promise<unknown>;
}

/**
 * The task list as it renders on a phone.
 *
 * A separate body rather than a responsive variant of the desktop one: every
 * per-row affordance desktop reveals on hover has no touch equivalent, so the
 * mobile row strips back to a title and a timestamp and puts the actions behind
 * a swipe instead. Sharing one component would mean every row rendering both
 * sets of chrome and hiding one of them, which is how a list ends up slow and
 * ambiguous at once.
 *
 * This body owns the scroll container - the desktop one is handed a scroller by
 * the panel - because pull-to-refresh has to attach a non-passive listener to
 * the exact element whose scroll position gates the gesture.
 *
 * Only one row's tray may be open, and that rule lives here. A row cannot
 * enforce it (it does not know its siblings) and the panel should not have to
 * (the tray is not part of the list's data). Scrolling closes it, matching
 * every platform list where the tray is a transient state rather than a mode.
 */
export function MobileHistoryList(props: MobileHistoryListProps): ReactNode {
  const {
    error,
    isPending,
    isFetching,
    hasActiveFilters,
    chatHostFilterUnsupported,
    items,
    onRetry,
    selectionMode,
    selectedIds,
    onToggleSelection,
    onRequestDelete,
    onSetPinned,
    pendingSetPinnedEpicIds,
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
    onOpenItem,
    onRefresh,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [openTrayEpicId, setOpenTrayEpicId] = useState<string | null>(null);

  const handleTrayOpenChange = useCallback((epicId: string, open: boolean) => {
    setOpenTrayEpicId((current) => {
      if (open) return epicId;
      return current === epicId ? null : current;
    });
  }, []);

  // Selection mode replaces what a touch on a row means, so a tray left open
  // from before it was entered would be an action the row can no longer
  // reach. Derived at render rather than reset in an effect: the tray is
  // simply never open while selection mode holds, and the stored id survives
  // only as far as the next explicit open.
  const visibleTrayEpicId = selectionMode ? null : openTrayEpicId;

  const pull = usePullToRefresh({
    scrollRef,
    onRefresh,
    // Nothing to refresh into: the first load has its own skeleton, and the
    // error state has an explicit Retry.
    disabled: isPending || error !== null,
  });

  const handleScroll = useCallback(() => {
    setOpenTrayEpicId((current) => (current === null ? current : null));
  }, []);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <PullIndicator
        pullPx={pull.pullPx}
        isArmed={pull.isArmed}
        isRefreshing={pull.isRefreshing}
      />
      <div
        ref={scrollRef}
        data-testid="mobile-history-scroller"
        // `overscroll-contain` stops the webview bouncing the whole surface
        // when the pull runs past the top of the content, which would otherwise
        // move underneath the indicator this gesture is already animating.
        //
        // The bottom floor is two things at once: 2.5rem is the breathing room
        // under the last row, and the inset term is the home indicator's
        // clearance where that is larger. `max()` and not a sum - the padding
        // already clears the indicator on every device that has one, and
        // stacking them would open a visible gap for no reason.
        className={cn(
          "h-full overflow-y-auto overscroll-contain",
          "pb-[max(2.5rem,var(--safe-area-inset-bottom))]",
          !pull.isPulling && SETTLE_CLASS,
        )}
        style={{ transform: `translate3d(0, ${pull.pullPx}px, 0)` }}
        onScroll={handleScroll}
      >
        <MobileHistoryListBody
          error={error}
          isPending={isPending}
          isFetching={isFetching}
          hasActiveFilters={hasActiveFilters}
          chatHostFilterUnsupported={chatHostFilterUnsupported}
          items={items}
          onRetry={onRetry}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          openTrayEpicId={visibleTrayEpicId}
          onTrayOpenChange={handleTrayOpenChange}
          onToggleSelection={onToggleSelection}
          onRequestDelete={onRequestDelete}
          onSetPinned={onSetPinned}
          pendingSetPinnedEpicIds={pendingSetPinnedEpicIds}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={onLoadMore}
          onOpenItem={onOpenItem}
        />
      </div>
    </div>
  );
}

/**
 * The pull affordance, parked behind the list and revealed by the gap the list
 * leaves as it travels. It reports three things in order - that the gesture is
 * being read, that releasing now would refresh, and that the refresh is running
 * - so the user never has to guess which of them is true.
 */
function PullIndicator(props: {
  readonly pullPx: number;
  readonly isArmed: boolean;
  readonly isRefreshing: boolean;
}): ReactNode {
  if (props.pullPx <= 0) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 flex items-end justify-center overflow-hidden text-muted-foreground"
      style={{ height: `${props.pullPx}px` }}
      data-testid="mobile-history-pull-indicator"
      data-armed={props.isArmed ? "true" : undefined}
      aria-hidden="true"
    >
      {/* Sized to where the surface stands once the pull arms, so the glyph is
          fully revealed exactly when releasing would refresh. */}
      <span
        className="flex items-center justify-center"
        style={{ height: `${PULL_INDICATOR_REST_PX}px` }}
      >
        {props.isRefreshing ? (
          <RefreshCwIcon className="size-4 animate-spin" />
        ) : (
          <ArrowDown
            className={cn(
              "size-4 transition-transform duration-150",
              props.isArmed && "rotate-180",
            )}
            style={{
              // Fades in with the pull so the affordance appears as it is
              // earned rather than snapping in on the first pixel.
              opacity: Math.min(1, props.pullPx / PULL_INDICATOR_REST_PX),
            }}
          />
        )}
      </span>
    </div>
  );
}

interface MobileHistoryListBodyProps {
  readonly error: Error | null;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly hasActiveFilters: boolean;
  readonly chatHostFilterUnsupported: boolean;
  readonly items: ReadonlyArray<HistoryItem>;
  readonly onRetry: () => void;
  readonly selectionMode: boolean;
  readonly selectedIds: ReadonlySet<string>;
  readonly openTrayEpicId: string | null;
  readonly onTrayOpenChange: (epicId: string, open: boolean) => void;
  readonly onToggleSelection: (id: string) => void;
  readonly onRequestDelete: (ids: ReadonlyArray<string>) => void;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly onLoadMore: () => void;
  readonly onOpenItem: (item: HistoryItem) => void;
}

function MobileHistoryListBody(props: MobileHistoryListBodyProps): ReactNode {
  if (props.error !== null) {
    return <EpicsListError error={props.error} onRetry={props.onRetry} />;
  }
  if (props.isPending) {
    return <EpicsListLoading />;
  }
  // Ahead of every other empty state: the rows were WITHHELD, not absent, and
  // "No tasks yet" would be an outright false statement about the account.
  if (props.chatHostFilterUnsupported) {
    return <EpicsListChatHostFilterUnsupported />;
  }
  if (props.items.length === 0 && !props.hasActiveFilters) {
    return <EpicsListEmpty />;
  }
  if (props.items.length === 0 && props.hasActiveFilters && props.isFetching) {
    return <EpicsListFilteringLoading />;
  }
  return (
    <>
      {props.items.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="epics-list-rows">
          {props.items.map((item) => (
            <MobileHistoryRow
              key={item.id}
              item={item}
              selectionMode={props.selectionMode}
              isSelected={props.selectedIds.has(item.epicId)}
              isTrayOpen={props.openTrayEpicId === item.epicId}
              isPinPending={props.pendingSetPinnedEpicIds.has(item.epicId)}
              onTrayOpenChange={props.onTrayOpenChange}
              onToggleSelection={props.onToggleSelection}
              onRequestDelete={props.onRequestDelete}
              onSetPinned={props.onSetPinned}
              onOpen={props.onOpenItem}
            />
          ))}
        </ul>
      ) : (
        <EpicsListFilteredEmpty />
      )}
      <EpicsListShowMore
        hasNextPage={props.hasNextPage}
        isFetchingNextPage={props.isFetchingNextPage}
        onLoadMore={props.onLoadMore}
      />
    </>
  );
}

import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { cn } from "@/lib/utils";

export interface MinimapListEntry {
  readonly key: string;
  readonly label: string;
  readonly level: 1 | 2;
}

export interface MinimapListCardProps {
  readonly currentIndex: number;
  readonly cursorIndex: number;
  readonly items: ReadonlyArray<MinimapListEntry>;
  readonly onCursorIndexChange: (index: number) => void;
  readonly onSelect: (index: number) => void;
  readonly side: "left" | "right";
  readonly title: string;
}

/** Shared, single-active-row navigator used by chat turns and artifact headings. */
export function MinimapListCard({
  currentIndex,
  cursorIndex,
  items,
  onCursorIndexChange,
  onSelect,
  side,
  title,
}: MinimapListCardProps) {
  const currentRowRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());

  useLayoutEffect(() => {
    const row = currentRowRef.current;
    const list = listRef.current;
    if (row === null || list === null) return;
    const rowRect = row.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const above = rowRect.top - listRect.top;
    const below = rowRect.bottom - listRect.bottom;
    if (above >= 0 && below <= 0) return;
    list.scrollTop = Math.max(0, list.scrollTop + (above < 0 ? above : below));
  }, [currentIndex]);

  const moveFocus = (index: number): void => {
    const next = Math.max(0, Math.min(index, items.length - 1));
    onCursorIndexChange(next);
    requestAnimationFrame(() => rowRefs.current.get(next)?.focus());
  };

  const handleRowKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(items.length - 1);
    }
  };

  return (
    <div
      className={cn(
        "pointer-events-auto flex max-h-[min(60cqh,calc(100cqh_-_1rem))] flex-col overflow-hidden rounded-xl border border-border/60 bg-popover text-left text-popover-foreground shadow-lg",
        "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-100",
        side === "left" ? "origin-left" : "origin-right",
      )}
      data-minimap-list-card=""
    >
      <div className="px-3 pt-3 pb-1 text-ui-xs font-medium tracking-wide text-muted-foreground/70 uppercase">
        {title}
      </div>
      <div
        className="min-h-0 overflow-y-auto overscroll-contain p-2 pt-1"
        ref={listRef}
      >
        <div className="flex flex-col gap-0.5">
          {items.map((item, index) => {
            const current = index === currentIndex;
            const cursor = index === cursorIndex;
            return (
              <button
                aria-current={current ? "location" : undefined}
                className={cn(
                  "w-full cursor-pointer rounded-lg py-1.5 pr-3 text-left text-ui-xs font-medium leading-5 transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
                  item.level === 1 ? "pl-3" : "pl-7",
                  current
                    ? "bg-foreground/[0.10] text-foreground"
                    : "text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground",
                )}
                data-active={current ? "true" : "false"}
                data-level={item.level}
                data-minimap-list-row=""
                key={item.key}
                onClick={() => onSelect(index)}
                onFocus={() => onCursorIndexChange(index)}
                onKeyDown={(event) => handleRowKeyDown(event, index)}
                ref={(node) => {
                  if (node === null) {
                    rowRefs.current.delete(index);
                  } else {
                    rowRefs.current.set(index, node);
                  }
                  if (current) currentRowRef.current = node;
                }}
                tabIndex={cursor ? 0 : -1}
                type="button"
              >
                <span
                  className={cn(
                    item.level === 1
                      ? "line-clamp-2 break-words"
                      : "block overflow-hidden text-ellipsis whitespace-nowrap",
                  )}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

import { useLayoutEffect, useRef } from "react";
import type { ChatTreeVirtualApi } from "@/components/epic-canvas/sidebar/chat-tree-virtual-context";

interface LaidOutRow {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

interface LastLayout {
  readonly revision: number;
  readonly rows: readonly LaidOutRow[];
}

/**
 * Keeps what the reader is looking at in place when rows above it come, go or
 * move - the browser's own scroll anchoring, which the nested tree had for free
 * and absolutely placed rows do not get.
 *
 * When the row sequence changes, the row that sat at the top of the viewport
 * keeps its distance from it: the scroll moves by exactly how far that row
 * moved. Nothing moves when that row is gone (collapsed into its parent,
 * removed) or when the list is scrolled to its very top.
 *
 * The rows' old offsets are recorded after every commit, so the anchor is read
 * against the layout the reader actually saw, at the scroll offset they are at
 * when the change lands.
 *
 * A hidden tab (`display: none`, a 0px scroller) is left alone, as the browser
 * leaves it: it has no layout to anchor, and it comes back at the offset it
 * was hidden at.
 */
export function useChatTreeScrollAnchor(api: ChatTreeVirtualApi): void {
  const { virtualizer, model } = api;
  const lastLayout = useRef<LastLayout | null>(null);
  useLayoutEffect(() => {
    const previous = lastLayout.current;
    const shown = (virtualizer.scrollRect?.height ?? 0) > 0;
    if (shown && previous !== null && previous.revision !== model.revision) {
      const offset = virtualizer.scrollOffset ?? 0;
      const anchor =
        offset > 0
          ? previous.rows.find((row) => row.start <= offset && row.end > offset)
          : undefined;
      const index =
        anchor === undefined ? undefined : model.indexByKey.get(anchor.key);
      if (anchor !== undefined && index !== undefined) {
        // Re-reads the measurements for the new rows before using them.
        virtualizer.getVirtualItems();
        const moved = virtualizer.measurementsCache[index].start - anchor.start;
        if (moved !== 0) virtualizer.scrollToOffset(offset + moved);
      }
    }
    lastLayout.current = {
      revision: model.revision,
      rows: virtualizer.getVirtualItems().map((item) => ({
        key: String(item.key),
        start: item.start,
        end: item.end,
      })),
    };
  });
}

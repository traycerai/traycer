import { useEffect, useEffectEvent, useState } from "react";
import type { ChatTreeVirtualApi } from "@/components/epic-canvas/sidebar/chat-tree-virtual-context";
import { useVirtualRowPin } from "@/components/epic-canvas/sidebar/virtual-row-pins";

/**
 * Keeps the rows Tab can reach next in the DOM, so moving through the tree by
 * keyboard is what it was when every row was rendered. Rows are reached by
 * native Tab through each row's own controls, in DOM order:
 *
 * - the first row: Tab from above the tree lands on it, wherever the list is
 *   scrolled;
 * - the last row: Shift+Tab from below the tree lands on it;
 * - the row holding focus and the rows either side of it: a focused row that
 *   scrolls out stays mounted and focused, and Tab or Shift+Tab reaches the
 *   next row across the edge of the rendered window.
 *
 * The focused row is followed by key, so rows arriving above it move the pin
 * with it. It moves only when another row takes focus: focus leaving for a
 * menu or dialog keeps it, so focus can come back to a row that is still
 * there. A key that leaves the rows holds nothing.
 */
export function useChatTreeFocusPins(api: ChatTreeVirtualApi): void {
  const { model, regionElement } = api;
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const onFocusIn = useEffectEvent((event: FocusEvent): void => {
    const region = regionElement();
    const target = event.target;
    if (region === null || !(target instanceof Element)) return;
    if (!region.contains(target)) return;
    const key = target.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
    if (key !== undefined) setFocusedKey(key);
  });
  useEffect(() => {
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  const { rows } = model;
  const focusedIndex =
    focusedKey === null ? -1 : (model.indexByKey.get(focusedKey) ?? -1);
  const keyAt = (index: number): string | null =>
    index >= 0 && index < rows.length ? rows[index].key : null;
  useVirtualRowPin(keyAt(0), true);
  useVirtualRowPin(keyAt(rows.length - 1), true);
  useVirtualRowPin(keyAt(focusedIndex - 1), focusedIndex > 0);
  useVirtualRowPin(keyAt(focusedIndex), focusedIndex >= 0);
  useVirtualRowPin(keyAt(focusedIndex + 1), focusedIndex >= 0);
}

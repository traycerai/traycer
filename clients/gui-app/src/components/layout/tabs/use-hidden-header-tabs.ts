import { useCallback, useLayoutEffect, useState } from "react";
import type { TaskTabLayout } from "@/lib/layout/layout-arrangement";
import { HORIZONTAL_STRIP_AXIS } from "@/components/epic-canvas/dnd/strip-axis";
import {
  registerTabStripGeometry,
  invalidateTabStripGeometry,
  revealStripTab,
  type StripGeometrySnapshot,
} from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";

export function useHiddenHeaderTabs(layout: TaskTabLayout) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [{ hiddenTabKeys, hasOverflow }, setHiddenTabs] =
    useState<StripGeometrySnapshot>({
      hiddenTabKeys: { left: [], right: [] },
      hasOverflow: false,
    });
  useLayoutEffect(() => {
    if (element === null) return;
    return registerTabStripGeometry(element, HORIZONTAL_STRIP_AXIS, (next) => {
      setHiddenTabs((previous) =>
        previous.hasOverflow === next.hasOverflow &&
        sameKeys(previous.hiddenTabKeys.left, next.hiddenTabKeys.left) &&
        sameKeys(previous.hiddenTabKeys.right, next.hiddenTabKeys.right)
          ? previous
          : next,
      );
    });
  }, [element]);
  useLayoutEffect(() => {
    if (element !== null) invalidateTabStripGeometry(element);
  }, [element, layout]);
  const revealTab = useCallback(
    (key: string) => {
      if (element !== null) revealStripTab(element, key);
    },
    [element],
  );
  return {
    setScrollElement: setElement,
    hiddenTabKeys,
    hasOverflow,
    revealTab,
  };
}

function sameKeys(
  previous: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): boolean {
  return (
    previous.length === next.length &&
    previous.every((key, index) => key === next[index])
  );
}

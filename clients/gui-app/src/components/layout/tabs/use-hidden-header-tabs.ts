import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { TaskTabLayout } from "@/stores/settings/settings-store";
import { readHeaderStripLayoutRect } from "./header-strip-geometry";

const TAB_SELECTOR = "[data-header-tab-key]";
const PIXEL_TOLERANCE = 1;

interface ActiveTabGeometry {
  readonly width: number;
  readonly key: string | null;
  readonly visible: boolean;
}

interface HiddenTabKeys {
  readonly left: ReadonlyArray<string>;
  readonly right: ReadonlyArray<string>;
}

interface HiddenTabsState {
  readonly hiddenTabKeys: HiddenTabKeys;
  readonly hasOverflow: boolean;
}

/** Observe the rendered tabs, including split members, but not collapsed groups. */
export function useHiddenHeaderTabs(layout: TaskTabLayout) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [{ hiddenTabKeys, hasOverflow }, setHiddenTabs] =
    useState<HiddenTabsState>({
      hiddenTabKeys: { left: [], right: [] },
      hasOverflow: false,
    });
  const activeGeometry = useRef<ActiveTabGeometry | null>(null);

  const measure = useCallback(
    (preserveVisibility: boolean) => {
      const left: string[] = [];
      const right: string[] = [];
      let overflowing = false;
      if (element !== null) {
        const viewport = element.getBoundingClientRect();
        activeGeometry.current = preserveActiveTabVisibility(
          element,
          viewport,
          activeGeometry.current,
          preserveVisibility,
        );
        // Both edge slots stay mounted during overflow, even when one has no
        // hidden tabs. Add both widths back so the slots cannot keep themselves
        // mounted after a resize makes the tabs fit without them.
        let availableWidth = element.clientWidth;
        const controls = element.parentElement?.querySelectorAll<HTMLElement>(
          "[data-hidden-tabs-control]",
        );
        for (const control of controls ?? []) {
          availableWidth += control.offsetWidth;
        }
        overflowing = element.scrollWidth > availableWidth + PIXEL_TOLERANCE;
        if (overflowing) {
          for (const tab of element.querySelectorAll<HTMLElement>(
            TAB_SELECTOR,
          )) {
            const key = tab.dataset.headerTabKey;
            const rect = readHeaderStripLayoutRect(tab);
            if (key === undefined || rect.width <= 0) continue;
            if (rect.left < viewport.left - PIXEL_TOLERANCE) {
              left.push(key);
            }
            if (rect.right > viewport.right + PIXEL_TOLERANCE) {
              right.push(key);
            }
          }
        }
      }
      setHiddenTabs((previous) =>
        previous.hasOverflow === overflowing &&
        sameKeys(previous.hiddenTabKeys.left, left) &&
        sameKeys(previous.hiddenTabKeys.right, right)
          ? previous
          : { hiddenTabKeys: { left, right }, hasOverflow: overflowing },
      );
    },
    [element],
  );

  useLayoutEffect(() => {
    element
      ?.querySelector<HTMLElement>(`${TAB_SELECTOR}[aria-selected="true"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [element, layout]);

  useLayoutEffect(() => {
    if (element === null) return;
    const observer = new ResizeObserver(() => measure(true));
    const handleScroll = () => measure(false);
    const observeChildren = () => {
      observer.disconnect();
      observer.observe(element);
      if (element.parentElement !== null) {
        observer.observe(element.parentElement);
      }
      for (const child of element.children) observer.observe(child);
    };
    // Reordering tabs and collapsing groups can change visibility without
    // resizing the strip. Selection changes also refresh the active snapshot
    // so the next resize can preserve the newly selected tab's visibility.
    const mutations = new MutationObserver(() => {
      observeChildren();
      measure(true);
    });
    mutations.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    });
    element.addEventListener("scroll", handleScroll, { passive: true });
    observeChildren();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      element.removeEventListener("scroll", handleScroll);
    };
  }, [element, measure]);

  const revealTab = useCallback(
    (key: string) => {
      const tab = Array.from(
        element?.querySelectorAll<HTMLElement>(TAB_SELECTOR) ?? [],
      ).find((candidate) => candidate.dataset.headerTabKey === key);
      tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
      tab?.focus({ preventScroll: true });
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

function preserveActiveTabVisibility(
  element: HTMLDivElement,
  viewport: DOMRect,
  previous: ActiveTabGeometry | null,
  preserveVisibility: boolean,
): ActiveTabGeometry {
  const activeTab = element.querySelector<HTMLElement>(
    `${TAB_SELECTOR}[aria-selected="true"]`,
  );
  const activeKey = activeTab?.dataset.headerTabKey ?? null;
  // Newly inserted edge slots or a window resize may clip a tab that
  // was visible. Preserve that visibility, but never undo a user's scroll
  // toward other tabs/groups just because it makes an edge menu appear.
  if (
    preserveVisibility &&
    previous?.visible === true &&
    previous.key === activeKey &&
    previous.width > element.clientWidth
  ) {
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  const activeRect =
    activeTab === null ? undefined : readHeaderStripLayoutRect(activeTab);
  return {
    width: element.clientWidth,
    key: activeKey,
    visible:
      activeRect !== undefined &&
      activeRect.left >= viewport.left - PIXEL_TOLERANCE &&
      activeRect.right <= viewport.right + PIXEL_TOLERANCE,
  };
}

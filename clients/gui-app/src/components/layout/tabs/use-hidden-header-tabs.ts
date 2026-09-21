import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { TaskTabLayout } from "@/stores/settings/settings-store";

const TAB_SELECTOR = "[data-header-tab-key]";
const PIXEL_TOLERANCE = 1;

interface ActiveTabGeometry {
  readonly width: number;
  readonly key: string | null;
  readonly visible: boolean;
}

/** Observe the rendered tabs, including split members, but not collapsed groups. */
export function useHiddenHeaderTabs(layout: TaskTabLayout) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [hiddenTabKeys, setHiddenTabKeys] = useState<ReadonlyArray<string>>([]);
  const activeGeometry = useRef<ActiveTabGeometry | null>(null);

  const measure = useCallback(
    (preserveVisibility: boolean) => {
      const hidden: string[] = [];
      if (element !== null) {
        const viewport = element.getBoundingClientRect();
        activeGeometry.current = preserveActiveTabVisibility(
          element,
          viewport,
          activeGeometry.current,
          preserveVisibility,
        );
        const control = element.parentElement?.querySelector<HTMLElement>(
          "[data-hidden-tabs-control]",
        );
        // Test against the space available WITHOUT the count control. Otherwise
        // the control can keep itself visible after a resize makes every tab fit.
        const availableWidth =
          element.clientWidth + (control?.offsetWidth ?? 0);
        if (element.scrollWidth > availableWidth + PIXEL_TOLERANCE) {
          for (const tab of element.querySelectorAll<HTMLElement>(
            TAB_SELECTOR,
          )) {
            const key = tab.dataset.headerTabKey;
            const rect = tab.getBoundingClientRect();
            if (
              key !== undefined &&
              rect.width > 0 &&
              (rect.left < viewport.left - PIXEL_TOLERANCE ||
                rect.right > viewport.right + PIXEL_TOLERANCE)
            ) {
              hidden.push(key);
            }
          }
        }
      }
      setHiddenTabKeys((previous) =>
        previous.length === hidden.length &&
        previous.every((key, index) => key === hidden[index])
          ? previous
          : hidden,
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
    // resizing the strip. Observe DOM changes alongside resize and scroll.
    const mutations = new MutationObserver(() => {
      observeChildren();
      measure(true);
    });
    mutations.observe(element, { childList: true, subtree: true });
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

  return { setScrollElement: setElement, hiddenTabKeys, revealTab };
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
  // A newly inserted count control or a window resize may clip a tab that
  // was visible. Preserve that visibility, but never undo a user's scroll
  // toward other tabs/groups just because it makes the count appear.
  if (
    preserveVisibility &&
    previous?.visible === true &&
    previous.key === activeKey &&
    previous.width > element.clientWidth
  ) {
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  const activeRect = activeTab?.getBoundingClientRect();
  return {
    width: element.clientWidth,
    key: activeKey,
    visible:
      activeRect !== undefined &&
      activeRect.left >= viewport.left - PIXEL_TOLERANCE &&
      activeRect.right <= viewport.right + PIXEL_TOLERANCE,
  };
}

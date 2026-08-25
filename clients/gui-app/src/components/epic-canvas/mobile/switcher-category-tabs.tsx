import { useEffect, useRef, useState } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  switcherCategoryTitle,
  visibleSwitcherCategoryDefs,
} from "@/components/epic-canvas/mobile/switcher-categories";
import { cn } from "@/lib/utils";

interface ScrollEdges {
  readonly left: boolean;
  readonly right: boolean;
}

const NO_EDGES: ScrollEdges = { left: false, right: false };

/**
 * Which horizontal edges of the scroller currently hide content. Tracked from
 * scroll + resize so the edge fades appear only where something is actually
 * cut off (a static both-ends mask would fade the first/last tab even when
 * fully scrolled to that side).
 */
function useHorizontalScrollEdges(
  ref: React.RefObject<HTMLDivElement | null>,
): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>(NO_EDGES);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const update = () => {
      const maxScroll = el.scrollWidth - el.clientWidth;
      // 1px slack: fractional scroll positions on touch never settle on the
      // exact integer bounds.
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft < maxScroll - 1;
      setEdges((prev) =>
        prev.left === left && prev.right === right ? prev : { left, right },
      );
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [ref]);
  return edges;
}

const FADE_BOTH =
  "[-webkit-mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)] [mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]";
const FADE_LEFT =
  "[-webkit-mask-image:linear-gradient(to_right,transparent,black_1.5rem)] [mask-image:linear-gradient(to_right,transparent,black_1.5rem)]";
const FADE_RIGHT =
  "[-webkit-mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]";

function fadeClassForEdges(edges: ScrollEdges): string | null {
  if (edges.left && edges.right) return FADE_BOTH;
  if (edges.left) return FADE_LEFT;
  if (edges.right) return FADE_RIGHT;
  return null;
}

interface SwitcherCategoryTabsProps {
  /** PR presence, which decides whether the Pull requests tab is on the bar. */
  readonly hasPullRequests: boolean;
}

/**
 * The category tab bar for the mobile "Switch tab" sheet: a `line`-variant
 * `TabsList` whose triggers take natural width and scroll horizontally when the
 * curated categories overflow phone width. Rendered inside the sheet's `Tabs`
 * root so selection flows through Radix. Identity comes from
 * {@link visibleSwitcherCategoryDefs} (the desktop left-panel registry).
 */
export function SwitcherCategoryTabs(props: SwitcherCategoryTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const edges = useHorizontalScrollEdges(listRef);
  return (
    <TabsList
      ref={listRef}
      variant="line"
      // This list is a scroll container (`overflow-x-auto`), which makes
      // overflow-y compute to `auto` too - any vertical spill inside it
      // becomes a user-visible vertical scroller rather than clipping. So
      // nothing may exceed the list's height: it sizes to its triggers
      // (`h-auto` on the base height's exact modifier so tailwind-merge
      // replaces the fixed `h-8`), and the triggers themselves carry the full
      // 44px touch height (min-h-[44px] below), which also collapses the
      // coarse-pointer hit-slop `::after` (`height: max(100%, 44px)` in
      // mobile-shell-touch-targets.css) to an exact fit.
      //
      // Every override here has to spell its modifier the way `ui/tabs` spells
      // its own, or tailwind-merge sees two unrelated utilities and keeps
      // BOTH - the base height wins and the spill is back. That coupling is
      // what `switcher-category-tabs.test.tsx` derives from the primitive
      // rather than restates.
      className={cn(
        "no-scrollbar w-full justify-start gap-1 overflow-x-auto px-2 group-data-[orientation=horizontal]/tabs:h-auto",
        fadeClassForEdges(edges),
      )}
      aria-label="Tab categories"
    >
      {visibleSwitcherCategoryDefs(props.hasPullRequests).map((definition) => {
        const Icon = definition.icon;
        return (
          <TabsTrigger
            key={definition.id}
            value={definition.id}
            // `min-h-[44px]`, not `min-h-11`: this surface's root font is 15px,
            // so a rem-based `11` is 41.25px and would leave the 44px hit-slop
            // `::after` spilling out of the list's exact fit.
            //
            // `data-[state=active]:bg-transparent`: force the line-variant
            // active state fill-less (the `:where()`-neutralised line override
            // can't out-specify the base `data-[state=active]:bg-*`; same prefix
            // here, so tailwind-merge drops it) - otherwise it paints a box
            // wherever the active `--background` differs from the sheet surface,
            // e.g. a white box in a light portal.
            //
            // The active indicator is a `::before` underline, NOT ui/tabs'
            // `::after` one: the mobile-shell hit-slop
            // (`mobile-shell-touch-targets.css`) claims every trigger's single
            // `::after` under `@media (pointer: coarse)`, so on touch devices
            // that `::after` is the (now transparent) slop, not the indicator.
            // `::before` is untouched by both ui/tabs and the slop rule, so it
            // renders the underline cleanly with no shared-pseudo collision.
            // ui/tabs' own `::after` still carries a `bottom-[-5px]` offset for
            // the indicator it thinks it owns, which on a fine pointer - a
            // narrow desktop window, where this shell also renders and no slop
            // rule overrides the geometry - hangs 5px below the trigger and
            // reopens the spill; pinning it flush is the same "nothing exceeds
            // the list" rule as the height above.
            className="min-h-[44px] flex-none gap-1.5 data-[state=active]:bg-transparent dark:data-[state=active]:bg-transparent group-data-[orientation=horizontal]/tabs:after:bottom-0 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-0 before:h-0.5 before:rounded-full before:bg-foreground before:opacity-0 before:transition-opacity data-[state=active]:before:opacity-100"
            data-testid={`mobile-switcher-tab-${definition.id}`}
          >
            <Icon className="size-4" />
            {switcherCategoryTitle(definition)}
          </TabsTrigger>
        );
      })}
    </TabsList>
  );
}

import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  switcherCategoryTitle,
  visibleSwitcherCategoryDefs,
} from "@/components/epic-canvas/mobile/switcher-categories";

/**
 * The category tab bar for the mobile "Switch tab" sheet: a `line`-variant
 * `TabsList` whose triggers take natural width and scroll horizontally when the
 * five curated categories overflow phone width. Rendered inside the sheet's
 * `Tabs` root so selection flows through Radix. Identity comes from
 * {@link visibleSwitcherCategoryDefs} (the desktop left-panel registry).
 */
export function SwitcherCategoryTabs() {
  return (
    <TabsList
      variant="line"
      className="w-full justify-start gap-1 overflow-x-auto px-2"
      aria-label="Tab categories"
    >
      {visibleSwitcherCategoryDefs().map((definition) => {
        const Icon = definition.icon;
        return (
          <TabsTrigger
            key={definition.id}
            value={definition.id}
            // `data-active:bg-transparent`: force the line-variant active state
            // fill-less (the `:where()`-neutralised line override can't
            // out-specify the base `data-active:bg-*`; same prefix here, so
            // tailwind-merge drops it) - otherwise it paints a box wherever the
            // active `--background` differs from the sheet surface, e.g. a white
            // box in a light portal.
            //
            // The active indicator is a `::before` underline, NOT ui/tabs'
            // `::after` one: the mobile-shell hit-slop
            // (`mobile-shell-touch-targets.css`) claims every trigger's single
            // `::after` under `@media (pointer: coarse)`, so on touch devices
            // that `::after` is the (now transparent) slop, not the indicator.
            // `::before` is untouched by both ui/tabs and the slop rule, so it
            // renders the underline cleanly with no shared-pseudo collision.
            className="min-h-9 flex-none gap-1.5 data-active:bg-transparent dark:data-active:bg-transparent before:pointer-events-none before:absolute before:inset-x-0 before:bottom-0 before:h-0.5 before:rounded-full before:bg-foreground before:opacity-0 before:transition-opacity data-active:before:opacity-100"
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

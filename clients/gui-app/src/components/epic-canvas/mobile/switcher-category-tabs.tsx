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
            // Force the line-variant active state to underline-only: the base
            // trigger's `data-active:bg-*` fill (which the `:where()`-neutralised
            // line override can't out-specify) paints a solid box wherever the
            // active `--background` differs from the sheet's `--popover`. Same
            // `data-active:` prefix, so tailwind-merge drops the base fill.
            className="min-h-9 flex-none gap-1.5 data-active:bg-transparent dark:data-active:bg-transparent"
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

import type { ReactNode } from "react";
import { ListFilter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ProviderListSearch } from "./provider-list-search";
import {
  MODEL_PROVIDER_METHOD_FILTER,
  MODEL_PROVIDER_METHOD_FILTER_OPTIONS,
  modelProviderMethodFilterLabel,
  type ModelProviderMethodFilter,
} from "./model-provider-filter";

/**
 * The catalog's search row: the shared `ProviderListSearch` plus one filter
 * menu, laid out the way the provider rail's controls are
 * (`provider-rail-controls.tsx`) so the two search rows in Settings ▸ Providers
 * do not each invent a vocabulary.
 *
 * The search box is COMPOSED rather than modified: it is shared with the MCP,
 * Plugins and Skills tabs, and none of those has a second axis to filter on.
 */
export function ModelProviderListControls(props: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly filter: ModelProviderMethodFilter;
  readonly onFilterChange: (filter: ModelProviderMethodFilter) => void;
  readonly resultCount: number;
}): ReactNode {
  return (
    <div className="flex w-full items-start gap-1">
      <div className="min-w-0 flex-1">
        <ProviderListSearch
          query={props.query}
          onQueryChange={props.onQueryChange}
          resultCount={props.resultCount}
          resourceLabel="providers"
        />
      </div>
      <ModelProviderFilterMenu
        filter={props.filter}
        onFilterChange={props.onFilterChange}
      />
    </div>
  );
}

function ModelProviderFilterMenu(props: {
  readonly filter: ModelProviderMethodFilter;
  readonly onFilterChange: (filter: ModelProviderMethodFilter) => void;
}): ReactNode {
  const active = props.filter !== MODEL_PROVIDER_METHOD_FILTER.All;
  // The accessible name carries the CURRENT value, not just "Filter": the dot
  // below says only that something is filtered, and a screen reader gets no
  // other reading of the trigger while the menu is closed.
  const label = active
    ? `Filter model providers, showing ${modelProviderMethodFilterLabel(props.filter).toLowerCase()}`
    : "Filter model providers";
  return (
    <DropdownMenu>
      <TooltipWrapper
        label={label}
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="relative shrink-0 text-muted-foreground transition-colors hover:text-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground"
            data-testid="model-provider-filter-trigger"
          >
            <ListFilter className="size-4" />
            {/* A dot, not a count: this list has ONE filter axis, so a number
                could only ever read "1" and would invite the question of what
                the one is. Same reasoning as the provider rail's. */}
            {active ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-foreground ring-1 ring-background"
              />
            ) : null}
          </Button>
        </DropdownMenuTrigger>
      </TooltipWrapper>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel className="text-overline tracking-wide uppercase">
          Sign-in method
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={props.filter}
          onValueChange={(next) => {
            const match = MODEL_PROVIDER_METHOD_FILTER_OPTIONS.find(
              (option) => option.value === next,
            );
            if (match !== undefined) props.onFilterChange(match.value);
          }}
        >
          {MODEL_PROVIDER_METHOD_FILTER_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

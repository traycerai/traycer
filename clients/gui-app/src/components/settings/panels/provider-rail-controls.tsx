/** The sidebar hides its input because the panel it lives in owns a header row worth trading away; this rail
 * has no header, so a mode would need a trigger with nowhere to sit. */
import { ListFilter, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  isProviderRailViewActive,
  PROVIDER_RAIL_STATUS,
  PROVIDER_RAIL_STATUS_OPTIONS,
  providerRailStatusLabel,
  type ProviderRailStatus,
  type ProviderRailView,
} from "./provider-rail-filter";

export function ProviderRailControls(props: {
  readonly view: ProviderRailView;
  readonly onViewChange: (view: ProviderRailView) => void;
  readonly resultCount: number;
}) {
  const { view, onViewChange } = props;
  const setQuery = (query: string): void => onViewChange({ ...view, query });

  // NOTE: no Escape-to-clear here, deliberately. Escape belongs to the Settings

  return (
    <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1">
      <InputGroup className="h-7 min-w-0 flex-1">
        <InputGroupAddon align="inline-start">
          <Search className="size-3.5" aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="text"
          value={view.query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          aria-label="Search providers"
          autoComplete="off"
          spellCheck={false}
          className="text-ui-sm"
          data-testid="provider-rail-search-input"
        />
        {view.query.length > 0 ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="button"
              size="icon-xs"
              aria-label="Clear provider search"
              onClick={() => setQuery("")}
              data-testid="provider-rail-search-clear"
            >
              <X className="size-3.5" aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      <ProviderRailFilterMenu
        status={view.status}
        onStatusChange={(status) => onViewChange({ ...view, status })}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {railStatusMessage(view, props.resultCount)}
      </p>
    </div>
  );
}

function railStatusMessage(view: ProviderRailView, count: number): string {
  if (!isProviderRailViewActive(view)) return "";
  if (count === 0) return "No providers match.";
  return `${count} ${count === 1 ? "provider" : "providers"} shown.`;
}

function ProviderRailFilterMenu(props: {
  readonly status: ProviderRailStatus;
  readonly onStatusChange: (status: ProviderRailStatus) => void;
}) {
  const active = props.status !== PROVIDER_RAIL_STATUS.All;
  // The accessible name carries the current value, not just "Filter" - the dot below says only that something is
  // filtered, and a screen reader gets no other reading of the trigger while the menu is closed.
  const label = active
    ? `Filter providers, showing ${providerRailStatusLabel(props.status).toLowerCase()}`
    : "Filter providers";
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
            data-testid="provider-rail-filter-trigger"
          >
            <ListFilter className="size-4" />
            {/* A dot, not the sidebar's numeric badge: this rail has one filter axis, so a count could only ever read "1"
               and would invite the question of what the one is. */}
            {active ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-foreground ring-1 ring-background"
              />
            ) : null}
          </Button>
        </DropdownMenuTrigger>
      </TooltipWrapper>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuLabel className="text-overline uppercase tracking-wide">
          Show
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={props.status}
          onValueChange={(next) => {
            const match = PROVIDER_RAIL_STATUS_OPTIONS.find(
              (option) => option.value === next,
            );
            if (match !== undefined) props.onStatusChange(match.value);
          }}
        >
          {PROVIDER_RAIL_STATUS_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

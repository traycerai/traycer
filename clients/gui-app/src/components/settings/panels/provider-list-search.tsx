import { type ReactNode } from "react";
import { Search, X } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { isProviderListSearchActive } from "./provider-list-search-filter";

/**
 * The shared search affordance for MCP, Skills, and Plugins. It deliberately
 * owns the corresponding no-results state too, so all three tabs distinguish
 * an unmatched query from a provider that has no resources at all in the same
 * way.
 */
export function ProviderListSearch(props: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly resultCount: number;
  readonly resourceLabel: string;
}): ReactNode {
  const active = isProviderListSearchActive(props.query);
  const inputLabel = `Search ${props.resourceLabel.toLowerCase()}`;
  return (
    <div className="w-full">
      <InputGroup className="h-8 w-full">
        <InputGroupAddon align="inline-start">
          <Search className="size-3.5" aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="text"
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          placeholder="Search"
          aria-label={inputLabel}
          autoComplete="off"
          spellCheck={false}
          className="text-ui-sm"
        />
        {props.query.length > 0 ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="button"
              size="icon-xs"
              aria-label={`Clear ${props.resourceLabel.toLowerCase()} search`}
              onClick={() => props.onQueryChange("")}
            >
              <X className="size-3.5" aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      <p className="sr-only" role="status" aria-live="polite">
        {providerListSearchStatusMessage(
          active,
          props.resultCount,
          props.resourceLabel,
        )}
      </p>
    </div>
  );
}

export function ProviderListSearchEmptyState(props: {
  readonly query: string;
  readonly resourceLabel: string;
}): ReactNode {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-8 text-center">
      <Search className="size-5 text-muted-foreground" aria-hidden />
      <p className="text-ui-xs text-muted-foreground">
        No {props.resourceLabel.toLowerCase()} match “{props.query.trim()}”.
      </p>
    </div>
  );
}

function providerListSearchStatusMessage(
  active: boolean,
  count: number,
  resourceLabel: string,
): string {
  if (!active) return "";
  if (count === 0) return `No ${resourceLabel.toLowerCase()} match.`;
  return `${count} ${count === 1 ? resourceLabel.slice(0, -1) : resourceLabel} shown.`;
}

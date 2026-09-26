import { Check, RefreshCw } from "lucide-react";
import type {
  SuggestionRow,
  SuggestionUsage,
} from "@/components/home/data/harness-model-search";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { modelRowElementId } from "@/components/home/pickers/harness-model-picker-keyboard";
import { ProfileUsageCompactMeter } from "@/components/providers/profile-usage-compact-meter";
import { profileUsageAccessibleStatus } from "@/components/providers/profile-dropdown-usage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { rateLimitWindowFillPercent } from "@/lib/rate-limits/window-severity";
import { cn } from "@/lib/utils";

interface SuggestionItemProps {
  readonly idPrefix: string;
  readonly row: SuggestionRow;
  readonly selected: boolean;
  readonly active: boolean;
  readonly onHover: (rowId: string) => void;
  readonly onActive: (rowId: string) => void;
  readonly onSelect: (row: SuggestionRow) => void;
}

/**
 * One injected suggestion, in the model list beside the catalog rows: the
 * destination's harness icon, its title and account, the reason it is dimmed
 * when it cannot be picked, its usage, and the Recommended pill.
 *
 * The same option semantics and highlight states as a model row, so the list
 * reads as one list. A dimmed row stays an option (`aria-disabled`, not
 * `disabled`): arrows still land on it, because its reason is the most useful
 * thing on it, and selecting it is the picker's no-op.
 *
 * The usage refresh sits OUTSIDE the option element, as the empty state's
 * actions do: a button nested in an `option` is flattened by assistive tech
 * and unreachable, and a button inside a button is not valid markup.
 */
export function SuggestionItem(props: SuggestionItemProps) {
  const { idPrefix, row, selected, active, onHover, onActive, onSelect } =
    props;
  return (
    <div className="flex w-full min-w-0 items-center gap-1">
      <button
        id={modelRowElementId(idPrefix, row.id)}
        type="button"
        role="option"
        aria-selected={selected}
        aria-disabled={!row.selectable}
        data-active={active}
        data-selected={selected}
        data-suggestion-action={row.action.kind}
        className={cn(
          "group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
          active && "bg-accent/30",
          selected && "bg-accent/70",
          !row.selectable && "opacity-60",
        )}
        onMouseEnter={() => {
          onHover(row.id);
          onActive(row.id);
        }}
        onFocus={() => {
          onActive(row.id);
        }}
        onClick={() => {
          onSelect(row);
        }}
      >
        <HarnessIcon harnessId={row.harnessId} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium leading-5">
            {row.title}
          </span>
          {row.subtitle === null ? null : (
            <span className="block truncate text-ui-xs text-muted-foreground">
              {row.subtitle}
            </span>
          )}
          {row.note === null ? null : (
            <span className="block text-ui-xs text-muted-foreground">
              {row.note}
            </span>
          )}
        </span>
        <SuggestionUsageCell usage={row.usage} />
        {row.recommended ? (
          <Badge variant="muted" size="xs">
            Recommended
          </Badge>
        ) : null}
        {selected ? (
          <Check className="size-4 shrink-0 text-primary" />
        ) : (
          <span className="size-4 shrink-0" />
        )}
      </button>
      {row.usage.kind === "not-checked" ? (
        <Button
          size="icon-xs"
          variant="muted"
          aria-label="Check usage again"
          onClick={row.usage.onRefresh}
        >
          <RefreshCw aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The usage cell's words, and the meter beside them when there is a reading.
 *
 * Text first: the meter is `aria-hidden` and colour only, so the words are
 * what the row says about its headroom, and they are part of the option's
 * accessible name.
 */
function SuggestionUsageCell({ usage }: { readonly usage: SuggestionUsage }) {
  switch (usage.kind) {
    case "none":
      return null;
    case "checking":
      return <UsageText>Checking usage…</UsageText>;
    case "not-checked":
      return <UsageText>Not checked</UsageText>;
    case "reading":
      return (
        <>
          <UsageText>{usageReadingText(usage.entry)}</UsageText>
          <ProfileUsageCompactMeter entry={usage.entry} />
        </>
      );
  }
}

function UsageText({ children }: { readonly children: string }) {
  return (
    <span className="shrink-0 whitespace-nowrap text-ui-xs tabular-nums text-muted-foreground">
      {children}
    </span>
  );
}

/** "Healthy · 28% used", or the status alone when no window was read. */
function usageReadingText(
  entry: Extract<SuggestionUsage, { kind: "reading" }>["entry"],
): string {
  const projection = entry.projection;
  const status = profileUsageAccessibleStatus(projection);
  if (projection.kind !== "detail" && projection.kind !== "stale") {
    return status;
  }
  const used = Math.round(
    rateLimitWindowFillPercent(projection.compactWindow.window.usedPercent),
  );
  return `${status} · ${used}% used`;
}

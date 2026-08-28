import { useState } from "react";
import { Moon } from "lucide-react";
import type { MentionMenuEntry } from "@/lib/composer/mentions";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { formatCompactRelativeTime } from "@/lib/relative-time";
export type { MentionMenuEntry } from "@/lib/composer/mentions";

/**
 * The row's trailing last-activity time, on the sidebar's compact ladder
 * (`now` / `10m` / `4h` / `1d` / `1w` / short date) but deliberately OFF the
 * shared tick clock: a menu row's timestamp reads once when the row mounts
 * and does not need to tick live while the picker is up, so the label is
 * sampled once (state initializers may be impure) instead of subscribing.
 */
function MentionRowTime(props: { readonly timestamp: number }) {
  const [label] = useState(() =>
    formatCompactRelativeTime(props.timestamp, Date.now()),
  );
  return (
    <span className="shrink-0 text-ui-xs tabular-nums text-muted-foreground/70">
      {label}
    </span>
  );
}

export interface MentionMenuItemProps {
  readonly entry: MentionMenuEntry;
}

export function MentionMenuItem(props: MentionMenuItemProps) {
  const { entry } = props;
  const trailing = entry.detail || entry.description;
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 py-0.5">
      <span className="shrink-0">{entry.icon}</span>
      {entry.labelPrefix === null ? null : (
        // Never shrinks: this is the row's identity (`#4917`), and a truncated
        // reference is worse than no reference. The title beside it gives way.
        <span className="shrink-0 text-ui-sm font-semibold text-muted-foreground">
          {entry.labelPrefix}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground">
        {entry.label}
      </span>
      {entry.archived ? (
        // Mirrors the sidebar's archived marker (semibold, muted). A separate
        // element rather than text inside `detail`, so it can never truncate
        // away with the detail string.
        <span className="shrink-0 text-ui-xs font-semibold text-muted-foreground">
          Archived
        </span>
      ) : null}
      {entry.dormant ? (
        // Mirrors the sidebar's dormant marker (`epic-browser-sidebar-row.tsx`'s
        // `BrowserTabStateSlot`): a small muted Moon, same slot as `Archived`.
        // The row stays fully mentionable while dormant (attach auto-wakes
        // it) - this only sets the expectation that the first message pays a
        // wake cost.
        <TooltipWrapper
          label="Browser asleep"
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <span
            aria-label="Browser asleep"
            className="flex shrink-0 items-center"
          >
            <Moon className="size-3.5 text-muted-foreground" aria-hidden />
          </span>
        </TooltipWrapper>
      ) : null}
      {trailing ? (
        <TooltipWrapper
          label={entry.preview === null ? trailing : undefined}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <span className="min-w-0 shrink max-w-[45%] truncate text-ui-xs text-muted-foreground/70">
            {trailing}
          </span>
        </TooltipWrapper>
      ) : null}
      {entry.updatedAt !== null ? (
        // Keyed by the entry, not the row position: the menu keys rows by
        // index, so a ranked reorder reuses this component instance for a
        // DIFFERENT Agent - without the key, the frozen label would keep the
        // previous occupant's time.
        <MentionRowTime key={entry.id} timestamp={entry.updatedAt} />
      ) : null}
    </div>
  );
}

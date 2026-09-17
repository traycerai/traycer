import type { DraftInventoryFilter } from "@/lib/drafts/draft-inventory";
import { cn } from "@/lib/utils";

interface DraftsFilterToggleProps {
  readonly value: DraftInventoryFilter;
  /** What `current` is called on this surface: `Start page` or `This epic`. */
  readonly currentLabel: string;
  readonly onChange: (next: DraftInventoryFilter) => void;
}

/**
 * The drafts list's scope switch, as one pressed segment among two.
 *
 * `aria-pressed` per segment rather than a radio group, matching
 * `CommandGraphViewModeToggle`: each segment's pressed state is the whole
 * state, and there is no group label to invent. `Tab` toggles it from the
 * list as well, so this is the visible half of a choice the keyboard also
 * owns - which is why the inactive segment still reads as a control.
 */
export function DraftsFilterToggle(props: DraftsFilterToggleProps) {
  const { value, currentLabel, onChange } = props;
  return (
    <div
      role="group"
      aria-label="Drafts filter"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-foreground/5 p-0.5"
    >
      <FilterSegment
        filter="current"
        label={currentLabel}
        active={value === "current"}
        onChange={onChange}
      />
      <FilterSegment
        filter="all"
        label="All"
        active={value === "all"}
        onChange={onChange}
      />
    </div>
  );
}

function FilterSegment(props: {
  readonly filter: DraftInventoryFilter;
  readonly label: string;
  readonly active: boolean;
  readonly onChange: (next: DraftInventoryFilter) => void;
}) {
  const { filter, label, active, onChange } = props;
  return (
    <button
      type="button"
      aria-pressed={active}
      // The popover deliberately keeps editor focus, so a segment must not
      // take it on press either - the same trick the trigger pill uses.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        if (active) return;
        onChange(filter);
      }}
      className={cn(
        "rounded-sm px-2 py-0.5 text-ui-xs font-medium whitespace-nowrap transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        active
          ? "bg-popover text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

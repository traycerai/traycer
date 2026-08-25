/**
 * The view-menu bodies shared by the desktop sidebar and the mobile switcher.
 *
 * Each export here is a leaf: it renders `DropdownMenu*` items for one facet of
 * the view and takes its value and setter as props, holding no state and
 * reading no store. That is the whole line between this file and its callers -
 * the surrounding menu decides how the facets are REACHED (the sidebar nests
 * them behind submenus, or drills into them when a rail is too narrow for two
 * columns; the phone lists them one after another in a single scrolling menu),
 * while what each facet SAYS and DOES lives here once.
 *
 * A facet duplicated per surface is how two surfaces silently disagree about
 * the same persisted view state, so callers compose these rather than
 * re-declaring them.
 */
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  RotateCcw,
} from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  DEFAULT_SORT_MODE,
  SORT_DIRECTION,
  SORT_FIELD_LABELS,
  type SortField,
  type SortMode,
} from "@/lib/epic-sort";
import { isSortModeActive } from "@/stores/epics/left-panel-store";

/**
 * Field and direction pickers for a panel's sort mode, plus a reset that only
 * appears once the mode is off its default.
 *
 * Every item preventDefaults its own select so the menu stays open: ordering is
 * a control the user re-aims (pick a field, then flip the direction), and a
 * menu that closed on the first pick would have to be reopened to finish the
 * thought.
 */
export function OrderingDetail(props: {
  readonly fields: ReadonlyArray<SortField>;
  readonly sort: SortMode;
  readonly onFieldChange: (field: SortField) => void;
  readonly onToggleDirection: () => void;
}) {
  const resetOrdering = (): void => {
    props.onFieldChange(DEFAULT_SORT_MODE.field);
    if (props.sort.direction !== DEFAULT_SORT_MODE.direction) {
      props.onToggleDirection();
    }
  };
  return (
    <>
      <DropdownMenuLabel>Order by</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={props.sort.field}
        onValueChange={(next) => {
          const match = props.fields.find((field) => field === next);
          if (match !== undefined) props.onFieldChange(match);
        }}
      >
        {props.fields.map((field) => (
          <DropdownMenuRadioItem
            key={field}
            value={field}
            onSelect={(event) => event.preventDefault()}
          >
            {SORT_FIELD_LABELS[field]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup value={props.sort.direction}>
        <DropdownMenuRadioItem
          value={SORT_DIRECTION.Desc}
          onSelect={(event) => {
            event.preventDefault();
            if (props.sort.direction !== SORT_DIRECTION.Desc) {
              props.onToggleDirection();
            }
          }}
        >
          <ArrowDownWideNarrow className="size-4" />
          Descending
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          value={SORT_DIRECTION.Asc}
          onSelect={(event) => {
            event.preventDefault();
            if (props.sort.direction !== SORT_DIRECTION.Asc) {
              props.onToggleDirection();
            }
          }}
        >
          <ArrowUpNarrowWide className="size-4" />
          Ascending
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      {isSortModeActive(props.sort) ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              resetOrdering();
            }}
          >
            <RotateCcw className="size-4" />
            Reset ordering
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

/**
 * The "how many filters are on" count that rides the corner of a view-menu
 * trigger, capped at `9+` so a wide count cannot stretch the icon button.
 *
 * `aria-hidden`: the trigger's own label already spells the count out, and a
 * screen reader reading a bare digit beside it would say the number twice.
 * Renders nothing at zero, so an unfiltered trigger is a plain icon.
 */
export function ViewMenuBadge(props: { readonly filterCount: number }) {
  if (props.filterCount <= 0) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground px-0.5 text-[9px] leading-none font-semibold text-background ring-1 ring-background"
    >
      {props.filterCount > 9 ? "9+" : String(props.filterCount)}
    </span>
  );
}

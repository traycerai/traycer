import { ArrowDownUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { HistorySortOption } from "@/components/home/data/home-page.data";

interface EpicsSortMenuProps {
  value: HistorySortOption;
  onChange: (next: HistorySortOption) => void;
  /** False on a host that cannot order by creation date. */
  createdSortAvailable: boolean;
}

const SORT_LABELS: Readonly<Record<HistorySortOption, string>> = {
  recent: "Most recent",
  "last-viewed": "Last viewed",
  relevance: "Relevance",
  "created-desc": "Newest created",
  oldest: "Oldest",
  "title-asc": "Title A → Z",
  "title-desc": "Title Z → A",
};

// `oldest` is no longer offered. A saved `oldest` still applies and keeps its
// label on the trigger until another sort is picked.
const MENU_SORTS: ReadonlyArray<HistorySortOption> = [
  "recent",
  "last-viewed",
  "relevance",
  "created-desc",
  "title-asc",
  "title-desc",
];

export function EpicsSortMenu(props: EpicsSortMenuProps) {
  const { value, onChange, createdSortAvailable } = props;
  const options = createdSortAvailable
    ? MENU_SORTS
    : MENU_SORTS.filter((sort) => sort !== "created-desc");

  const trigger = (
    <Button type="button" variant="muted" size="sm">
      <ArrowDownUp className="size-4" />
      {SORT_LABELS[value]}
    </Button>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const match = options.find((sort) => sort === next);
            if (match !== undefined) {
              onChange(match);
            }
          }}
        >
          {options.map((sort) => (
            <DropdownMenuRadioItem key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

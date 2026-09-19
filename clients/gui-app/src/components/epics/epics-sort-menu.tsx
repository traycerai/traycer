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
}

const SORT_OPTIONS: ReadonlyArray<{
  value: HistorySortOption;
  label: string;
}> = [
  { value: "recent", label: "Most recent" },
  { value: "last-viewed", label: "Last viewed" },
  { value: "relevance", label: "Relevance" },
  { value: "oldest", label: "Oldest" },
  { value: "title-asc", label: "Title A → Z" },
  { value: "title-desc", label: "Title Z → A" },
];

export function EpicsSortMenu(props: EpicsSortMenuProps) {
  const { value, onChange } = props;
  const currentLabel =
    SORT_OPTIONS.find((option) => option.value === value)?.label ?? "Sort";

  const trigger = (
    <Button type="button" variant="muted" size="sm">
      <ArrowDownUp className="size-4" />
      {currentLabel}
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
            const match = SORT_OPTIONS.find((option) => option.value === next);
            if (match !== undefined) {
              onChange(match.value);
            }
          }}
        >
          {SORT_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

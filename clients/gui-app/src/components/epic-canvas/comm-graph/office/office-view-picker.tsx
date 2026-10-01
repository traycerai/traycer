import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OFFICE_VIEWS } from "@/lib/comm-graph/office/views/office-view";
import {
  isOfficeViewChoice,
  OFFICE_VIEW_CHOICES,
  type OfficeViewChoice,
} from "@/lib/comm-graph/office/office-view-vocabulary";

export interface OfficeViewPickerProps {
  readonly choice: OfficeViewChoice;
  readonly onChoose: (choice: OfficeViewChoice) => void;
}

export function OfficeViewPicker(props: OfficeViewPickerProps) {
  const { choice, onChoose } = props;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label="Office view"
          data-testid="comm-graph-office-view-picker"
        >
          {OFFICE_VIEWS[choice].label}
          <ChevronDown data-icon="inline-end" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      {/* The shadcn base pins `w` to the trigger, so an explicit fluid `w`
          overrides it while `max-w-*` caps it: 90vw on a narrow screen, the
          tokenized ceiling on a wide one - fluid, no fixed rem layout width. */}
      <DropdownMenuContent align="end" className="w-[90vw] max-w-sm">
        <DropdownMenuRadioGroup
          value={choice}
          onValueChange={(value) => {
            if (isOfficeViewChoice(value)) onChoose(value);
          }}
        >
          {OFFICE_VIEW_CHOICES.map((id) => (
            <DropdownMenuRadioItem
              key={id}
              value={id}
              data-testid={`comm-graph-office-view-${id}`}
            >
              <span className="flex flex-col gap-0.5">
                <span>{OFFICE_VIEWS[id].label}</span>
                <span className="text-ui-xs text-muted-foreground">
                  {OFFICE_VIEWS[id].description}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

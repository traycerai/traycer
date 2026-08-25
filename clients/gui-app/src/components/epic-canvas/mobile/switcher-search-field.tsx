import { Search, X } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";

/**
 * The resting search field in a switcher category's header.
 *
 * Resting, unlike the sidebar's, where search is a MODE the header trades its
 * whole row for. That trade exists because a rail header has no room for a
 * title, its actions, and an input at once; the sheet's header row does, so the
 * mode - and the portal that swaps the row, and the type-to-filter keystroke
 * that enters it - has nothing to solve here. What it filters is identical.
 *
 * Never autofocuses. On a touch surface, focus raises the keyboard over the
 * very list the user opened the switcher to look at, and a search they did not
 * ask for is not worth that.
 */
export function SwitcherSearchField(props: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly placeholder: string;
  readonly testId: string;
}) {
  const { value, onValueChange, placeholder, testId } = props;
  return (
    <InputGroup className="min-h-11 min-w-0 flex-1">
      <InputGroupAddon align="inline-start">
        <Search className="size-3.5" aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        type="text"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid={testId}
      />
      {value.length > 0 ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Clear search"
            data-testid={`${testId}-clear`}
            onClick={() => onValueChange("")}
          >
            <X className="size-3.5" />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

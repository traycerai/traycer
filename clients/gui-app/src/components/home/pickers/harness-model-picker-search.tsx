import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Search } from "lucide-react";
import type { RefObject } from "react";

interface HarnessModelPickerSearchProps {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly providerLabel: string;
  readonly listboxId: string;
  readonly activeDescendant: string | undefined;
}

export function HarnessModelPickerSearch(props: HarnessModelPickerSearchProps) {
  const {
    inputRef,
    value,
    onChange,
    providerLabel,
    listboxId,
    activeDescendant,
  } = props;
  // Search is scoped to the active harness, so name it in the placeholder. Falls
  // back to the generic copy before the catalog resolves the active provider.
  const placeholder =
    providerLabel.length > 0
      ? `Search ${providerLabel} models`
      : "Search models";

  return (
    <div className="shrink-0 border-b p-2">
      <InputGroup className="h-9! rounded-lg border-input/40 bg-input/25 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        <InputGroupInput
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          className="text-ui-sm"
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

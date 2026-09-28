import {
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Search, X } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { mergeRefs } from "@/lib/merge-refs";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

interface RegionFilterProps {
  readonly ref: Ref<HTMLInputElement>;
  /** ArrowDown from the field moves to the first row below it (L-31). */
  readonly onArrowDown: () => void;
  /** Enter opens the first result, without a trip through the rows. */
  readonly onEnter: () => void;
}

/**
 * Find a setting: the one field, at the inspector's All settings level. The
 * level lists the settings it matches by name, option or state word, and a
 * result opens its area with that row expanded and selected. The level reads
 * `filter` off the store directly, so this component only owns the field
 * itself and the store write.
 *
 * `InputGroup variant="search"` rather than a hand-placed icon over an
 * `Input`: it is the app's own filter-field shape, and it has the slot the
 * clear button needs. Escape has always cleared the field and nothing said so
 * (L-125), which is a keyboard-only affordance on a page whose whole point is
 * that it is also the pointer and touch path.
 *
 * Takes its ref as a plain prop (React 19) so `layout-form.tsx` can return
 * focus to it: L-31's "ArrowUp from the first row returns to the filter"
 * needs the field itself, not a store flag. The field is merged with
 * one of this component's own, because clearing has to put focus back where
 * the user was typing.
 */
export function RegionFilter(props: RegionFilterProps): ReactNode {
  const { ref } = props;
  const filter = useLayoutEditorStore((state) => state.filter);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fieldRef = useMemo(() => mergeRefs(ref, inputRef), [ref]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      props.onArrowDown();
    } else if (event.key === "Enter") {
      event.preventDefault();
      props.onEnter();
    } else if (event.key === "Escape" && filter.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      useLayoutEditorStore.getState().setFilter("");
    }
  }

  return (
    <div className="px-3 py-2">
      <InputGroup variant="search">
        <InputGroupAddon align="inline-start">
          <Search aria-hidden className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput
          ref={fieldRef}
          type="text"
          placeholder="Find a setting"
          aria-label="Find a setting"
          autoComplete="off"
          value={filter}
          onChange={(event) => {
            useLayoutEditorStore.getState().setFilter(event.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
        {filter.length === 0 ? null : (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="button"
              size="icon-xs"
              aria-label="Clear filter"
              onClick={() => {
                useLayoutEditorStore.getState().setFilter("");
                inputRef.current?.focus();
              }}
            >
              <X aria-hidden className="size-3.5" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
    </div>
  );
}

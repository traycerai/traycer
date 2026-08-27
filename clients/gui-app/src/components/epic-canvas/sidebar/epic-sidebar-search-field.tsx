/**
 * The search field every Epic panel search renders - the sidebar's agent and
 * artifact header searches, and the mobile switcher's category searches.
 *
 * One component, because a search field is a thing users recognize by sight:
 * the leading magnifier, the trailing clear, the `…` in the placeholder, the
 * suppressed autocomplete and spellcheck. Three surfaces hand-rolling that
 * shape is three surfaces that drift apart on the details nobody re-checks.
 *
 * What a caller owns is the MOUNT, not the field: where the DOM lands (the
 * sidebar portals it into a header slot it traded its title row for; the
 * switcher renders it inline), whether the caret is taken on mount, and where
 * the query is stored. What the field owns is everything the user sees.
 *
 * `onClose` is null for a RESTING field - one that is always present rather
 * than a mode entered and left. Such a field has nothing to close, so it shows
 * no `esc` affordance and claims no keyboard the surface may not have.
 */
import { Search, X } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

/**
 * The combobox ARIA a caller wires when its results are a listbox the field
 * drives. `null` when results are not a popup the field owns - the switcher's
 * hits are ordinary rows in the list below it, not an overlay it controls.
 */
export interface PanelSearchFieldCombobox {
  readonly listboxRendered: boolean;
  readonly listboxId: string;
  readonly activeOptionId: string | undefined;
}

export function PanelSearchField(props: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /**
   * The clear button's action, separate from `onValueChange("")` because a
   * mount may owe the caret something afterwards - the sidebar's field returns
   * focus to the input so typing continues, which a resting field has no reason
   * to do (and on a phone would summon the keyboard the user just dismissed).
   */
  readonly onClear: () => void;
  /** `null` for a resting field: no mode to leave, so no `esc` button. */
  readonly onClose: (() => void) | null;
  readonly onKeyDown: ((event: KeyboardEvent<HTMLInputElement>) => void) | null;
  /**
   * React 19 takes `ref` as an ordinary prop, and naming it that is what marks
   * it as one: threaded under any other name it is a ref-typed value the render
   * path is reading, which is exactly what the refs lint rule exists to catch.
   */
  readonly ref: RefObject<HTMLInputElement | null> | null;
  readonly combobox: PanelSearchFieldCombobox | null;
  readonly placeholder: string;
  readonly label: string;
  readonly clearLabel: string;
  readonly closeLabel: string;
  readonly testIdPrefix: string;
  /** Mount-specific sizing only; the field's own look is not a caller concern. */
  readonly className: string;
}) {
  const {
    value,
    onValueChange,
    onClear,
    onClose,
    onKeyDown,
    ref,
    combobox,
    placeholder,
    label,
    clearLabel,
    closeLabel,
    testIdPrefix,
    className,
  } = props;
  return (
    <InputGroup className={cn("w-full", className)}>
      <InputGroupAddon align="inline-start">
        <Search className="size-3.5" aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        ref={ref}
        type="text"
        role={combobox === null ? undefined : "combobox"}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={onKeyDown ?? undefined}
        placeholder={placeholder}
        aria-label={label}
        aria-autocomplete={combobox === null ? undefined : "list"}
        aria-expanded={combobox === null ? undefined : combobox.listboxRendered}
        aria-controls={
          combobox !== null && combobox.listboxRendered
            ? combobox.listboxId
            : undefined
        }
        aria-activedescendant={
          combobox !== null && combobox.listboxRendered
            ? combobox.activeOptionId
            : undefined
        }
        autoComplete="off"
        spellCheck={false}
        className="text-ui-sm"
        data-testid={`${testIdPrefix}-input`}
      />
      <InputGroupAddon align="inline-end">
        {value.length > 0 ? (
          <InputGroupButton
            type="button"
            size="icon-xs"
            aria-label={clearLabel}
            onClick={onClear}
            data-testid={`${testIdPrefix}-clear`}
          >
            <X className="size-3.5" aria-hidden />
          </InputGroupButton>
        ) : null}
        {onClose === null ? null : (
          <InputGroupButton
            type="button"
            size="icon-xs"
            aria-label={closeLabel}
            onClick={onClose}
            data-testid={`${testIdPrefix}-close`}
          >
            <span aria-hidden className="text-overline uppercase">
              esc
            </span>
          </InputGroupButton>
        )}
      </InputGroupAddon>
    </InputGroup>
  );
}

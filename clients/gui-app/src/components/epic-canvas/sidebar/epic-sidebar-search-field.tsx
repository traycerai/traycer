/**
 * `onClose` is null for a RESTING field - one that is always present rather than a mode entered and left.
 * The treatment is the git-diff repo switcher's, which is also the only one of them that was safe there - the others filled with `bg-muted`, and every preset dark theme collapses `--muted` into the sheet's own `--popover`, rendering the box invisible.
 */
import { Search, X } from "lucide-react";
import type { KeyboardEvent, RefObject } from "react";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

/**
 * The combobox ARIA a caller wires when its results are a listbox the field drives.
 * `null` when results are not a popup the field owns - the switcher's hits are ordinary rows in the list below it, not an overlay it controls.
 */
/**
 * The `!` modifiers are not decoration - the `InputGroup` primitive sets its own height and shadow, and a bare utility would tie rather than win.
 */
const MOBILE_FIELD_CLASS =
  "h-8! rounded-lg border-input/40 bg-input/25 shadow-none! *:data-[slot=input-group-addon]:pl-2!";

/**
 * Hit area without paint: the input keeps a touch-sized box while the FIELDSET stays 30px, so what the user sees is the reference box and what the thumb lands on is not a 30px target.
 * It goes on the input rather than the wrapper because only the input can carry it.
 */
const MOBILE_INPUT_HIT_CLASS = "h-11";

export interface PanelSearchFieldCombobox {
  readonly listboxRendered: boolean;
  readonly listboxId: string;
  readonly activeOptionId: string | undefined;
}

export function PanelSearchField(props: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /**
   * The clear button's action, separate from `onValueChange("")` because a mount may owe the caret something afterwards - the sidebar's field returns focus to the input so typing continues, which a resting field has no reason to do (and on a phone would summon the keyboard the user just dismissed).
   */
  readonly onClear: (() => void) | null;
  /** `null` for a resting field: no mode to leave, so no `esc` button. */
  readonly onClose: (() => void) | null;
  readonly onKeyDown: ((event: KeyboardEvent<HTMLInputElement>) => void) | null;
  /**
   * React 19 takes `ref` as an ordinary prop, and naming it that is what marks it as one: threaded under any other name it is a ref-typed value the render path is reading, which is exactly what the refs lint rule exists to catch.
   */
  readonly ref: RefObject<HTMLInputElement | null> | null;
  readonly combobox: PanelSearchFieldCombobox | null;
  readonly placeholder: string;
  readonly label: string;
  readonly clearLabel: string;
  readonly closeLabel: string;
  readonly testIdPrefix: string;
  /**
   * The DESKTOP look for this mount. Ignored on a phone, where every panel
   * search renders the one shared box.
   */
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
  const isMobileViewport = useIsMobileViewport();
  return (
    <InputGroup
      className={cn(
        "w-full",
        isMobileViewport ? MOBILE_FIELD_CLASS : className,
      )}
    >
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
        className={cn("text-ui-sm", isMobileViewport && MOBILE_INPUT_HIT_CLASS)}
        data-testid={`${testIdPrefix}-input`}
      />
      <InputGroupAddon align="inline-end">
        {onClear !== null && value.length > 0 ? (
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

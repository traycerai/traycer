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
 * `onClear` is null for a field that offers no clear affordance at all.
 *
 * On a phone every one of these renders the SAME box, regardless of which panel
 * it belongs to: a filter that looks like one thing in one category and another
 * thing in the next reads as two different controls. The treatment is the
 * git-diff repo switcher's, which is also the only one of them that was safe
 * there - the others filled with `bg-muted`, and every preset dark theme
 * collapses `--muted` into the sheet's own `--popover`, rendering the box
 * invisible. `--input` does not collapse.
 *
 * It keys on the VIEWPORT rather than a prop because the file-tree and git-diff
 * panels are the same components on both surfaces - they mount inside the
 * switcher's embeds - so a caller could not tell the phone from the desktop.
 * That is also what keeps this one variant instead of five skins.
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
 * The combobox ARIA a caller wires when its results are a listbox the field
 * drives. `null` when results are not a popup the field owns - the switcher's
 * hits are ordinary rows in the list below it, not an overlay it controls.
 */
/**
 * The one phone treatment: the git-diff repo switcher's box, literally - its
 * `h-8` included. That box is the one that was chosen by eye on a phone, and
 * its proportions are part of what was chosen; a taller field wearing the same
 * border reads as a different control, not as that one.
 *
 * The `!` modifiers are not decoration - the `InputGroup` primitive sets its own
 * height and shadow, and a bare utility would tie rather than win.
 */
const MOBILE_FIELD_CLASS =
  "h-8! rounded-lg border-input/40 bg-input/25 shadow-none! *:data-[slot=input-group-addon]:pl-2!";

/**
 * Hit area without paint: the input keeps a touch-sized box while the FIELDSET
 * stays 30px, so what the user sees is the reference box and what the thumb
 * lands on is not a 30px target.
 *
 * It goes on the input rather than the wrapper because only the input can carry
 * it. `InputGroup` is a bare `fieldset` with no click-to-focus handler, so slop
 * added there would enlarge a box that does nothing when tapped - and an
 * `<input>` renders no pseudo-elements, so the `::after` trick the shell's touch
 * scope uses for buttons has nothing to attach to here. A taller input inside a
 * fixed-height flex row simply overflows it, invisibly: the input paints no
 * background of its own.
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
   * The clear button's action, separate from `onValueChange("")` because a
   * mount may owe the caret something afterwards - the sidebar's field returns
   * focus to the input so typing continues, which a resting field has no reason
   * to do (and on a phone would summon the keyboard the user just dismissed).
   */
  readonly onClear: (() => void) | null;
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

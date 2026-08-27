import { PanelSearchField } from "@/components/epic-canvas/sidebar/epic-sidebar-search-field";

/**
 * The switcher's mount of the sidebar's search field - the same component the
 * Agents and Artifacts panel headers render, so the phone shows the same
 * magnifier, the same clear affordance, the same placeholder wording, and the
 * same suppressed autocomplete as the desktop it mirrors.
 *
 * Three mount differences, all of them about where the field lives rather than
 * what it is:
 *
 * 1. **Inline, not portaled.** The sidebar trades its header row for the field
 *    because a rail has no room for a title, its actions, and an input at once.
 *    The sheet's header row has room, so the field simply sits in it.
 * 2. **Resting, so no `esc` affordance** (`onClose: null`). The sidebar's field
 *    is a MODE the user enters and leaves; this one is always there, has nothing
 *    to close, and a phone has no Escape key to honour the button's promise.
 * 3. **Taller.** The sidebar's `h-7` is a pointer-sized control. The touch-target
 *    guideline governs here, and the sheet's touch scope only extends hit area
 *    for `data-slot="button"` - an input has to carry its own height.
 *
 * It also never takes focus on mount, unlike the sidebar's field, which is
 * opened deliberately and so is owed the caret. Here the field is present
 * whether or not the user came to search, and stealing focus would raise the
 * keyboard over the very list the switcher exists to show.
 */
export function SwitcherSearchField(props: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly placeholder: string;
  readonly label: string;
  readonly clearLabel: string;
  readonly testIdPrefix: string;
}) {
  const { value, onValueChange } = props;
  return (
    <PanelSearchField
      value={value}
      onValueChange={onValueChange}
      onClear={() => onValueChange("")}
      onClose={null}
      onKeyDown={null}
      ref={null}
      combobox={null}
      placeholder={props.placeholder}
      label={props.label}
      clearLabel={props.clearLabel}
      // Unreachable while `onClose` is null; the field renders no close button.
      closeLabel=""
      testIdPrefix={props.testIdPrefix}
      className="min-h-11"
    />
  );
}

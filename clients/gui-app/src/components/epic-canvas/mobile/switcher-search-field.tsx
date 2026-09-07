import { PanelSearchField } from "@/components/epic-canvas/sidebar/epic-sidebar-search-field";

/**
 * Three mount differences, all of them about where the field lives rather than what it is: 1. **Inline, not portaled.** The sidebar trades its header row for the field because a rail has no room for a title, its actions, and an input at once.
 * The touch-target guideline governs here, and the sheet's touch scope only extends hit area for `data-slot="button"` - an input has to carry its own height.
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

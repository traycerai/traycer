import { Checkbox } from "@/components/ui/checkbox";

/**
 * Checked-by-default opt-out shown in every bulk revert confirmation when the
 * scope includes artifacts: "Also revert N artifacts". Unchecking excludes the
 * artifact changes from the revert (files still revert). Renders nothing when
 * there are no artifacts in scope.
 *
 * `count: null` is "there may be artifacts and this side cannot count them" -
 * a windowed transcript whose history below the revert point is not hydrated.
 * It renders the opt-out WITHOUT a number, which is the only honest pair of
 * choices available: hiding it would revert artifacts with no opt-out shown
 * (the checkbox defaults to checked), and printing a number derived from the
 * hydrated slice would state an under-count as a measurement.
 */
export function RevertArtifactsCheckbox(props: {
  readonly count: number | null;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled: boolean;
}) {
  if (props.count === 0) return null;
  const count = props.count;
  return (
    <label className="flex cursor-pointer items-center gap-2 text-ui-sm text-muted-foreground select-none">
      <Checkbox
        checked={props.checked}
        onCheckedChange={(value) => props.onCheckedChange(value === true)}
        disabled={props.disabled}
        data-testid="revert-artifacts-checkbox"
      />
      <span>
        {count === null
          ? "Also revert artifacts changed since this message"
          : `Also revert ${count} artifact${count === 1 ? "" : "s"}`}
      </span>
    </label>
  );
}

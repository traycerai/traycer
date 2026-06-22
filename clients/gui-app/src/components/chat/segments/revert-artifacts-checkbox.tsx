import { Checkbox } from "@/components/ui/checkbox";

/**
 * Checked-by-default opt-out shown in every bulk revert confirmation when the
 * scope includes artifacts: "Also revert N artifacts". Unchecking excludes the
 * artifact changes from the revert (files still revert). Renders nothing when
 * there are no artifacts in scope.
 */
export function RevertArtifactsCheckbox(props: {
  readonly count: number;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly disabled: boolean;
}) {
  if (props.count === 0) return null;
  return (
    <label className="flex cursor-pointer items-center gap-2 text-ui-sm text-muted-foreground select-none">
      <Checkbox
        checked={props.checked}
        onCheckedChange={(value) => props.onCheckedChange(value === true)}
        disabled={props.disabled}
        data-testid="revert-artifacts-checkbox"
      />
      <span>
        Also revert {props.count} artifact{props.count === 1 ? "" : "s"}
      </span>
    </label>
  );
}

import type { ReactNode } from "react";

/** Shown beside the reread value after a compare-and-set refuses an edit. */
export function ConfigurationConflict(props: {
  readonly changedBy: string | null;
}): ReactNode {
  return (
    <p role="status" className="text-ui-xs text-warning-foreground">
      Changed by {props.changedBy ?? "another member"} a moment ago
    </p>
  );
}

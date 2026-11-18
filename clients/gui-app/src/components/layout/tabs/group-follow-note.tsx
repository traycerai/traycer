import type { ReactNode } from "react";

/** Under a grouped task's disabled swatches: whose colour it draws, and where to change it. */
export function GroupFollowNote(props: { readonly name: string }): ReactNode {
  return (
    <p className="mt-1 text-ui-xs text-muted-foreground">
      Follows the group {props.name || "Unnamed group"}. Change it on the group.
    </p>
  );
}

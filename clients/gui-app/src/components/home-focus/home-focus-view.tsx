import type { ReactNode } from "react";

/**
 * The Home tab's body: everything happening right now across every task.
 *
 * Only the empty state exists so far - the sections (Needs you, Running,
 * Background) land with the cross-task focus model. The export name and the
 * prop-free signature are the contract `TopLevelTabHost` mounts, so they stay
 * fixed while the body fills in.
 */
export function HomeFocusView(): ReactNode {
  return (
    <div
      data-testid="home-focus-view"
      className="flex min-h-0 w-full flex-1 items-center justify-center p-6"
    >
      <p className="max-w-prose text-center text-ui-sm text-muted-foreground">
        Nothing needs you. Start a new task or open a recent one.
      </p>
    </div>
  );
}

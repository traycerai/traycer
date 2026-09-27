import type { ReactNode } from "react";
import { SIDE_TAB_TITLE_CLASS } from "@/components/layout/tabs/side-strip/side-strip-tokens";
import { cn } from "@/lib/utils";

/**
 * The panel sheet's task header row (D12): the task's chip and its title. The
 * live panel fills it from the task's tab; the layout editor's miniature draws
 * the same row for its picture of a task.
 *
 * `titleEditor` replaces the title while it is being renamed; `titleAction`
 * sits after the title and shows only while the row is hovered or the action
 * holds focus.
 */
export function PanelTaskHeaderBody(props: {
  readonly testId: string | null;
  readonly chip: ReactNode;
  readonly title: string;
  readonly titleEditor: ReactNode | null;
  readonly titleAction: ReactNode | null;
}): ReactNode {
  return (
    <div
      data-testid={props.testId ?? undefined}
      className="group/task-header flex min-w-0 shrink-0 items-center gap-2 px-3 pt-2 pb-1.5"
    >
      {props.chip}
      {props.titleEditor ?? (
        <>
          <span
            className={cn(
              SIDE_TAB_TITLE_CLASS,
              "min-w-0 truncate font-semibold text-foreground",
            )}
          >
            {props.title}
          </span>
          {props.titleAction === null ? null : (
            <span className="flex shrink-0 opacity-0 transition-opacity group-hover/task-header:opacity-100 focus-within:opacity-100">
              {props.titleAction}
            </span>
          )}
        </>
      )}
    </div>
  );
}

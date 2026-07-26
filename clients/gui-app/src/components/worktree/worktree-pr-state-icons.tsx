import {
  use,
  useCallback,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { cn } from "@/lib/utils";
import { RunnerHostContext } from "@/providers/runner-host-context";
import type { WorktreePrReference } from "@/components/worktree/worktree-pr-metadata-model";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  PR_STATE_ICON,
  PR_STATE_TINT_CLASS,
} from "@/components/worktree/worktree-pr-state-palette";

/**
 * Icon-only PR references for a sidebar chat row's second line: one glyph +
 * `#number` per detected PR, colored by state.
 *
 * **Why a `role="link"` span and not the pill's `<a>`.** This renders INSIDE
 * the sidebar row, which is a `<button>` in its display variant and a `<label>`
 * in selection mode. A real `<a href>` inside a button is invalid HTML, and
 * inside the label it would fight the checkbox for activation. The same shape
 * the chat segments already use for this exact bind (`artifact-change-row.tsx`:
 * a `role`+`tabIndex` span, because its row header is likewise already a
 * button) applies here: an ARIA link that owns its own click and Enter/Space
 * activation and stops both from reaching the row.
 *
 * It stays in the tab order (`tabIndex={0}`) rather than going pointer-only.
 * That does add a stop per PR to tree traversal, but the alternative - a bare
 * `<span onClick>` - would reach the same nesting depth while silently
 * excluding keyboard users from an affordance pointer users have.
 */
export function WorktreePrStateIcons(props: {
  readonly references: readonly WorktreePrReference[];
  readonly testId: string;
}): ReactNode {
  if (props.references.length === 0) return null;
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      data-testid={props.testId}
    >
      {props.references.map((reference) => (
        <WorktreePrStateIcon key={reference.key} reference={reference} />
      ))}
    </span>
  );
}

function WorktreePrStateIcon(props: {
  readonly reference: WorktreePrReference;
}): ReactNode {
  const runnerHost = use(RunnerHostContext);
  const openExternalLink = useRunnerOpenExternalLink();
  const url = props.reference.url;
  const open = useCallback((): void => {
    if (runnerHost === null) {
      window.open(url, "_blank", "noreferrer");
      return;
    }
    openExternalLink.mutate(url);
  }, [openExternalLink, runnerHost, url]);
  const openOnClick = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      // `stopPropagation` keeps the row's onClick from opening the chat;
      // `preventDefault` keeps the selection-mode `<label>` from toggling its
      // checkbox, which is a browser default on any descendant click rather
      // than a bubbled handler.
      event.stopPropagation();
      event.preventDefault();
      open();
    },
    [open],
  );
  const openOnKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== "Enter" && event.key !== " ") return;
      // Space would otherwise scroll the tree, and both keys would activate
      // the enclosing row.
      event.stopPropagation();
      event.preventDefault();
      open();
    },
    [open],
  );
  const stopDragActivation = useCallback(
    (event: PointerEvent<HTMLSpanElement>): void => {
      // The row installs dnd-kit drag listeners, which activate on pointer-down
      // and would swallow the press before it ever becomes a click.
      event.stopPropagation();
    },
    [],
  );
  const Icon = PR_STATE_ICON[props.reference.state];
  return (
    <TooltipWrapper
      label={props.reference.label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        role="link"
        tabIndex={0}
        aria-label={props.reference.ariaLabel}
        data-testid="worktree-pr-state-icon"
        data-pr-state={props.reference.state}
        className={cn(
          "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium",
          "focus-visible:ring-ring rounded-sm focus-visible:outline-none focus-visible:ring-2",
          PR_STATE_TINT_CLASS[props.reference.state],
        )}
        onClick={openOnClick}
        onKeyDown={openOnKeyDown}
        onPointerDown={stopDragActivation}
      >
        <Icon className="size-3" aria-hidden />
        <span>#{props.reference.prNumber}</span>
      </span>
    </TooltipWrapper>
  );
}

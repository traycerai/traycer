import {
  useCallback,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useOpenLink } from "@/lib/links/open-link";
import { cn } from "@/lib/utils";
import type { WorktreePrReference } from "@/components/worktree/worktree-pr-metadata-model";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  PR_STATE_ICON,
  PR_STATE_TINT_CLASS,
} from "@/components/worktree/worktree-pr-state-palette";
import { onMiddleClick } from "@/lib/dom/on-middle-click";

/** That does add a stop per PR to tree traversal, but the alternative - a bare `<span onClick>` - would reach
 * the same nesting depth while silently excluding keyboard users from an affordance pointer users have. */
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
  const openLink = useOpenLink();
  const url = props.reference.url;
  const openOnClick = useCallback(
    (event: MouseEvent<HTMLSpanElement>): void => {
      // `stopPropagation` keeps the row's onClick from opening the chat.
      event.stopPropagation();
      event.preventDefault();
      void openLink(url, "github", event);
    },
    [openLink, url],
  );
  const openOnKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>): void => {
      if (event.key !== "Enter" && event.key !== " ") return;
      // Space would otherwise scroll the tree, and both keys would activate
      // the enclosing row.
      event.stopPropagation();
      event.preventDefault();
      // Keyboard activation carries modifiers too (ctrl+Enter forces the OS
      // browser); only the mouse button is missing (R7).
      void openLink(url, "github", {
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        button: 0,
      });
    },
    [openLink, url],
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
        onAuxClick={onMiddleClick(openOnClick)}
        onKeyDown={openOnKeyDown}
        onPointerDown={stopDragActivation}
      >
        <Icon className="size-3" aria-hidden />
        <span>#{props.reference.prNumber}</span>
      </span>
    </TooltipWrapper>
  );
}

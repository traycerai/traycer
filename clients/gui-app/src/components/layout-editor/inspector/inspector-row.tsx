import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";

/** The revert glyph every layout row, group header and preset draws (L-20). */
export function RevertButton(props: {
  readonly onRevert: () => void;
  readonly label: string;
}): ReactNode {
  return (
    <TooltipWrapper
      label={props.label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={props.label}
        onClick={(event) => {
          keepFocusInRow(event.currentTarget);
          props.onRevert();
        }}
      >
        <RotateCcw />
      </Button>
    </TooltipWrapper>
  );
}

/**
 * The ↺ leaves with the change it puts back, and a focused button that
 * unmounts drops focus to the page: a keyboard user pressing Enter on it
 * landed nowhere. Focus moves first to another control of the same row, which
 * survives the revert, so it happens before the revert rather than after a
 * re-render nothing here can observe.
 */
function keepFocusInRow(button: HTMLElement): void {
  const row = button.closest("[data-sortable-id], [data-layout-form-row]");
  if (row === null) return;
  const next = [
    ...row.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), [tabindex='0']",
    ),
  ].find((node) => node !== button && !node.closest("[inert]"));
  next?.focus();
}

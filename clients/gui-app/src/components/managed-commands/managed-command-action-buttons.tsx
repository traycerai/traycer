import type { ReactNode } from "react";
import { Square } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

/** `pressed` turns the button into a toggle (`aria-pressed`), for the one setting a person edits on a command -
 * relaunch after a host restart. */
export function ManagedCommandActionButton(props: {
  readonly label: string;
  readonly ariaLabel: string;
  readonly icon: ReactNode;
  readonly isPending: boolean;
  readonly testId: string;
  readonly className: string | undefined;
  readonly pressed: boolean | undefined;
  readonly onClick: () => void;
}) {
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
        size="icon"
        className={cn(
          "size-6 text-muted-foreground hover:text-foreground",
          props.className,
        )}
        aria-label={props.ariaLabel}
        aria-pressed={props.pressed}
        data-testid={props.testId}
        disabled={props.isPending}
        // The surrounding row opens the output window; a lifecycle press is a
        // separate act and must not also open it.
        onClick={(event) => {
          event.stopPropagation();
          props.onClick();
        }}
      >
        {props.isPending ? (
          <AgentSpinningDots
            className="size-3.5"
            testId={undefined}
            variant={undefined}
          />
        ) : (
          props.icon
        )}
      </Button>
    </TooltipWrapper>
  );
}

/** Sharing the button rather than the hook is what keeps a shell looking stoppable everywhere it appears. */
export function ManagedCommandStopButton(props: {
  readonly commandId: string;
  readonly ariaLabel: string;
  readonly isPending: boolean;
  readonly className: string | undefined;
  readonly onStop: () => void;
}) {
  return (
    <ManagedCommandActionButton
      label="Stop"
      ariaLabel={props.ariaLabel}
      icon={<Square aria-hidden className="size-3.5" />}
      isPending={props.isPending}
      testId={`managed-command-stop-${props.commandId}`}
      className={props.className}
      pressed={undefined}
      onClick={props.onStop}
    />
  );
}

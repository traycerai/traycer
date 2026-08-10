import type { ReactNode } from "react";
import { Square } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";

/**
 * One lifecycle affordance for a managed command: icon button, verb tooltip,
 * and a spinner in place of the glyph while its mutation is in flight.
 *
 * `ariaLabel` is separate from the tooltip because a surface that lists several
 * shells at once needs each button to name ITS shell, while the tooltip stays
 * the bare verb.
 */
export function ManagedCommandActionButton(props: {
  readonly label: string;
  readonly ariaLabel: string;
  readonly icon: ReactNode;
  readonly isPending: boolean;
  readonly testId: string;
  readonly className: string | undefined;
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

/**
 * The Stop affordance itself - square glyph, "Stop" tooltip - with no opinion
 * about WHICH mutation fires it.
 *
 * The Shells surfaces stop one command through their own hook; the resource
 * monitor stops whole selections through a batched one. Sharing the button
 * rather than the hook is what keeps a shell looking stoppable everywhere it
 * appears - which matters most in the monitor, where the affordance next to it
 * says "Kill" in words and a supervised shell must never read as one of those.
 */
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
      onClick={props.onStop}
    />
  );
}

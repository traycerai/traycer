import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useContext } from "react";
import { AutomationTerminalOpenContext } from "./automation-terminal-open-context";

/** A first open can fail between the placeholder disappearing and its row arriving. */
export function AutomationTerminalOpenFallback(props: {
  readonly shownHostIds: readonly string[];
  readonly unstartedShown: boolean;
}) {
  const open = useContext(AutomationTerminalOpenContext);
  if (
    open === null ||
    !open.failed ||
    props.unstartedShown ||
    props.shownHostIds.some((hostId) => hostId === open.hostId)
  )
    return null;
  return (
    <AutomationTerminalOpenError onRetry={open.run} pending={open.starting} />
  );
}

export function AutomationTerminalOpenError(props: {
  readonly onRetry: () => void;
  readonly pending: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex basis-full items-center gap-2 text-ui-sm text-destructive"
    >
      <span>Couldn't open a terminal on Automations.</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={props.onRetry}
        disabled={props.pending}
      >
        {props.pending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
          />
        ) : null}
        Retry
      </Button>
    </div>
  );
}

import type { ReactNode } from "react";
import { SandboxStartingLine } from "@/components/composer/sandbox-setup-line";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import type { AutomationTerminalRequest } from "@/stores/home/landing-panel-store";
import { useAutomationTerminalPaneOpen } from "./use-automation-terminal-pane-open";

/** The reserved terminal row stays here through wake, failure and Retry. */
export function AutomationTerminalPane(props: {
  readonly request: AutomationTerminalRequest;
  readonly instanceId: string;
}): ReactNode {
  const open = useAutomationTerminalPaneOpen(props.request, props.instanceId);
  let content: ReactNode = null;
  if (open.failureCode !== null) {
    content = (
      <div
        role="alert"
        className="flex flex-wrap items-baseline gap-2 text-ui-sm"
      >
        <span className="text-destructive">
          {open.failureCode === "automation-pod-missing"
            ? "This host no longer exists."
            : "Couldn't open a terminal on Automations."}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={open.starting}
          onClick={open.run}
        >
          {open.starting ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Retry
        </Button>
        <details className="basis-full text-ui-xs text-muted-foreground">
          <summary className="cursor-pointer">Details</summary>
          <code>{open.failureCode}</code>
        </details>
      </div>
    );
  } else if (props.request.existing?.awake !== true) {
    content = <SandboxStartingLine startedAt={props.request.startedAt} />;
  }
  return (
    <div
      data-testid="automation-terminal-pane"
      data-host-id={open.hostId}
      className="flex h-full min-h-0 flex-col gap-3 bg-canvas p-4"
    >
      {content}
    </div>
  );
}

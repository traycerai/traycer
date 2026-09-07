import type { ReactNode } from "react";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { createReportIssueContext } from "@/lib/report-issue-context";
import type { TerminalConnectionOverlayState } from "./terminal-connection-overlay-state";

/**
 * Without it a dropped session reads as a live terminal - the stale frame stays painted and xterm's local cursor keeps blinking, so the user types into a dead PTY with no feedback.
 */
export interface TerminalConnectionOverlayProps {
  readonly state: TerminalConnectionOverlayState;
  readonly onReconnect: () => void;
  readonly testId: string;
}

export function TerminalConnectionOverlay(
  props: TerminalConnectionOverlayProps,
): ReactNode {
  const isLost = props.state === "lost";
  const isAlert = isLost;
  let content: ReactNode;
  if (isLost) {
    content = (
      <>
        <p className="max-w-md">
          This session disconnected and could not be restarted. It may have
          ended while the app was asleep.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onReconnect}
          >
            Reconnect
          </Button>
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Terminal session could not reconnect",
              message: "The terminal session could not be restarted.",
              code: null,
              source: "Terminal",
            })}
            presentation="text"
            className={undefined}
          />
        </div>
      </>
    );
  } else {
    const label =
      props.state === "recovering"
        ? "Reconnecting and resuming the session…"
        : "Reconnecting…";
    content = (
      <div className="flex items-center gap-2">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        <span>{label}</span>
      </div>
    );
  }
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-canvas/85 px-6 text-center text-ui-sm text-muted-foreground"
      data-testid={props.testId}
      role={isAlert ? "alert" : "status"}
      aria-live={isAlert ? "assertive" : "polite"}
      aria-busy={!isAlert}
    >
      {content}
    </div>
  );
}

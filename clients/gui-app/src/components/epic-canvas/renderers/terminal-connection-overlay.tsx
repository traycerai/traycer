import type { ReactNode } from "react";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { createReportIssueContext } from "@/lib/report-issue-context";
import type { TerminalConnectionOverlayState } from "./terminal-connection-overlay-state";

/**
 * Overlay surfaced over a terminal/TUI tile whose live stream is no longer
 * connected. Without it a dropped session reads as a live terminal - the stale
 * frame stays painted and xterm's local cursor keeps blinking, so the user types
 * into a dead PTY with no feedback. The overlay covers the grid (so input lands
 * on it, not the dead terminal) and names the state.
 *
 * - `reconnecting` - the transport dropped and is re-dialing; transient, the
 *   session is expected back on its own.
 * - `recovering` - the session was found gone and is being respawned-and-resumed
 *   automatically (see `useTerminalSessionRecovery`).
 * - `lost` - automatic recovery gave up (the respawn kept failing); offer a
 *   manual retry ("reattachable" - the session may still exist, Architecture §8).
 * - `sessionLost` - the host confirmed (`TERMINAL_NOT_FOUND`) this session is
 *   definitively gone (linger expired + reaped, or lost across a host
 *   restart) - a final state (Journey 4: "Scroll back to see how it
 *   finished"); no retry affordance, only Close.
 *
 * Keystrokes are already blocked from the dead PTY at the store
 * (`writeInput` returns null while `status` is `"lost"`/`"reaped"` or the
 * connection is not open), so the overlay does not steal focus; it covers
 * the grid and announces the state as a live region.
 */
export interface TerminalConnectionOverlayProps {
  readonly state: TerminalConnectionOverlayState;
  readonly onReconnect: () => void;
  /** Only invoked from the `sessionLost` state's Close action. */
  readonly onClose: () => void;
  readonly testId: string;
}

export function TerminalConnectionOverlay(
  props: TerminalConnectionOverlayProps,
): ReactNode {
  const isLost = props.state === "lost";
  const isSessionLost = props.state === "sessionLost";
  const isAlert = isLost || isSessionLost;
  let content: ReactNode;
  if (isSessionLost) {
    content = (
      <>
        <p className="max-w-md">
          This terminal&apos;s session ended while you were away. Scroll back to
          see how it finished.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onClose}
        >
          Close
        </Button>
      </>
    );
  } else if (isLost) {
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

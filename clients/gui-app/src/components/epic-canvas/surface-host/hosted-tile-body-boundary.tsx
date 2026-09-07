import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { appLogger } from "@/lib/logger";
import { createReportIssueDraftContext } from "@/lib/report-issue-draft-context";
import {
  captureReportIssueError,
  type ReportIssueErrorCapture,
} from "@/lib/report-issue-error-capture";

interface HostedTileBodyBoundaryProps {
  /** The hosted record this body belongs to - for the log line and test ids. */
  readonly instanceId: string;
  /**
   * Any value whose identity change means "the body was re-pointed" (the host passes the slot's anchor element, which changes on transfer): a crash that belonged to the previous placement is cleared and the body retried, so moving or re-hosting a tile is itself a recovery, not something the user has to follow with a Retry click.
   * Keep it to a value that changes on re-pointing ONLY - a key that churns on ordinary re-renders would retry (and re-capture) a deterministic crash on every one of them.
   */
  readonly resetKey: unknown;
  readonly children: ReactNode;
}

interface HostedTileBodyBoundaryState {
  readonly error: Error | null;
  readonly capture: ReportIssueErrorCapture | null;
}

const CLEARED: HostedTileBodyBoundaryState = { error: null, capture: null };

/**
 * The record's DOM container, its geometry, and every other tile stay up; only this body is replaced by a recoverable panel.
 */
export class HostedTileBodyBoundary extends Component<
  HostedTileBodyBoundaryProps,
  HostedTileBodyBoundaryState
> {
  constructor(props: HostedTileBodyBoundaryProps) {
    super(props);
    this.state = CLEARED;
  }

  static getDerivedStateFromError(error: Error): HostedTileBodyBoundaryState {
    return { error, capture: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Captured at catch time, once per error (mints the correlation id and
    // reports to Sentry) - never in render, which re-runs.
    const capture = captureReportIssueError({
      error,
      componentStack: info.componentStack ?? null,
      errorCode: null,
      sourceAction: "Agent tile",
    });
    this.setState({ capture });
    appLogger.errorSummary(
      "[hosted-tile] tile body crashed",
      {
        instanceId: this.props.instanceId,
        componentStack: capture.cause.componentStack,
      },
      error,
    );
  }

  override componentDidUpdate(prev: HostedTileBodyBoundaryProps): void {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState(CLEARED);
    }
  }

  private readonly retry = (): void => {
    this.setState(CLEARED);
  };

  override render(): ReactNode {
    const { error, capture } = this.state;
    if (error === null) {
      return this.props.children;
    }
    return (
      <div
        role="alert"
        data-testid={`hosted-tile-body-error-${this.props.instanceId}`}
        className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background p-6 text-center"
      >
        <div className="text-ui font-medium text-foreground">
          This agent's view stopped rendering.
        </div>
        <div className="max-w-md text-ui-sm text-muted-foreground">
          The rest of the window is unaffected. Retry to rebuild this view; if
          it keeps happening, report it so we can see the cause.
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={this.retry}
          >
            Retry
          </Button>
          <ReportIssueAction
            context={createReportIssueDraftContext({
              title: "Agent tile stopped rendering",
              // Real error text goes ONLY into `capture.cause`, never here -
              // this is the public GitHub-issue prefill.
              message: null,
              code: null,
              source: "Agent tile",
              capture,
            })}
            presentation="icon"
            className={undefined}
          />
        </div>
      </div>
    );
  }
}

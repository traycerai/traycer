import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { appLogger } from "@/lib/logger";
import {
  captureReportIssueError,
  type ReportIssueErrorCapture,
} from "@/lib/report-issue-error-capture";

interface TileErrorBoundaryProps {
  /** Tile identity - keys the log line and clears a stuck error on re-point. */
  readonly instanceId: string;
  /**
   * Any value whose identity change means "this tile was replaced" (the tile
   * node's instance id): a crash that belonged to the previous tile is
   * cleared and the body retried, so opening different content in the pane is
   * itself a recovery. Keep it to a value that changes on replacement ONLY - a
   * key that churns on ordinary re-renders would retry (and re-capture) a
   * deterministic crash on every one of them.
   */
  readonly resetKey: unknown;
  readonly children: ReactNode;
}

interface TileErrorBoundaryState {
  readonly error: Error | null;
  readonly capture: ReportIssueErrorCapture | null;
}

const CLEARED: TileErrorBoundaryState = { error: null, capture: null };

/**
 * Per-tile error boundary wrapping the kind-specific body in `renderTile`. A
 * throw inside any tile (a browser guest, a diff, a spec) previously bubbled
 * to the route boundary and then `RootErrorBoundary`, blanking the whole
 * window and unmounting every sibling tile. This catches it at the tile so
 * only the one tile is replaced by a compact, tile-sized fallback; every other
 * tile stays alive.
 *
 * Hosted (chat/terminal) tiles already render under `HostedTileBodyBoundary`
 * at the surface-host seam; this boundary sits inside the tile providers, so it
 * catches a body throw first and finer, while that outer boundary still covers
 * a throw from the provider wrappers above it.
 */
export class TileErrorBoundary extends Component<
  TileErrorBoundaryProps,
  TileErrorBoundaryState
> {
  constructor(props: TileErrorBoundaryProps) {
    super(props);
    this.state = CLEARED;
  }

  static getDerivedStateFromError(error: Error): TileErrorBoundaryState {
    return { error, capture: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Captured at catch time, once per error (mints the correlation id and
    // reports to Sentry) - never in render, which re-runs.
    const capture = captureReportIssueError({
      error,
      componentStack: info.componentStack ?? null,
      errorCode: null,
      sourceAction: "Canvas tile",
    });
    this.setState({ capture });
    appLogger.errorSummary(
      "[epic-canvas] tile crashed",
      {
        instanceId: this.props.instanceId,
        componentStack: capture.cause.componentStack,
      },
      error,
    );
  }

  override componentDidUpdate(prev: TileErrorBoundaryProps): void {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState(CLEARED);
    }
  }

  private readonly reload = (): void => {
    this.setState(CLEARED);
  };

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <div
        role="alert"
        data-testid={`tile-error-${this.props.instanceId}`}
        className={cn(
          "flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center",
        )}
      >
        <div className="text-ui font-medium text-foreground">
          This tab hit an error.
        </div>
        <div className="max-w-md text-ui-sm text-muted-foreground">
          The rest of your tabs are unaffected. Reload to rebuild this one.
        </div>
        <Button type="button" variant="outline" size="sm" onClick={this.reload}>
          Reload
        </Button>
      </div>
    );
  }
}

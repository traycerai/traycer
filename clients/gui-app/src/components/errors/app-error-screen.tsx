import type { ReactNode } from "react";
import { AlertTriangle, House, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";

export interface AppErrorScreenProps {
  /** The thrown value, surfaced as a short technical detail for support. */
  readonly error: unknown;
  /** Reload the renderer window (`window.location.reload()`). */
  readonly onRefresh: () => void;
  /** Navigate back to the home route and clear the error. */
  readonly onReturnHome: () => void;
}

/**
 * Full-viewport fallback rendered when a renderer error escapes a feature's
 * own handling - both the router's `defaultErrorComponent` (route-tree crashes)
 * and the top-level `RootErrorBoundary` (provider crashes above the router)
 * render this so every uncaught error lands on one recognizable card instead
 * of a blank canvas. Presentational only: the host decides what "refresh" and
 * "return home" do.
 */
export function AppErrorScreen(props: AppErrorScreenProps): ReactNode {
  const detail = errorDetail(props.error);
  return (
    <div
      data-testid="app-error-screen"
      role="alert"
      className="flex min-h-svh w-full items-center justify-center bg-background p-6 text-foreground"
    >
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
          <div className="flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-5" aria-hidden />
          </div>
          <div className="flex flex-col gap-1.5">
            <h1 className="text-title-md font-semibold text-foreground">
              Something went wrong
            </h1>
            <p className="text-ui-sm text-muted-foreground">
              The app hit an unexpected error. Refreshing the window usually
              clears it; if it keeps happening, return home and try again.
            </p>
          </div>
          {detail === null ? null : (
            <p className="max-h-24 w-full overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left font-mono text-code-xs break-words whitespace-pre-wrap text-muted-foreground">
              {detail}
            </p>
          )}
          <div className="flex w-full flex-col gap-2 pt-1">
            <Button
              type="button"
              size="lg"
              className="w-full"
              onClick={props.onRefresh}
            >
              <RotateCw aria-hidden />
              Refresh window
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full"
              onClick={props.onReturnHome}
            >
              <House aria-hidden />
              Return to Home
            </Button>
            <ReportIssueAction
              context={createReportIssueContext({
                title: "Something went wrong",
                message: "The app hit an unexpected error.",
                code: null,
                source: "Traycer app",
              })}
              presentation="text"
              className="w-full"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const MAX_DETAIL_LENGTH = 300;

/**
 * Best-effort one-line technical detail for the card. Returns the error
 * message (truncated) so support can identify the failure; never the stack or
 * any payload, keeping user content out of the surface.
 */
function errorDetail(error: unknown): string | null {
  const message = readErrorMessage(error);
  if (message === null) return null;
  const trimmed = message.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= MAX_DETAIL_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…`;
}

function readErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return null;
}

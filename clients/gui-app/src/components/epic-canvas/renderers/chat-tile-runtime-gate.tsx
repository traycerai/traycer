import { type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";

// Display-only components for the chat tile's pre-snapshot states (loading and
// fatal-close error). Kept separate from chat-tile.tsx so Fast Refresh stays
// intact.

export function ChatTileLoading(): ReactNode {
  return (
    <div
      data-testid="chat-tile-loading"
      role="status"
      aria-label="Loading chat"
      aria-live="polite"
      className="flex w-full flex-1 items-center justify-center px-6 py-8"
    >
      <MutedAgentSpinner />
      <span className="sr-only">Loading chat</span>
    </div>
  );
}

/**
 * Shown when the host terminates `chat.subscribe` with a fatal error before
 * any snapshot - the chat will never load on this attempt, so we surface the
 * reason and a retry instead of spinning forever. The wire collapses
 * CHAT_INVALID / CHAT_NOT_VISIBLE / etc. into one UNAUTHORIZED code; the
 * human-readable `reason` carries the real cause, so we drop the redundant
 * `CODE: ` prefix for display.
 */
export function ChatTileError(props: {
  readonly details: { readonly reason: string };
  readonly onRetry: () => void;
}): ReactNode {
  const detail = props.details.reason.replace(/^[A-Z_]+:\s*/, "");
  return (
    <div
      data-testid="chat-tile-error"
      className="flex w-full flex-1 items-center justify-center px-6 py-8"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-md border border-canvas-border/70 bg-canvas p-4 text-center">
        <div className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
          <AlertTriangle className="size-4 text-destructive" aria-hidden />
          <span>This chat could not be opened.</span>
        </div>
        <p className="text-ui-sm text-muted-foreground">{detail}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onRetry}
          >
            Retry
          </Button>
          <ReportIssueAction
            context={createReportIssueContext({
              title: "This chat could not be opened",
              message: "The chat could not be opened.",
              code: null,
              source: "Chat",
            })}
            presentation="text"
            className={undefined}
          />
        </div>
      </div>
    </div>
  );
}
